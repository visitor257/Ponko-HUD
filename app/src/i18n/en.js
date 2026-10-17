// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 英文包 —— **boot.* 的兜底，也是 ui.* 的兜底**。
//
// 为什么英文包先于其它语言出现：
//   · boot.* —— 启动画面里宿主/后端那几十行是在页面拿到语言包之前就写进 run/boot.log 的
//     （存的是事件 id + 参数，见 server/bootlog.js），页面渲染时按"当前语言包有没有这条 key"
//     决定用谁 —— 没有就落到这里。所以 zh-cn 之外的任何语言，启动画面都是英文。
//   · ui.*  —— 同理：zh-cn 是界面文案的"原文"，别的语言包翻到哪算哪，**没翻的落这里**。
//     所以空语言包（ja.js）的效果 = 界面英文 + 启动画面英文，而不是半屏中文。
//
// 注意：带 {占位符} 的整句**必须是整句**，不能按片段拼 —— 别的语言语序不同，片段拼不出来。
//      参数值写成 `@其它key` 时，渲染前会先被翻成那条 key 的译文（mode / how / disk / gpu 这类小片段）。
//      IP 地址、城市名、`local`、`tok/s`、面板名（SHELL / AGENT）这些是**数据/标识**，不进字典。
export default {
  // ── 界面：外框 / 状态行 / 按键提示 ────────────────────────────────────
  'ui.exit.idle': ' ✕ Quit ',
  'ui.exit.armed': ' ✕ Click again ',
  'ui.exit.quitting': ' ✕ Quitting… ',
  'ui.status.llmOn': 'local · LLM linked',
  'ui.status.llmOff': 'local · no LLM',
  'ui.hint.zoomOn': '▚ {panel} zoomed · click 〼 at its corner to restore the split view',
  'ui.hint.zoomOff': '▚ focus={focus} · drag to select text · globe drags · splitter drags · ⛶ at a panel corner zooms',
  // hotkey bar: the `[^M]mood` entry is gone — Ctrl+M was retired with the debug
  // feature on 2026-10-17 (^M is Enter in a terminal, too easy to hit by accident).
  'ui.hotkeys': '[TAB]switch [^⏎]send / Enter=newline [ESC]deselect/abort [^⇧C]or[^C]copy [^⇧T]new tab [^Tab]next tab (follows focus) [^⇧Q]quit [wheel]scroll',

  // ── 底部提示条（toast）
  'ui.toast.noSelection': 'nothing selected',
  'ui.toast.copied': 'copied {n} characters',
  'ui.toast.copyFail': 'copy failed',
  'ui.toast.lastConv': 'the last conversation cannot be closed',
  'ui.toast.maxConv': 'conversation limit reached',
  'ui.toast.maxTab': 'tab limit reached',
  'ui.toast.exitArm': 'click 「Quit」 again to close Ponko-HUD',
  'ui.toast.exiting': 'closing Ponko-HUD…',
  'ui.toast.exitManual': 'could not close the window automatically — run stop.bat to exit',

  // ── 删对话的两步确认条
  'ui.convdel.last': ' Clear conversation "{title}" and delete its archive? It is the last one — a fresh empty one takes its place  Enter to confirm · ESC to cancel ',
  'ui.convdel.one': ' Delete conversation "{title}" and its archive?  Enter to confirm · ESC to cancel ',

  // ── SHELL 面板自己说的话（程序输出与命令回显不走字典，原样显示）
  'ui.shell.welcome': 'Ponko-HUD shell · persistent session · type ponko-help for the command list',
  'ui.shell.unknownError': 'unknown error',
  'ui.shell.ptyError': 'PTY: {msg}',
  'ui.shell.ptyExit': 'terminal exited',
  'ui.shell.leftPty': 'left the real terminal · back to pipe mode',
  'ui.shell.startingPty': 'starting the real terminal…',
  'ui.shell.startingPtyNamed': 'starting the real terminal: {name}…',
  'ui.shell.ptyHint': '(the real terminal makes interactive programs work · Ctrl+Shift+E to leave)',
  'ui.shell.timeout': 'command timed out (60s) · interrupted',
  'ui.shell.exitCode': 'exit code {code}',
  'ui.shell.interrupted': '^C interrupted',
  'ui.shell.cmdFailed': 'the last command failed',
  'ui.shell.shellError': 'shell error',
  'ui.shell.langCurrent': 'lang · current lang_id {id} · usage: lang <lang_id>',
  'ui.shell.langBad': 'lang · no such language pack: {id}',
  'ui.shell.langDone': 'lang · switched to {id} · applied right away · also remembered',
  'ui.shell.help.title': 'Ponko-HUD panel help · the native help / Get-Help is untouched and still works',
  'ui.shell.help.shell': 'current shell: {kind}',
  'ui.shell.help.cmd': 'cmd / powershell   switch shell (exit in CMD drops back to PowerShell first)',
  'ui.shell.help.exit': 'exit   end this tab\'s shell and close the tab (the last one opens a fresh one)',
  'ui.shell.help.clear': 'clear wipes the screen · ESC interrupts · ↑/↓ walks command history · pty <cmd> opens a real terminal (any program)',
  'ui.shell.help.lang': 'lang [lang_id]   show / switch the interface language (no argument lists the current lang_id and the switchable ones)',
  'ui.shell.help.pty': 'interactive programs (python / node / ssh / vim… run bare) open a real terminal automatically',
  'ui.shell.help.keys': 'real terminal = keystrokes go straight through: ^C interrupt · ^D end input · ^E leave',
  'ui.shell.help.tabs': 'tabs: ^⇧T new · ^Tab switch (each tab is independent) · close one by typing exit inside it',
  'ui.shell.help.tabs2': '         each tab has its own colour (tab strip / top-right of SHELL) — match the colour, not a number',
  'ui.shell.help.agent': 'AGENT has tabbed conversations too; the same ^⇧T/^Tab is dispatched by focus: focus on AGENT drives conversations',
  'ui.shell.help.agent2': '         conversations auto-save and come back after a restart; deleting one has no shortcut — type /del chat in the input box',
  'ui.shell.help.agent3': '         typing goes through the same confirmation: the red bar shows up, Enter really deletes, ESC cancels, typing anything else cancels too',
  'ui.shell.help.boot': 'the screen at startup is a real log: the self-check steps and timings of host + backend, the whole record lives in run/boot.log',

  // ── AGENT 面板
  'ui.agent.newConv': 'New chat',
  'ui.agent.backendError': 'backend error: {msg}',
  'ui.agent.noBackend': 'cannot reach the agent backend',
  'ui.agent.aborted': 'interrupted',
  'ui.agent.placeholder': 'type here… (Ctrl+Enter to send)',
  'ui.agent.streaming': 'streaming · {rate} tok/s',
  'ui.agent.idle': 'idle',
  'ui.agent.ready': 'ready. Type shell commands on the left, or just talk to me here.',
  'ui.agent.cleared': 'cleared · the panel cannot have zero conversations, so this new one took its place. To delete, type /del chat in the input box (it deletes after you press Enter)',
  'ui.agent.llmOn': 'LLM connected ({model}) — just talk to me.',
  'ui.agent.formTitle': '⚙ Connect an LLM',
  'ui.agent.field.apiAddr': 'API address',
  'ui.agent.field.apiKey': 'API Key',
  'ui.agent.field.model': 'Model',
  'ui.agent.field.provider': 'Protocol',
  // "形象"（角色立绘包）译作 Character；Personality 留给下面新增的「性格」那一栏 ——
  // 两条都叫 Persona* 的话，英文界面上分不清哪个是哪个。
  'ui.agent.field.charpack': 'Character',
  'ui.agent.field.persona': 'Personality',
  'ui.agent.opt.personaDefault': 'natural',
  'ui.agent.opt.personaTsundere': 'tsundere',
  'ui.agent.opt.personaGenki': 'peppy',
  'ui.agent.opt.personaSarcastic': 'sarcastic',
  'ui.agent.opt.personaGentle': 'gentle',
  'ui.agent.opt.auto': 'auto-detect',
  'ui.agent.opt.openai': 'OpenAI-compatible',
  'ui.agent.opt.anthropic': 'Anthropic',
  // "auto" for the character row: not "take the first pack", but let the configured model pick one
  'ui.agent.opt.charpackAuto': 'auto',
  'ui.agent.form.pickArt': 'letting the model pick a character…',
  'ui.agent.form.pickArtFail': 'character not picked: {err} · using the default (save again to retry)',
  // Left in the conversation after an auto pick (the status line is gone in a second, this stays)
  'ui.agent.artAuto': 'character: {id} (picked by {model})',
  'ui.agent.form.hint': 'fill in address / key / model, then press Enter to save (the connection is verified first)',
  // The form shown when "+" creates a conversation: only says edits stay local.
  // It must NOT claim anything about where the values came from — the pre-fill is the conversation
  // you were looking at when you pressed "+" (see _llmOfTab), and that one may have nothing at all.
  'ui.agent.form.hintNew': 'new conversation · edits here affect only this conversation',
  'ui.agent.form.needBoth': 'the address and the key cannot be empty',
  'ui.agent.form.testing': 'verifying the connection…',
  'ui.agent.form.testFail': 'connection failed: {err}',
  'ui.agent.form.modelChecked': ' · model verified',
  'ui.agent.verifyOk': 'verified ({ms}ms{via}{pname}) ✓ saved',
  'ui.agent.form.saveFail': 'save failed: missing field',
  'ui.agent.form.saveError': 'save error: {err}',
  'ui.agent.form.hintSkip': 'no LLM configured: this conversation cannot send yet · type /llm to bring the form back',
  'ui.agent.form.keys': 'TAB/↑↓ switch · ←→ change value · Enter saves · mouse clicks work too',
  'ui.agent.btn.testing': '[ checking ]',
  'ui.agent.btn.save': '[  save  ]',
  'ui.agent.btn.cancel': '[ cancel ]',
  'ui.agent.status.off': 'no LLM',
  'ui.agent.status.on': 'linked',

  // ── MOOD / 主题
  // Mood **names** (idle / thinking / …) are not here: they belong to the character pack
  // (pack.json's moods.<tag>.label, resolved by moodLabel() in mood.js).
  // The entries below are *status notes* shown when the mood falls back locally.
  'ui.mood.srcLocal': 'local',
  'ui.mood.srcManual': 'manual',
  'ui.mood.waiting': 'waiting for the agent',
  'ui.mood.manualOverride': 'manual override (debug)',

  // ── CHAR panel ('loading…' / 'mood N / 100' are plain English, not in the dictionary)
  //    The old ui.char.style* group (top-right render-path label) was dropped on 2026-10-15.
  'ui.char.missing': ' ✗missing',
  // 'ui.char.history' was removed on 2026-10-17 together with the sparkline itself.

  // ── GLOBE 面板（IP / 城市名是数据，不进字典）
  'ui.globe.decor': 'decorative',
  'ui.globe.center': 'center {deg}°',
  'ui.globe.noGeo': 'no public geo data · offline or restricted network',
  'ui.globe.loading': 'looking up network geography…',
  'ui.globe.notDirect': 'not directly reachable',
  'ui.globe.self': 'this host {ip}',
  'ui.globe.gateway': 'gateway {gw}',

  // ── 启动画面：页面自己画的版式

  'boot.progress': 'progress',
  'boot.pbar.info': ' {shown}/{total} · backend {backend}s · {server} lines from host/node · {live} from page',
  'boot.done': 'boot complete · backend self-check {backend}s · page self-check {page}s'
    + ' · {logs} log lines · handing off to HUD',

  // ── 启动画面：页面自己记的日志行（tag 与之一一对应）
  'boot.ui.bootlog': 'GET /api/bootlog · {ms} · {n} records (pid {pid})',
  'boot.ui.bootlog.fail': 'could not fetch boot records: {err}',
  'boot.ui.canvas': 'canvas {w}×{h} @dpr{dpr} · cell {cw}×{ch} · {cols}×{rows} cells',
  'boot.ui.engine': 'renderer {ua} · logical cores {cores}',
  'boot.ui.engine.unknown': 'unknown',
  'boot.ui.layout': 'layout done · {cols}×{rows} · {panels} panels · {rects} rects',
  'boot.ui.repaint': 'full repaint {ms}ms · {cells} cells',
  // same picture as when you quit: the mood snapshot came back from run/ui-state.json
  'boot.ui.moodRestored': 'mood snapshot restored {ms} · now {mood}',
  'boot.pack.loaded': '{id} loaded · {n} moods · frames decoded on demand',
  'boot.pack.none': 'no character pack found → the char panel sits this one out',
  'boot.sys.ok': 'GET /api/sys {ms} · CPU {cpu}% · mem {used}/{total}GB {pct}%{disk}{gpu} · uptime {up}h',
  'boot.sys.disk': ' · disk {pct}%',
  'boot.sys.gpu': ' · GPU {util}%',
  'boot.sys.fail': 'GET /api/sys failed ({ms}) · panels run on placeholder data for now',
  'boot.net.ok': 'globe geo {ms} · {place} · {dns} resolvers',
  'boot.net.nogeo': 'no egress geo',
  'boot.net.fail': 'geo lookup failed ({ms}) → globe panel falls back to decorative mode',
  'boot.conv.restored': 'restored {n} conversations · {msgs} messages',
  'boot.conv.none': 'no saved conversations yet → starting a fresh one',
  'boot.net.more': 'boot records: {n} more lines landed while replaying',

  // ── 宿主 native_host.py 写下的行（窗还没出来那几毫秒里发生的事）
  'boot.host.started': 'Ponko-HUD host started · pid {pid} · Python {py}',
  'boot.host.fast': '--fast: skipping the boot log (?boot=0) · going straight to the HUD',
  'boot.host.already.raise': 'another instance is running → raising its window, not opening a new one',
  'boot.host.already.ghost': 'another instance holds the mutex but no window was found → exiting',
  'boot.host.mutex': 'single-instance mutex {id}.Mutex acquired',
  'boot.host.nobackend': '--no-backend: assuming the backend is already running · skipping spawn',
  'boot.host.nonode': 'node.exe not found · cannot start the backend → exiting',
  'boot.host.taskbar': 'taskbar identity {id} registered (independent of the browser)',
  'boot.host.pywebview': 'pywebview {ver} loaded in {ms}ms · renderer WebView2 (the built-in Edge engine)',
  'boot.host.noicon': 'missing tools/assets/Ponko-HUD.ico → using the system default window icon',
  'boot.host.spawned': 'backend process spawned · pid {pid} · server/server.js · port {port}',
  'boot.host.node': 'node {ver} · {path}',
  'boot.host.shown': 'window shown · {ms}ms since host process start',
  'boot.host.reuse': 'port {port} already has a backend running · reusing it (not spawning)',
  'boot.host.dead': 'backend exited early → the real page may not open (see run/host.log and server errors)',
  'boot.host.ready': 'backend answered HTTP 200 · {ms}ms from spawn → window loads the real page',
  'boot.host.late': 'backend did not answer within {s}s · loading anyway (may be blank)',
  'boot.host.win': 'window created · {mode} {w}x{h} · {how} · {url}',
  'boot.host.mode.windowed': 'windowed',
  'boot.host.mode.full': 'fullscreen borderless',
  'boot.host.how.splash': 'splash first, real page once the backend is ready',
  'boot.host.how.load': 'loading',

  // ── 后端 server.js 写下的行
  'boot.node.runtime': 'Node {ver} · {platform} {arch} · pid {pid} · ppid {ppid}',
  'boot.node.root': 'project root {root}',
  'boot.node.stale': 'boot.log holds {n} leftover line(s) from a previous run · not counted',
  // Config is per conversation now (there is no global one), so on describes the most recently used one
  'boot.llm.on': 'LLM connected · {host} · model {model} · protocol {proto} · key stored per conversation',
  'boot.llm.off': 'scanned {n} conversation archives, none configured → fill in the address and key when creating one (per conversation)',
  'boot.pack.count': '{packs} character packs · {moods} moods · {frames} frame files · {size}',
  'boot.pty.fail': '{bin} could not start ({err}) → real terminal /api/pty unavailable · pipe mode still works',
  'boot.pty.ok': '{out} · {bin} · probe {ms}ms · bridge server/ptybridge.py',
  'boot.sys.host': '{platform} {arch} · {host}\\{user} · CPU {cpu} ×{cores} · mem {mem}GB{disk}{gpu}',
  'boot.sys.diskUsed': ' · disk {used}/{total}GB {pct}%',
  'boot.sys.gpuMem': ' · GPU {util}% {used}/{total}MB',
  'boot.conv.count': 'run/conversations/ {n} archive(s) · latest {title}',
  'boot.conv.empty': 'run/conversations/ has no archives yet · starting an empty conversation',
  'boot.node.listen': 'listening on http://127.0.0.1:{port} · backend self-check {ms}ms',
  'boot.net.egress': 'public egress {ip} · {where} · {isp}{as}',
  'boot.net.unknownPlace': 'unknown location',
  'boot.net.unknownIsp': 'unknown ISP',
  'boot.net.empty': 'geo lookup returned nothing (fully usable offline · the globe panel just has fewer dots)',
  'boot.net.dns': 'DNS resolvers {n} · LAN fingerprint {fp}',
  'boot.net.error': 'geo lookup failed: {err}',
};
