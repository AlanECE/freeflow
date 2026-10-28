'use strict';
// Manages the local STT sidecar (faster-whisper HTTP server). Replaces Wispr's
// gRPC/WebSocket stream to api.wisprflow.ai with a loopback HTTP call.
const { spawn, execFile, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class Sidecar extends EventEmitter {
  /**
   * @param {{port:number, hfHome:string, model?:string, log:Function, appPath:string,
   *          resourcesPath:string, isPackaged:boolean}} opts
   */
  constructor(opts) {
    super();
    this.port = opts.port;
    this.hfHome = opts.hfHome;
    this.model = opts.model || 'auto';     // 'auto' = large-v3 on an NVIDIA GPU, small on the processor
    this.log = opts.log || (() => {});
    this.appPath = opts.appPath;
    this.resourcesPath = opts.resourcesPath;
    this.isPackaged = opts.isPackaged;
    this.child = null;
    this.external = false;      // true when we adopted an already-running server
    this.forceCpu = false;      // set after all GPU attempts failed, so the next start uses the CPU
    const vendor = this.detectGpuVendor();
    this.computeTypes = vendor === 'nvidia'
      ? ['float16', 'int8_float16', 'int8']
      : ['int8', 'int8_float16', 'int8_float32', 'float16'];
    this.computeTypeIndex = 0;
    // Per-launch secret: the engine refuses POST requests without it, so no other
    // program (or web page) can use or stop it.
    this.token = crypto.randomBytes(24).toString('hex');
    this.info = { ready: false, loading: true, error: null, device: null, compute_type: null, model: null, load_ms: null };
    this.restarts = 0;
    this._poll = null;
  }

  get base() { return `http://127.0.0.1:${this.port}`; }
  get ready() { return !!this.info.ready; }

  /** Detect the GPU vendor on Windows (nvidia / amd / cpu). */
  detectGpuVendor() {
    if (process.platform !== 'win32') return 'cpu';
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        "(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join ' '"],
        { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (/nvidia|geforce|quadro|tesla|\brtx\b|\bgtx\b/i.test(out)) return 'nvidia';
      if (/amd|radeon/i.test(out)) return 'amd';
    } catch { /* ignore */ }
    return 'cpu';
  }

  /** Candidate launch commands, first existing wins. Supports both NVIDIA (cuda) and
   *  AMD (rocm) engines when both are shipped, picking the one matching the GPU. */
  resolveCommand() {
    const bin = process.platform === 'win32' ? 'freeflow-stt.exe' : 'freeflow-stt';
    const vendor = this.detectGpuVendor();
    const folders = vendor === 'nvidia'
      ? ['freeflow-stt-cuda', 'freeflow-stt-rocm', 'freeflow-stt']
      : vendor === 'amd'
        ? ['freeflow-stt-rocm', 'freeflow-stt-cuda', 'freeflow-stt']
        : ['freeflow-stt', 'freeflow-stt-cuda', 'freeflow-stt-rocm'];
    const exeCandidates = [];
    if (process.env.FREEFLOW_STT_EXE) exeCandidates.push(process.env.FREEFLOW_STT_EXE);
    for (const folder of folders) {
      exeCandidates.push(path.join(this.resourcesPath || '', 'stt', folder, bin));
      exeCandidates.push(path.join(this.resourcesPath || '', folder, bin));
      exeCandidates.push(path.join(this.appPath, 'stt', 'dist', folder, bin));
    }
    exeCandidates.push(path.join(this.resourcesPath || '', 'stt', 'freeflow-stt', bin));
    exeCandidates.push(path.join(this.appPath, 'stt', 'dist', 'freeflow-stt', bin));
    for (const exe of exeCandidates) {
      if (exe && fs.existsSync(exe)) return { cmd: exe, args: [], kind: 'exe' };
    }
    const script = path.join(this.appPath, 'stt', 'stt_server.py');
    if (!this.isPackaged && fs.existsSync(script)) {
      return { cmd: process.env.FREEFLOW_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), args: [script], kind: 'python' };
    }
    return null;
  }

  async start() {
    let existing = await this.health(1500);
    // Another FreeFlow engine protected by its own token holds the port: use the next one.
    for (let i = 0; existing && existing.auth && i < 5; i++) {
      this.log(`sidecar: port ${this.port} taken by another engine, trying ${this.port + 1}`);
      this.port += 1;
      existing = await this.health(800);
    }
    if (existing) {
      this.external = true;
      this.info = { ...this.info, ...existing };
      this.log(`sidecar: adopting existing server on :${this.port} (ready=${existing.ready})`);
      this._startPolling();
      if (existing.ready) this.emit('ready', this.info);
      return;
    }
    const cmd = this.resolveCommand();
    if (!cmd) {
      this.info = { ...this.info, loading: false, error: 'Moteur STT introuvable (stt/dist/freeflow-stt ou stt/stt_server.py)' };
      this.log('sidecar: no command found');
      this.emit('failed', this.info.error);
      return;
    }
    this.log(`sidecar: spawning ${cmd.kind} ${cmd.cmd} ${cmd.args.join(' ')}`);
    const env = {
      ...process.env, FREEFLOW_PORT: String(this.port), PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8',
      FREEFLOW_TOKEN: this.token, FREEFLOW_WATCH_STDIN: '1',
    };
    if (this.forceCpu) env.FREEFLOW_DEVICE = 'cpu';
    else if (this.computeTypeIndex < this.computeTypes.length) env.FREEFLOW_COMPUTE_TYPE = this.computeTypes[this.computeTypeIndex];
    if (this.hfHome) env.HF_HOME = this.hfHome;
    if (this.model && this.model !== 'auto') { env.FREEFLOW_MODEL = this.model; env.FREEFLOW_CPU_MODEL = this.model; }
    // stdin stays open and unused: when FreeFlow dies, it closes and the engine exits too.
    this.child = spawn(cmd.cmd, cmd.args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: path.dirname(cmd.cmd) });
    this.child.stdin.on('error', () => {});
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    let buf = '';
    this.child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        this.log(`[stt out] ${line}`);
        if (line === 'READY') this.health(2000).then((h) => { if (h) { this.info = { ...this.info, ...h }; } else { this.info.ready = true; this.info.loading = false; } this.emit('ready', this.info); });
        if (line === 'FAILED') this.health(2000).then((h) => { this.info = { ...this.info, ...(h || {}), ready: false, loading: false }; this.emit('failed', this.info.error || 'Chargement du modèle impossible'); });
      }
    });
    this.child.stderr.on('data', (d) => {
      for (const l of d.split(/\r?\n/)) {
        const line = l.trim();
        if (line) this.log(line.startsWith('[stt]') ? line : `[stt] ${line}`);
      }
    });
    this.child.on('exit', (code, sig) => {
      this.log(`sidecar: exited code=${code} sig=${sig}`);
      this.child = null;
      const wasReady = this.info.ready;
      this.info = { ...this.info, ready: false, loading: false, error: this.info.error || `Moteur arrêté (code ${code})` };
      this.emit('exit', code);
      if (!this.stopping && !this.forceCpu && code && code !== 0) {
        if (this.computeTypeIndex + 1 < this.computeTypes.length) {
          this.computeTypeIndex += 1;
          this.restarts = 0;
          this.log(`sidecar: GPU crashed, trying compute type ${this.computeTypes[this.computeTypeIndex]}`);
          this.info = { ...this.info, ready: false, loading: true, error: null };
          this.emit('progress', this.info);
          setTimeout(() => this.start(), 1000);
          return;
        }
        this.forceCpu = true;
        this.computeTypeIndex = 0;
        this.restarts = 0;
        this.log('sidecar: all GPU compute types failed, falling back to CPU');
        this.info = { ...this.info, ready: false, loading: true, error: null };
        this.emit('progress', this.info);
        setTimeout(() => this.start(), 1000);
        return;
      }
      if (!this.stopping && wasReady && this.restarts < 2) {
        this.restarts += 1;
        this.log('sidecar: restarting...');
        setTimeout(() => this.start(), 1000);
      }
    });
    this._startPolling();
  }

  _startPolling() {
    clearInterval(this._poll);
    this._poll = setInterval(async () => {
      const h = await this.health(1500);
      if (h) {
        const becameReady = h.ready && !this.info.ready;
        const before = JSON.stringify([this.info.phase, this.info.download]);
        this.info = { ...this.info, ...h };
        if (becameReady) this.emit('ready', this.info);
        else if (JSON.stringify([h.phase, h.download]) !== before) this.emit('progress', this.info);
      }
      if (this.info.ready) { clearInterval(this._poll); this._poll = null; }
    }, 1000);
  }

  async health(timeoutMs = 1500) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      const r = await fetch(`${this.base}/health`, { signal: ac.signal });
      clearTimeout(t);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  /** @returns {Promise<{text:string, language:string, duration_ms:number, audio_ms:number}>} */
  async transcribe(wav, { lang = 'auto', hints = [] } = {}) {
    if (!this.info.ready) throw new Error('Le moteur de transcription n’est pas prêt');
    const q = new URLSearchParams({ lang: lang || 'auto' });
    const h = (hints || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 80);
    if (h.length) q.set('hints', h.join(','));
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 120000);
    try {
      const r = await fetch(`${this.base}/transcribe?${q}`, {
        method: 'POST', body: wav, headers: { 'Content-Type': 'audio/wav', 'X-FreeFlow-Token': this.token }, signal: ac.signal,
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `STT HTTP ${r.status}`);
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Meeting transcription: both tracks, streamed back segment by segment.
   * @param {{tracks:{mic?:string,computer?:string,file?:string}, lang?:string, hints?:string[], mix?:string}} req
   * @param {(event:object)=>void} onEvent every NDJSON line ({phase}, segments, {done}, {error})
   */
  async transcribeMeeting(req, onEvent) {
    if (!this.info.ready) throw new Error('Le moteur de transcription n’est pas prêt');
    const r = await fetch(`${this.base}/transcribe_meeting`, {
      method: 'POST', body: JSON.stringify(req),
      headers: { 'Content-Type': 'application/json', 'X-FreeFlow-Token': this.token },
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `STT HTTP ${r.status}`); }
    const decoder = new TextDecoder();
    let buf = '', done = null;
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.error) throw new Error(ev.error);
        if (ev.done) done = ev;
        onEvent(ev);
      }
    }
    if (!done) throw new Error('Transcription interrompue');
    return done;
  }

  /** Restart with another model (the new one is downloaded first if needed). */
  async restart({ model } = {}) {
    if (model) this.model = model;
    if (this.external) return false;            // adopted server: not ours to restart
    await this.stop();
    this.stopping = false;
    this.forceCpu = false;
    this.computeTypeIndex = 0;
    this.restarts = 0;
    this.info = { ready: false, loading: true, error: null, device: null, compute_type: null, model: null, load_ms: null };
    this.emit('progress', this.info);
    await this.start();
    return true;
  }

  async stop() {
    this.stopping = true;
    clearInterval(this._poll);
    if (this.external || !this.child) return;
    const child = this.child;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 800);
      await fetch(`${this.base}/shutdown`, { method: 'POST', headers: { 'X-FreeFlow-Token': this.token }, signal: ac.signal }).catch(() => {});
      clearTimeout(t);
    } catch { /* ignore */ }
    await new Promise((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        if (process.platform === 'win32' && child.pid) {
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => done());
        } else done();
      }, 1200);
    });
    this.child = null;
  }
}

module.exports = { Sidecar };
