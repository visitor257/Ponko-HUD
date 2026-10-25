# -*- coding: utf-8 -*-
# Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
"""watermark —— 给立绘写入**构造上不可见**的溯源标记。

写在哪：`alpha == 0` 像素的 RGB 最低位。
全透明像素的颜色不参与任何合成（无论底下是黑、是白、是什么壁纸），
所以改它们**数学上**不可能影响显示 —— 不是"几乎看不出"，是零影响。

存什么：一小段 JSON（作者 / 项目 / 素材名 / 许可路径 / 仓库 / 可见像素的 sha256 前 16 位）
+ CRC32。带上可见像素的哈希，是因为它能发现"脸被换过、水印还留着"这种拼贴。

能扛什么：无损另存、`optimize=True`、git 克隆 / 打包成 zip。
扛不住什么：截图、缩放、裁切、量化（pngquant）、白底压平、转 JPEG —— 全都会把它冲掉。
所以它是**举证与威慑**手段，不是防护手段：证明"这个文件是从本仓库流出去的"，
不能证明"这张画是谁画的"，也追不到具体是谁泄露的。

用法：
    python tools/watermark.py --apply        # 给 characters/*/src/*.png 全部写入（幂等）
    python tools/watermark.py --verify       # 校验：缺失 / CRC 坏 / 内容哈希不符 → 非零退出
    python tools/watermark.py --selfcheck    # 幂等自检：重新算一遍必须是**逐字节相同**
    python tools/watermark.py --strip        # 抹掉标记（透明区的这几位重写成 0）
    python tools/watermark.py --manifest     # 重新生成 characters/MANIFEST.json

素材管线里它是最后一步：`_matte_pack.py --apply` 写完图会自动调 `embed_file`，
所以新加一张图不会漏。**顺序不能反** —— 抠图会重算画幅并把所有图（当前八张）全部重写。
"""
import argparse
import glob
import hashlib
import json
import os
import shutil
import sys
import tempfile
import zlib

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHARS = os.path.join(ROOT, "characters")
MANIFEST = os.path.join(CHARS, "MANIFEST.json")

MAGIC = b"PKWM"
VERSION = 1
MAX_BODY = 512                     # 载荷上限（字节）；实际只用 ~140
REPO = "github.com/visitor257/Ponko-HUD"
COPYRIGHT = "© 2026 visitor257"


# ── 载荷 ────────────────────────────────────────────────────────────────
def visible_hash(arr):
    """可见像素（alpha>0）的哈希：水印里带着它，改图不改水印就能被发现。"""
    vis = arr[arr[:, :, 3] > 0]
    return hashlib.sha256(vis.tobytes()).hexdigest()[:16]


def build_payload(art, vis):
    body = json.dumps(
        {"v": VERSION, "p": "Ponko HUD", "c": COPYRIGHT, "art": art,
         "lic": "characters/LICENSE", "repo": REPO, "h": vis},
        ensure_ascii=False, separators=(",", ":"),
    ).encode("utf-8")
    if len(body) > MAX_BODY:
        raise SystemExit("载荷过长: %d > %d" % (len(body), MAX_BODY))
    return MAGIC + bytes([VERSION]) + len(body).to_bytes(2, "big") + body \
        + zlib.crc32(body).to_bytes(4, "big")


def capacity_bits(arr):
    return int((arr[:, :, 3] == 0).sum()) * 3


def _slot(arr):
    """可用的透明像素（行优先顺序），返回 (扁平化视图, 像素下标数组)。"""
    flat = arr.reshape(-1, 4)
    return flat, np.flatnonzero(flat[:, 3] == 0)


def _clear(arr, nbits):
    flat, idx = _slot(arr)
    n = min(nbits, len(idx) * 3)
    for k in range(n):
        p, ch = idx[k // 3], k % 3
        flat[p, ch] &= 0xFE


def _write(arr, raw):
    bits = np.unpackbits(np.frombuffer(raw, dtype=np.uint8))
    if len(bits) > capacity_bits(arr):
        raise SystemExit("透明区容量不足")
    flat, idx = _slot(arr)
    for k, b in enumerate(bits):
        p, ch = idx[k // 3], k % 3
        flat[p, ch] = (flat[p, ch] & 0xFE) | int(b)
    return len(bits), len({int(idx[k // 3]) for k in range(len(bits))})


def read_payload(arr):
    """返回 (payload dict 或 None, 状态字符串)。"""
    flat, idx = _slot(arr)
    if not len(idx):
        return None, "无透明像素"
    n = min(len(idx) * 3, 8 * (MAX_BODY + 16))
    bits = np.array([flat[idx[k // 3], k % 3] & 1 for k in range(n)], dtype=np.uint8)
    raw = np.packbits(bits).tobytes()
    if raw[:4] != MAGIC:
        return None, "无标记"
    body_len = int.from_bytes(raw[5:7], "big")
    body = raw[7:7 + body_len]
    crc = int.from_bytes(raw[7 + body_len:11 + body_len], "big")
    if len(body) != body_len:
        return None, "截断"
    if zlib.crc32(body) != crc:
        return None, "CRC 不符"
    try:
        return json.loads(body.decode("utf-8")), "ok"
    except Exception:
        return None, "JSON 坏"


# ── 读写 ────────────────────────────────────────────────────────────────
def load(path):
    return np.array(Image.open(path).convert("RGBA"))


def save(arr, path):
    Image.fromarray(arr, "RGBA").save(path)


def embed_file(path, art):
    """给一张图写标记，返回统计。**幂等**：同一张图重复写，字节完全相同。"""
    src = load(path)
    vis = visible_hash(src)
    arr = src.copy()
    raw = build_payload(art, vis)
    _clear(arr, 8 * (MAX_BODY + 16))          # 先清空载荷区（旧标记长短不一）
    nbits, npix = _write(arr, raw)
    save(arr, path)

    out = load(path)
    # 写完立刻自证：可见像素一个都不能变
    diff = int(np.abs(src.astype(np.int16) - out.astype(np.int16))[src[:, :, 3] > 0].max()) \
        if (src[:, :, 3] > 0).any() else 0
    if diff:
        raise SystemExit("可见像素被改动了（差 %d）—— 不该发生" % diff)
    got, st = read_payload(out)
    if st != "ok" or not got or got.get("art") != art:
        raise SystemExit("写后读回失败: %s" % st)
    return {"bits": nbits, "pixels": npix, "delta": os.path.getsize(path)}


def strip_file(path):
    arr = load(path)
    _clear(arr, 8 * (MAX_BODY + 16))
    save(arr, path)
    return read_payload(load(path))[1] == "无标记"


def check_file(path, art):
    """返回 "ok" 或一句失败原因。"""
    arr = load(path)
    got, st = read_payload(arr)
    if st != "ok":
        return st
    if got.get("art") != art:
        return "素材名不符: %s" % got.get("art")
    if got.get("h") != visible_hash(arr):
        return "可见像素被改过（哈希不符）"
    return "ok"


def selftest():
    """拿第一张图做四个反向/正向用例，证明这套东西**真的会报错**，而不是永远绿。"""
    path, art = assets()[0]
    bad = 0

    def say(ok, name, extra=""):
        nonlocal bad
        bad += 0 if ok else 1
        print(f"  {'ok  ' if ok else 'FAIL'} {name}{'' if ok else '   → ' + extra}")

    with tempfile.TemporaryDirectory() as td:
        tmp = os.path.join(td, "a.png")
        shutil.copyfile(path, tmp)
        with open(path, "rb") as f:
            original = f.read()

        say(check_file(tmp, art) == "ok", "原样通过", check_file(tmp, art))

        arr = load(tmp)
        ys, xs = np.nonzero(arr[:, :, 3] > 0)          # 只碰可见像素，模拟"换脸"
        arr[ys[0], xs[0], 0] ^= 0x01
        save(arr, tmp)
        st = check_file(tmp, art)
        say(st != "ok", "改了一个可见像素必须被发现", "居然通过了")
        print(f"       ^ 报的是：{st}")

        shutil.copyfile(path, tmp)
        strip_file(tmp)
        say(check_file(tmp, art) == "无标记", "抹掉后读不到", check_file(tmp, art))

        embed_file(tmp, art)
        with open(tmp, "rb") as f:
            again = f.read()
        say(again == original, "重新写入后与原文件逐字节相同")

        say(check_file(tmp, art) == "ok", "重写后校验通过")
    return bad


def assets():
    """characters/<pack>/src/*.png → (路径, 素材 id)。"""
    out = []
    for p in sorted(glob.glob(os.path.join(CHARS, "*", "src", "*.png"))):
        pack = os.path.basename(os.path.dirname(os.path.dirname(p)))
        out.append((p, "%s/%s" % (pack, os.path.splitext(os.path.basename(p))[0])))
    return out


# ── 清单 ────────────────────────────────────────────────────────────────
def build_manifest():
    files = []
    for path, art in assets():
        with open(path, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
        arr = load(path)
        got, st = read_payload(arr)
        files.append({
            "art": art,
            "path": os.path.relpath(path, ROOT).replace("\\", "/"),
            "bytes": os.path.getsize(path),
            "sha256": digest,
            "visible_sha256_16": visible_hash(arr),
            "watermark": st,
        })
    return {
        "_comment": [
            "由 tools/watermark.py --manifest 生成，请勿手改。",
            "sha256 = 文件字节；visible_sha256_16 = 可见像素（alpha>0）的哈希，同一份值也写在图里的不可见标记中。",
            "两者不一致说明文件被动过（重存无害，改图有害）。",
        ],
        "generated_by": "tools/watermark.py --manifest",
        "files": files,
    }


def write_manifest():
    data = build_manifest()
    with open(MANIFEST, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return data


# ── CLI ─────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="写入标记")
    ap.add_argument("--verify", action="store_true", help="校验标记与内容哈希")
    ap.add_argument("--selfcheck", action="store_true", help="幂等自检（重算须逐字节相同）")
    ap.add_argument("--selftest", action="store_true", help="反向自检（改图必须报错）")
    ap.add_argument("--strip", action="store_true", help="抹掉标记")
    ap.add_argument("--manifest", action="store_true", help="重新生成 characters/MANIFEST.json")
    args = ap.parse_args()
    if not any([args.apply, args.verify, args.selfcheck, args.selftest,
                args.strip, args.manifest]):
        ap.print_help()
        return 1

    items = assets()
    if not items:
        print("没找到 characters/*/src/*.png")
        return 1

    bad = 0
    if args.apply:
        for path, art in items:
            st = embed_file(path, art)
            print(f"  写入 {art:<18} {st['bits']} bit / {st['pixels']} px  {st['delta'] / 1024:.0f}KB")
        write_manifest()
        print("已更新 characters/MANIFEST.json")

    if args.verify:
        for path, art in items:
            st = check_file(path, art)
            if st == "ok":
                got, _ = read_payload(load(path))
                print(f"  ok   {art:<18} v{got.get('v')} {got.get('c')} {got.get('h')}")
            else:
                print(f"  FAIL {art:<18} {st}")
                bad += 1
        if os.path.exists(MANIFEST):
            with open(MANIFEST, encoding="utf-8") as f:
                man = {x["art"]: x for x in json.load(f)["files"]}
            for path, art in items:
                with open(path, "rb") as f:
                    digest = hashlib.sha256(f.read()).hexdigest()
                if man.get(art, {}).get("sha256") != digest:
                    print(f"  FAIL {art:<18} 与 MANIFEST.json 的 sha256 不一致（改图后忘了 --manifest？）")
                    bad += 1
        else:
            print("  FAIL 缺 characters/MANIFEST.json")
            bad += 1

    if args.selfcheck:
        for path, art in items:
            with open(path, "rb") as f:
                before = f.read()
            with tempfile.TemporaryDirectory() as td:
                tmp = os.path.join(td, "a.png")
                with open(tmp, "wb") as f:
                    f.write(before)
                embed_file(tmp, art)
                with open(tmp, "rb") as f:
                    again = f.read()
            same = again == before
            print(f"  {'ok  ' if same else 'FAIL'} {art:<18} 重写后{'逐字节相同' if same else '变了（不幂等）'}")
            bad += 0 if same else 1

    if args.selftest:
        print("反向自检（下面这几条必须报错，否则守卫等于没跑）:")
        bad += selftest()

    if args.strip:
        for path, art in items:
            print(f"  {'ok  ' if strip_file(path) else 'FAIL'} {art:<18} 已抹掉")

    if args.manifest and not args.apply:
        write_manifest()
        print("已更新 characters/MANIFEST.json")

    if bad:
        print(f"\n{bad} 项失败")
        return 1
    print("\n全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
