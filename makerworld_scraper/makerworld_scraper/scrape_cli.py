from __future__ import annotations

import json
import sys

from itemadapter import ItemAdapter
from scrapy import signals
from scrapy.crawler import CrawlerProcess
from scrapy.settings import Settings

from makerworld_scraper.spiders.model import MakerWorldModelSpider


def build_settings() -> Settings:
    settings = Settings()
    settings.setmodule("makerworld_scraper.settings", priority="project")
    settings.set("ITEM_PIPELINES", {}, priority="cmdline")
    settings.set("LOG_LEVEL", "ERROR", priority="cmdline")
    settings.set("TELNETCONSOLE_ENABLED", False, priority="cmdline")
    return settings


def scrape(url: str) -> dict:
    items: list[dict] = []
    process = CrawlerProcess(build_settings())
    crawler = process.create_crawler(MakerWorldModelSpider)

    def on_item_scraped(item, response, spider):
        items.append(ItemAdapter(item).asdict())

    crawler.signals.connect(on_item_scraped, signal=signals.item_scraped, weak=False)
    process.crawl(crawler, url=url)
    process.start()

    if not items:
        raise RuntimeError("Scraper não retornou nenhum item.")
    return items[0]


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(json.dumps({"error": "usage: python -m makerworld_scraper.scrape_cli <url>"}))
        return 1

    try:
        payload = scrape(argv[1])
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"error": str(error)}))
        return 1

    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
