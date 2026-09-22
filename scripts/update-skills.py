#!/usr/bin/env python3
"""Refresh the preview's weekly AI Skills leaderboard from Skills.sh."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import tempfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote, urlencode
from zoneinfo import ZoneInfo


SOURCE_URL = "https://skills.sh/"
OFFICIAL_LIMIT = 8
COMMUNITY_LIMIT = 8
MAX_PER_SOURCE = 2

class DescriptionParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.description = ""

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta" and attrs.get("name") == "description":
            self.description = attrs.get("content", "")


def source_description(html: str) -> str:
    parser = DescriptionParser()
    parser.feed(html)
    text = " ".join(parser.description.split())
    # Keep the first complete sentence, without splitting domains such as inference.sh.
    text = re.split(r"(?<=[.!?。！？])\s+", text, maxsplit=1)[0]
    if len(text) < 12 or text.endswith(("…", "...")) or len(text) > 600:
        raise ValueError("Detail page has no usable complete description")
    return text


def valid_description(text: str) -> bool:
    return bool(re.search(r"[\u4e00-\u9fff]", text)) and "待补充" not in text and len(text) >= 8


def translate_description(text: str) -> str:
    if re.search(r"[\u4e00-\u9fff]", text):
        return text
    query = urlencode({"client": "gtx", "sl": "auto", "tl": "zh-CN", "dt": "t", "q": text})
    translated = json.loads(fetch_html("https://translate.googleapis.com/translate_a/single?" + query))
    result = "".join(part[0] for part in translated[0] if part[0]).strip()
    if not valid_description(result):
        raise ValueError("Translation did not return a Chinese description")
    return result


def enrich_descriptions(payload: dict, previous: dict) -> None:
    cache = {item["url"]: item for group in ("official", "community") for item in previous.get(group, [])}

    def enrich(item):
        old = cache.get(item["url"], {})
        try:
            original = source_description(fetch_html(item["url"]))
            if original == old.get("descriptionOriginal") and valid_description(old.get("description", "")):
                description = old["description"]
            else:
                description = translate_description(original)
            item.update(description=description, descriptionOriginal=original)
        except (RuntimeError, ValueError, TypeError, IndexError, subprocess.SubprocessError) as error:
            if not valid_description(old.get("description", "")):
                raise RuntimeError(f"No verified Chinese description for {item['url']}; keeping previous leaderboard") from error
            item["description"] = old["description"]
            item["descriptionOriginal"] = old.get("descriptionOriginal", "")
            print(f"Using cached description: {item['url']}")

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(enrich, payload["official"] + payload["community"]))


def parse_skills(html: str) -> list[dict]:
    start_marker = r'\"initialSkills\":'
    end_marker = r',\"totalSkills\":'
    try:
        start = html.index(start_marker) + len(start_marker)
        end = html.index(end_marker, start)
        return json.loads(html[start:end].replace(r'\"', '"'))
    except (ValueError, json.JSONDecodeError) as error:
        raise RuntimeError("Skills.sh page format changed; leaderboard not found") from error


def weekly_installs(skill: dict) -> int:
    history = skill.get("weeklyInstalls") or []
    return int(history[-1]) if history else 0


def normalize_skill(skill: dict) -> dict:
    source = str(skill.get("source") or "").strip()
    skill_id = str(skill.get("skillId") or "").strip()
    return {
        "name": str(skill.get("name") or skill_id).strip(),
        "source": source,
        "weeklyInstalls": weekly_installs(skill),
        "totalInstalls": int(skill.get("installs") or 0),
        "url": f"https://skills.sh/{quote(source, safe='/')}/{quote(skill_id)}",
    }


def skill_key(skill: dict) -> str:
    return str(skill.get("skillId") or skill.get("name") or "").strip().casefold()


def top_skills(skills: list[dict], *, official: bool, limit: int, excluded=()) -> list[dict]:
    candidates = []
    for skill in skills:
        is_official = bool(skill.get("isOfficial"))
        current = weekly_installs(skill)
        total = int(skill.get("installs") or 0)
        if official != is_official or current <= 0:
            continue
        if not official and (total < 100_000 or current < 1_000):
            continue
        candidates.append(skill)

    counts: Counter[str] = Counter()
    seen = set(excluded)
    result = []
    for skill in sorted(candidates, key=weekly_installs, reverse=True):
        source = str(skill.get("source") or "")
        key = skill_key(skill)
        if not source or not key or key in seen or counts[source] >= MAX_PER_SOURCE:
            continue
        seen.add(key)
        counts[source] += 1
        result.append(normalize_skill(skill))
        if len(result) == limit:
            break
    return result


def build_payload(skills: list[dict]) -> dict:
    official_keys = {skill_key(skill) for skill in skills if skill.get("isOfficial") and weekly_installs(skill) > 0}
    return {
        "updatedAt": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds"),
        "source": {"name": "Skills.sh"},
        "methodology": "按本周安装量排序；同名技能仅展示一次，优先官方来源，否则保留本周安装量最高的来源，安装量不累加；社区榜门槛：总安装量≥10万、本周≥1000",
        "official": top_skills(skills, official=True, limit=OFFICIAL_LIMIT),
        "community": top_skills(skills, official=False, limit=COMMUNITY_LIMIT, excluded=official_keys),
    }


def fetch_html(url: str = SOURCE_URL) -> str:
    process = subprocess.run(
        ["curl", "-fsSL", "--retry", "2", "--connect-timeout", "15", "--max-time", "45", url],
        check=True,
        capture_output=True,
        text=True,
    )
    return process.stdout


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as output:
        json.dump(payload, output, ensure_ascii=False, indent=2)
        output.write("\n")
        temporary = Path(output.name)
    temporary.replace(path)


def self_check() -> None:
    sample = [
        {"source": "official/a", "skillId": "one", "name": "One", "installs": 5, "weeklyInstalls": [3], "isOfficial": True},
        {"source": "community/b", "skillId": "two", "name": "Two", "installs": 100_000, "weeklyInstalls": [1_000]},
        {"source": "community/c", "skillId": "three", "name": "Three", "installs": 99_999, "weeklyInstalls": [2_000]},
    ]
    html = f'prefix\\"initialSkills\\":{json.dumps(sample)} ,\\"totalSkills\\":3 suffix'.replace("} ,", "},")
    payload = build_payload(parse_skills(html))
    assert [item["name"] for item in payload["official"]] == ["One"]
    assert [item["name"] for item in payload["community"]] == ["Two"]
    duplicates = [
        {"source": "mirror/one", "skillId": "same", "installs": 200_000, "weeklyInstalls": [2_000]},
        {"source": "mirror/two", "skillId": "SAME", "installs": 300_000, "weeklyInstalls": [3_000]},
        {"source": "other/skills", "skillId": "distinct", "installs": 100_000, "weeklyInstalls": [1_000]},
    ]
    ranked = build_payload(duplicates)["community"]
    assert [item["source"] for item in ranked] == ["mirror/two", "other/skills"]
    assert ranked[0]["weeklyInstalls"] == 3_000
    duplicates.append({"source": "official/skills", "skillId": "same", "weeklyInstalls": [100], "isOfficial": True})
    assert [item["name"] for item in build_payload(duplicates)["community"]] == ["distinct"]
    assert source_description('<meta name="description" content="Generate video via inference.sh CLI. More details.">') == "Generate video via inference.sh CLI."
    assert not valid_description("用途介绍待补充，可点击名称查看详情。")
    assert valid_description("根据文字描述自动生成视频。")
    from unittest.mock import patch
    fresh = {"official": [{"url": "https://skills.sh/new/skill"}], "community": []}
    with patch(__name__ + ".fetch_html", return_value='<meta name="description" content="Generate video from text.">'), patch(__name__ + ".translate_description", return_value="根据文字描述自动生成视频。"):
        enrich_descriptions(fresh, {})
    assert fresh["official"][0]["description"] == "根据文字描述自动生成视频。"
    with patch(__name__ + ".fetch_html", side_effect=RuntimeError("offline")):
        enrich_descriptions(fresh, fresh)
        try:
            enrich_descriptions({"official": [{"url": "https://skills.sh/unknown"}], "community": []}, {})
        except RuntimeError:
            pass
        else:
            raise AssertionError("New skills without descriptions must not be published")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "skills-hot.json")
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if args.self_check:
        self_check()
        print("self-check passed")
        return
    payload = build_payload(parse_skills(fetch_html()))
    if not payload["official"] or not payload["community"]:
        raise RuntimeError("Skills leaderboard is unexpectedly empty")
    cache_path = Path(__file__).resolve().parents[1] / "data" / "skills-hot.json"
    previous = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    enrich_descriptions(payload, previous)
    write_json(args.output, payload)
    print(f"updated {len(payload['official']) + len(payload['community'])} skills -> {args.output}")


if __name__ == "__main__":
    main()
