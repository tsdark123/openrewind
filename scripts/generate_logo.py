#!/usr/bin/env python3
"""Generate a temporary OpenRewind brand icon and favicon set."""
from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).parent.parent
ICONS_DIR = ROOT / "src-tauri" / "icons"
PUBLIC_DIR = ROOT / "frontend" / "public"

# Brand colors
BLUE = (41, 98, 255)  # #2962ff
WHITE = (255, 255, 255)

SIZE = 1024
RADIUS = 180


def make_source(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded blue square background
    draw.rounded_rectangle((0, 0, size, size), radius=RADIUS, fill=BLUE)

    # Two left-pointing triangles = rewind/fast-backward icon
    cx, cy = size // 2, size // 2
    tri_w, tri_h = 220, 380
    gap = 60
    total_w = tri_w * 2 + gap
    left_tip = cx - total_w // 2
    base_x1 = left_tip + tri_w
    right_tip = base_x1 + gap
    base_x2 = right_tip + tri_w

    top = cy - tri_h // 2
    bot = cy + tri_h // 2

    draw.polygon(
        [(left_tip, cy), (base_x1, top), (base_x1, bot)],
        fill=WHITE,
    )
    draw.polygon(
        [(right_tip, cy), (base_x2, top), (base_x2, bot)],
        fill=WHITE,
    )

    return img


def save_ico(sizes: list[tuple[int, int]], src: Image.Image, dest: Path) -> None:
    frames: list[Image.Image] = []
    for w, h in sizes:
        frame = src.resize((w, h), Image.Resampling.LANCZOS).convert("RGBA")
        frames.append(frame)
    frames[0].save(dest, format="ICO", sizes=sizes, append_images=frames[1:])


def main() -> None:
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)

    source = make_source(SIZE)
    source_path = ICONS_DIR / "icon-source.png"
    source.save(source_path)

    # Frontend favicons (generated from the 1024px master)
    fav32 = source.resize((32, 32), Image.Resampling.LANCZOS)
    fav32.save(PUBLIC_DIR / "favicon-32x32.png")

    fav16 = source.resize((16, 16), Image.Resampling.LANCZOS)
    fav16.save(PUBLIC_DIR / "favicon-16x16.png")

    source.resize((180, 180), Image.Resampling.LANCZOS).save(PUBLIC_DIR / "apple-touch-icon.png")
    source.resize((192, 192), Image.Resampling.LANCZOS).save(PUBLIC_DIR / "android-chrome-192x192.png")
    source.resize((512, 512), Image.Resampling.LANCZOS).save(PUBLIC_DIR / "android-chrome-512x512.png")

    save_ico([(16, 16), (32, 32), (48, 48), (64, 64)], source, PUBLIC_DIR / "favicon.ico")

    print(f"Saved brand source to {source_path}")
    print(f"Saved favicons to {PUBLIC_DIR}")


if __name__ == "__main__":
    main()
