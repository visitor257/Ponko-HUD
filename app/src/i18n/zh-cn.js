// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 简体中文包 —— 默认语言，也是**界面文案的原文**（其它语言缺哪条就落到 en.js，见 i18n/index.js）。
//
// ★ 为什么这个文件必须是"全的"：回退是"缺就用英文"（BASE.ui = en）。zh-cn 虽然叫"原文"，
//   但它同时也是一个语言包 —— 只要它缺一条 ui.*，中文界面上那条就会变成英文。
//   所以凡是进字典的 ui.* 在这里都得有，一条不能少（test_i18n.mjs 第 5 节钉着）。
//   boot.* 同理：本文件含 boot 段，简中下整屏启动日志才是中文。
// ★ 不进字典的（见 i18n/index.js 第 1 / 3 条）：模型 prompt、识别别名表（charpack 的 ALIAS）、
//   协议字段名、本来就写死英文的面板名（SHELL / AGENT / SYS / MOOD / GLOBE / GLOBE 的
//   NETLINK、DNS↑…）与单位（tok/s、GB、ms、ip）。IP、城市名、人名是数据，也不翻。
//
// 参数值写成 `@其它key` 时，渲染前会先被翻成那条 key 的译文（见 i18n/index.js）。
export default {
  // ── 界面：外框 / 状态行 / 按键提示 ────────────────────────────────────
  'ui.exit.idle': ' ✕ 退出 ',
  'ui.exit.armed': ' ✕ 再点一次 ',
  'ui.exit.quitting': ' ✕ 退出中… ',
  'ui.status.llmOn': 'local · 已接 LLM',
  'ui.status.llmOff': 'local · 未接 LLM',
  'ui.hint.zoomOn': '▚ 已放大 {panel} · 点右下角 〼 恢复分栏',
  'ui.hint.zoomOff': '▚ 焦点={focus} · 按住拖选文本 · 地球可拖 · 分割条可拖 · 框右下角 ⛶ 放大',
  // 热键条：`[^M]心情` 那一项已去掉 —— Ctrl+M 在 2026-10-17 随调试功能一起下线
  //（终端里 ^M 就是回车，容易误触）。热键条要跟着行为走，别留着一条按了没用的提示。
  'ui.hotkeys': '[TAB]切换 [^⏎]发送/回车换行 [ESC]退选/中断 [^⇧C]或[^C]复制 [^⇧T]新标签 [^Tab]切标签(随焦点) [^⇧Q]退出 [滚轮]滚动',

  // ── 底部提示条（toast）：只在"该说一声"的时候出现一下
  'ui.toast.noSelection': '没有选中内容',
  'ui.toast.copied': '已复制 {n} 字符',
  'ui.toast.copyFail': '复制失败',
  'ui.toast.lastConv': '最后一个对话不能关',
  'ui.toast.maxConv': '对话数已达上限',
  'ui.toast.maxTab': '标签数已达上限',
  'ui.toast.exitArm': '再点一次「退出」确认关闭 Ponko-HUD',
  'ui.toast.exiting': '正在退出 Ponko-HUD…',
  'ui.toast.exitManual': '无法自动关闭窗口 —— 请运行 stop.bat 退出',

  // ── 删对话的两步确认条（红条正文；{title} 是对话题目，属于数据）
  'ui.convdel.last': ' 清空对话「{title}」并删掉存档？只剩这一个了，会用一个新的空对话顶上  回车确认 · ESC 取消 ',
  'ui.convdel.one': ' 删除对话「{title}」并清掉存档？  回车确认 · ESC 取消 ',

  // ── SHELL 面板自己说的话（程序输出与命令回显不走字典，原样显示）
  'ui.shell.welcome': 'Ponko-HUD shell · 持久会话 · 输入 ponko-help 看可用命令',
  'ui.shell.unknownError': '未知错误',
  'ui.shell.ptyError': 'PTY：{msg}',
  'ui.shell.ptyExit': '终端已退出',
  'ui.shell.leftPty': '已退出真终端，回到管道模式。',
  'ui.shell.startingPty': '正在启动真终端…',
  'ui.shell.startingPtyNamed': '正在启动真终端：{name}…',
  'ui.shell.ptyHint': '（真终端让交互程序能用；Ctrl+Shift+E 退出）',
  'ui.shell.timeout': '命令超时（60s），已中断',
  'ui.shell.exitCode': '退出码 {code}',
  'ui.shell.interrupted': '^C 已中断',
  'ui.shell.cmdFailed': '上一条命令失败了',
  'ui.shell.shellError': 'shell 出错',
  'ui.shell.langCurrent': 'lang · 当前 lang_id {id} · 用法 lang <lang_id>',
  'ui.shell.langBad': 'lang · 没有这个语言包：{id}',
  'ui.shell.langDone': 'lang · 已切到 {id} · 当场生效 · 偏好也记住了',
  'ui.shell.help.title': 'Ponko-HUD 面板帮助 · 原生 help / Get-Help 未被占用，照常可用',
  'ui.shell.help.shell': '当前 shell：{kind}',
  'ui.shell.help.cmd': 'cmd / powershell   切换 shell（CMD 下 exit 先退回 PowerShell）',
  'ui.shell.help.exit': 'exit   结束本标签的 shell 并关闭该标签（最后一个会自动开个新的）',
  'ui.shell.help.clear': 'clear 清屏 · ESC 中断 · ↑/↓ 翻命令历史 · pty <cmd> 开真终端（任意程序都行）',
  'ui.shell.help.lang': 'lang [lang_id]   看/换界面语言（不带参数列出当前 lang_id 与可切换的 id）',
  'ui.shell.help.pty': '交互式程序（python / node / ssh / vim…裸跑）会自动开真终端',
  'ui.shell.help.keys': '真终端 = 按键直通：^C 中断 · ^D 结束输入 · ^E 退出终端',
  'ui.shell.help.tabs': '多标签：^⇧T 新建 · ^Tab 切换（各标签互相独立）· 关标签就在那个标签里打 exit',
  'ui.shell.help.tabs2': '         每个标签一个颜色（标签栏 / SHELL 右上角各一块），认颜色不认编号',
  'ui.shell.help.agent': 'AGENT 那边也有多标签对话，同一个 ^⇧T/^Tab 按「焦点」分派：焦点在 AGENT 时管对话',
  'ui.shell.help.agent2': '         对话自动存档，重启原样恢复；删对话不用键位 —— 在输入框里打 /del chat',
  'ui.shell.help.agent3': '         打字一样要过一道确认：红条出来之后按回车才真删、ESC 取消，开始打别的字也算取消',
  'ui.shell.help.boot': '启动时那屏刷的是真日志：宿主 + 后端的自检步骤与耗时，整份记录在 run/boot.log',

  // ── AGENT 面板
  'ui.agent.newConv': '新对话',
  'ui.agent.backendError': '后端错误：{msg}',
  'ui.agent.noBackend': '连不上 agent 后端',
  'ui.agent.aborted': '已中断',
  'ui.agent.placeholder': '输入内容...（Ctrl+回车发送）',
  'ui.agent.streaming': '流式输出中 · {rate} tok/s',
  'ui.agent.idle': '待机',
  'ui.agent.ready': '已就绪。左边敲 shell 命令，这儿直接跟我说话。',
  'ui.agent.cleared': '已清空 · 面板不能没有对话，所以换成了这个新的。想删就在输入框里打 /del chat（回车确认后才删）',
  'ui.agent.llmOn': '已接入 LLM（{model}），直接跟我说吧。',
  'ui.agent.formTitle': '⚙ 接入 LLM',
  'ui.agent.field.apiAddr': 'API地址',
  'ui.agent.field.apiKey': 'API Key',
  'ui.agent.field.model': '模型名',
  'ui.agent.field.provider': '协议',
  'ui.agent.field.charpack': '形象',
  // 性格：跟形象同一层（每个对话一份，随存档走）。这是**喂给模型的人设** ——
  // 决定它情绪表达的路子；「自然」= 不加人设（提示词本身已经写足"有情绪的人"）。
  // 选项 id 在 agent.js 的 PERSONA_OPTS，必须和 server/moodprotocol.js 的 PERSONAS 一一对应。
  'ui.agent.field.persona': '性格',
  'ui.agent.opt.personaDefault': '自然',
  'ui.agent.opt.personaTsundere': '傲娇',
  'ui.agent.opt.personaGenki': '元气',
  'ui.agent.opt.personaSarcastic': '毒舌',
  'ui.agent.opt.personaGentle': '温柔',
  'ui.agent.opt.auto': '自动识别',
  'ui.agent.opt.openai': 'OpenAI 兼容',
  'ui.agent.opt.anthropic': 'Anthropic',
  // 形象那一栏的「自动」：不是"挑第一个包"，而是保存时让配好的模型自己选一个
  'ui.agent.opt.charpackAuto': '自动',
  'ui.agent.form.pickArt': '正在让模型挑选形象…',
  'ui.agent.form.pickArtFail': '形象没挑成：{err} · 先用默认的（想重挑就再保存一次）',
  // 自动挑完之后落在对话里的那句（状态行一会儿就没了，这句留得住）
  'ui.agent.artAuto': '形象：{id}（{model} 自己挑的）',
  'ui.agent.form.hint': '填地址 / Key / 模型后回车保存（会先验证连通）',
  // 点「+」新建对话时弹的那张表单：只说"改动只影响这一个对话"。
  // **不写"已按上一个对话预填"** —— 预填的是**按 + 那一刻你正看着的那个对话**那份（见 agent.js 的
  // _llmOfTab），当前那个没配过就是空表单；一句话既说不准所有情况，也容易被读成"从别处抄了一份"
  // （2026-10-14 用户指出）。
  'ui.agent.form.hintNew': '新对话 · 这里的改动只影响这一个对话',
  'ui.agent.form.needBoth': '地址和 Key 都不能为空',
  'ui.agent.form.testing': '正在验证连接…',
  'ui.agent.form.testFail': '连接失败：{err}',
  'ui.agent.form.modelChecked': ' · 模型已核对',
  'ui.agent.verifyOk': '验证通过（{ms}ms{via}{pname}）✓ 已保存',
  'ui.agent.form.saveFail': '保存失败：缺少字段',
  'ui.agent.form.saveError': '保存出错：{err}',
  'ui.agent.form.hintSkip': '还没配 LLM：这个对话暂时发不出消息 · 输入 /llm 再把配置框叫回来',
  'ui.agent.form.keys': 'TAB/↑↓ 切换 · ←→ 改值 · 回车 保存 · 鼠标点击也可',
  'ui.agent.btn.testing': '[ 验证中 ]',
  'ui.agent.btn.save': '[  保存  ]',
  'ui.agent.btn.cancel': '[  取消  ]',
  'ui.agent.status.off': '未接LLM',
  'ui.agent.status.on': '已接入',

  // ── MOOD / 主题：状态名、来源标记、兜底说明
  // 心情的**名字**（待机/思考/…）不在语言包里 —— 它归角色素材包所有，
  // 见 characters/<pack>/frames/pack.json 的 moods.<标签>.label 与 mood.js 的 moodLabel()。
  // 下面这些是**状态说明**（本地兜底时才出现），不是心情名字，所以留在语言包里。
  'ui.mood.srcLocal': '本地兜底',
  'ui.mood.srcManual': '手动',
  'ui.mood.waiting': '等待 agent 接管',
  'ui.mood.manualOverride': '手动覆盖（调试）',

  // ── CHAR 面板：表情未收录标记 / 历史区标题
  //    （'loading…'、'mood N / 100' 本来就是英文，写死不进字典）
  //    这里原先还有一组 ui.char.style*（面板右上角标"高清立绘/点阵立绘/方块字符"）——
  //    2026-10-15 用户要求去掉，右上角不再显示画法，那组 key 一并删掉。
  'ui.char.missing': ' ✗未收录',
  // 'ui.char.history' 已删（2026-10-17 用户："情绪历史不需要"，那根曲线与它一起下线）

  // ── GLOBE 面板：状态行与图例（IP / 城市名是**数据**，不进字典、也不翻译）
  'ui.globe.decor': '装饰',
  'ui.globe.center': '中心 {deg}°',
  'ui.globe.noGeo': '未取到公网地理 · 离线或受限网络',
  'ui.globe.loading': '正在获取网络地理…',
  'ui.globe.notDirect': '从本机不可直连',
  'ui.globe.self': '本机 {ip}',
  'ui.globe.gateway': '网关 {gw}',

  // ── 启动画面：页面自己画的版式
  'boot.progress': '进度',
  'boot.pbar.info': ' {shown}/{total} · 后端 {backend}s · 日志 {server} 行来自 host/node，{live} 行来自页面',
  'boot.done': '启动完成 · 后端自检 {backend}s · 页面自检 {page}s · 日志 {logs} 行 · 交给 HUD',

  // ── 启动画面：页面自己记的日志行
  'boot.ui.bootlog': 'GET /api/bootlog · {ms} · {n} 行记录（pid {pid}）',
  'boot.ui.bootlog.fail': '取启动记录失败：{err}',
  'boot.ui.canvas': '画布 {w}×{h} @dpr{dpr} · 单元格 {cw}×{ch} · {cols}×{rows} 格',
  'boot.ui.engine': '渲染内核 {ua} · 逻辑核 {cores}',
  'boot.ui.engine.unknown': '未知',
  'boot.ui.layout': '布局完成 · {cols}×{rows} · {panels} 个面板 · {rects} 块矩形',
  'boot.ui.repaint': '整幅重绘 {ms}ms · {cells} 格',
  // 重启后画面跟关掉时一样：心情快照从 run/ui-state.json 还回来了
  'boot.ui.moodRestored': '恢复心情快照 {ms} · 此刻 {mood}',
  'boot.pack.loaded': '{id} 装载完成 · {n} 个表情 · 帧按需解码',
  'boot.pack.none': '没找到素材包 → 角色面板这次缺席',
  'boot.sys.ok': 'GET /api/sys {ms} · CPU {cpu}% · 内存 {used}/{total}GB {pct}%{disk}{gpu} · 开机 {up}h',
  'boot.sys.disk': ' · 系统盘 {pct}%',
  'boot.sys.gpu': ' · GPU {util}%',
  'boot.sys.fail': 'GET /api/sys 失败（{ms}）· 面板先用装饰数据顶着',
  'boot.net.ok': '地球定位 {ms} · {place} · 递归解析器 {dns} 个',
  'boot.net.nogeo': '无出口定位',
  'boot.net.fail': '地理查询失败（{ms}）→ 地球面板进装饰模式',
  'boot.conv.restored': '恢复 {n} 个对话 · 共 {msgs} 条消息',
  'boot.conv.none': '暂无存档 → 启动后是一个空对话',
  'boot.net.more': '启动记录补 {n} 行（回放期间新落盘的）',

  // ── 宿主 native_host.py 写下的行
  'boot.host.started': 'Ponko-HUD 宿主启动 · pid {pid} · Python {py}',
  'boot.host.fast': '--fast：跳过启动刷屏（?boot=0），直接进 HUD',
  'boot.host.already.raise': '已有实例在跑 → 抬起它的窗口，本次不再开新窗',
  'boot.host.already.ghost': '已有实例占着互斥体但找不到窗口 → 直接退出',
  'boot.host.mutex': '单实例互斥体 {id}.Mutex 已获取',
  'boot.host.nobackend': '--no-backend：假定后端已在跑，跳过拉起',
  'boot.host.nonode': '找不到 node.exe，无法启动后端 → 退出',
  'boot.host.taskbar': '任务栏身份 {id} 已登记（独立于浏览器）',
  'boot.host.pywebview': 'pywebview {ver} 装载 {ms}ms · 渲染引擎 WebView2（系统自带的 Edge 内核）',
  'boot.host.noicon': '缺 tools/assets/Ponko-HUD.ico → 窗口用系统默认图标',
  'boot.host.spawned': '已拉起后端进程 pid {pid} · server/server.js · 端口 {port}',
  'boot.host.node': 'node {ver} · {path}',
  'boot.host.shown': '窗口已显示 · 从宿主进程启动算起 {ms}ms',
  'boot.host.reuse': '{port} 端口已有后端在跑，直接复用（不再新起）',
  'boot.host.dead': '后端进程提前退出 → 真页面可能打不开（看 run/host.log 与 server 报错）',
  'boot.host.ready': '后端应答 HTTP 200 · 从拉起算起 {ms}ms → 窗口载入真页面',
  'boot.host.late': '后端 {s}s 内没应答，仍然载入（可能白屏）',
  'boot.host.win': '窗口已创建 · {mode} {w}x{h} · {how} · {url}',
  'boot.host.mode.windowed': '窗口化',
  'boot.host.mode.full': '全屏无边框',
  'boot.host.how.splash': '先显示占位页，后端就绪后载入',
  'boot.host.how.load': '载入',

  // ── 后端 server.js 写下的行
  'boot.node.runtime': 'Node {ver} · {platform} {arch} · pid {pid} · ppid {ppid}',
  'boot.node.root': '项目根 {root}',
  'boot.node.stale': 'boot.log 里另有 {n} 行上次启动的残留，不算进本次',
  // 配置是**每个对话一份**（不再有全局那份），所以 on 说的是"最近在用的那个对话接了什么"
  'boot.llm.on': '已接入 {host} · 模型 {model} · 协议 {proto} · Key 已存（每个对话一份）',
  'boot.llm.off': '扫过 {n} 个对话存档、都没配 → 在 AGENT 面板新建对话时填地址与 Key（每个对话一份）',
  'boot.pack.count': '{packs} 个素材包 · {moods} 个表情 · {frames} 个帧文件 · {size}',
  'boot.pty.fail': '{bin} 起不来（{err}）→ 真终端 /api/pty 不可用，管道模式照常',
  'boot.pty.ok': '{out} · {bin} · 探测 {ms}ms · 桥 server/ptybridge.py',
  'boot.sys.host': '{platform} {arch} · {host}\\{user} · CPU {cpu} ×{cores} · 内存 {mem}GB{disk}{gpu}',
  'boot.sys.diskUsed': ' · 系统盘 {used}/{total}GB {pct}%',
  'boot.sys.gpuMem': ' · GPU {util}% {used}/{total}MB',
  'boot.conv.count': 'run/conversations/ {n} 个存档 · 最近 {title}',
  'boot.conv.empty': 'run/conversations/ 暂无存档 · 启动后是一个空对话',
  'boot.node.listen': '监听 http://127.0.0.1:{port} · 后端自检共 {ms}ms',
  'boot.net.egress': '公网出口 {ip} · {where} · {isp}{as}',
  'boot.net.unknownPlace': '未知位置',
  'boot.net.unknownIsp': '未知 ISP',
  'boot.net.empty': '地理查询无结果（离线照常可用，地球面板只少打点）',
  'boot.net.dns': 'DNS 递归解析器 {n} 个 · 局域网指纹 {fp}',
  'boot.net.error': '地理查询失败：{err}',
};
