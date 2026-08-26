#!/usr/bin/env python3
"""Generate the macOS app icon (ADR-0012 §3, ARCHITECTURE §13).

The icon is GENERATED rather than committed as an opaque binary, for the same
reason everything else here is reviewable: `icon.icns` is a container of ten
bitmaps that no diff can show you, and an icon nobody can regenerate is an icon
nobody can adjust. This script is the source; the .icns is a build artifact of
it, and both are checked in so a contributor without the toolchain still builds
a signed app that looks right.

It has no dependencies on purpose. This machine has no SVG rasteriser and no
Pillow, and adding either to build a single asset would put a native image
library in the release path of a desktop app that otherwise needs none — so the
PNG bytes are written directly (zlib is stdlib) and the geometry is drawn with
signed distance fields, which give real anti-aliasing from one coverage sample
per pixel. `sips` and `iconutil` (both shipped with macOS) do the downscaling
and the container.

The mark is the app's own design language, not new branding: the drafting
orange and blueprint blue are `--accent` and `--blueprint` from
`renderer/src/styles.css`, and the shape is a node and its two downstream
nodes — the thing the app is for — with orthogonal wires, which read as both a
node editor and a plan drawing.

Deliberately few, large elements. An icon is judged at 16px in a Dock and 32px
in a Finder list; a faithful miniature of the canvas would be mush at both.

Usage:  python3 make-icon.py            # writes icon.icns beside this script
"""

import math
import struct
import subprocess
import sys
import zlib
from pathlib import Path

SIZE = 1024
HERE = Path(__file__).resolve().parent

# --- palette, from renderer/src/styles.css ----------------------------------
BG_TOP = (0x15, 0x1A, 0x21)
BG_BOTTOM = (0x0B, 0x0E, 0x12)
GRID = (0x1C, 0x24, 0x2E)
ACCENT = (0xFF, 0x8A, 0x3D)      # --accent, drafting orange
BLUEPRINT = (0x4C, 0xC2, 0xFF)   # --blueprint

# --- geometry ---------------------------------------------------------------
MARGIN = 96.0
TILE_R = 200.0                   # corner radius of the app tile
# Sized for 16px first, then checked at 1024 — not the other way round. The
# first pass used a 74px node and a 30px wire, which is a half-pixel line in a
# Dock: the glyph turned to mush at the size it is seen at most. Everything
# below is deliberately large and few.
NODE_R = 104.0
WIRE_W = 52.0

LEFT = (300.0, 512.0)
TOP_RIGHT = (724.0, 312.0)
BOT_RIGHT = (724.0, 712.0)
ELBOW_X = 512.0                  # the trunk splits on the tile's centreline


def rounded_rect_sd(px, py, x0, y0, x1, y1, r):
    """Signed distance to a rounded rectangle; negative inside."""
    cx = min(max(px, x0 + r), x1 - r)
    cy = min(max(py, y0 + r), y1 - r)
    return math.hypot(px - cx, py - cy) - r


def segment_sd(px, py, ax, ay, bx, by):
    """Signed distance to a line segment's centreline."""
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    denom = vx * vx + vy * vy
    t = 0.0 if denom == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / denom))
    return math.hypot(wx - t * vx, wy - t * vy)


def coverage(sd):
    """Anti-aliased coverage from a signed distance, in [0, 1]."""
    return min(1.0, max(0.0, 0.5 - sd))


def over(dst, src, a):
    """Source-over composite of an opaque colour at coverage `a`."""
    return tuple(int(round(s * a + d * (1.0 - a))) for d, s in zip(dst, src))


def render():
    x0 = y0 = MARGIN
    x1 = y1 = SIZE - MARGIN
    rows = []

    # The wire path, as segments: trunk out of the left node, a vertical riser,
    # then a run into each right-hand node.
    wires = [
        (LEFT[0], LEFT[1], ELBOW_X, LEFT[1]),
        (ELBOW_X, TOP_RIGHT[1], ELBOW_X, BOT_RIGHT[1]),
        (ELBOW_X, TOP_RIGHT[1], TOP_RIGHT[0], TOP_RIGHT[1]),
        (ELBOW_X, BOT_RIGHT[1], BOT_RIGHT[0], BOT_RIGHT[1]),
    ]

    for y in range(SIZE):
        py = y + 0.5
        row = bytearray()
        row.append(0)  # PNG filter: none
        # Vertical gradient, computed once per scanline.
        t = py / SIZE
        bg = tuple(int(round(a + (b - a) * t)) for a, b in zip(BG_TOP, BG_BOTTOM))

        for x in range(SIZE):
            px = x + 0.5
            tile = coverage(rounded_rect_sd(px, py, x0, y0, x1, y1, TILE_R))
            if tile <= 0.0:
                row.extend((0, 0, 0, 0))
                continue

            rgb = bg

            # Blueprint grid, faint, clipped to the tile.
            gx = min(abs((px - x0) % 128.0), abs(128.0 - (px - x0) % 128.0))
            gy = min(abs((py - y0) % 128.0), abs(128.0 - (py - y0) % 128.0))
            g = coverage(min(gx, gy) - 1.0)
            if g > 0.0:
                rgb = over(rgb, GRID, g * 0.9)

            # Wires under the nodes, so a node's edge stays crisp.
            wsd = min(segment_sd(px, py, *w) for w in wires) - WIRE_W / 2.0
            wc = coverage(wsd)
            if wc > 0.0:
                rgb = over(rgb, ACCENT, wc)

            for centre, colour in ((LEFT, ACCENT), (TOP_RIGHT, BLUEPRINT), (BOT_RIGHT, ACCENT)):
                nc = coverage(math.hypot(px - centre[0], py - centre[1]) - NODE_R)
                if nc > 0.0:
                    rgb = over(rgb, colour, nc)

            row.extend((rgb[0], rgb[1], rgb[2], int(round(255 * tile))))
        rows.append(bytes(row))
    return b"".join(rows)


def write_png(path, raw):
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)  # 8-bit RGBA
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main():
    master = HERE / "icon.png"
    print(f"rendering {SIZE}x{SIZE}…", flush=True)
    write_png(master, render())

    iconset = HERE / "icon.iconset"
    iconset.mkdir(exist_ok=True)
    # The ten entries iconutil expects. @2x is the same pixel count as the next
    # size up, but macOS picks by name, so both must exist.
    for base in (16, 32, 128, 256, 512):
        for scale, suffix in ((1, ""), (2, "@2x")):
            px = base * scale
            out = iconset / f"icon_{base}x{base}{suffix}.png"
            subprocess.run(
                ["sips", "-z", str(px), str(px), str(master), "--out", str(out)],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(HERE / "icon.icns")], check=True)
    print(f"wrote {HERE / 'icon.icns'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
