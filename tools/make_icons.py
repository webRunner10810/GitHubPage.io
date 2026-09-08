#!/usr/bin/env python3
"""Generate the PWA icon set for Summary.

Pure standard library (zlib + struct) so the icons can be regenerated in any
environment without installing an imaging package.

Usage: python3 tools/make_icons.py
"""
import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "icons")

# Brand gradient: violet -> cyan, matching --accent / --accent-2 in css/app.css
C1 = (124, 92, 255)
C2 = (34, 211, 238)
INK = (10, 14, 20)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_box_alpha(x, y, size, inset, radius):
    """Anti-aliased coverage of a rounded square inset into a `size` canvas."""
    left, top = inset, inset
    right, bottom = size - inset, size - inset
    # Distance from the rounded-rect boundary (negative inside).
    cx = min(max(x, left + radius), right - radius)
    cy = min(max(y, top + radius), bottom - radius)
    d = math.hypot(x - cx, y - cy) - radius
    return max(0.0, min(1.0, 0.5 - d))


def bars_alpha(x, y, size, inset):
    """A centred audio-waveform glyph: five rounded bars of varying height."""
    span = size - inset * 2
    heights = (0.34, 0.62, 1.0, 0.70, 0.42)
    bar_w = span * 0.088
    gap = span * 0.062
    total = len(heights) * bar_w + (len(heights) - 1) * gap
    start = inset + (span - total) / 2
    mid = size / 2
    best = 0.0
    for i, h in enumerate(heights):
        bx = start + i * (bar_w + gap)
        half = span * 0.30 * h
        # Rounded capsule around the bar.
        dx = abs(x - (bx + bar_w / 2)) - (bar_w / 2 - bar_w / 2)
        dy = abs(y - mid) - max(0.0, half - bar_w / 2)
        d = math.hypot(max(dx, 0.0), max(dy, 0.0)) + min(max(dx, dy), 0.0) - bar_w / 2
        best = max(best, max(0.0, min(1.0, 0.5 - d)))
    return best


def render(size, maskable=False):
    # Maskable icons must keep their content inside a 40% safe circle.
    inset = size * (0.16 if maskable else 0.06)
    glyph_inset = size * (0.34 if maskable else 0.26)
    radius = (size - inset * 2) * (0.5 if maskable else 0.235)
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # PNG filter type 0 for this scanline
        for x in range(size):
            px, py = x + 0.5, y + 0.5
            plate = rounded_box_alpha(px, py, size, inset, radius)
            t = (px + py) / (2 * size)
            base = lerp(C1, C2, t)
            glyph = bars_alpha(px, py, size, glyph_inset) * plate
            rgb = tuple(round(base[i] * (1 - glyph) + INK[i] * glyph) for i in range(3))
            rows += bytes((rgb[0], rgb[1], rgb[2], round(255 * plate)))
    return bytes(rows)


def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, size, raw):
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(png)
    return len(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    targets = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, True),
    ]
    for name, size, maskable in targets:
        n = write_png(os.path.join(OUT_DIR, name), size, render(size, maskable))
        print("wrote %-26s %4dpx %6d bytes" % (name, size, n))


if __name__ == "__main__":
    main()
