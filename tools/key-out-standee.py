"""
把纯白/纯色背景的立绘抠成透明 PNG（边缘连通洪泛，保护主体内部浅色）。
纯 PIL 实现，不依赖 numpy/scipy（venv 装 scipy 太慢，网络受限环境直接用这个）。
用法: python key-out-standee.py <in.png> <out.png>
"""
import sys
from PIL import Image, ImageFilter, ImageDraw

def main(src, dst, thresh=238, inner_area=2500):
    im = Image.open(src).convert("RGB")
    w, h = im.size

    # 近白掩码：近白=255，其他=0
    gray = im.convert("L")
    mask = gray.point(lambda v: 255 if v >= thresh else 0)

    # 从 4 角 + 4 边中点 floodfill：与边缘连通的近白区域 255 -> 128
    # 只剔除与边缘连通的背景，主体内部的浅色（念珠、铃铛）不受影响
    seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
             (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
    for s in seeds:
        if mask.getpixel(s) == 255:
            ImageDraw.floodfill(mask, s, 128, thresh=30)

    # 128 = 边缘背景已剔除。剩余 255 里还混着两种东西：
    #   - 主体内部的大块镂空白（两腿之间的楔形等）→ 也要透明
    #   - 主体浅色小件（骷髅念珠等）→ 必须保留
    # 用"逐块 fill + 面积判断"区分：每发现一块 255 区域就 fill 成递增标记值，
    # histogram 算出各块面积，大块(>2500px)判为镂空、小块保留。
    hist = mask.histogram()
    marks = {}
    next_mark = 100
    for y in range(0, h, 12):
        for x in range(0, w, 12):
            if mask.getpixel((x, y)) == 255:
                before = mask.histogram()[255]
                ImageDraw.floodfill(mask, (x, y), next_mark, thresh=0)
                after = mask.histogram()[255]
                marks[next_mark] = before - after
                next_mark += 1
                if next_mark > 250:
                    break
    # LUT：背景(128 或大块标记) -> 0，其余 -> 255
    lut = [255] * 256
    lut[128] = 0
    for v, area in marks.items():
        if area > inner_area:
            lut[v] = 0
    alpha = mask.point(lut)
    # 边缘羽化：收一档 + 轻微模糊，抗白边
    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.2))

    out = im.convert("RGBA")
    out.putalpha(alpha)

    # 裁到主体包围盒 + 12px 边距
    bbox = alpha.getbbox()
    if bbox:
        l, t, r, b = bbox
        pad = 12
        l, t = max(0, l - pad), max(0, t - pad)
        r, b = min(w, r + pad), min(h, b + pad)
        out = out.crop((l, t, r, b))
    out.save(dst)
    print("saved:", dst, out.size)

if __name__ == "__main__":
    # 可选第三参：内部白区面积阈值（默认 2500；樱花树这类枝间空隙多的用小值如 400）
    ia = int(sys.argv[3]) if len(sys.argv) > 3 else 2500
    main(sys.argv[1], sys.argv[2], inner_area=ia)
