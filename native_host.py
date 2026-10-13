#!/usr/bin/env python3
# Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
"""Ponko-HUD desktop host -- a real application window instead of a browser window.

Why this exists
---------------
The old launcher shelled out to ``msedge --app=...``. That works, but the window
still *is* Edge: it shares the user's default profile, shows up as Edge in the
taskbar / Alt+Tab / Task Manager, keeps browser context menus and shortcuts, and
requires Edge itself to be installed and healthy.

This host renders the very same UI inside a Win32 form hosting WebView2 (the
Chromium runtime Windows ships on its own), and adds the things a real app needs:

  * own icon + AppUserModelID -> own taskbar entry, own Alt+Tab entry
  * no address bar, no tabs, no extensions, no browser context menu
  * single instance (a second launch just raises the running window)
  * starts the Node backend itself and always tears it down on exit
  * dark immersive title bar tinted to the HUD palette

Usage
-----
    pythonw native_host.py            # normal
    python  native_host.py --frameless --devtools
    pythonw native_host.py --always-on-top
"""

import argparse
import atexit
import ctypes
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from ctypes import wintypes

_T0 = time.time()          # 宿主进程的时间原点：下面所有"从启动算起 {n}ms"都拿它算

APP_ID = "Ponko-HUD.Desktop"
APP_TITLE = "Ponko-HUD"
ROOT = os.path.dirname(os.path.abspath(__file__))
ICON = os.path.join(ROOT, "tools", "assets", "Ponko-HUD.ico")
RUN_DIR = os.path.join(ROOT, "run")

# HUD palette as COLORREF (0x00bbggrr)
CAPTION_COLOR = 0x100C07   # #070C10
TEXT_COLOR = 0xFFF97D      # #7DF9FF
BORDER_COLOR = 0x1C1A0E    # #0E1A1C

DWMWA_USE_IMMERSIVE_DARK_MODE = 20
DWMWA_BORDER_COLOR = 34
DWMWA_CAPTION_COLOR = 35
DWMWA_TEXT_COLOR = 36

CREATE_NO_WINDOW = 0x08000000
ERROR_ALREADY_EXISTS = 183

_backend_proc = None
_backend_owned = False

BOOT_LOG = os.path.join(RUN_DIR, "boot.log")

# 后端还没应答的那段时间，窗口里先显示这一页（纯静态、零依赖）。
# 以前这段时间是"窗口压根还没建出来"，看上去就像双击了没反应。
SPLASH_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Ponko-HUD</title>
<style>
  html,body{margin:0;height:100%;background:#070C10;overflow:hidden}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;
       font:13px "Cascadia Mono",Consolas,"Microsoft YaHei",monospace}
  .t{color:#7DF9FF;letter-spacing:.28em}
  .s{color:#688492;letter-spacing:.12em}
</style></head>
<body><div class="t">PONKO-HUD</div><div class="s">Connecting to the local backend…</div></body></html>
"""


def boot_reset() -> None:
    """每次启动都从零开一份启动记录 —— 里面只会有本次启动真实发生的事。"""
    try:
        os.makedirs(RUN_DIR, exist_ok=True)
        open(BOOT_LOG, "w", encoding="utf-8").close()
    except OSError:
        pass


def _boot(tag: str, key: str, args: dict | None = None) -> None:
    """写一行**真实**启动日志：事件 id + 参数（格式见 server/bootlog.js；后端与前端读同一份）。

    为什么不写成品句子：启动画面上的语言要跟着语言包走，而这些行是在页面拿到语言包
    **之前**就落盘的 —— 只有把"发生了什么"（key）和"参数是什么"（args）存下来，
    页面才能用当前语言重新渲染（见 app/src/i18n/*.js 与 app/src/boot.js 的 replay）。

    行格式（人可读；`{...}` 一定是行尾那段紧凑 JSON，所以正文里带空格也不会解析错）：
        2026-10-13 00:40:12.345  host   boot.host.started {"pid":1234,"py":"3.14.4"}
    """
    now = time.time()
    ms = min(999, int((now % 1) * 1000))
    stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now)) + f".{ms:03d}"
    payload = json.dumps(args or {}, ensure_ascii=False, separators=(",", ":"))
    try:
        os.makedirs(RUN_DIR, exist_ok=True)
        with open(BOOT_LOG, "a", encoding="utf-8", errors="replace") as f:
            f.write(f"{stamp}  {tag:<6} {key} {payload}\n")
    except OSError:
        pass


def _log(*args_, **kwargs):
    """Write to run/host.log (pythonw launches have no console to print to)."""
    msg = kwargs.get("sep", " ").join(str(a) for a in args_)
    try:
        os.makedirs(RUN_DIR, exist_ok=True)
        with open(os.path.join(RUN_DIR, "host.log"), "a", encoding="utf-8",
                  errors="replace") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# backend (node server.js)
# --------------------------------------------------------------------------- #
def port_listening(port: int) -> bool:
    s = socket.socket()
    s.settimeout(0.35)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def find_node() -> str | None:
    """找 node.exe（本机实测 5ms —— 所以它留在主线程上也无所谓）。"""
    exe = shutil.which("node") or shutil.which("node.exe")
    if exe:
        return exe
    for cand in (
        r"C:\Program Files\nodejs\node.exe",
        os.path.join(os.environ.get("ProgramW6432", ""), "nodejs", "node.exe"),
    ):
        if cand and os.path.isfile(cand):
            return cand
    return None


def node_version(node: str) -> str:
    """真的问一次 node 自己的版本，别猜。"""
    try:
        out = subprocess.run([node, "-v"], capture_output=True, text=True,
                             timeout=8, creationflags=CREATE_NO_WINDOW)
        return (out.stdout or out.stderr or "").strip() or "未知版本"
    except Exception:  # noqa: BLE001
        return "版本探测失败"


def spawn_backend(port: int, node: str) -> None:
    """把 server.js 拉起来就返回 —— **不等它就绪，也不探端口**（探端口在后台做）。"""
    global _backend_proc, _backend_owned
    server = os.path.join(ROOT, "server", "server.js")
    # ★ 端口必须真的传过去：以前只改了窗口要开的 URL，后端仍按默认 8787 监听，
    #   于是 --port 8791 会一直等不到应答，白等 20 秒才开窗。
    env = dict(os.environ, PONKO_PORT=str(port))
    _backend_proc = subprocess.Popen(
        [node, server],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=CREATE_NO_WINDOW,
    )
    _backend_owned = True
    write_pid("backend.pid", _backend_proc.pid)
    _log(f"[host] backend started (pid {_backend_proc.pid}) on port {port}")
    _boot("host", "boot.host.spawned", {"pid": _backend_proc.pid, "port": port})
    # node -v 要另起一个子进程（本机实测 400ms+），而它只是启动日志里的一行诊断 ——
    # 放到后台写，别把"拉起后端"乃至开窗一起拖慢。
    threading.Thread(target=_probe_node_version, args=(node,),
                     name="ponko-nodev", daemon=True).start()


def _probe_node_version(node: str) -> None:
    _boot("host", "boot.host.node", {"ver": node_version(node), "path": node})


def _on_window_shown() -> None:
    """窗口真正显示出来的那一刻记一行真日志 —— "双击到看见窗口"就落在这一行里。"""
    _boot("host", "boot.host.shown", {"ms": int((time.time() - _T0) * 1000)})


def backend_answers(url: str, port: int) -> bool:
    """端口通 + 真的吐回 200 才算"后端在"：只认实际应答，不认"进程还活着"。"""
    if not port_listening(port):
        return False
    try:
        with urllib.request.urlopen(url, timeout=2) as r:
            return r.status == 200
    except Exception:  # noqa: BLE001
        return False


def run_backend(window, url: str, port: int, node: str, timeout: float = 30.0) -> None:
    """后台整条后端链路：有没有现成的 → 没有就拉起 → 等它真的应答 → 让窗口换真页面。

    为什么整条都放后台：第一步 port_listening() 要初始化 Winsock，**本机实测 365ms**，
    而它只是"问一句端口上有没有人"；以前它挡在 create_window 前面，等于每段开机
    都要先白付这 365ms。现在窗口先起（显示占位页），这段与 pywebview 装载、
    WebView2 起窗（约 1.5s）并行跑 —— 谁先好谁先上屏。
    """
    t0 = time.time()
    if backend_answers(url, port):
        _log(f"[host] backend already listening on {port}, reusing it")
        _boot("host", "boot.host.reuse", {"port": port})
    else:
        spawn_backend(port, node)

    ok = False
    while time.time() - t0 < timeout:
        if _backend_proc is not None and _backend_proc.poll() is not None:
            _log("[host] backend exited before answering", file=sys.stderr)
            _boot("host", "boot.host.dead")
            break
        if backend_answers(url, port):
            ms = int((time.time() - t0) * 1000)
            _log("[host] backend ready")
            _boot("host", "boot.host.ready", {"ms": ms})
            ok = True
            break
        time.sleep(0.05)                      # 细粒度：别再让轮询间隔（原来 0.25s）白加进等待
    if not ok:
        _log(f"[host] WARNING: backend did not answer in {timeout}s, loading anyway")
        _boot("host", "boot.host.late", {"s": int(timeout)})

    # pywebview 的 load_url 在窗口实例建出来之前会被静默丢掉（instances 里还没有它）→
    # 先等 shown，再导航。
    try:
        window.events.shown.wait(timeout)
    except Exception as e:  # noqa: BLE001
        _log(f"[host] waiting for window.shown failed: {e!r}")
    try:
        window.load_url(url)
        _log(f"[host] navigating to {url}")
    except Exception as e:  # noqa: BLE001
        _log(f"[host] load_url failed: {e!r}")


def stop_backend() -> None:
    """Never block the exit path: kill immediately, then sweep children in the background.

    以前这里跑 ``taskkill ... timeout=10`` 同步等，机器上实测出现过 TimeoutExpired
    （日志里那行 backend kill failed）—— 退出时白等 10 秒，看着就像"卡死"。
    现在：先 fire-and-forget 起 taskkill /t（趁 node 还活着才能枚举到 pwsh 等子进程），
    再 TerminateProcess 立刻收掉 node —— 整条路径最多 ~0.2s，绝不阻塞退出。
    """
    global _backend_proc, _backend_owned
    if _backend_proc and _backend_owned:
        pid = _backend_proc.pid
        try:
            subprocess.Popen(
                ["taskkill", "/pid", str(pid), "/t", "/f"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=CREATE_NO_WINDOW,
            )
            time.sleep(0.15)        # 给 taskkill 一点时间枚举进程树
        except Exception as e:  # noqa: BLE001
            _log(f"[host] backend taskkill spawn failed: {e!r}")
        try:
            _backend_proc.kill()
        except Exception as e:  # noqa: BLE001
            _log(f"[host] backend terminate failed: {e!r}")
        _log(f"[host] backend stopped (pid {pid})")
        _backend_proc = None
        _backend_owned = False
    remove_pid("backend.pid")


# --------------------------------------------------------------------------- #
# pid files (so stop.bat can be precise)
# --------------------------------------------------------------------------- #
def write_pid(name: str, pid: int) -> None:
    try:
        os.makedirs(RUN_DIR, exist_ok=True)
        with open(os.path.join(RUN_DIR, name), "w", encoding="utf-8") as f:
            f.write(str(pid))
    except OSError:
        pass


def remove_pid(name: str) -> None:
    try:
        os.remove(os.path.join(RUN_DIR, name))
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# win32 helpers
# --------------------------------------------------------------------------- #
_u = ctypes.windll.user32
_k = ctypes.windll.kernel32
_dwmapi = ctypes.windll.dwmapi

_u.LoadImageW.restype = ctypes.c_void_p
_u.EnumWindows.restype = ctypes.c_bool
_u.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
_u.FindWindowW.restype = wintypes.HWND
_k.CreateMutexW.restype = ctypes.c_void_p


def list_windows(title_prefix: str, pid: int | None = None) -> list[int]:
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_long)
    def cb(hwnd, _lparam):
        if _u.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(256)
            _u.GetWindowTextW(hwnd, buf, 256)
            if buf.value.startswith(title_prefix):
                proc = ctypes.c_ulong()
                _u.GetWindowThreadProcessId(hwnd, ctypes.byref(proc))
                if pid is None or proc.value == pid:
                    found.append(hwnd)
        return True

    _u.EnumWindows(cb, 0)
    cb_keepalive.append(cb)
    return found


cb_keepalive = []


def acquire_single_instance() -> bool:
    """True if this process owns the app; False if another instance is running."""
    handle = _k.CreateMutexW(None, True, f"Local\\{APP_ID}.Mutex")
    if not handle:
        return True
    owned = _k.GetLastError() != ERROR_ALREADY_EXISTS
    # keep the handle alive for the lifetime of the process
    globals()["_mutex_handle"] = handle
    if not owned:
        return False
    return True


def focus_existing() -> bool:
    hwnds = list_windows(APP_TITLE)
    if not hwnds:
        # try again briefly: window may still be coming up
        time.sleep(1.2)
        hwnds = list_windows(APP_TITLE)
    if not hwnds:
        return False
    hwnd = hwnds[0]
    if _u.IsIconic(hwnd):
        _u.ShowWindow(hwnd, 9)      # SW_RESTORE
    _u.SetForegroundWindow(hwnd)
    _u.FlashWindow(hwnd, True)
    return True


def apply_window_style(hwnd: int) -> None:
    """Icon + dark immersive title bar tinted to the HUD palette."""
    if os.path.isfile(ICON):
        h_big = _u.LoadImageW(0, ICON, 1, 0, 0, 0x0010)    # IMAGE_ICON, LR_LOADFROMFILE
        h_small = _u.LoadImageW(0, ICON, 1, 16, 16, 0x0010)
        if h_big:
            _u.SendMessageW(hwnd, 0x0080, 1, h_big)        # WM_SETICON / ICON_BIG
        if h_small:
            _u.SendMessageW(hwnd, 0x0080, 0, h_small)      # WM_SETICON / ICON_SMALL

    def set_attr(attr, value):
        try:
            _dwmapi.DwmSetWindowAttribute(
                hwnd, attr, ctypes.byref(ctypes.c_int(value)), 4
            )
        except Exception:  # noqa: BLE001 - old Windows builds lack these attrs
            pass

    set_attr(DWMWA_USE_IMMERSIVE_DARK_MODE, 1)
    set_attr(DWMWA_CAPTION_COLOR, ctypes.c_int(CAPTION_COLOR).value)
    set_attr(DWMWA_TEXT_COLOR, ctypes.c_int(TEXT_COLOR).value)
    set_attr(DWMWA_BORDER_COLOR, ctypes.c_int(BORDER_COLOR).value)


def window_decorator() -> None:
    for _ in range(80):
        hwnds = list_windows(APP_TITLE, pid=os.getpid())
        if hwnds:
            try:
                apply_window_style(hwnds[0])
                _log(f"[host] window styled (hwnd {hwnds[0]})")
            except Exception as e:  # noqa: BLE001
                _log(f"[host] styling failed: {e!r}")
            return
        time.sleep(0.15)


def screen_size() -> tuple[int, int]:
    return _u.GetSystemMetrics(0), _u.GetSystemMetrics(1)


# --------------------------------------------------------------------------- #
# UI bridge (pywebview JS API) -- the page's own "退出" button calls into this
# --------------------------------------------------------------------------- #
class UIApi:
    """Exposed to the page as ``window.pywebview.api``.

    The HUD runs fullscreen / borderless, so there is no native title bar with a
    close button. The page draws its own "退出" button and calls ``quit()`` here;
    destroying the window makes ``webview.start`` return, and this host then tears
    the node backend down in its ``finally`` block (same as stop.bat, but in-app).

    !! 只许有 public *方法*，别的属性一律加下划线 !!
    pywebview 造 JS API 时会 dir() 这个对象，并把所有"非 callable 的 public 属性"
    递归扫进 .NET 对象图（util.get_functions）。之前窗口存在 self.window 上，于是
    它顺着 Window -> .native（WinForms 窗体）一路 getattr：几百个跨线程 COM 取值、
    "maximum recursion depth exceeded"，最后 finish_script 根本没来得及执行 ——
    页面上压根没有 window.pywebview.api，退出按钮自然点什么都没反应。
    """

    def __init__(self) -> None:
        self._window = None          # 不能叫 self.window（见类注释）
        self._quitting = False
        self._lock = threading.Lock()

    def quit(self) -> bool:
        """页面「退出」按钮 / ^⇧Q 走这里。立刻返回，真正的收尾交给 helper 线程。"""
        with self._lock:
            if self._quitting:
                return True          # 连点两次只收尾一次
            self._quitting = True

        _log("[host] quit requested from the UI")
        threading.Thread(target=self._teardown, name="ponko-quit", daemon=True).start()
        return True

    def _teardown(self) -> None:
        # 1) 让上面那个 return 的写回（pywebview 把结果 evaluate_js 回页面）先跑完，
        #    免得 window.destroy() 跟它抢 UI 线程。
        time.sleep(0.3)
        try:
            if self._window is not None:
                self._window.destroy()
                _log("[host] window destroyed")
        except Exception as e:  # noqa: BLE001
            _log(f"[host] window.destroy failed: {e!r}")

        # 2) 兜底：窗口消失后再给主线程 2s 走完 finally / atexit；还活着就是卡住了，
        #    直接把后端收了硬退 —— 绝不留"点了退出程序不动"的状态。
        for _ in range(16):
            if not list_windows(APP_TITLE, pid=os.getpid()):
                break
            time.sleep(0.5)
        time.sleep(2.0)
        _log("[host] quit watchdog: forcing exit")
        stop_backend()
        os._exit(0)


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main() -> None:
    ap = argparse.ArgumentParser(description="Ponko-HUD native window host")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--windowed", action="store_true",
                    help="windowed mode instead of fullscreen (default is fullscreen borderless)")
    ap.add_argument("--frameless", action="store_true",
                    help="(windowed mode) drop the native title bar")
    ap.add_argument("--always-on-top", action="store_true")
    ap.add_argument("--devtools", action="store_true", help="enable WebView2 dev tools")
    ap.add_argument("--no-backend", action="store_true", help="assume server already runs")
    ap.add_argument("--query", default="", help="extra url query, e.g. \"?demo=1\" or \"?mood=error\"")
    ap.add_argument("--fast", action="store_true",
                    help="skip the boot log splash (?boot=0) -- saves ~2s while iterating")
    args = ap.parse_args()

    atexit.register(stop_backend)

    boot_reset()
    _boot("host", "boot.host.started", {"pid": os.getpid(), "py": sys.version.split()[0]})
    if args.fast:
        _boot("host", "boot.host.fast")

    if not acquire_single_instance():
        if focus_existing():
            _log("[host] already running, raised existing window")
            _boot("host", "boot.host.already.raise")
        else:
            # 之前这里会继续往下走，于是桌上叠出第二个全屏窗口（日志 16:02:52 那次）。
            # 已经有一个实例占着互斥体，就不再开新窗口，直接退出。
            _log("[host] another instance holds the mutex but its window was not found; exiting")
            _boot("host", "boot.host.already.ghost")
        sys.exit(0)
    _boot("host", "boot.host.mutex", {"id": APP_ID})

    # ★ 这里只确认"机器上有没有 node"（5ms，见下面的实测），**不探端口、不等后端**：
    #   探端口要初始化 Winsock（365ms）、拉起后端要等它应答（~0.5s），两件都交给
    #   run_backend() 在后台做，窗口同时起 —— 谁也不挡谁。
    node = None
    if args.no_backend:
        _boot("host", "boot.host.nobackend")
    else:
        node = find_node()
        if not node:
            _log("[host] FATAL: node.exe not found in PATH", file=sys.stderr)
            _boot("host", "boot.host.nonode")
            sys.exit(1)

    # own taskbar identity (must happen before any window is created)
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
        _boot("host", "boot.host.taskbar", {"id": APP_ID})
    except Exception:  # noqa: BLE001
        pass

    t_imp = time.time()
    import webview  # imported late: single-instance exit should stay cheap
    try:
        from importlib.metadata import version as _pkgver
        wv_ver = _pkgver("pywebview")
    except Exception:  # noqa: BLE001
        wv_ver = getattr(webview, "__version__", "unknown")
    _boot("host", "boot.host.pywebview", {"ver": wv_ver, "ms": int((time.time() - t_imp) * 1000)})

    if os.path.isfile(ICON):
        try:
            webview._state["icon"] = ICON
        except Exception:  # noqa: BLE001
            pass
    else:
        _boot("host", "boot.host.noicon")

    sw, sh = screen_size()

    query = (args.query or "").strip()
    if query and not query.startswith("?"):
        query = "?" + query
    if args.fast:
        query += ("&" if query else "?") + "boot=0"
    url = f"http://127.0.0.1:{args.port}/index.html{query}"

    # JS bridge: page's "退出" button -> window.destroy() -> clean shutdown
    api = UIApi()
    # 后端由我们自己管（node 已找到）→ 窗口先显示占位页，等后端应答再导航过去
    splash = node is not None
    first_url = None if splash else url
    first_html = SPLASH_HTML if splash else None
    how = "@boot.host.how.splash" if splash else "@boot.host.how.load"

    if args.windowed:
        # old windowed behaviour: a resizable box centred on the screen
        width = max(1000, min(1680, sw - 120))
        height = max(640, min(940, sh - 120))
        _log(f"[host] opening {url} windowed at {width}x{height}")
        _boot("host", "boot.host.win", {"mode": "@boot.host.mode.windowed", "w": width, "h": height, "how": how, "url": url})
        window = webview.create_window(
            APP_TITLE,
            url=first_url,
            html=first_html,
            width=width,
            height=height,
            min_size=(900, 560),
            resizable=True,
            frameless=args.frameless,
            easy_drag=args.frameless,
            on_top=args.always_on_top,
            background_color="#070C10",
            text_select=True,
            js_api=api,
        )
    else:
        # default: fullscreen, borderless, covering the whole primary display
        # (pywebview's fullscreen is itself borderless; do not also set
        #  frameless, which interferes with the maximise that hides the taskbar)
        _log(f"[host] opening {url} fullscreen borderless ({sw}x{sh})")
        _boot("host", "boot.host.win", {"mode": "@boot.host.mode.full", "w": sw, "h": sh, "how": how, "url": url})
        window = webview.create_window(
            APP_TITLE,
            url=first_url,
            html=first_html,
            width=sw,
            height=sh,
            fullscreen=True,
            on_top=False,
            background_color="#070C10",
            text_select=True,
            js_api=api,
        )

    api._window = window

    try:
        window.events.shown += _on_window_shown
    except Exception:  # noqa: BLE001 - 假 webview / 老版本没有 events 也不影响开窗
        pass

    if splash:
        threading.Thread(target=run_backend, args=(window, url, args.port, node),
                         name="ponko-backend", daemon=True).start()

    threading.Thread(target=window_decorator, daemon=True).start()

    write_pid("host.pid", os.getpid())
    try:
        webview.start(
            debug=args.devtools,
            private_mode=False,
            storage_path=os.path.join(ROOT, "run", "webview-profile"),
        )
    finally:
        remove_pid("host.pid")
        stop_backend()


if __name__ == "__main__":
    main()
