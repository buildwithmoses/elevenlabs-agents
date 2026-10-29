#!/usr/bin/env python3
"""Render one 1280x720 title card PNG per segment (ffmpeg on this machine has no drawtext).
usage: python3 -I cards.py <videos.json> <out_dir>"""
import json, sys, os
from PIL import Image, ImageDraw, ImageFont

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
REG = "/System/Library/Fonts/Supplemental/Arial.ttf"
for v in json.load(open(src))["videos"]:
    for i, seg in enumerate(v["segments"]):
        img = Image.new("RGB", (1280, 720), (243, 244, 242))
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, 1280, 64], fill=(46, 94, 86))
        d.text((40, 16), "Riverbend Physical Therapy  ·  Home exercise", font=ImageFont.truetype(REG, 28), fill=(255, 255, 255))
        lines = seg["card"]
        y = 300 - 60 * (len(lines) - 1)
        for j, line in enumerate(lines):
            f = ImageFont.truetype(BOLD if j == 0 else REG, 76 if j == 0 else 60)
            w = d.textlength(line, font=f)
            color = (154, 59, 46) if "pain" in line.lower() or "LEFT" in line else (22, 26, 26)
            d.text(((1280 - w) / 2, y), line, font=f, fill=color)
            y += 120
        d.text((40, 670), "Fictional demo video", font=ImageFont.truetype(REG, 22), fill=(91, 100, 98))
        img.save(os.path.join(out, f"{v['id']}-{i:02d}.png"))
print("cards ok")
