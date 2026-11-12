"""Builds the app icon from build/icon-source.png: the supplied design (a
video call whose speech becomes a transcript and a chart, on an orange
tile), cut out along its rounded corners. Its artwork, colours and shading
are used as they are; this only sizes it.

The tile is placed with a small margin, like other app icons, and every size
uses the same picture. Writes build/icon.png (1024 px) plus icon.ico and
icon.icns, and public/favicon.png for the page.
"""
from pathlib import Path
from PIL import Image

SIZE = 1024
MARGIN = 40                     # transparent margin around the tile at 1024 px
HERE = Path(__file__).parent


def compose():
    tile = Image.open(HERE / "icon-source.png").convert("RGBA")
    side = SIZE - 2 * MARGIN
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.alpha_composite(tile.resize((side, side), Image.LANCZOS), (MARGIN, MARGIN))
    return canvas


if __name__ == "__main__":
    big = compose()
    big.save(HERE / "icon.png")
    ico = [big.resize((s, s), Image.LANCZOS) for s in (16, 24, 32, 48, 64, 128, 256)]
    ico[-1].save(HERE / "icon.ico", sizes=[im.size for im in ico], append_images=ico[:-1])
    big.save(HERE / "icon.icns")
    big.resize((64, 64), Image.LANCZOS).save(HERE.parent / "public" / "favicon.png")
    print(HERE / "icon.png", HERE / "icon.ico", HERE / "icon.icns", HERE.parent / "public" / "favicon.png")
