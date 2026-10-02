"""Prepare browser-collected MakerWorld payloads for import.

Usage:
  python prepare_import.py --payloads payloads.json --translations pt.json \
         --out ready-payloads.json [--drop-images drop.json] [--images-dir ../product-images]

* payloads.json     object keyed by model URL (output of the browser extract snippet).
* pt.json           { "<model_id>": { "name": "...", "summary": "...", "description": "...",
                      "categories": ["Primary", "Other"] } }  written/reviewed by Claude.
* drop.json         optional list of source image URLs to leave out (text banners etc.).

Downloads each model's first 3 images, stores optimized WebP copies in product-images/ via
localize_images.py, and writes payloads whose `image_urls` point at /product-images/... and
that carry the `pt` block read by scripts/import-makerworld-urls.mjs. Models without a
translation or with no usable image are reported and left out.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import localize_images as li

MAX_IMAGES = 3


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--payloads", required=True, type=Path)
    parser.add_argument("--translations", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--drop-images", type=Path)
    parser.add_argument("--images-dir", type=Path, default=Path(__file__).resolve().parent.parent / "product-images")
    parser.add_argument("--cache", type=Path, default=Path("/tmp/mw-image-cache"))
    args = parser.parse_args(argv)

    payloads = json.loads(args.payloads.read_text(encoding="utf-8"))
    translations = json.loads(args.translations.read_text(encoding="utf-8"))
    drop = set(json.loads(args.drop_images.read_text())) if args.drop_images else set()

    ready, problems = {}, []
    wanted: dict[str, list[str]] = {}
    for url, payload in payloads.items():
        model_id = str(payload.get("model_id") or "")
        pt = translations.get(model_id)
        if not pt or not pt.get("name"):
            problems.append((model_id, "missing translation"))
            continue
        images = [u for u in payload.get("image_urls", []) if u not in drop and "bblmw.com" in u and "/model/" in u]
        images = images[:MAX_IMAGES]
        if not images:
            problems.append((model_id, "no usable images"))
            continue
        if not (payload.get("best_profile") or {}).get("weight_grams"):
            problems.append((model_id, "no print profile with weight"))
            continue
        wanted[url] = images
        ready[url] = {**payload, "pt": pt}

    args.images_dir.mkdir(parents=True, exist_ok=True)
    args.cache.mkdir(parents=True, exist_ok=True)
    manifest_path = args.images_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    all_urls = sorted({u for imgs in wanted.values() for u in imgs})
    for image_url, public, error in (li.process(u, args.images_dir, args.cache, 1200, 80) for u in all_urls):
        if public:
            manifest[image_url] = public
        else:
            problems.append((image_url, f"image failed: {error}"))
    manifest_path.write_text(json.dumps(dict(sorted(manifest.items())), indent=0, ensure_ascii=False) + "\n")

    final = {}
    for url, payload in ready.items():
        local = [manifest[u] for u in wanted[url] if u in manifest]
        if not local:
            problems.append((payload.get("model_id"), "no image could be stored"))
            continue
        final[url] = {**payload, "image_urls": local}
    args.out.write_text(json.dumps(final, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"ready={len(final)} skipped={len(problems)} images_dir={args.images_dir}")
    for item, reason in problems:
        print("SKIP", item, reason, file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
