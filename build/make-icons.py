"""生成工资小组件图标（PNG + ICO）。"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
ASSETS.mkdir(exist_ok=True)

SIZE = 256
MARGIN = 10
RADIUS = 58


def linear_gradient(size, top, bottom):
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    px = img.load()
    for y in range(size[1]):
        t = y / max(1, size[1] - 1)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(size[0]):
            px[x, y] = (*color, 255)
    return img


def main():
    base = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (MARGIN, MARGIN, SIZE - MARGIN, SIZE - MARGIN), radius=RADIUS, fill=255
    )

    gradient = linear_gradient((SIZE, SIZE), (253, 186, 116), (249, 115, 22))
    base.paste(gradient, (0, 0), mask)

    # 左上角高光
    gloss = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gloss)
    gd.ellipse((-70, -150, 210, 110), fill=(255, 255, 255, 34))
    gloss.putalpha(Image.composite(gloss.getchannel("A"), Image.new("L", (SIZE, SIZE), 0), mask))
    base = Image.alpha_composite(base, gloss)

    draw = ImageDraw.Draw(base)
    font = ImageFont.truetype("C:/Windows/Fonts/seguibl.ttf", 150)
    text = "¥"
    box = draw.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    tx = (SIZE - tw) / 2 - box[0]
    ty = (SIZE - th) / 2 - box[1] - 4
    # 文字阴影 + 主文字
    draw.text((tx + 2, ty + 3), text, font=font, fill=(3, 58, 40, 70))
    draw.text((tx, ty), text, font=font, fill=(255, 255, 255, 255))

    base.save(ASSETS / "icon.png")
    base.save(
        ASSETS / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("icons written to", ASSETS)


if __name__ == "__main__":
    main()
