"""Build review sheets that highlight product images with text or MakerWorld "Customize" labels.

Usage:
  python flag_images.py --payloads payloads.json --out /tmp/review

Downloads each model's first 3 images, runs tesseract OCR (reports readable word counts) and a
green-label detector, and writes contact sheets sheet_NN.jpg in --out plus index.json mapping
the "#N" labels to model id / image URL. Red header = flagged (OCR words or green pixels).
Requires: tesseract on PATH, Pillow, numpy.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

import localize_images as li


def ocr_words(path: Path) -> int:
    result = subprocess.run(["tesseract", path.name, "-", "--psm", "11", "tsv"], capture_output=True, cwd=path.parent, timeout=90)
    count = 0
    for line in result.stdout.decode("utf-8", "ignore").splitlines()[1:]:
        fields = line.split("\t")
        if len(fields) >= 12 and fields[11].strip():
            try:
                conf = float(fields[10])
            except ValueError:
                continue
            if conf >= 70 and len(re.sub(r"[^A-Za-zÀ-ÿ0-9]", "", fields[11])) >= 3:
                count += 1
    return count


def green_percent(image: Image.Image) -> float:
    arr = np.asarray(image.convert("RGB").resize((250, 250))).astype(int)
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    return float(((g > 140) & (r < 120) & (b < 120) & (g - r > 70)).mean() * 100)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--payloads", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--cache", type=Path, default=Path("/tmp/mw-image-cache"))
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    args.cache.mkdir(parents=True, exist_ok=True)

    payloads = json.loads(args.payloads.read_text(encoding="utf-8"))
    items = []
    for payload in payloads.values():
        urls = [u for u in payload.get("image_urls", []) if "bblmw.com" in u and "/model/" in u][:3]
        for url in urls:
            items.append({"model_id": payload.get("model_id"), "name": payload.get("name"), "url": url})

    small = args.out / "small"
    small.mkdir(exist_ok=True)
    for index, item in enumerate(items):
        raw = li.download(item["url"], args.cache / f"{li.digest(item['url'])}.src")
        image = Image.open(__import__("io").BytesIO(raw)).convert("RGB")
        image.thumbnail((1000, 1000))
        image.save(small / f"{index}.jpg", quality=88)
        item["words"] = ocr_words(small / f"{index}.jpg")
        item["green"] = round(green_percent(image), 2)
    json.dump(items, (args.out / "index.json").open("w"), ensure_ascii=False, indent=1)

    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 18)
    except OSError:
        font = ImageFont.load_default()
    cell, cols, rows_per = 256, 5, 4
    per = cols * rows_per
    for start in range(0, len(items), per):
        sheet = Image.new("RGB", (cols * cell, rows_per * (cell + 24)), "white")
        draw = ImageDraw.Draw(sheet)
        for k, index in enumerate(range(start, min(start + per, len(items)))):
            image = Image.open(small / f"{index}.jpg")
            image.thumbnail((cell - 4, cell - 4))
            x, y = (k % cols) * cell, (k // cols) * (cell + 24)
            sheet.paste(image, (x + 2, y + 26))
            flagged = items[index]["words"] >= 1 or items[index]["green"] > 0.3
            draw.rectangle([x, y, x + cell - 1, y + 22], fill=(200, 30, 30) if flagged else (40, 40, 40))
            draw.text((x + 4, y + 1), f"#{index} t{items[index]['words']} g{items[index]['green']}", fill="white", font=font)
        sheet.save(args.out / f"sheet_{start // per:02d}.jpg", quality=85)
    flagged_count = sum(1 for i in items if i["words"] >= 1 or i["green"] > 0.3)
    print(f"images={len(items)} flagged={flagged_count} sheets={(len(items) + per - 1) // per} out={args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
