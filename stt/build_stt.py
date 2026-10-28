"""Build the FreeFlow STT sidecar with PyInstaller (onedir) and copy the CUDA 12
runtime DLLs (cuBLAS + cuDNN 9 from the nvidia-* pip wheels) next to it, so the
packaged exe runs on the GPU on a machine without Python or the CUDA toolkit.

Usage:  python stt/build_stt.py [--no-cuda|--cpu|--cuda|--rocm|--backend=X]
Output: stt/dist/freeflow-stt/freeflow-stt.exe  (+ _internal/cuda/*.dll)
On macOS (no CUDA there): stt/dist/freeflow-stt/freeflow-stt, processor only.
"""
import glob
import os
import shutil
import site
import subprocess
import sys
import time
import tempfile
import urllib.request
import zipfile
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")
BUILD = os.path.join(HERE, "build")
APP = os.path.join(DIST, "freeflow-stt")

CUDA_DLLS = [
    "cublas64_12.dll", "cublasLt64_12.dll",
    "cudnn_graph64_9.dll", "cudnn_ops64_9.dll", "cudnn_cnn64_9.dll",
    "cudnn_engines_precompiled64_9.dll", "cudnn_engines_runtime_compiled64_9.dll",
    "cudnn_heuristic64_9.dll",
]


def site_dirs():
    return list(site.getsitepackages()) + [site.getusersitepackages()]


def find_in_site(rel_glob):
    for root in site_dirs():
        hits = glob.glob(os.path.join(root, rel_glob))
        if hits:
            return hits
    return []


def detect_backend():
    if sys.platform != "win32":
        return "cpu"
    names = ""
    try:
        import subprocess
        names = subprocess.check_output(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"],
            text=True, stderr=subprocess.DEVNULL, timeout=15).lower()
    except Exception:
        names = ""
    if "nvidia" in names or "geforce" in names or "quadro" in names or "tesla" in names or "rtx" in names or "gtx" in names:
        return "cuda"
    if "amd" in names or "radeon" in names:
        return "rocm"
    return "cpu"


def ctranslate2_backend():
    try:
        import ctranslate2
        dll = os.path.join(os.path.dirname(ctranslate2.__file__), "ctranslate2.dll")
        data = open(dll, "rb").read()
    except Exception:
        return "unknown"
    low = data.lower()
    if b"rocblas" in low or b"hipblas" in low or b"amdhip64" in low:
        return "rocm"
    if b"cublas" in low:
        return "cuda"
    return "cpu"


def parse_backend():
    backend = None
    it = iter(sys.argv[1:])
    for a in it:
        if a == "--rocm":
            backend = "rocm"
        elif a == "--cuda":
            backend = "cuda"
        elif a in ("--cpu", "--no-cuda"):
            backend = "cpu"
        elif a.startswith("--backend="):
            backend = a.split("=", 1)[1].strip().lower()
        elif a == "--backend":
            try:
                backend = next(it).strip().lower()
            except StopIteration:
                pass
    if backend is None:
        backend = detect_backend()
    if backend not in ("cuda", "rocm", "cpu"):
        backend = "cpu"
    return backend


def ensure_rocm_ctranslate2():
    if ctranslate2_backend() == "rocm":
        return
    py = f"{sys.version_info.major}{sys.version_info.minor}"
    wheel_name = f"ctranslate2-4.8.3-cp{py}-cp{py}-win_amd64.whl"
    url = ("https://github.com/OpenNMT/CTranslate2/releases/download/"
           "v4.8.3/rocm-python-wheels-Windows.zip")
    print(f"!! ctranslate2 is not the ROCm build; downloading {url}")
    tmp = tempfile.mkdtemp()
    zip_path = os.path.join(tmp, "rocm-wheels.zip")
    urllib.request.urlretrieve(url, zip_path)
    with zipfile.ZipFile(zip_path) as z:
        members = [m for m in z.namelist() if m.endswith(wheel_name)]
        if not members:
            raise RuntimeError(f"{wheel_name} not found in the ROCm wheels archive")
        z.extract(members[0], tmp)
        wheel_path = os.path.join(tmp, members[0])
    print(f"installing {wheel_path}")
    subprocess.check_call([sys.executable, "-m", "pip", "install", wheel_path,
                          "--force-reinstall", "--no-deps"])


def main():
    backend = parse_backend()
    no_cuda = backend != "cuda" or sys.platform != "win32"
    if backend == "rocm" and sys.platform == "win32":
        ensure_rocm_ctranslate2()
    print(f"FreeFlow STT build: backend={backend} (ctranslate2={ctranslate2_backend()})")

    # Clean previous dist output to avoid stale folders (e.g. leftover cuda/ on a rocm build).
    if os.path.isdir(APP):
        shutil.rmtree(APP, ignore_errors=True)

    t0 = time.time()
    cmd = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
        "--name", "freeflow-stt", "--distpath", DIST, "--workpath", BUILD, "--specpath", HERE,
        "--console",
        "--collect-all", "faster_whisper",
        "--collect-all", "ctranslate2",
        "--collect-all", "onnxruntime",
        "--collect-all", "av",
        "--collect-all", "tokenizers",
        "--collect-submodules", "huggingface_hub",
        "--hidden-import", "numpy",
    ]
    # Bundle only the ROCm runtime DLLs (not the whole SDK, which pulls torch).
    if backend == "rocm":
        for pkg in ("_rocm_sdk_core", "_rocm_sdk_libraries_custom"):
            spec = importlib.util.find_spec(pkg)
            if spec is None or not spec.origin:
                continue
            pkg_dir = os.path.dirname(spec.origin)
            bin_dir = os.path.join(pkg_dir, "bin")
            if os.path.isdir(bin_dir):
                cmd += ["--add-data", f"{bin_dir}{os.pathsep}{pkg}/bin"]
    for mod in ("torch", "torchaudio", "torchvision", "matplotlib", "tkinter", "PIL", "scipy", "pandas",
                "rapidocr_onnxruntime", "sounddevice", "IPython", "jedi", "pytest", "nvidia",
                "numba", "llvmlite", "pyarrow", "pydantic", "pydantic_core", "cryptography",
                "win32com", "pythonwin", "pywin32", "win32api", "hf_xet", "zstandard", "tzdata",
                "cv2", "sklearn", "sympy", "psutil"):
        cmd += ["--exclude-module", mod]
    for d in find_in_site("av.libs"):
        cmd += ["--add-data", f"{d}{os.pathsep}av.libs"]
    cmd.append(os.path.join(HERE, "stt_server.py"))
    print("+", " ".join(cmd), flush=True)
    subprocess.check_call(cmd, cwd=HERE)

    if not no_cuda:
        dst = os.path.join(APP, "_internal", "cuda")
        os.makedirs(dst, exist_ok=True)
        copied = []
        for name in CUDA_DLLS:
            src = find_in_site(os.path.join("nvidia", "*", "bin", name))
            if src:
                shutil.copy2(src[0], os.path.join(dst, name))
                copied.append(name)
            else:
                print("!! missing", name, "(pip install nvidia-cublas-cu12 nvidia-cudnn-cu12)")
        total = sum(os.path.getsize(os.path.join(dst, n)) for n in copied) / 1e6 if copied else 0
        print(f"CUDA DLLs copied: {len(copied)}/{len(CUDA_DLLS)} ({total:.0f} MB) -> {dst}")
    else:
        # Remove any stale cuda folder on non-cuda builds.
        cuda_dir = os.path.join(APP, "_internal", "cuda")
        if os.path.isdir(cuda_dir):
            shutil.rmtree(cuda_dir, ignore_errors=True)

    for root, dirs, _ in os.walk(APP, topdown=False):
        for d in dirs:
            if d == "__pycache__":
                shutil.rmtree(os.path.join(root, d), ignore_errors=True)
    for sub in ("tools", "transformers", "quantization"):
        shutil.rmtree(os.path.join(APP, "_internal", "onnxruntime", sub), ignore_errors=True)

    size = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(APP) for f in fs) / 1e6
    print(f"done in {time.time() - t0:.0f}s, {APP} = {size:.0f} MB")


if __name__ == "__main__":
    main()