"""Download product images and store optimized WebP copies for self-hosting.

Usage:
  python localize_images.py --urls-file urls.txt [--out ../product-images] [--max-px 1200]
         [--quality 80] [--cache /tmp/mw-cache] [--workers 8]

`urls.txt` has one image URL per line (or pass a JSON array). Files are named by the
SHA-1 of the source URL (stable, deduplicated, safe for immutable caching) and a
`manifest.json` maps each source URL to its public path (`/product-images/<hash>.webp`).
Existing outputs are kept, so the command is safe to re-run.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import io
import json
import sys
import urllib.request
from pathlib import Path

from PIL import Image, ImageOps

PUBLIC_PREFIX = "/product-images/"


def digest(url: str) -> str:
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]


def read_urls(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8").strip()
    if text.startswith("["):
        values = json.loads(text)
    else:
        values = [line.strip() for line in text.splitlines()]
    seen: dict[str, None] = {}
    for value in values:
        if value and value.startswith("http"):
            seen.setdefault(value, None)
    return list(seen)


def download(url: str, cache_file: Path) -> bytes:
    if cache_file.exists() and cache_file.stat().st_size > 0:
        return cache_file.read_bytes()
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    data = urllib.request.urlopen(request, timeout=60).read()
    cache_file.write_bytes(data)
    return data


def to_webp(data: bytes, max_px: int, quality: int) -> bytes:
    image = Image.open(io.BytesIO(data))
    image = ImageOps.exif_transpose(image)  # animated formats: first frame only
    has_alpha = image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)
    image = image.convert("RGBA" if has_alpha else "RGB")
    image.thumbnail((max_px, max_px), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    image.save(out, "WEBP", quality=quality, method=6)
    return out.getvalue()


def process(url: str, out_dir: Path, cache_dir: Path, max_px: int, quality: int):
    name = f"{digest(url)}.webp"
    target = out_dir / name
    if target.exists() and target.stat().st_size > 0:
        return url, PUBLIC_PREFIX + name, None
    try:
        raw = download(url, cache_dir / f"{digest(url)}.src")
        target.write_bytes(to_webp(raw, max_px, quality))
        return url, PUBLIC_PREFIX + name, None
    except Exception as error:  # noqa: BLE001 - report and continue with the other images
        return url, None, f"{type(error).__name__}: {error}"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--urls-file", required=True, type=Path)
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "product-images")
    parser.add_argument("--cache", type=Path, default=Path("/tmp/mw-image-cache"))
    parser.add_argument("--max-px", type=int, default=1200)
    parser.add_argument("--quality", type=int, default=80)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args(argv)

    args.out.mkdir(parents=True, exist_ok=True)
    args.cache.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}

    urls = read_urls(args.urls_file)
    failures = []
    with cf.ThreadPoolExecutor(args.workers) as pool:
        for url, public, error in pool.map(lambda u: process(u, args.out, args.cache, args.max_px, args.quality), urls):
            if public:
                manifest[url] = public
            else:
                failures.append((url, error))

    manifest_path.write_text(json.dumps(dict(sorted(manifest.items())), indent=0, ensure_ascii=False) + "\n")
    total = sum(f.stat().st_size for f in args.out.glob("*.webp"))
    print(f"urls={len(urls)} stored={len(urls) - len(failures)} failed={len(failures)} total={total / 1e6:.1f} MB")
    for url, error in failures:
        print("FAILED", url, error, file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
