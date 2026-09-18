#!/usr/bin/env python3
"""Refresh the preview's weekly AI Skills leaderboard from Skills.sh."""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from collections import Counter
from datetime import datetime
from pathlib import Path
from urllib.parse import quote
from zoneinfo import ZoneInfo


SOURCE_URL = "https://skills.sh/"
OFFICIAL_LIMIT = 8
COMMUNITY_LIMIT = 8
MAX_PER_SOURCE = 2

# Chinese summaries checked against each linked Skills.sh detail page.
DESCRIPTIONS = {
    "find-skills": "按任务需求查找并安装合适的 AI 技能。",
    "agent-browser": "让 AI 自动浏览网页、填写表单与提取信息。",
    "frontend-design": "生成有设计感、可直接使用的前端界面。",
    "web-design-guidelines": "检查网页设计、交互与无障碍规范。",
    "prisma-client-api": "辅助编写数据库查询、关联与事务操作。",
    "prisma-cli": "指导数据库初始化、迁移与命令行管理。",
    "neon-postgres": "指导连接和使用 Neon 云端 Postgres 数据库。",
    "neon": "辅助搭建包含数据库、认证与存储的云后端。",
    "design-mobile-apps": "将自然语言需求转化为移动应用界面设计。",
    "video-edit": "按需求选择模型，完成视频改风格与动作迁移。",
    "reddit-automation": "寻找相关 Reddit 讨论并起草有针对性的回复。",
    "image-to-video": "把静态图片转为动画、口型同步等视频内容。",
    "ai-video-generation": "通过命令行调用多种 AI 模型生成视频。",
    "ai-image-generation": "通过命令行调用多种 AI 模型生成图片。",
    "google-agents-cli-adk-code": "提供智能体、工具调用与状态管理的开发指引。",
    "google-agents-cli-scaffold": "创建智能体项目并配置部署与持续集成。"
}


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
        "description": DESCRIPTIONS.get(skill_id, "用途介绍待补充，可点击名称查看详情。"),
        "source": source,
        "weeklyInstalls": weekly_installs(skill),
        "totalInstalls": int(skill.get("installs") or 0),
        "url": f"https://skills.sh/{quote(source, safe='/')}/{quote(skill_id)}",
    }


def top_skills(skills: list[dict], *, official: bool, limit: int) -> list[dict]:
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
    result = []
    for skill in sorted(candidates, key=weekly_installs, reverse=True):
        source = str(skill.get("source") or "")
        if not source or counts[source] >= MAX_PER_SOURCE:
            continue
        counts[source] += 1
        result.append(normalize_skill(skill))
        if len(result) == limit:
            break
    return result


def build_payload(skills: list[dict]) -> dict:
    return {
        "updatedAt": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds"),
        "source": {"name": "Skills.sh"},
        "methodology": "按本周安装量排序；官方榜使用目录官方标记，社区榜仅收录总安装量≥10万且本周≥1000的 Skill",
        "official": top_skills(skills, official=True, limit=OFFICIAL_LIMIT),
        "community": top_skills(skills, official=False, limit=COMMUNITY_LIMIT),
    }


def fetch_html() -> str:
    process = subprocess.run(
        ["curl", "-fsSL", "--retry", "2", "--connect-timeout", "15", "--max-time", "45", SOURCE_URL],
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
    write_json(args.output, payload)
    print(f"updated {len(payload['official']) + len(payload['community'])} skills -> {args.output}")


if __name__ == "__main__":
    main()
