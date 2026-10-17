# -*- coding: utf-8 -*-
# Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
"""程序化绘制几何风格的 Ponko 立绘（5 种表情），用于 charpack 素材管线。

为什么不用 AI 立绘直接缩：
  角色面板只给 **28 列** ≈ 28 x 38 个颜色采样。写实立绘的渐变、发丝、细勾线在这个尺度上
  会糊成一团；而 **大色块 + 硬边** 的扁平几何图能被稳定采样下来 —— 这正是早期那个
  占位角色看起来"更清楚"的原因，跟画得好不好看无关。

这份脚本按立绘（桌面 ph/）的真实配色重画一版几何版 Ponko：
  浅蓝白渐变长发 / 琥珀色眼睛 / 白色科技感衣装 + 藏青描边 / 白丝 + 藏青鞋。
头身比走 Q 版（头大、五官大），保证 28 列下脸还能认出形状。

用法：
    python tools/make_ponko_geo.py                     # 输出 characters/ponko/src
    python tools/make_ponko_geo.py --out D:/tmp/ponko  # 指定输出目录
之后照常：
    python tools/charpack.py --src <out> --out <frames> --cols 48 --charset block --emit-pack
"""
import argparse
import os

from PIL import Image, ImageDraw, ImageFilter

W, H = 480, 640

# ── 配色：从桌面 ph/idle.png 采样（浅蓝白长发 + 琥珀眼）──
# 注意：立绘本身非常淡（大面积近白），而面板底色是深蓝 —— 近白在深底上会糊成一团。
# 所以这里**刻意压暗、加对比**（发色蓝一点、后发/描边明显更深），换取 28 列下的可辨识度。
HAIR_HI = (232, 238, 250)     # 发顶浅色
HAIR_MID = (156, 178, 222)    # 发中段（藕荷蓝）
HAIR_LO = (104, 130, 188)     # 发梢（雾蓝）
HAIR_DARK = (58, 76, 126)     # 后发 / 轮廓（明显压深，用来把人物从底色里"切"出来）
SKIN = (254, 236, 226)
SKIN_SH = (234, 202, 190)
EYE = (247, 172, 74)          # 琥珀
EYE_DEEP = (188, 74, 34)      # 虹膜下缘（铁锈橙）
LINE = (34, 30, 46)           # 描边 / 瞳孔
DRESS = (240, 244, 251)
DRESS_SH = (196, 204, 230)
TRIM = (56, 58, 110)          # 藏青（领口 / 裙边 / 鞋）
ACCENT = (120, 142, 194)
BLUSH = (243, 160, 160)
STOCK = (226, 234, 248)       # 白丝
MOUTH = (146, 66, 78)


def vgrad(w, h, c1, c2):
    img = Image.new("RGBA", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        c = tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3)) + (255,)
        d.line([(0, y), (w, y)], fill=c)
    return img


def grad_shape(size, c1, c2, draw_fn):
    """透明画布上按 draw_fn 生成带竖直渐变的形状"""
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    mask = Image.new("L", size, 0)
    draw_fn(ImageDraw.Draw(mask))
    canvas.paste(vgrad(size[0], size[1], c1, c2), (0, 0), mask)
    return canvas


def draw_body(d):
    """裙装 + 手臂 + 腿 + 鞋（都压在头发下面）。

    刻意**少细节**：28 列下面板只给 28x38 个颜色采样，任何细于 1 格的线都会变成噪点。
    所以全身只留 4 个色块：白裙 / 藏青领 / 藏青裙边 / 白丝 + 藏青鞋。
    """
    # 裙身（梯形）—— 带深色描边，把白裙从白丝/皮肤里切出来
    d.polygon([(176, 350), (304, 350), (338, 486), (322, 566), (158, 566), (142, 486)],
              fill=DRESS, outline=HAIR_DARK, width=4)
    # 领口（藏青）—— 小 V 领，别做成一大块（不然像胡子）
    d.polygon([(208, 356), (272, 356), (264, 388), (240, 402), (216, 388)], fill=TRIM)
    # 裙摆的藏青边（一整条，够粗）
    d.polygon([(324, 566), (156, 566), (154, 540), (326, 540)], fill=TRIM)
    # 手臂
    d.ellipse([118, 352, 178, 488], fill=DRESS, outline=HAIR_DARK, width=4)      # 袖
    d.ellipse([302, 352, 362, 488], fill=DRESS, outline=HAIR_DARK, width=4)
    d.ellipse([126, 436, 172, 488], fill=SKIN)                                   # 手
    d.ellipse([308, 436, 354, 488], fill=SKIN)
    # 腿（白丝）+ 鞋
    d.rounded_rectangle([200, 550, 232, 614], 12, fill=STOCK, outline=HAIR_DARK, width=3)
    d.rounded_rectangle([248, 550, 280, 614], 12, fill=STOCK, outline=HAIR_DARK, width=3)
    d.ellipse([182, 598, 246, 634], fill=TRIM)
    d.ellipse([234, 598, 298, 634], fill=TRIM)


def draw_face(d, mood):
    ex_l, ex_r, ey = 194, 286, 234
    for cx in (ex_l, ex_r):
        if mood == "sleepy":
            # 闭眼：一段上凸的弧
            d.arc([cx - 32, ey - 26, cx + 32, ey + 28], 200, 340, fill=LINE, width=10)
        elif mood == "error":
            # 泪眼：大眼 + 下坠的深橙
            d.ellipse([cx - 30, ey - 34, cx + 30, ey + 34], fill=LINE)
            d.ellipse([cx - 23, ey - 26, cx + 23, ey + 28], fill=EYE)
            d.ellipse([cx - 23, ey + 2, cx + 23, ey + 28], fill=EYE_DEEP)
            d.ellipse([cx - 16, ey - 17, cx - 3, ey - 4], fill=(255, 255, 255))
        else:
            big = (mood == "streaming")
            rx, ry = (33, 36) if big else (30, 33)
            d.ellipse([cx - rx, ey - ry, cx + rx, ey + ry], fill=LINE)       # 外描边（够粗）
            d.ellipse([cx - rx + 5, ey - ry + 4, cx + rx - 5, ey + ry - 4], fill=EYE)
            d.ellipse([cx - rx + 5, ey + 2, cx + rx - 5, ey + ry - 4], fill=EYE_DEEP)   # 虹膜下缘
            d.ellipse([cx - rx + 5, ey - ry + 4, cx + rx - 5, ey + 8], fill=EYE)
            d.ellipse([cx - rx + 9, ey - ry + 9, cx - rx + 21, ey - ry + 21], fill=(255, 255, 255))

    # 腮红
    if mood in ("idle", "streaming", "thinking"):
        d.ellipse([146, 268, 190, 290], fill=BLUSH)
        d.ellipse([290, 268, 334, 290], fill=BLUSH)

    # 嘴
    if mood == "streaming":
        d.ellipse([222, 284, 258, 312], fill=MOUTH)
    elif mood == "error":
        d.arc([214, 296, 266, 326], 200, 340, fill=MOUTH, width=8)
    elif mood == "sleepy":
        d.ellipse([230, 290, 250, 304], fill=MOUTH)
    elif mood == "thinking":
        d.arc([222, 288, 258, 310], 200, 340, fill=MOUTH, width=7)
    else:
        d.arc([216, 278, 264, 310], 20, 160, fill=MOUTH, width=7)


def draw_decoration(img, mood):
    d = ImageDraw.Draw(img)
    if mood == "thinking":
        for x, y, r in ((396, 172, 14), (428, 140, 18), (462, 104, 23)):
            d.ellipse([x - r, y - r, x + r, y + r], fill=(214, 232, 252))
    elif mood == "streaming":
        for x, y, s in ((78, 156, 17), (392, 200, 14), (58, 268, 12)):
            d.polygon([(x, y - s), (x + s * 0.32, y - s * 0.32), (x + s, y),
                       (x + s * 0.32, y + s * 0.32), (x, y + s),
                       (x - s * 0.32, y + s * 0.32), (x - s, y),
                       (x - s * 0.32, y - s * 0.32)], fill=(255, 226, 146))
    elif mood == "sleepy":
        for x, y, s in ((392, 128, 24), (352, 168, 17), (322, 200, 12)):
            w = max(5, s // 4)
            d.line([(x - s, y - s), (x + s, y - s)], fill=(150, 190, 250), width=w)
            d.line([(x + s, y - s), (x - s, y + s)], fill=(150, 190, 250), width=w)
            d.line([(x - s, y + s), (x + s, y + s)], fill=(150, 190, 250), width=w)


def make(mood):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))

    # ── 后发（轮廓 + 两束垂到腰的长发）──
    # 先铺一层压深的"影子轮廓"：28 列下它是把人物从深底里切出来的关键
    d = ImageDraw.Draw(img)
    d.ellipse([80, 46, 400, 414], fill=HAIR_DARK)
    for cx, sgn in ((92, -1), (388, 1)):
        t = grad_shape((W, H), HAIR_MID, HAIR_LO,
                       lambda dd, cx=cx, sgn=sgn: dd.polygon(
                           [(cx - 58, 160), (cx + 58, 160),
                            (cx + 68, 320), (cx + 46, 476),
                            (cx + 16, 548), (cx - 22, 476),
                            (cx - 66, 320)]))
        img.alpha_composite(t)
    # 后发（发尾在身后铺开）
    back = grad_shape((W, H), HAIR_MID, HAIR_LO,
                      lambda dd: dd.polygon([(116, 250), (364, 250), (398, 478), (82, 478)]))
    img.alpha_composite(back)

    # ── 身体 ──
    draw_body(d)

    # ── 头 ──
    # 头的影子轮廓（略大一圈的深色），保证脸/发从后发里也分得开
    d.ellipse([104, 52, 376, 358], fill=HAIR_DARK)
    head = grad_shape((W, H), HAIR_HI, HAIR_MID, lambda dd: dd.ellipse([112, 60, 368, 350]))
    img.alpha_composite(head)
    d = ImageDraw.Draw(img)
    d.ellipse([150, 122, 330, 322], fill=SKIN)                        # 脸
    d.chord([152, 130, 328, 300], 200, 340, fill=SKIN_SH)             # 下巴阴影
    d.ellipse([146, 118, 334, 306], fill=SKIN)
    # 刘海（两层，做出层次）
    d.chord([110, 60, 370, 322], 180, 360, fill=HAIR_HI)
    d.chord([128, 68, 352, 288], 180, 360, fill=(226, 234, 248))
    # 鬓角两缕
    d.polygon([(150, 150), (178, 150), (172, 302), (146, 302)], fill=HAIR_MID)
    d.polygon([(302, 150), (330, 150), (334, 302), (308, 302)], fill=HAIR_MID)
    # 呆毛
    d.polygon([(232, 62), (244, 8), (268, 46), (250, 62)], fill=HAIR_MID)

    draw_face(d, mood)
    draw_decoration(img, mood)

    # 轻微柔化：硬边直接 17 倍降采样会有振铃，先糊一点点再交给 charpack 的 LANCZOS
    return img.filter(ImageFilter.GaussianBlur(1.1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                  "..", "characters", "ponko", "src"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    for mood in ("idle", "thinking", "streaming", "sleepy", "error"):
        p = os.path.join(args.out, mood + ".png")
        make(mood).save(p)
        print("wrote", os.path.normpath(p))


if __name__ == "__main__":
    main()
