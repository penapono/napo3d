from __future__ import annotations

import re
from urllib.parse import urlparse

import scrapy

from makerworld_scraper.extractors import (
    choose_best_profile,
    extract_description,
    extract_images,
    extract_name,
    extract_profiles,
    parse_json_scripts,
)
from makerworld_scraper.items import MakerWorldModelItem


class MakerWorldModelSpider(scrapy.Spider):
    name = "makerworld_model"
    allowed_domains = ["makerworld.com", "www.makerworld.com", "makerworld.bblmw.com"]

    def __init__(self, url: str | None = None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if not url:
            raise ValueError("Use -a url=https://makerworld.com/en/models/<id>-<slug>")
        self.model_url = self._validate_url(url)

    async def start(self):
        yield scrapy.Request(
            self.model_url,
            callback=self.parse,
            headers={"Referer": "https://makerworld.com/"},
        )

    def parse(self, response):
        if response.status >= 400:
            self.logger.error("MakerWorld returned HTTP %s for %s", response.status, response.url)
            return

        json_values = parse_json_scripts(response)
        profiles = extract_profiles(json_values, response.text)
        best = choose_best_profile(profiles)
        images = extract_images(response, json_values)

        item = MakerWorldModelItem()
        item["url"] = response.url
        item["model_id"] = self._model_id(response.url)
        item["name"] = extract_name(response, json_values)
        item["description"] = extract_description(response, json_values)
        item["image_urls"] = images
        item["best_profile"] = best.as_dict() if best else None
        yield item

    @staticmethod
    def _validate_url(url: str) -> str:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        if parsed.scheme not in {"http", "https"} or host not in {"makerworld.com", "www.makerworld.com"}:
            raise ValueError("Only makerworld.com model URLs are accepted")
        if not re.search(r"/models/\d+", parsed.path):
            raise ValueError("URL must point to a MakerWorld model (/models/<id>-...)")
        return url

    @staticmethod
    def _model_id(url: str) -> str:
        match = re.search(r"/models/(\d+)", url)
        return match.group(1) if match else "model"
