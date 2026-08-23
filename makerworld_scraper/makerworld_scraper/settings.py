BOT_NAME = "makerworld_scraper"
SPIDER_MODULES = ["makerworld_scraper.spiders"]
NEWSPIDER_MODULE = "makerworld_scraper.spiders"

ROBOTSTXT_OBEY = True
CONCURRENT_REQUESTS_PER_DOMAIN = 1
DOWNLOAD_DELAY = 1.5
RANDOMIZE_DOWNLOAD_DELAY = True
DOWNLOAD_TIMEOUT = 30
RETRY_TIMES = 3
RETRY_HTTP_CODES = [408, 425, 429, 500, 502, 503, 504]
COOKIES_ENABLED = True
AUTOTHROTTLE_ENABLED = True
AUTOTHROTTLE_START_DELAY = 1.0
AUTOTHROTTLE_MAX_DELAY = 20.0
AUTOTHROTTLE_TARGET_CONCURRENCY = 0.5

DEFAULT_REQUEST_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36"
)

ITEM_PIPELINES = {
    "makerworld_scraper.pipelines.ModelImagesPipeline": 100,
    "makerworld_scraper.pipelines.ModelJsonWriterPipeline": 200,
}
IMAGES_STORE = "output/images"
IMAGES_EXPIRES = 3650
MODEL_JSON_STORE = "output"

# This spider yields exactly one model item. Close only after that item has
# completed every pipeline stage (including image downloads and JSON writing).
CLOSESPIDER_ITEMCOUNT = 1

LOG_LEVEL = "INFO"
TELNETCONSOLE_ENABLED = False
