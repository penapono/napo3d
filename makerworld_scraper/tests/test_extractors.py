from scrapy.http import HtmlResponse

from makerworld_scraper.extractors import (
    choose_best_profile,
    extract_images,
    extract_name,
    extract_profiles,
    parse_duration,
    parse_weight,
)


def test_best_profile_prefers_rating_then_review_count():
    payload = [{
        "profiles": [
            {"id": 1, "name": "A", "rating": 4.9, "ratingCount": 500, "printTime": 3600, "weight": "50 g"},
            {"id": 2, "name": "B", "rating": 5.0, "ratingCount": 3, "printTime": 4200, "weight": "55 g"},
            {"id": 3, "name": "C", "rating": 5.0, "ratingCount": 20, "printTime": 4000, "weight": "52 g"},
        ]
    }]
    best = choose_best_profile(extract_profiles(payload))
    assert best is not None
    assert best.profile_id == "3"
    assert best.rating == 5.0
    assert best.rating_count == 20


def test_parsers():
    assert parse_duration("2 h 30 min") == 9000
    assert parse_duration("45 min") == 2700
    assert parse_weight("1.2 kg") == 1200
    assert parse_weight("84 g") == 84


def test_extract_images_rejects_navigation_and_html_fragments():
    response = HtmlResponse(
        url="https://makerworld.com/en/models/139303-the-organizer",
        body=b'''<html><head>
            <meta property="og:image" content="https://makerworld.bblmw.com/model/cover.webp">
        </head><body>
            <img src="https://makerworld.bblmw.com/model/photo.png">
        </body></html>''',
        encoding="utf-8",
    )
    payload = [{
        "url": "/user-agreement",
        "preview": "3D Preview",
        "imageUrl": "https://makerworld.bblmw.com/model/from-json.jpg",
        "picture": "<figure><img src='https://makerworld.bblmw.com/bad.png'></figure>",
        "title": "Image",
    }]

    assert extract_images(response, payload) == [
        "https://makerworld.bblmw.com/model/cover.webp",
        "https://makerworld.bblmw.com/model/photo.png",
        "https://makerworld.bblmw.com/model/from-json.jpg",
    ]


def test_extract_images_does_not_treat_generic_url_as_image():
    response = HtmlResponse(
        url="https://makerworld.com/en/models/139303-the-organizer",
        body=b"<html></html>",
        encoding="utf-8",
    )
    payload = [{
        "url": "https://makerworld.com/community-guidelines",
        "imageUrl": "https://makerworld.bblmw.com/model/real.webp",
    }]

    assert extract_images(response, payload) == [
        "https://makerworld.bblmw.com/model/real.webp",
    ]


def test_extract_name_strips_portuguese_makerworld_suffix():
    response = HtmlResponse(
        url="https://makerworld.com/pt/models/2838224-airplane-business-card-holder-a320-airbus",
        body=b"""<html><head>
            <meta property="og:title" content="Suporte para Cartoes de Visita de Aviao - Modelo gratuito para impressao 3D - MakerWorld">
        </head></html>""",
        encoding="utf-8",
    )

    assert extract_name(response, []) == "Suporte para Cartoes de Visita de Aviao"


def test_extract_profiles_prefers_rating_score_total_over_internal_score():
    payload = [{
        "profiles": [
            {
                "id": "816228634",
                "title": "Camada de 0.16mm",
                "prediction": 43914,
                "weight": "176 g",
                "ratingScoreTotal": 5,
                "ratingCount": 1,
                "score": 0.42647560559535996,
            }
        ]
    }]

    best = choose_best_profile(extract_profiles(payload))
    assert best is not None
    assert best.profile_id == "816228634"
    assert best.rating == 5.0
    assert best.rating_count == 1
