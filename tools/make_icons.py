"""Draws the app icons (PNG) with plain Python — no extra libraries needed.

Run:  python3 tools/make_icons.py
"""
import math
import struct
import zlib
from pathlib import Path

NAVY = (20, 33, 61)
GOLD = (233, 196, 106)
GOLD_DARK = (196, 152, 62)
RED = (226, 72, 61)
WHITE = (255, 255, 255)


def colour_at(x, y):
    """Colour of one point; x, y run 0..1 across the icon."""
    cx, cy, r = 0.5, 0.5, 0.36
    dx, dy = x - cx, y - cy
    d = math.hypot(dx, dy)
    c = NAVY
    if d < r:
        # Globe: gold, with "scratched off" patches showing darker gold
        c = GOLD
        lat_band = math.sin((dy / r) * 5.0)
        lon_band = math.sin((dx / math.sqrt(max(r * r - dy * dy, 1e-6))) * 4.0)
        if lat_band > 0.55 or lon_band > 0.75:
            c = GOLD_DARK
    # Route: a wavy red line across the globe, with a white edge
    ry = 0.56 + 0.08 * math.sin((x - 0.15) * 9.0)
    dist = abs(y - ry)
    if 0.17 < x < 0.83:
        if dist < 0.034:
            c = WHITE
        if dist < 0.022:
            c = RED
    # Start and end dots
    for px in (0.17, 0.83):
        py = 0.56 + 0.08 * math.sin((px - 0.15) * 9.0)
        if math.hypot(x - px, y - py) < 0.05:
            c = WHITE
        if math.hypot(x - px, y - py) < 0.035:
            c = RED
    return c


def render(size, ss=3):
    rows = []
    for j in range(size):
        row = bytearray([0])  # PNG filter byte
        for i in range(size):
            acc = [0, 0, 0]
            for a in range(ss):
                for b in range(ss):
                    col = colour_at((i + (a + 0.5) / ss) / size, (j + (b + 0.5) / ss) / size)
                    for k in range(3):
                        acc[k] += col[k]
            row += bytes(v // (ss * ss) for v in acc)
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


out = Path(__file__).resolve().parent.parent / "icons"
out.mkdir(exist_ok=True)
for name, size in [("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)]:
    (out / name).write_bytes(render(size))
    print("wrote", out / name)
