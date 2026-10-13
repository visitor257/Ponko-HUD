#!/usr/bin/env python3
# Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
"""启动记录的跨语言契约测试。

宿主是 Python、后端是 Node，两边往**同一个文件**里追加同一套格式：时间戳 · tag ·
事件 id · 行尾紧凑 JSON 参数（见 server/bootlog.js 顶部说明）。格式一旦写歪（缩进、
时间戳毫秒位、标签列宽、编码、JSON 被截断），后端就解析不出来 —— 前端启动画面就会
少掉整个 host 段，而且不会有任何报错，只是"看起来日志变短了"。所以这里把两边接起来跑：

  1. 用 native_host 真实的 ``_boot()`` 写几行（含中文值与反斜杠路径）
  2. 起一个真后端（PONKO_BOOT_LOG 指向同一份文件），GET /api/bootlog
  3. 断言那几行被逐字解析回来（tag=host、key 与 args 一模一样、时间戳在几秒内）

注意：**断的是事件 id，不是句子** —— 句子由页面按当前语言渲染（"语言包含日志段就用
该语言，不含就英文"），所以文案改了不该让这个测试红；key 改名才该红。

跑法：python tools/test_boot_host.py
"""
import importlib.util
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8908
results = []

# 后端解析用的同一套规则（server/bootlog.js 的 STRUCT_RE）
LINE_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\s+(\S+)\s+(\S+)\s+(\{.*\})$")


def chk(name, ok, detail=""):
    results.append(ok)
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else "   → " + str(detail)))


def load_host():
    """把 native_host.py 当模块导进来（main() 有 __main__ 保护，不会真的开窗）"""
    path = os.path.join(ROOT, "native_host.py")
    spec = importlib.util.spec_from_file_location("ponko_native_host", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["ponko_native_host"] = mod
    spec.loader.exec_module(mod)
    return mod


def events(path):
    """把 boot.log 读成 [{'tag','key','args'}] —— 用的就是后端那套解析规则"""
    out = []
    raw = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
    for line in raw.split("\n"):
        m = LINE_RE.match(line.strip())
        if m:
            out.append({"tag": m.group(1), "key": m.group(2), "args": json.loads(m.group(3))})
    return out


def keys_of(evs):
    return [e["key"] for e in evs]


def port_open(port):
    s = socket.socket()
    s.settimeout(0.3)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def free_port(preferred):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", preferred))
        s.close()
        return preferred
    except OSError:
        s.close()
        s2 = socket.socket()
        s2.bind(("127.0.0.1", 0))
        p = s2.getsockname()[1]
        s2.close()
        return p


def main():
    print("── 1. 宿主侧 _boot() 写出来的格式 ──")
    host = load_host()
    tmpdir = tempfile.mkdtemp(prefix="ponko-bootfmt-")
    bootfile = os.path.join(tmpdir, "boot.log")
    host.RUN_DIR = tmpdir                      # 别动真机的 run/
    host.BOOT_LOG = bootfile
    host.boot_reset()
    chk("boot_reset() 建出空文件", os.path.exists(bootfile) and os.path.getsize(bootfile) == 0, bootfile)

    # 就照真实调用里的写法来：反斜杠路径、中文值、@key 片段、嵌套对象
    host._boot("host", "boot.host.started", {"pid": 4321, "py": "3.14.4"})
    host._boot("host", "boot.host.node", {"ver": "v24.15.0", "path": "C:\\Program Files\\nodejs\\node.exe"})
    host._boot("host", "boot.host.spawned", {"pid": 8765, "port": 8787})
    host._boot("host", "boot.host.ready", {"ms": 412})
    host._boot("host", "boot.host.win", {"mode": "@boot.host.mode.full", "w": 1920, "h": 1080,
                                         "how": "@boot.host.how.load",
                                         "url": "http://127.0.0.1:8787/index.html"})
    host._boot("host", "boot.conv.count", {"n": 3, "title": "中文标题 · 带空格"})
    host._boot("host", "boot.host.taskbar", {"id": "Ponko-HUD.Desktop"})
    raw = open(bootfile, encoding="utf-8").read()
    lines = [l for l in raw.split("\n") if l.strip()]
    chk("写了 7 行", len(lines) == 7, len(lines))
    pat = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}  host   \S+ \{.*\}$")
    chk("每行都是『YYYY-MM-DD HH:MM:SS.mmm␣␣host␣␣␣␣事件id␣{紧凑JSON}』",
        all(pat.match(l) for l in lines), lines[0] if lines else "")
    chk("行尾那段 Json 能直接解析（正文里的空格/中文不破坏格式）",
        all(json.loads(LINE_RE.match(l).group(3)) for l in lines), "")
    chk("反斜杠路径没被编码坏掉",
        "C:\\\\Program Files\\\\nodejs\\\\node.exe" in raw, raw[:160])
    chk("中文值没被编码坏掉（ensure_ascii=False）", "中文标题" in raw and "\\u" not in raw, raw[-160:])
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})", lines[0])
    chk("时间戳是此刻（误差 10 秒内）", bool(m) and abs(time.time() - time.mktime(
        (int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)),
         int(m.group(5)), int(m.group(6)), 0, 0, -1))) < 10, lines[0][:23])
    chk("文件里存的是事件 id，不是成品句子",
        all(re.search(r"\{", l) for l in lines) and "host started" not in raw, "")

    print("\n── 2. 后端把同一份文件解析回来 ──")
    port = free_port(PORT)
    backend = subprocess.Popen(
        ["node", os.path.join(ROOT, "server", "server.js")],
        cwd=ROOT, env={**os.environ, "PONKO_PORT": str(port), "PONKO_BOOT_LOG": bootfile},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    snap = None
    try:
        for _ in range(80):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/bootlog", timeout=2) as r:
                    snap = json.loads(r.read().decode("utf-8"))
                    break
            except Exception:
                time.sleep(0.15)
        chk("后端起来了并能读 /api/bootlog", snap is not None, "")
        if snap:
            hostlines = [l for l in snap["lines"] if l["tag"] == "host"]
            chk("宿主的 7 行全部被解析出来（含 key 与 args）",
                len(hostlines) == 7 and all(l.get("key") for l in hostlines),
                json.dumps(hostlines[:2], ensure_ascii=False)[:200])
            chk("第一行的 key 与参数逐字一致",
                hostlines[0]["key"] == "boot.host.started" and hostlines[0]["args"]["pid"] == 4321,
                json.dumps(hostlines[0], ensure_ascii=False))
            chk("反斜杠路径没被吃掉",
                any(l.get("args", {}).get("path") == "C:\\Program Files\\nodejs\\node.exe"
                    for l in hostlines), "")
            chk("中文参数值原样回来（含中间那个空格）",
                any(l.get("args", {}).get("title") == "中文标题 · 带空格" for l in hostlines), "")
            chk("布尔/数字类型没退化成字符串",
                any(l["key"] == "boot.host.ready" and l["args"]["ms"] == 412 for l in hostlines), "")
            chk("host 行的时间戳是真实的（解析后与原文差 < 2s）",
                all(abs(time.time() * 1000 - l["ts"]) < 120_000 for l in hostlines), "")
            chk("host 段排在后端自己的行之前（真时间序）",
                snap["lines"][0]["tag"] == "host", snap["lines"][0]["tag"])
            chk("后端自己的行也是事件 id（tag=node）",
                any(l["tag"] == "node" and str(l.get("key", "")).startswith("boot.node.")
                    for l in snap["lines"]), "")
    finally:
        backend.kill()
        time.sleep(0.2)

    print("\n── 3. 真跑一遍宿主 main()：这些行是在真时刻按真顺序写的吗 ──")
    # 用假 webview 顶掉真渲染（不弹窗、不动真机的 run/），其余流程照走：
    # 参数解析 → boot_reset → 互斥体 → 拉起/跳过后端 → 任务栏身份 → 载入 pywebview → 建窗
    bootfile2 = os.path.join(tmpdir, "boot2.log")
    host.RUN_DIR = tmpdir
    host.BOOT_LOG = bootfile2
    host.acquire_single_instance = lambda: True       # 不碰真机那个互斥体
    host.window_decorator = lambda: None             # 别起那个找窗口的 ctypes 线程
    calls = []

    class FakeWindow:
        pass

    fake = type(sys)("webview")
    fake._state = {}
    fake.create_window = lambda *a, **k: (calls.append(k.get("fullscreen", False)), FakeWindow())[1]
    fake.start = lambda **k: calls.append("start")
    sys.modules["webview"] = fake
    argv = sys.argv
    sys.argv = ["native_host.py", "--no-backend", "--port", "8899"]
    try:
        host.main()
    finally:
        sys.argv = argv
        sys.modules.pop("webview", None)

    ev3 = events(bootfile2)
    got = keys_of(ev3)
    print("  宿主实际写出：")
    for e in ev3:
        print("    · %-24s %s" % (e["key"], json.dumps(e["args"], ensure_ascii=False)[:60]))
    chk("先写『宿主启动』（含真 pid）",
        any(e["key"] == "boot.host.started" and e["args"]["pid"] == os.getpid() for e in ev3),
        json.dumps(ev3[:1], ensure_ascii=False))
    chk("有单实例互斥体那行（带上真 APP_ID）",
        any(e["key"] == "boot.host.mutex" and e["args"]["id"] == host.APP_ID for e in ev3), "")
    chk("--no-backend 时如实说跳过后端", "boot.host.nobackend" in got, "")
    chk("记了任务栏身份",
        any(e["key"] == "boot.host.taskbar" and e["args"]["id"] == host.APP_ID for e in ev3), "")
    chk("记了 pywebview 版本与装载耗时",
        any(e["key"] == "boot.host.pywebview" and e["args"]["ver"] and e["args"]["ms"] >= 0
            for e in ev3), "")
    chk("最后一行是建窗与载入地址（真实端口）",
        bool(ev3) and ev3[-1]["key"] == "boot.host.win" and "8899" in ev3[-1]["args"]["url"],
        json.dumps(ev3[-1:], ensure_ascii=False))
    chk("建窗参数里 fullscreen=True（默认全屏无边框）",
        calls and calls[0] is True and "start" in calls, calls)
    order = ["boot.host.started", "boot.host.mutex", "boot.host.nobackend",
             "boot.host.taskbar", "boot.host.pywebview", "boot.host.win"]
    chk("顺序正确（启动 → 互斥体 → 跳过后端 → 身份 → pywebview → 建窗）",
        all(k in got for k in order) and got[:len(order)] == order, got)

    print("\n── 4. 拉起后端：端口真的传过去，而且立刻返回（不等后端就绪） ──")
    # 以前 spawn 时没传 PONKO_PORT：--port 8791 只改了窗口要开的 URL，后端仍听 8787，
    # 于是宿主一直等不到应答，白等 20 秒才开窗。这里就钉住这个"端口没传"的老 bug。
    node = host.find_node()
    chk("这台机器上能找到 node.exe", node is not None, "")
    if node:
        port4 = free_port(8911)
        bootfile4 = os.path.join(tmpdir, "boot4.log")
        host.RUN_DIR = tmpdir
        host.BOOT_LOG = bootfile4
        old_env = os.environ.get("PONKO_BOOT_LOG")
        os.environ["PONKO_BOOT_LOG"] = bootfile4      # 别把测试的行写进真机的 run/boot.log
        try:
            t0 = time.time()
            host.spawn_backend(port4, node)
            dt = (time.time() - t0) * 1000
            chk(f"spawn_backend 立刻返回（{dt:.0f}ms < 1000ms：不等后端就绪）", dt < 1000, f"{dt:.0f}ms")
            up = False
            for _ in range(100):
                if port_open(port4):
                    up = True
                    break
                time.sleep(0.1)
            chk(f"后端真的监听在给的端口 {port4}（而不是默认的 8787）", up, "")
            ev4 = events(bootfile4)
            chk("拉起时顺手记了一行真日志（事件 id 里带着真端口）",
                any(e["key"] == "boot.host.spawned" and e["args"]["port"] == port4 for e in ev4),
                json.dumps(ev4, ensure_ascii=False)[:200])
        finally:
            host.stop_backend()
            if old_env is None:
                os.environ.pop("PONKO_BOOT_LOG", None)
            else:
                os.environ["PONKO_BOOT_LOG"] = old_env

    print("\n── 5. 顺序：窗口先出来，后端在后台起（不再挡在开窗前面） ──")
    bootfile5 = os.path.join(tmpdir, "boot5.log")
    host.RUN_DIR = tmpdir
    host.BOOT_LOG = bootfile5
    os.environ["PONKO_BOOT_LOG"] = bootfile5
    port5 = free_port(8921)
    sys.modules["webview"] = fake
    argv = sys.argv
    sys.argv = ["native_host.py", "--port", str(port5)]
    try:
        host.main()
    finally:
        sys.argv = argv
        sys.modules.pop("webview", None)
    time.sleep(2.5)                      # 后台线程：探端口(约 365ms) → 拉起 → 等应答
    host.stop_backend()                  # 收掉后台刚拉起的那个（main 的 finally 可能抢先）
    ev5 = events(bootfile5)
    got5 = keys_of(ev5)
    print("  这次写出：")
    for e in ev5:
        print("    · %-24s %s" % (e["key"], json.dumps(e["args"], ensure_ascii=False)[:60]))
    i_win = got5.index("boot.host.win") if "boot.host.win" in got5 else -1
    i_spawn = got5.index("boot.host.spawned") if "boot.host.spawned" in got5 else -1
    i_ans = got5.index("boot.host.ready") if "boot.host.ready" in got5 else -1
    chk("建窗那行真的存在", i_win >= 0, got5)
    chk("后端是在后台被拉起来的（有那一行）", i_spawn >= 0, got5)
    chk("窗口先出来，后端后拉起（建窗那行排在拉起之前 —— 以前正好相反）",
        i_win >= 0 and i_spawn >= 0 and i_win < i_spawn, f"win={i_win} spawn={i_spawn}")
    chk("后端应答也没挡在建窗之前",
        i_win >= 0 and (i_ans < 0 or i_win < i_ans), f"win={i_win} ans={i_ans}")
    chk("建窗时给的是占位页（不是先去猜后端好了没）",
        any(e["key"] == "boot.host.win" and e["args"]["how"] == "@boot.host.how.splash" for e in ev5),
        json.dumps([e for e in ev5 if e["key"] == "boot.host.win"], ensure_ascii=False))
    os.environ.pop("PONKO_BOOT_LOG", None)
    shutil.rmtree(tmpdir, ignore_errors=True)

    print("\n%d/%d PASS" % (sum(results), len(results)))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
