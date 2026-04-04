#!/usr/bin/env python3
import argparse
import json
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def load_font() -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        '/System/Library/Fonts/PingFang.ttc',
        '/System/Library/Fonts/Hiragino Sans GB.ttc',
        '/System/Library/Fonts/STHeiti Medium.ttc',
        '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    ]
    for candidate in candidates:
        path = Path(candidate)
        if not path.exists():
            continue
        try:
            return ImageFont.truetype(str(path), 22)
        except Exception:
            continue
    return ImageFont.load_default()


def to_lines(payload: dict, title: str) -> list[str]:
    lines: list[str] = []
    lines.append(title)
    lines.append('')
    lines.append(f"Step: {payload.get('step')}")
    lines.append(f"Prompt: {payload.get('prompt', '')}")

    metadata = payload.get('metadata') or {}
    lines.append(f"SelectedTags: {metadata.get('selectedTags', [])}")
    lines.append(f"RankingIds: {metadata.get('rankingIds', [])}")
    lines.append(f"HistoricalBlockIds: {payload.get('historicalBlockIds', [])}")
    lines.append(f"WorkingSetBlockIds: {payload.get('workingSetBlockIds', [])}")

    checks = payload.get('orderingChecks') or {}
    lines.append(f"Ordering.rankedTaskBlocksChronological: {checks.get('rankedTaskBlocksChronological')}")
    lines.append(f"Ordering.historicalIdsChronological: {checks.get('historicalIdsChronological')}")
    lines.append('')

    hit_checks = payload.get('hitChecks') or {}
    must_include = hit_checks.get('mustInclude') or []
    must_exclude = hit_checks.get('mustExclude') or []
    if must_include or must_exclude:
      lines.append('Hit Checks:')
      for item in must_include:
          lines.append(f"- include[{item.get('needle')}]: hit={item.get('hit')}")
      for item in must_exclude:
          lines.append(f"- exclude[{item.get('needle')}]: hit={item.get('hit')}")
      lines.append('')

    lines.append('Included Task Blocks:')
    for block in payload.get('rankedTaskBlocks', []) or []:
        start = block.get('startTimeIso')
        block_id = block.get('id')
        topic = block.get('topic')
        tags = block.get('tags')
        first_user = block.get('firstUser')
        lines.append(f"- {block_id} | {start} | topic={topic} | tags={tags}")
        lines.append(f"  firstUser: {first_user}")

    lines.append('')
    lines.append('Message Preview:')
    for msg in payload.get('messagePreview', []) or []:
        role = msg.get('role')
        content = msg.get('content')
        lines.append(f"- [{role}] {content}")

    wrapped: list[str] = []
    for line in lines:
        if len(line) <= 110:
            wrapped.append(line)
            continue
        wrapped.extend(textwrap.wrap(line, width=110, break_long_words=False, break_on_hyphens=False))

    return wrapped


def render(lines: list[str], out_path: Path) -> None:
    font = load_font()
    padding = 24
    line_height = 32 if hasattr(font, 'size') else 18

    max_width = 0
    for line in lines:
        bbox = font.getbbox(line)
        width = bbox[2] - bbox[0]
        max_width = max(max_width, width)

    width = max(1200, max_width + padding * 2)
    height = max(700, padding * 2 + line_height * len(lines))

    img = Image.new('RGB', (width, height), color=(18, 20, 24))
    draw = ImageDraw.Draw(img)

    y = padding
    for line in lines:
        draw.text((padding, y), line, font=font, fill=(230, 233, 238))
        y += line_height

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path)


def main() -> None:
    parser = argparse.ArgumentParser(description='Render context rebuild evidence screenshot from JSON')
    parser.add_argument('--input', required=True, help='Input JSON file path')
    parser.add_argument('--output', required=True, help='Output PNG file path')
    parser.add_argument('--title', required=True, help='Screenshot title')
    args = parser.parse_args()

    payload = json.loads(Path(args.input).read_text(encoding='utf-8'))
    lines = to_lines(payload, args.title)
    render(lines, Path(args.output))


if __name__ == '__main__':
    main()
