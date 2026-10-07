"""
优化天幕图：PNG(1536x1024, ~2MB) → JPG(2048x1024, ~200KB)

为什么：
- 天幕贴到 SphereGeometry 上，用 2:1 等距柱状构图更契合球面 UV；
- 原 PNG 每张 ~2MB，19 张首次加载会很慢，演示时是硬伤；
- 这类氛围背景用 JPEG q88 肉眼几乎无损，体积降到 1/10。

用法： python optimize-sky.py
产物： assets/sky/*.jpg（保留原 png 不删，便于回退）
"""
import glob
import os
from PIL import Image

SRC_DIR = os.path.join(os.path.dirname(__file__), '..', 'assets', 'sky')
TARGET_W, TARGET_H = 2048, 1024   # 2:1 等距柱状
QUALITY = 88


def main():
    files = sorted(glob.glob(os.path.join(SRC_DIR, '*.png')))
    total_before = 0
    total_after = 0
    for f in files:
        base = os.path.splitext(os.path.basename(f))[0]
        out = os.path.join(SRC_DIR, base + '.jpg')
        before = os.path.getsize(f)
        total_before += before

        img = Image.open(f).convert('RGB')
        # 先按 2:1 中心裁剪（原图 3:2，裁掉上下），再缩放到 2048x1024
        w, h = img.size
        target_ratio = TARGET_W / TARGET_H   # 2.0
        cur_ratio = w / h
        if cur_ratio > target_ratio:
            new_w = int(h * target_ratio)
            left = (w - new_w) // 2
            img = img.crop((left, 0, left + new_w, h))
        else:
            new_h = int(w / target_ratio)
            top = (h - new_h) // 2
            img = img.crop((0, top, w, top + new_h))

        img = img.resize((TARGET_W, TARGET_H), Image.LANCZOS)
        img.save(out, 'JPEG', quality=QUALITY, optimize=True, progressive=True)
        after = os.path.getsize(out)
        total_after += after
        print(f'{base:24s} {before//1024:5d}KB -> {after//1024:4d}KB')

    print(f'--- total {total_before//1024//1024}MB -> {total_after//1024//1024}MB '
          f'({len(files)} files) ---')


if __name__ == '__main__':
    main()
