"""Before a release: look for personal data in a folder (the built app, the repo).

    python scripts/scan_secrets.py release/FreeFlow-win32-x64 [other words to look for...]
"""
import getpass
import os
import re
import sys

home = os.path.expanduser("~")
needles = {getpass.getuser(), home, home.replace("\\", "/"), *sys.argv[2:]}
needles = [n.encode() for n in needles if n and len(n) >= 4]
PATTERNS = [re.compile(rb"hf_[A-Za-z0-9]{30,}"), re.compile(rb"sk-(?:ant-)?[A-Za-z0-9_-]{30,}"),
            re.compile(rb"gh[pousr]_[A-Za-z0-9]{30,}"), re.compile(rb"AKIA[0-9A-Z]{16}")]
SKIP = {".git", "node_modules", "__pycache__"}
BINARY_EXT = {".exe", ".dll", ".node", ".bin", ".pak", ".7z"}

hits = 0
for root, dirs, files in os.walk(sys.argv[1]):
    dirs[:] = [d for d in dirs if d not in SKIP]
    for f in files:
        p = os.path.join(root, f)
        try:
            with open(p, "rb") as fh:
                data = fh.read()
        except OSError:
            continue
        for n in needles:
            if n in data or n.decode().encode("utf-16-le") in data:
                print("PERSONAL", n.decode(), "->", p)
                hits += 1
        if os.path.splitext(f)[1].lower() in BINARY_EXT:
            continue
        for r in PATTERNS:
            m = r.search(data)
            if m:
                print("KEY?", m.group(0)[:10].decode(errors="replace") + "...", "->", p)
                hits += 1
print("hits:", hits)
sys.exit(1 if hits else 0)
