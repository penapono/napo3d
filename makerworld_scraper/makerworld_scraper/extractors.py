from __future__ import annotations

import html
import json
import math
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any
from pathlib import PurePath
from urllib.parse import urljoin, urlsplit, urlunsplit


IMAGE_KEYS = {
    "image", "imageurl", "image_url", "cover", "coverurl", "cover_url",
    "thumbnail", "thumbnailurl", "thumbnail_url", "previewurl",
    "preview_url", "picture", "pictureurl", "picture_url",
}

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"}
IMAGE_HOSTS = {"makerworld.bblmw.com", "makerworld.com", "www.makerworld.com"}
RATING_KEYS = ("rating", "ratingscore", "rating_score", "averagerating", "average_rating", "avgrating", "avg_rating", "score")
RATING_TOTAL_KEYS = ("ratingscoretotal", "rating_score_total", "totalscore", "total_score")
RATING_COUNT_KEYS = ("ratingcount", "rating_count", "ratings", "reviewcount", "review_count", "commentcount", "comment_count")
TIME_KEYS = ("printtime", "print_time", "printingtime", "printing_time", "totaltime", "total_time", "estimatedtime", "estimated_time", "prediction", "duration")
WEIGHT_KEYS = ("weight", "filamentweight", "filament_weight", "totalweight", "total_weight", "materialweight", "material_weight", "filamentusage", "filament_usage")
NAME_KEYS = ("profilename", "profile_name", "title", "name")
PROFILE_ID_KEYS = ("profileid", "profile_id", "id")


@dataclass(frozen=True)
class Profile:
    profile_id: str | None
    name: str | None
    rating: float | None
    rating_count: int
    print_time_seconds: int | None
    weight_grams: float | None
    raw: Mapping[str, Any]

    def rank(self) -> tuple[float, int]:
        return (self.rating if self.rating is not None else -1.0, self.rating_count)

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.profile_id,
            "name": self.name,
            "rating": self.rating,
            "rating_count": self.rating_count,
            "print_time_seconds": self.print_time_seconds,
            "print_time": format_duration(self.print_time_seconds),
            "weight_grams": round(self.weight_grams, 2) if self.weight_grams is not None else None,
        }


def walk_json(value: Any) -> Iterable[Any]:
    yield value
    if isinstance(value, Mapping):
        for child in value.values():
            yield from walk_json(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_json(child)


def parse_json_scripts(response) -> list[Any]:
    values: list[Any] = []
    for text in response.xpath("//script/text()").getall():
        text = html.unescape(text).strip()
        if not text:
            continue
        candidates = [text]
        # Common hydration assignments: window.__FOO__ = {...};
        match = re.search(r"(?:__NEXT_DATA__|__INITIAL_STATE__|__APOLLO_STATE__|__NUXT__)[^=]*=\s*(\{.*\})\s*;?\s*$", text, re.S)
        if match:
            candidates.append(match.group(1))
        for candidate in candidates:
            try:
                values.append(json.loads(candidate))
                break
            except (json.JSONDecodeError, TypeError):
                continue
    return values


def first_text(response, selectors: list[str]) -> str | None:
    for selector in selectors:
        value = response.css(selector).get()
        if value:
            value = re.sub(r"\s+", " ", html.unescape(value)).strip()
            if value:
                return value
    return None


def extract_name(response, json_values: list[Any]) -> str | None:
    value = first_text(response, [
        'meta[property="og:title"]::attr(content)',
        'meta[name="twitter:title"]::attr(content)',
        "h1::text",
        "title::text",
    ])
    if value:
        return re.sub(
            r"\s+-\s+(?:Free 3D Print Model|Modelo gratuito para impressão 3D).*?$",
            "",
            value,
            flags=re.I,
        ).strip()
    return find_json_string(json_values, {"name", "title"})


def extract_description(response, json_values: list[Any]) -> str | None:
    value = first_text(response, [
        'meta[property="og:description"]::attr(content)',
        'meta[name="description"]::attr(content)',
        'meta[name="twitter:description"]::attr(content)',
    ])
    if value:
        return value
    return find_json_string(json_values, {"description", "modeldescription", "model_description"})


def find_json_string(values: list[Any], keys: set[str]) -> str | None:
    for root in values:
        for node in walk_json(root):
            if not isinstance(node, Mapping):
                continue
            normalized = {normalize_key(k): v for k, v in node.items()}
            for key in keys:
                value = normalized.get(normalize_key(key))
                if isinstance(value, str) and value.strip():
                    return re.sub(r"\s+", " ", html.unescape(value)).strip()
    return None


def extract_images(response, json_values: list[Any]) -> list[str]:
    candidates: list[str] = []
    candidates.extend(response.css('meta[property="og:image"]::attr(content)').getall())
    candidates.extend(response.css('meta[name="twitter:image"]::attr(content)').getall())
    candidates.extend(response.css("img::attr(src)").getall())
    candidates.extend(response.css("img::attr(data-src)").getall())
    candidates.extend(response.css("img::attr(data-original)").getall())

    for root in json_values:
        for node in walk_json(root):
            if not isinstance(node, Mapping):
                continue
            for key, value in node.items():
                if normalize_key(str(key)) not in IMAGE_KEYS:
                    continue
                if isinstance(value, str):
                    candidates.append(value)
                elif isinstance(value, list):
                    candidates.extend(v for v in value if isinstance(v, str))

    output: list[str] = []
    seen: set[str] = set()
    for value in candidates:
        url = normalize_image_url(response.url, value)
        if not url or url in seen or not is_image_url(url):
            continue
        seen.add(url)
        output.append(url)
    return output


def normalize_image_url(base_url: str, value: str) -> str | None:
    value = html.unescape(value.strip()).replace("\\u0026", "&").replace("\\/", "/")
    if not value or value.startswith("data:"):
        return None

    # Reject HTML fragments and UI labels before urljoin turns them into bogus relative URLs.
    lowered = value.lower()
    if "<" in value or ">" in value or lowered.startswith(("javascript:", "blob:")):
        return None

    url = urljoin(base_url, value)
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        return None
    return urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, ""))


def is_image_url(url: str) -> bool:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if not (host in IMAGE_HOSTS or host.endswith(".bblmw.com")):
        return False

    lowered = url.lower()
    if any(token in lowered for token in ("avatar", "/icon", "logo")):
        return False

    suffix = PurePath(parts.path).suffix.lower()
    if suffix in IMAGE_EXTENSIONS:
        return True

    # MakerWorld CDN transformations sometimes omit a traditional extension but
    # include a format directive in the query/path.
    return host.endswith("bblmw.com") and any(
        token in lowered for token in ("format,webp", "format,jpg", "format,jpeg", "format,png")
    )


def extract_profiles(json_values: list[Any], page_text: str = "") -> list[Profile]:
    profiles: list[Profile] = []
    seen: set[tuple] = set()
    for root in json_values:
        for node in walk_json(root):
            if not isinstance(node, Mapping):
                continue
            profile = profile_from_mapping(node)
            if not profile:
                continue
            signature = (profile.profile_id, profile.name, profile.rating, profile.print_time_seconds, profile.weight_grams)
            if signature in seen:
                continue
            seen.add(signature)
            profiles.append(profile)

    # Fallback for server-rendered/indexable text where profile cards expose values such as:
    # "4.8(23) · 2.5 h · 1 plate · 84 g".
    if not profiles and page_text:
        profiles.extend(profiles_from_text(page_text))
    return profiles


def profile_from_mapping(node: Mapping[str, Any]) -> Profile | None:
    normalized = {normalize_key(str(k)): v for k, v in node.items()}
    rating_count = int(first_number(normalized, RATING_COUNT_KEYS) or 0)
    rating = resolve_rating(normalized, rating_count)
    print_time = first_duration(normalized, TIME_KEYS)
    weight = first_weight(normalized, WEIGHT_KEYS)

    # A profile must carry at least one slicing metric and one profile/rating signal.
    has_metric = print_time is not None or weight is not None
    has_profile_signal = rating is not None or any(k in normalized for k in map(normalize_key, NAME_KEYS)) or "profileid" in normalized
    if not (has_metric and has_profile_signal):
        return None

    name = first_string(normalized, NAME_KEYS)
    profile_id = first_scalar(normalized, PROFILE_ID_KEYS)
    return Profile(
        profile_id=str(profile_id) if profile_id is not None else None,
        name=name,
        rating=rating,
        rating_count=max(rating_count, 0),
        print_time_seconds=print_time,
        weight_grams=weight,
        raw=node,
    )


def profiles_from_text(text: str) -> list[Profile]:
    compact = re.sub(r"\s+", " ", html.unescape(text))
    # Conservative fallback: bind rating/time/weight only when they are close together.
    pattern = re.compile(
        r"(?P<rating>[0-5](?:\.\d+)?)\s*\((?P<count>\d+)\).{0,100}?"
        r"(?P<time>\d+(?:\.\d+)?\s*(?:h|hr|hrs|hour|hours|min|mins|minutes)).{0,100}?"
        r"(?P<weight>\d+(?:\.\d+)?\s*(?:g|kg))",
        re.I,
    )
    return [
        Profile(
            profile_id=None,
            name=None,
            rating=float(m.group("rating")),
            rating_count=int(m.group("count")),
            print_time_seconds=parse_duration(m.group("time")),
            weight_grams=parse_weight(m.group("weight")),
            raw={},
        )
        for m in pattern.finditer(compact)
    ]


def choose_best_profile(profiles: list[Profile]) -> Profile | None:
    valid = [p for p in profiles if p.rating is not None]
    if valid:
        return max(valid, key=lambda p: p.rank())
    return max(profiles, key=lambda p: (p.rating_count, p.print_time_seconds is not None, p.weight_grams is not None), default=None)


def normalize_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def first_number(mapping: Mapping[str, Any], keys: Iterable[str]) -> float | None:
    for key in keys:
        value = mapping.get(normalize_key(key))
        number = parse_number(value)
        if number is not None:
            return number
    return None


def first_duration(mapping: Mapping[str, Any], keys: Iterable[str]) -> int | None:
    for key in keys:
        value = mapping.get(normalize_key(key))
        duration = parse_duration(value)
        if duration is not None:
            return duration
    return None


def first_weight(mapping: Mapping[str, Any], keys: Iterable[str]) -> float | None:
    for key in keys:
        value = mapping.get(normalize_key(key))
        weight = parse_weight(value)
        if weight is not None:
            return weight
    return None


def first_string(mapping: Mapping[str, Any], keys: Iterable[str]) -> str | None:
    for key in keys:
        value = mapping.get(normalize_key(key))
        if isinstance(value, str) and value.strip():
            return re.sub(r"\s+", " ", value).strip()
    return None


def first_scalar(mapping: Mapping[str, Any], keys: Iterable[str]) -> Any | None:
    for key in keys:
        value = mapping.get(normalize_key(key))
        if isinstance(value, (str, int)):
            return value
    return None


def parse_number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    if isinstance(value, str):
        match = re.search(r"-?\d+(?:[.,]\d+)?", value)
        if match:
            try:
                return float(match.group().replace(",", "."))
            except ValueError:
                return None
    return None


def normalize_rating(value: float | None) -> float | None:
    if value is None:
        return None
    # MakerWorld's public UI is a 5-star scale. Ignore unrelated large numeric scores.
    return value if 0 <= value <= 5 else None


def resolve_rating(mapping: Mapping[str, Any], rating_count: int) -> float | None:
    total = first_number(mapping, RATING_TOTAL_KEYS)
    if total is not None and rating_count > 0:
        return normalize_rating(total / rating_count)

    direct_keys = tuple(key for key in RATING_KEYS if key != "score")
    direct = first_number(mapping, direct_keys)
    if direct is not None:
        return normalize_rating(direct)

    score = first_number(mapping, ("score",))
    if score is None or (0 < score < 1):
        return None
    return normalize_rating(score)


def parse_duration(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        if number <= 0:
            return None
        # Hydration payloads commonly use seconds. Very small values are more plausibly minutes.
        return int(round(number if number >= 600 else number * 60))
    if not isinstance(value, str):
        return None
    s = value.strip().lower().replace(",", ".")
    h = re.search(r"(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)", s)
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)", s)
    sec = re.search(r"(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)", s)
    if h or m or sec:
        return int(round((float(h.group(1)) if h else 0) * 3600 + (float(m.group(1)) if m else 0) * 60 + (float(sec.group(1)) if sec else 0)))
    if re.fullmatch(r"\d+(?:\.\d+)?", s):
        return parse_duration(float(s))
    return None


def parse_weight(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if number > 0 else None
    if not isinstance(value, str):
        return None
    s = value.strip().lower().replace(",", ".")
    match = re.search(r"(\d+(?:\.\d+)?)\s*(kg|g|gram|grams)?", s)
    if not match:
        return None
    number = float(match.group(1))
    unit = match.group(2)
    return number * 1000 if unit == "kg" else number


def format_duration(seconds: int | None) -> str | None:
    if seconds is None:
        return None
    hours, remainder = divmod(seconds, 3600)
    minutes = round(remainder / 60)
    if minutes == 60:
        hours += 1
        minutes = 0
    if hours and minutes:
        return f"{hours}h {minutes}m"
    if hours:
        return f"{hours}h"
    return f"{minutes}m"
