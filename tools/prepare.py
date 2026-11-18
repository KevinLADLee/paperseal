"""Build the local WebView assets. Only the first build requires network access."""
import base64
import hashlib
import io
from pathlib import Path
import shutil
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
VERSION = "4.10.38"
INTEGRITY = "/Y3fcFrXEAsMjJXeL9J8+ZG9U01LbuWaYypvDW2ycW1jL269L3js3DVBjDJ0Up9Np1uqDXsDrRihHANhZOlwdQ=="
cache = ROOT / ".local-tools" / f"pdfjs-dist-{VERSION}.tgz"
cache.parent.mkdir(exist_ok=True)
if not cache.exists():
    urllib.request.urlretrieve(f"https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-{VERSION}.tgz", cache)
blob = cache.read_bytes()
if hashlib.sha512(blob).digest() != base64.b64decode(INTEGRITY):
    raise SystemExit(f"PDF.js checksum mismatch: {cache}")
dist = ROOT / "dist"
shutil.copytree(ROOT / "ui", dist, dirs_exist_ok=True)
with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as archive:
    for entry in archive.getmembers():
        name = entry.name.removeprefix("package/")
        if not entry.isfile() or ".." in Path(name).parts:
            continue
        if name in ("legacy/build/pdf.min.mjs", "legacy/build/pdf.worker.min.mjs"):
            dest = dist / "vendor" / Path(name).name
        elif name.startswith(("cmaps/", "standard_fonts/")) or name == "LICENSE":
            dest = dist / "vendor" / name
        else:
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(archive.extractfile(entry).read())
print("Offline preview assets ready in", dist)
