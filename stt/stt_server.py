"""FreeFlow STT sidecar.

Local replacement for Wispr Flow's cloud speech backend (api.wisprflow.ai).
Stdlib-only HTTP server in front of faster-whisper:

  GET  /health                 -> {"status","ready","device","compute_type","model",...}
  POST /transcribe?lang=auto|fr|en&hints=a,b,c   body = WAV bytes
                               -> {"text","language","language_probability",
                                   "duration_ms","audio_ms","segments"}
  POST /transcribe_meeting     body = {"tracks": {"mic": path, "computer": path}, "lang", "hints", "mix": path}
                               -> NDJSON stream: {"phase":"decoded","duration"}, then one line per
                                  segment {"track","start","end","text","progress"}, then {"done":true}
                                  (the two tracks mixed for playback are written to "mix")
  POST /shutdown               -> exits the process

Prints READY on stdout once the model is loaded and warm. Env vars:
  FREEFLOW_PORT     listening port (default 48123)
  FREEFLOW_MODEL    whisper model for the GPU path (default large-v3)
  FREEFLOW_CPU_MODEL fallback model when CUDA fails (default small)
  FREEFLOW_DEVICE   force "cuda" or "cpu" (default: try cuda, fall back to cpu)
  FREEFLOW_CPU_THREADS threads for the processor path (default: up to 8)
  FREEFLOW_TOKEN    secret the app sends in X-FreeFlow-Token (POST requests refused without it)
  FREEFLOW_WATCH_STDIN=1  exit when stdin closes, i.e. when the app that started us is gone
  HF_HOME           Hugging Face cache (the app passes <userData>\\models)

Only local programs may talk to it: requests carrying an Origin header (any web
page in a browser) or a Host other than 127.0.0.1/localhost (DNS rebinding) get 403.

macOS has no CUDA: the engine runs on the processor there (Apple Accelerate).

The first launch downloads the model from the Hugging Face Hub; /health then
reports phase="downloading" and download={"model","done","total"} in bytes.
"""
import multiprocessing

if __name__ == "__main__":
    # macOS/Linux: a multiprocessing lock (tqdm, while loading the model) starts a
    # "resource tracker" by re-running this frozen executable; without this call
    # the whole server would start a second time (and fail on the busy port).
    multiprocessing.freeze_support()

import glob
import hmac
import itertools
import io
import json
import os
import site
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


def _log(*args):
    print("[stt]", *args, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Environment: HF cache + CUDA DLL discovery (must run before importing
# ctranslate2, which LoadLibrary()s cublas64_12.dll / cudnn64_9.dll lazily).
# ---------------------------------------------------------------------------
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def _add_dll_dir(d):
    if not os.path.isdir(d):
        return False
    os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
    try:
        os.add_dll_directory(d)
    except (AttributeError, OSError):
        pass
    return True


def _setup_gpu_dlls():
    if sys.platform != "win32":
        return                      # no CUDA/ROCm on macOS; Linux finds its libraries itself
    found = []
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        meipass = getattr(sys, "_MEIPASS", exe_dir)
        for d in (os.path.join(exe_dir, "cuda"), os.path.join(meipass, "cuda"), meipass):
            if _add_dll_dir(d):
                found.append(d)
    else:
        roots = list(site.getsitepackages()) + [site.getusersitepackages()]
        for root in roots:
            for d in glob.glob(os.path.join(root, "nvidia", "*", "bin")):
                if _add_dll_dir(d):
                    found.append(d)
    # AMD ROCm
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        for d in glob.glob(os.path.join(exe_dir, "_rocm_sdk_core", "bin")) + glob.glob(os.path.join(exe_dir, "_rocm_sdk_libraries_custom", "bin")):
            if _add_dll_dir(d):
                found.append(d)
    else:
        roots = list(site.getsitepackages()) + [site.getusersitepackages()]
        for root in roots:
            for d in glob.glob(os.path.join(root, "_rocm_sdk_core", "bin")) + glob.glob(os.path.join(root, "_rocm_sdk_libraries_custom", "bin")):
                if _add_dll_dir(d):
                    found.append(d)
        for d in glob.glob(r"C:\Program Files\AMD\ROCm\*\bin"):
            if _add_dll_dir(d):
                found.append(d)
    if found:
        _log("GPU DLL dirs:", "; ".join(found))
    else:
        _log("no extra GPU DLL dir found (GPU may be unavailable)")


_setup_gpu_dlls()

import numpy as np  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402
from faster_whisper.utils import _MODELS, download_model  # noqa: E402

PORT = int(os.environ.get("FREEFLOW_PORT", "48123"))
GPU_MODEL = os.environ.get("FREEFLOW_MODEL", "large-v3")
CPU_MODEL = os.environ.get("FREEFLOW_CPU_MODEL", "small")
FORCE_DEVICE = os.environ.get("FREEFLOW_DEVICE", "").lower().strip()
# CTranslate2 uses 4 threads by default; dictation is short, more cores = less wait.
CPU_THREADS = int(os.environ.get("FREEFLOW_CPU_THREADS") or min(8, os.cpu_count() or 4))
TOKEN = os.environ.get("FREEFLOW_TOKEN", "")
MAX_BODY = 200 * 1024 * 1024        # ~1 h of 16 kHz WAV; the app caps dictations at 5 min
# Files faster-whisper needs from a CTranslate2 Whisper repo (same list as download_model).
_MODEL_FILES = ("config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.")

STATE = {
    "ready": False,
    "loading": True,
    "phase": "starting",          # starting | downloading | loading | ready | error
    "download": None,             # {"model", "done", "total"} while downloading
    "error": None,
    "device": None,
    "compute_type": None,
    "model": None,
    "load_ms": None,
    "transcriptions": 0,
}
MODEL = None
MODEL_LOCK = threading.Lock()
SERVER = None


def _repo_dir(repo_id):
    hub = os.environ.get("HF_HUB_CACHE") or os.path.join(
        os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface"), "hub")
    return os.path.join(hub, "models--" + repo_id.replace("/", "--"))


def _dir_bytes(d):
    """Bytes of the real files under d (symlinks skipped so blobs are not counted twice)."""
    total = 0
    for root, _, files in os.walk(d):
        for f in files:
            p = os.path.join(root, f)
            try:
                if not os.path.islink(p):
                    total += os.path.getsize(p)
            except OSError:
                pass
    return total


def _expected_bytes(repo_id):
    try:
        from huggingface_hub import HfApi
        info = HfApi().model_info(repo_id, files_metadata=True)
        return sum(s.size or 0 for s in info.siblings if s.rfilename.startswith(_MODEL_FILES)) or None
    except Exception as e:
        _log(f"model size unknown ({type(e).__name__}: {e})")
        return None


def _complete(path):
    """True when every file faster-whisper needs is in the snapshot. snapshot_download
    with local_files_only returns the folder even after an interrupted download."""
    try:
        names = os.listdir(path)
    except OSError:
        return False
    need = ("model.bin", "config.json", "tokenizer.json")
    return all(os.path.isfile(os.path.join(path, n)) for n in need) and any(n.startswith("vocabulary.") for n in names)


def _ensure_model(name):
    """Local path of the model, downloading it first (with progress in STATE) if needed.
    An interrupted download resumes where it stopped."""
    try:
        path = download_model(name, local_files_only=True)
        if _complete(path):
            return path
        _log(f"{name}: incomplete local copy, resuming the download")
    except Exception:
        pass
    repo_id = _MODELS.get(name, name)
    cache = _repo_dir(repo_id)
    dl = {"model": name, "done": _dir_bytes(cache), "total": None}
    STATE.update(phase="downloading", download=dl)
    _log(f"{name} not in local cache, downloading {repo_id}...")
    dl["total"] = _expected_bytes(repo_id)
    stop = threading.Event()

    def poll():
        while not stop.wait(0.5):
            dl["done"] = _dir_bytes(cache)

    threading.Thread(target=poll, daemon=True).start()
    try:
        path = download_model(name)
    finally:
        stop.set()
    dl["done"] = dl["total"] or _dir_bytes(cache)
    _log(f"downloaded {repo_id} ({dl['done'] / 1e9:.2f} GB)")
    return path


def _gpu_devices():
    try:
        import ctranslate2
        return ctranslate2.get_cuda_device_count()
    except Exception as e:
        _log(f"GPU unavailable ({type(e).__name__}: {e})")
        return 0

def _is_rocm():
    try:
        import ctranslate2
        dll = os.path.join(os.path.dirname(ctranslate2.__file__), "ctranslate2.dll")
        data = open(dll, "rb").read().lower()
        return (b"rocblas" in data) or (b"hipblas" in data) or (b"amdhip64" in data)
    except Exception:
        return False


def _load(model_name, device, compute_type):
    path = _ensure_model(model_name)
    STATE.update(phase="loading", download=None)
    return WhisperModel(path, device=device, compute_type=compute_type,
                        cpu_threads=CPU_THREADS if device == "cpu" else 0)


def _warm(model):
    """First CUDA call initialises cuBLAS/cuDNN; do it before announcing READY."""
    silence = np.zeros(16000, dtype=np.float32)
    segs, _ = model.transcribe(silence, beam_size=1, vad_filter=False, language="fr")
    list(segs)


def load_model():
    global MODEL
    t0 = time.time()
    attempts = []
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    os.environ.setdefault("MKL_NUM_THREADS", "1")
    gpu_count = _gpu_devices()
    _log(f"detected {gpu_count} GPU device(s) via CTranslate2")
    rocm = _is_rocm()
    large_model = "large" in (GPU_MODEL or "").lower()
    forced_ct = os.environ.get("FREEFLOW_COMPUTE_TYPE", "").strip().lower()
    use_gpu = (FORCE_DEVICE == "cuda") or (FORCE_DEVICE != "cpu" and gpu_count > 0)
    if rocm and large_model and FORCE_DEVICE != "cuda":
        _log("ROCm + large model: trying GPU first; will fall back to CPU if it crashes")
    if use_gpu:
        if forced_ct:
            attempts.append((GPU_MODEL, "cuda", forced_ct))
        else:
            attempts.append((GPU_MODEL, "cuda", "int8"))
            attempts.append((GPU_MODEL, "cuda", "int8_float16"))
            attempts.append((GPU_MODEL, "cuda", "float16"))
    if FORCE_DEVICE != "cuda":
        attempts.append((CPU_MODEL, "cpu", "int8"))
    last_err = None
    for name, device, ctype in attempts:
        try:
            _log(f"loading {name} on {device} ({ctype})...")
            m = _load(name, device, ctype)
            if not (rocm and large_model):
                _warm(m)
            MODEL = m
            STATE.update(ready=True, loading=False, phase="ready", download=None, device=device,
                         compute_type=ctype, model=name, load_ms=int((time.time() - t0) * 1000), error=None)
            _log(f"model ready: {name} {device}/{ctype} in {STATE['load_ms']} ms")
            print("READY", flush=True)
            return
        except Exception as e:
            last_err = f"{type(e).__name__}: {e}"
            _log(f"failed on {device}: {last_err}")
            traceback.print_exc(file=sys.stderr)
    STATE.update(ready=False, loading=False, phase="error", download=None, error=last_err)
    print("FAILED", flush=True)


# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------
def _decode_audio(input_file, sampling_rate=16000):
    """Decode any container PyAV understands (WAV, webm/opus, mp3...) to mono float32.

    We deliberately do NOT use faster_whisper's decode_audio helper: that helper
    calls av.open(..., metadata_errors="ignore"), an argument our bundled PyAV
    does not accept, which broke meeting transcription. Decoding here keeps us
    independent of that mismatch.
    """
    import av
    import gc

    if isinstance(input_file, (bytes, bytearray)):
        input_file = io.BytesIO(input_file)

    resampler = av.audio.resampler.AudioResampler(
        format="s16", layout="mono", rate=sampling_rate)
    raw_buffer = io.BytesIO()
    dtype = None

    with av.open(input_file, mode="r") as container:
        frames = container.decode(audio=0)

        def _ignore_invalid(it):
            while True:
                try:
                    yield next(it)
                except StopIteration:
                    break
                except av.error.InvalidDataError:
                    continue

        frames = _ignore_invalid(iter(frames))

        fifo = av.audio.fifo.AudioFifo()

        def _group(it):
            for frame in it:
                frame.pts = None
                fifo.write(frame)
                if fifo.samples >= 500000:
                    yield fifo.read()
            if fifo.samples > 0:
                yield fifo.read()

        frames = _group(frames)

        def _resample(it):
            for frame in itertools.chain(it, [None]):
                yield from resampler.resample(frame)

        for frame in _resample(frames):
            array = frame.to_ndarray()
            dtype = array.dtype
            raw_buffer.write(array)

    del resampler
    gc.collect()

    audio = np.frombuffer(raw_buffer.getbuffer(), dtype=dtype)
    audio = audio.astype(np.float32) / 32768.0
    return audio


def _wav_to_float32(body):
    """Decode any container PyAV understands (WAV, webm/opus, mp3...) to 16 kHz mono."""
    try:
        return _decode_audio(body, 16000)
    except Exception:
        # Fallback: plain PCM16 WAV via the wave module.
        import wave
        with wave.open(io.BytesIO(body), "rb") as w:
            rate = w.getframerate()
            ch = w.getnchannels()
            width = w.getsampwidth()
            raw = w.readframes(w.getnframes())
        if width != 2:
            raise ValueError("only 16-bit PCM WAV is supported by the fallback decoder")
        pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        if ch > 1:
            pcm = pcm.reshape(-1, ch).mean(axis=1)
        if rate != 16000:
            n = int(len(pcm) * 16000 / rate)
            pcm = np.interp(np.linspace(0, len(pcm), n, endpoint=False),
                            np.arange(len(pcm)), pcm).astype(np.float32)
        return pcm


def transcribe(body, lang="auto", hints=None):
    audio = _wav_to_float32(body)
    audio_ms = int(len(audio) / 16.0)
    language = None if lang in ("", "auto") else lang
    initial_prompt = None
    if hints:
        # Dictionary words become the decoder prompt, the same way Wispr feeds
        # its "Dictionary" to the server.
        initial_prompt = ", ".join(h.strip() for h in hints if h.strip())
    t0 = time.time()
    with MODEL_LOCK:
        segments, info = MODEL.transcribe(
            audio,
            language=language,
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300, "speech_pad_ms": 200},
            initial_prompt=initial_prompt,
            condition_on_previous_text=False,
            word_timestamps=False,
        )
        segs = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
                for s in segments]
    text = " ".join(s["text"] for s in segs if s["text"]).strip()
    STATE["transcriptions"] += 1
    return {
        "text": text,
        "language": info.language,
        "language_probability": round(float(info.language_probability or 0), 3),
        "duration_ms": int((time.time() - t0) * 1000),
        "audio_ms": audio_ms,
        "segments": segs,
    }


def _write_mix(path, tracks):
    """Both tracks mixed for listening back: Ogg/Opus (about 15 MB an hour), WAV if that fails."""
    n = max(len(a) for a in tracks)
    mix = np.zeros(n, dtype=np.float32)
    for a in tracks:
        mix[:len(a)] += a
    peak = float(np.max(np.abs(mix))) if n else 0.0
    if peak > 0.99:
        mix /= peak / 0.99
    pcm = (mix * 32767).astype(np.int16)
    try:
        import av
        with av.open(path, mode="w", format="ogg") as out:
            stream = out.add_stream("libopus", rate=16000)
            stream.bit_rate = 32000
            stream.layout = "mono"
            fifo = av.AudioFifo()
            frame = av.AudioFrame.from_ndarray(pcm.reshape(1, -1), format="s16", layout="mono")
            frame.sample_rate = 16000
            fifo.write(frame)
            size = stream.codec_context.frame_size or 320
            while True:
                chunk = fifo.read(size, partial=True)
                if chunk is None:
                    break
                for packet in stream.encode(chunk):
                    out.mux(packet)
            for packet in stream.encode(None):
                out.mux(packet)
        return path
    except Exception as e:
        _log(f"ogg mix failed ({type(e).__name__}: {e}), writing WAV")
        import wave
        wav_path = os.path.splitext(path)[0] + ".wav"
        with wave.open(wav_path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(pcm.tobytes())
        return wav_path


def transcribe_meeting(req, emit):
    """Long recordings: one track after the other, segment by segment. The model
    lock is taken per segment, so a dictation can slip in between two segments."""
    tracks = {k: v for k, v in (req.get("tracks") or {}).items() if v}
    if not tracks:
        raise ValueError("no track")
    lang = req.get("lang") or "auto"
    language = None if lang in ("", "auto") else lang
    hints = [h.strip() for h in (req.get("hints") or []) if str(h).strip()]
    audio = {name: _decode_audio(path, 16000) for name, path in tracks.items()}
    duration = max(len(a) for a in audio.values()) / 16000.0
    total = sum(len(a) for a in audio.values()) / 16000.0 or 1.0
    mix = _write_mix(req["mix"], list(audio.values())) if req.get("mix") else None
    emit({"phase": "decoded", "duration": round(duration, 2), "mix": mix})
    t0, done_s = time.time(), 0.0
    for name, a in audio.items():
        with MODEL_LOCK:
            segments, info = MODEL.transcribe(
                a, language=language, beam_size=5, vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 300},
                initial_prompt=", ".join(hints) or None, condition_on_previous_text=False)
        it = iter(segments)
        while True:
            with MODEL_LOCK:
                s = next(it, None)
            if s is None:
                break
            text = s.text.strip()
            if text:
                emit({"track": name, "start": round(s.start, 2), "end": round(s.end, 2), "text": text,
                      "language": info.language, "progress": round(min(1.0, (done_s + s.end) / total), 3)})
        done_s += len(a) / 16000.0
    STATE["transcriptions"] += 1
    emit({"done": True, "duration": round(duration, 2), "seconds": int(time.time() - t0)})


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter than the default
        _log(self.command, self.path, fmt % args)

    def _json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        if code >= 400:
            # A refused request's body may still be unread: never reuse that connection.
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(data)

    def _allowed(self, need_token):
        """Local programs only: no browser page, no DNS rebinding, and the app's token to act."""
        if self.headers.get("Origin"):
            return False
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        if host not in ("", "127.0.0.1", "localhost", "::1"):
            return False
        if need_token and TOKEN:
            return hmac.compare_digest(self.headers.get("X-FreeFlow-Token", ""), TOKEN)
        return True

    def _meeting(self):
        if not STATE["ready"]:
            return self._json(503, {"error": "model not ready", **STATE})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length < 1_000_000:
            return self._json(400, {"error": "bad request"})
        try:
            req = json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            return self._json(400, {"error": "bad json"})
        # Chunked NDJSON: the app shows the progress and the lines as they come.
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        def emit(obj):
            data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
            self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
            self.wfile.flush()

        try:
            transcribe_meeting(req, emit)
        except (BrokenPipeError, ConnectionResetError):
            _log("meeting: the app stopped listening")
            self.close_connection = True
            return
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            try:
                emit({"error": f"{type(e).__name__}: {e}"})
            except OSError:
                pass
        try:
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except OSError:
            pass

    def do_GET(self):
        if not self._allowed(False):
            return self._json(403, {"error": "forbidden"})
        path = urlparse(self.path).path
        if path in ("/health", "/"):
            return self._json(200, {"status": "ok" if STATE["ready"] else ("loading" if STATE["loading"] else "error"),
                                    "port": PORT, "auth": bool(TOKEN), **STATE})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._allowed(True):
            return self._json(403, {"error": "forbidden"})
        url = urlparse(self.path)
        if url.path == "/shutdown":
            self._json(200, {"ok": True})
            threading.Thread(target=SERVER.shutdown, daemon=True).start()
            return
        if url.path == "/transcribe_meeting":
            return self._meeting()
        if url.path != "/transcribe":
            return self._json(404, {"error": "not found"})
        if not STATE["ready"]:
            return self._json(503, {"error": "model not ready", **STATE})
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return self._json(413, {"error": "audio too long"})
        body = self.rfile.read(length) if length else b""
        if len(body) < 100:
            return self._json(400, {"error": "empty audio"})
        q = parse_qs(url.query)
        lang = (q.get("lang") or ["auto"])[0]
        hints = (q.get("hints") or [""])[0]
        hints = [h for h in hints.split(",") if h.strip()] if hints else None
        try:
            return self._json(200, transcribe(body, lang, hints))
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})


def _watch_parent():
    """The app keeps our stdin open and never writes to it: EOF means it is gone
    (crash, kill), so do not linger as an orphan holding the port and the GPU."""
    try:
        while sys.stdin.buffer.read(1):
            pass
    except Exception:
        pass
    _log("app gone (stdin closed), exiting")
    os._exit(0)


def main():
    global SERVER
    SERVER = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    SERVER.daemon_threads = True
    _log(f"listening on http://127.0.0.1:{PORT}  (HF_HOME={os.environ.get('HF_HOME')}, token={'yes' if TOKEN else 'no'})")
    print(f"LISTENING {PORT}", flush=True)
    if os.environ.get("FREEFLOW_WATCH_STDIN") == "1" and sys.stdin:
        threading.Thread(target=_watch_parent, daemon=True).start()
    threading.Thread(target=load_model, daemon=True).start()
    try:
        SERVER.serve_forever()
    except KeyboardInterrupt:
        pass
    _log("bye")
    # Exit right away: a normal interpreter shutdown would wait on the stdin watcher
    # thread (blocked in read) and abort with "could not acquire lock for <stdin>".
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
