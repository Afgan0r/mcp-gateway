#!/usr/bin/env python3
"""Export the built gateway without settings, credentials or dependencies."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    files = []
    # Deliberate allowlist: never open .env, runtime settings or repository data.
    for directory in ("dist", "src", "patches", "frontend/dist"):
        for item in sorted((root / directory).rglob("*")):
            if item.is_symlink():
                raise ValueError("Export cannot contain symlinks")
            if item.is_file() and not item.name.startswith(".env"):
                files.append(item)
    for relative in ("package.json", "pnpm-lock.yaml", ".pnpmfile.cjs", "pnpm-workspace.yaml", "LICENSE", "tsconfig.json",
                     "scripts/local-gateway.mjs", "scripts/gateway-docker.mjs",
                     "scripts/export-local-gateway.py", "scripts/build-mcp-client.js"):
        item = root / relative
        if not item.is_file():
            raise ValueError("Export input is missing: " + relative)
        files.append(item)
    hashes = {str(item.relative_to(root)): hashlib.sha256(item.read_bytes()).hexdigest()
              for item in sorted(set(files))}
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    provenance = json.dumps({"schemaVersion": 1, "baseRevision": revision,
                             "files": hashes}, sort_keys=True, indent=2).encode() + b"\n"
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", filename="", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as archive:
            for relative in sorted(hashes):
                data = (root / relative).read_bytes()
                info = tarfile.TarInfo(relative)
                info.size = len(data)
                info.mode = 0o644
                archive.addfile(info, io.BytesIO(data))
            info = tarfile.TarInfo("runtime-source-manifest.json")
            info.size = len(provenance)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(provenance))
    data = buffer.getvalue()
    digest = hashlib.sha256(data).hexdigest()
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    if not args.destination.exists() or args.destination.read_bytes() != data:
        args.destination.write_bytes(data)
    manifest = json.loads(args.manifest.read_text())
    manifest["runtime"].update(sha256=digest, baseRevision=revision,
                               sourceManifestSha256=hashlib.sha256(provenance).hexdigest())
    encoded = json.dumps(manifest, indent=2) + "\n"
    if args.manifest.read_text() != encoded:
        args.manifest.write_text(encoded)
    print(json.dumps({"sha256": digest, "files": len(files), "bytes": len(data)}))


if __name__ == "__main__":
    main()
