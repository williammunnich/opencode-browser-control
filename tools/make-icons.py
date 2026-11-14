#!/usr/bin/env python3
"""
@file make-icons.py
Draws the extension's icon and writes it as PNG files in the four sizes Chrome wants
(extension/icons/icon-16.png, -32, -48 and -128). The picture is this project's own: a plain
browser window with a mouse pointer on it, in neutral greys with one accent colour. It is
drawn here from a few shapes, so there is no source image to keep and no drawing program or
extra Python package is needed (only the standard library).

To change the look, edit the colours and shapes below and run this again; the same input
always gives the same files.

@usage python3 tools/make-icons.py
@project opencode-browser-control
@author Claude (Anthropic), written for and prompted by William Munnich
@date Last edited 2026-11-14
"""
import math
import os
import struct
import zlib

# Where the PNG files go: extension/icons, next to this file's folder.
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "extension", "icons")
SIZES = (16, 32, 48, 128)

# ---- Colours (red, green, blue), each 0-255. Change these to restyle the icon. ----
FRAME = (63, 63, 70)       # window outline and title bar: dark neutral grey
PAGE = (250, 250, 250)     # the window's content area: near white
DOT = (161, 161, 170)      # the three small dots in the title bar
POINTER = (37, 99, 235)    # the mouse pointer: the accent colour (same blue as the extension's buttons)
OUTLINE = (255, 255, 255)  # thin edge around the pointer so it stands out on any background

# ---- Shapes, in a square that runs from 0 to 1 in both directions (y grows downwards). ----
WINDOW = (0.05, 0.12, 0.95, 0.80)   # left, top, right, bottom of the browser window
RADIUS = 0.11                       # roundness of its corners
BORDER = 0.06                       # thickness of its outline
TITLE_BAR = 0.19                    # height of the dark bar at the top of the window
# The pointer: an arrow whose tip is the first point, drawn over the lower right of the window.
ARROW = [(0.47, 0.40), (0.47, 0.91), (0.59, 0.80), (0.68, 0.98), (0.77, 0.94), (0.68, 0.76), (0.85, 0.76)]
ARROW_EDGE = 0.035                  # thickness of the light edge around the pointer


def rounded_box_distance(x, y):
    """How far a point is from the edge of the window's rounded rectangle.

    @param x: horizontal position, 0-1
    @param y: vertical position, 0-1
    @return: distance to the edge; negative inside the window, positive outside
    """
    left, top, right, bottom = WINDOW
    # Fold the point into one quarter of the box, measured from the box's centre.
    dx = abs(x - (left + right) / 2) - ((right - left) / 2 - RADIUS)
    dy = abs(y - (top + bottom) / 2) - ((bottom - top) / 2 - RADIUS)
    outside = math.hypot(max(dx, 0), max(dy, 0))
    inside = min(max(dx, dy), 0)
    return outside + inside - RADIUS


def inside_polygon(x, y, points):
    """Whether a point lies inside a polygon (even-odd rule: count edge crossings to the right).

    @param x: horizontal position
    @param y: vertical position
    @param points: the polygon's corners as (x, y) pairs
    @return: True when the point is inside
    """
    inside = False
    for (x1, y1), (x2, y2) in zip(points, points[1:] + points[:1]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def distance_to_polygon_edge(x, y, points):
    """Distance from a point to the nearest edge of a polygon.

    @param x: horizontal position
    @param y: vertical position
    @param points: the polygon's corners as (x, y) pairs
    @return: the distance (never negative)
    """
    best = 9.0
    for (x1, y1), (x2, y2) in zip(points, points[1:] + points[:1]):
        ex, ey = x2 - x1, y2 - y1
        # t = how far along the edge the closest point is, kept between its two ends.
        t = max(0.0, min(1.0, ((x - x1) * ex + (y - y1) * ey) / (ex * ex + ey * ey)))
        best = min(best, math.hypot(x - (x1 + t * ex), y - (y1 + t * ey)))
    return best


def colour_at(x, y, size):
    """The icon's colour at one point: the pointer on top, then the window, else nothing.

    @param x: horizontal position, 0-1
    @param y: vertical position, 0-1
    @param size: the icon's size in pixels (small sizes leave out the title-bar dots)
    @return: (red, green, blue, alpha) with alpha 0 (see-through) or 255
    """
    if inside_polygon(x, y, ARROW):
        return POINTER + (255,)
    if distance_to_polygon_edge(x, y, ARROW) < ARROW_EDGE:
        return OUTLINE + (255,)
    d = rounded_box_distance(x, y)
    if d > 0:
        return (0, 0, 0, 0)
    top = WINDOW[1]
    if d > -BORDER or y < top + TITLE_BAR:
        if size >= 48:  # the dots would be a blur in the small sizes
            for i in range(3):
                if math.hypot(x - (WINDOW[0] + 0.115 + i * 0.085), y - (top + TITLE_BAR / 2 + 0.01)) < 0.027:
                    return DOT + (255,)
        return FRAME + (255,)
    return PAGE + (255,)


def render(size, samples=5):
    """Draws the icon at one size. Each pixel is the average of samples x samples points
    inside it, which gives smooth edges.

    @param size: width and height in pixels
    @param samples: points per pixel in each direction
    @return: the picture as bytes, 4 per pixel (red, green, blue, alpha), row after row
    """
    out = bytearray()
    n = samples * samples
    for py in range(size):
        for px in range(size):
            r = g = b = a = 0
            for sy in range(samples):
                for sx in range(samples):
                    cr, cg, cb, ca = colour_at((px + (sx + 0.5) / samples) / size, (py + (sy + 0.5) / samples) / size, size)
                    # Colour is weighted by alpha so see-through points do not darken the edge.
                    r += cr * ca; g += cg * ca; b += cb * ca; a += ca
            out += bytes((round(r / a), round(g / a), round(b / a), round(a / n)) if a else (0, 0, 0, 0))
    return bytes(out)


def png(size, pixels):
    """Packs a picture into the PNG file format.

    @param size: width and height in pixels
    @param pixels: bytes from render()
    @return: the PNG file's bytes
    """
    def chunk(kind, data):
        """One PNG chunk: length, kind, data, checksum.

        @param kind: 4-letter chunk type as bytes
        @param data: the chunk's content
        @return: the chunk's bytes
        """
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    # Each row starts with a 0 byte ("no filter"). 8 bits per channel, colour type 6 = RGBA.
    rows = b"".join(b"\x00" + pixels[y * size * 4:(y + 1) * size * 4] for y in range(size))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


def main():
    """Writes the four icon files.

    @return: None
    """
    os.makedirs(OUT, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT, f"icon-{size}.png")
        with open(path, "wb") as f:
            f.write(png(size, render(size)))
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
