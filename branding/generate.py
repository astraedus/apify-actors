#!/usr/bin/env python3
"""Generate the store icon family for the three Apify actors.

Hand-written SVG (no fonts, no external assets) -> rendered to PNG via
cairosvg -> assembled into a contact sheet via Pillow.

Run: python3 generate.py
"""
import math
import os

import cairosvg
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.dirname(os.path.abspath(__file__))

CANVAS = 512
PAD = round(CANVAS * 0.12)          # ~61px padding
RX = round(CANVAS * 0.18)           # ~92px corner radius
INK = "#0B1220"
INK_LIGHT = "#141F33"               # vignette highlight, same family, no new hue
WHITE = "#FFFFFF"

ACCENTS = {
    "app-review-monitor": "#F59E0B",
    "fediverse-scraper": "#8B5CF6",
    "tiktok-growth-monitor": "#14B8A6",
}

STROKE = round(CANVAS * 0.085)      # ~44px, safely over the 8% floor

# content box (post-padding)
X0, Y0 = PAD, PAD
X1, Y1 = CANVAS - PAD, CANVAS - PAD
CX, CY = CANVAS / 2, CANVAS / 2


def bg(accent_id):
    """Shared rounded-square background + subtle radial vignette."""
    return f'''  <defs>
    <radialGradient id="vg-{accent_id}" cx="50%" cy="38%" r="65%">
      <stop offset="0%" stop-color="{INK_LIGHT}"/>
      <stop offset="100%" stop-color="{INK}"/>
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="{CANVAS}" height="{CANVAS}" rx="{RX}" ry="{RX}" fill="{INK}"/>
  <rect x="0" y="0" width="{CANVAS}" height="{CANVAS}" rx="{RX}" ry="{RX}" fill="url(#vg-{accent_id})"/>
'''


def svg_wrap(accent_id, glyph):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {CANVAS} {CANVAS}" width="{CANVAS}" height="{CANVAS}">
{bg(accent_id)}{glyph}</svg>
'''


def star_points(cx, cy, r_outer, r_inner, rotation_deg=-90):
    pts = []
    for i in range(10):
        r = r_outer if i % 2 == 0 else r_inner
        angle = math.radians(rotation_deg + i * 36)
        pts.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    return " ".join(f"{x:.2f},{y:.2f}" for x, y in pts)


def glyph_review_monitor(accent):
    # Speech bubble outline (white) + filled 5-point star (accent) inside.
    bw, bh = 336, 232
    bx, by = CX - bw / 2, Y0 + 22
    rx = 50
    tail = f"{bx+58:.1f},{by+bh:.1f} {bx+128:.1f},{by+bh:.1f} {bx+34:.1f},{by+bh+62:.1f}"
    star_cx, star_cy = CX, by + bh / 2 - 4
    star = star_points(star_cx, star_cy, r_outer=86, r_inner=33)
    return f'''  <polygon points="{tail}" fill="{WHITE}"/>
  <rect x="{bx:.1f}" y="{by:.1f}" width="{bw}" height="{bh}" rx="{rx}" ry="{rx}"
        fill="none" stroke="{WHITE}" stroke-width="{STROKE}" stroke-linejoin="round"/>
  <polygon points="{star}" fill="{accent}"/>
'''


def glyph_fediverse(accent):
    # Five nodes joined edge-to-edge in a pentagon; one node accented.
    r = 152
    node_r = 44
    ring = 9  # ink-colored ring so edges appear to pass behind nodes
    verts = []
    for i in range(5):
        angle = math.radians(-90 + i * 72)
        verts.append((CX + r * math.cos(angle), CY + r * math.sin(angle)))
    edges = []
    for i in range(5):
        x1, y1 = verts[i]
        x2, y2 = verts[(i + 1) % 5]
        edges.append(
            f'  <line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="{WHITE}" stroke-width="{STROKE - 4}" stroke-linecap="round"/>'
        )
    nodes = []
    for i, (x, y) in enumerate(verts):
        fill = accent if i == 0 else WHITE
        nodes.append(
            f'  <circle cx="{x:.1f}" cy="{y:.1f}" r="{node_r + ring}" fill="{INK}"/>\n'
            f'  <circle cx="{x:.1f}" cy="{y:.1f}" r="{node_r}" fill="{fill}"/>'
        )
    return "\n".join(edges) + "\n" + "\n".join(nodes) + "\n"


def glyph_tiktok_growth(accent):
    # Rising 3-segment line ending in a play triangle, oriented with the line.
    pts = [(X0 + 30, Y1 - 20), (198, 300), (300, 332), (X1 - 42, 148)]
    path_pts = " ".join(f"{x},{y}" for x, y in pts)
    (ax, ay), (bx, by) = pts[-2], pts[-1]
    angle = math.degrees(math.atan2(by - ay, bx - ax))
    size = 78
    # equilateral-ish play triangle pointing +x, then rotated to the segment angle
    tri = f"{size*0.62:.1f},0 {-size*0.42:.1f},{size*0.5:.1f} {-size*0.42:.1f},{-size*0.5:.1f}"
    return f'''  <polyline points="{path_pts}" fill="none" stroke="{WHITE}"
            stroke-width="{STROKE}" stroke-linecap="round" stroke-linejoin="round"/>
  <g transform="translate({bx},{by}) rotate({angle:.1f})">
    <polygon points="{tri}" fill="{accent}"/>
  </g>
'''


GLYPHS = {
    "app-review-monitor": glyph_review_monitor,
    "fediverse-scraper": glyph_fediverse,
    "tiktok-growth-monitor": glyph_tiktok_growth,
}


def build_all():
    pngs = {}
    for name, accent in ACCENTS.items():
        svg = svg_wrap(name, GLYPHS[name](accent))
        svg_path = os.path.join(OUT, f"{name}.svg")
        with open(svg_path, "w") as f:
            f.write(svg)
        png512 = os.path.join(OUT, f"{name}-512.png")
        png128 = os.path.join(OUT, f"{name}-128.png")
        cairosvg.svg2png(url=svg_path, write_to=png512, output_width=512, output_height=512)
        cairosvg.svg2png(url=svg_path, write_to=png128, output_width=128, output_height=128)
        pngs[name] = png512
        print(f"wrote {svg_path}, {png512}, {png128}")
    return pngs


def contact_sheet(pngs):
    names = list(ACCENTS.keys())
    sizes = [48, 128]
    bgs = [("white", (255, 255, 255)), ("dark", (17, 17, 20))]
    cols = sizes * len(bgs)  # 48/white,128/white,48/dark,128/dark ordering built below
    col_specs = []
    for bg_name, bg_color in bgs:
        for s in sizes:
            col_specs.append((s, bg_name, bg_color))

    label_w = 260
    header_h = 56
    cell_w = 200
    cell_h = 200
    row_label_h = 30

    total_w = label_w + cell_w * len(col_specs)
    total_h = header_h + (cell_h + row_label_h) * len(names)

    sheet = Image.new("RGB", (total_w, total_h), (235, 235, 238))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.load_default(size=18)
        font_small = ImageFont.load_default(size=14)
    except TypeError:
        font = ImageFont.load_default()
        font_small = font

    # header labels
    for i, (s, bg_name, _) in enumerate(col_specs):
        x = label_w + i * cell_w
        draw.text((x + 14, 16), f"{s}px / {bg_name}", fill=(20, 20, 20), font=font_small)

    y = header_h
    for name in names:
        # cells
        for i, (s, bg_name, bg_color) in enumerate(col_specs):
            x = label_w + i * cell_w
            draw.rectangle([x + 10, y + 10, x + cell_w - 10, y + cell_h - 10], fill=bg_color)
            icon = Image.open(pngs[name]).convert("RGBA").resize((s, s), Image.LANCZOS)
            px = x + (cell_w - s) // 2
            py = y + 10 + ((cell_h - 20) - s) // 2
            sheet.paste(icon, (px, py), icon)
        draw.text((16, y + cell_h // 2 - 10), name, fill=(20, 20, 20), font=font)
        y += cell_h + row_label_h

    out_path = os.path.join(OUT, "contact-sheet.png")
    sheet.save(out_path)
    print(f"wrote {out_path}")


if __name__ == "__main__":
    pngs = build_all()
    contact_sheet(pngs)
