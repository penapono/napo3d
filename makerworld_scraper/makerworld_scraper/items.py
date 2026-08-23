import scrapy


class MakerWorldModelItem(scrapy.Item):
    url = scrapy.Field()
    model_id = scrapy.Field()
    name = scrapy.Field()
    description = scrapy.Field()
    images = scrapy.Field()
    image_urls = scrapy.Field()
    best_profile = scrapy.Field()
