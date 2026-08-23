import inspect
import json
from pathlib import Path

from makerworld_scraper.items import MakerWorldModelItem
from makerworld_scraper.pipelines import ModelJsonWriterPipeline


def test_pipeline_signatures_match_scrapy_217_api():
    assert list(inspect.signature(ModelJsonWriterPipeline.open_spider).parameters) == ["self"]
    assert list(inspect.signature(ModelJsonWriterPipeline.process_item).parameters) == ["self", "item"]


def test_json_writer_uses_model_id_filename(tmp_path: Path):
    pipeline = ModelJsonWriterPipeline(str(tmp_path))
    pipeline.open_spider()

    item = MakerWorldModelItem(
        url="https://makerworld.com/en/models/139303-the-organizer",
        model_id="139303",
        name="The Organizer",
        description="Example",
        image_urls=["https://makerworld.bblmw.com/model/a.webp"],
        images=["139303/a.webp"],
        best_profile={"rating": 5.0},
    )

    returned = pipeline.process_item(item)

    output = tmp_path / "139303.json"
    assert output.exists()
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["model_id"] == "139303"
    assert payload["images"] == ["139303/a.webp"]
    assert returned is item
