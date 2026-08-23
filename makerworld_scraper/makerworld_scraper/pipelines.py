from __future__ import annotations

import json
from hashlib import sha1
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

import scrapy
from itemadapter import ItemAdapter
from scrapy.pipelines.images import ImagesPipeline


class ModelImagesPipeline(ImagesPipeline):
    def get_media_requests(self, item, info):
        referer = item.get("url")
        for url in item.get("image_urls") or []:
            yield scrapy.Request(
                url,
                headers={"Referer": referer} if referer else None,
                meta={"model_id": item.get("model_id") or "model"},
            )

    def file_path(self, request, response=None, info=None, *, item=None):
        model_id = request.meta.get("model_id", "model")
        path = PurePosixPath(urlsplit(request.url).path)
        suffix = (
            path.suffix.lower()
            if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".gif"}
            else ".jpg"
        )
        digest = sha1(request.url.encode("utf-8")).hexdigest()[:16]
        return f"{model_id}/{digest}{suffix}"

    def item_completed(self, results, item, info):
        item["images"] = [
            data["path"]
            for ok, data in results
            if ok and isinstance(data, dict) and data.get("path")
        ]
        return item


class ModelJsonWriterPipeline:
    def __init__(self, output_dir: str):
        self.output_dir = Path(output_dir)

    @classmethod
    def from_crawler(cls, crawler):
        return cls(output_dir=crawler.settings.get("MODEL_JSON_STORE", "output"))

    def open_spider(self):
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def process_item(self, item):
        adapter = ItemAdapter(item)
        model_id = str(adapter.get("model_id") or "model")
        payload = {
            "url": adapter.get("url"),
            "model_id": model_id,
            "name": adapter.get("name"),
            "description": adapter.get("description"),
            "image_urls": adapter.get("image_urls") or [],
            "images": adapter.get("images") or [],
            "best_profile": adapter.get("best_profile"),
        }

        output_path = self.output_dir / f"{model_id}.json"
        output_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return item
