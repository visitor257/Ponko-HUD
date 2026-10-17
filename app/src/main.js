// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 主装配：布局 / 主循环 / 输入 / 鼠标
import { Grid, ATTR, rgb, mix } from './grid.js';
import { themeFor, MOOD_KEYS } from './theme.js';
import { Mood, moodLabel, moodView } from './mood.js';
import { loadPacks } from './charpack.js';
import { sysSnapshot, netgeo, bootLog, getUiState, saveUiState } from './api.js';
import { mkMoodSaver } from './uistate.js';
import { BootScreen } from './boot.js';
import { SysPanel } from './panels/sys.js';
import { ShellPanel } from './panels/shell.js';
import { AgentPanel } from './panels/agent.js';
import { CharPanel } from './panels/char.js';
import { GlobePanel } from './panels/globe.js';
import { Selection } from './selection.js';
import { exitButtonRect } from './exitbutton.js';
import { ZOOM_KEYS, PANEL_NAME, zoomBtnRect, fullRect } from './zoombtn.js';
import {
  ZOOM_DUR, zoomPhase, zoomEase, zoomAnimRect, zoomBorderMix,
  zoomSelfFade, zoomOtherFade, zoomOtherOrder,
} from './zoomanim.js';
import * as i18n from './i18n/index.js';

// 语言要在任何画面（含启动画面）之前定下来：?lang=xx 覆盖 > localStorage > 默认 zh-cn。
// 启动画面的文案走 boot.* → 默认英文（见 i18n/index.js）。
// 这里用命名空间导入而不是 `import { t }`：本文件已经有一个模块级的 `let t`（帧计时，见主循环），
// 直接 import t 会重复声明。
i18n.initLang();

const canvas = document.getElementById('screen');
const grid = new Grid(canvas, { fontSize: 15, lineHeight: 1.2 });
const hidden = document.getElementById('hidden-input');

// 克林贡文 pIqaD 的字形在私用区（U+F8D0 起），系统字体一个都没有，字体是自带的
// （app/assets/fonts，见 style.css 的 @font-face）。字体**异步**到，到了必须清一次
// 字符宽度缓存 —— 不然字体没到之前量到的"豆腐块宽度"会被 chWidth 记死（见 Grid.clearWidthCache）。
// 这里**故意不 await**：首屏不该为 16KB 字体停一下；字体一到下一帧就重排，顶多闪一两帧。
const piqadFont = (document.fonts && document.fonts.load)
  ? document.fonts.load('15px "pIqaD qolqoS"').catch(() => [])
  : Promise.resolve([]);
piqadFont.then(() => grid.clearWidthCache());

// 启动画面（eDEX-UI 那种开机刷屏）：每行都是本次运行真实发生的事，见 boot.js。
// ?boot=0 跳过（自动化验证用），?bootpace=N 改回放预算毫秒
let bootScr = null;
let bootWaiter = null;          // 等启动画面放完才开 HUD 进场动画
let bootFrames = 0;
let bootDrawLogged = false;     // 重绘耗时只记一次（而且要等日志回放进来了再记）

// 屏幕上的心情 = **当前对话**的那份（每个对话一份，见 AgentConv 的构造函数与 mood.js 的 moodView）。
// 全项目照旧 `mood.xxx` 地用：读写都实时落到 panels.agent.activeMood()，切标签自动换人。
// 所以这里只是**一层视图**，不要再往它身上存东西（存不住，切个标签就换了）。
// bootMood 只兜面板还没造好那一小段（本模块顶层 → panels 建完之前）。
// ⚠ 这个 getter 只在真正绘制 / 写盘时才跑，那时 panels 已经建好了；别在面板的构造函数里读它。
const bootMood = new Mood();
const mood = moodView(() => (panels && panels.agent && panels.agent.activeMood()) || bootMood);
// 心情快照的落盘（关掉再开，配色和立绘要跟退出前一样）。
// 闸门在 saver 那边：**seed() 之前一笔都不写** —— 开机那一刻 mood 还是默认待机，
// 抢着存就会把盘上那份好快照盖成待机（正好是这次要修的症状的反面）。
// 所以下面这趟"读快照 → 恢复（或确认没有）"走完之前，主循环里的 pump() 是空转的。
const moodSaver = mkMoodSaver((snap) => { saveUiState({ mood: snap }); });
/** 读快照这一趟走完（拿到快照或确认没有）→ 把当前状态记成基准并开闸，之后才允许写盘 */
function moodBooted(snap) {
  if (moodSaver.primed) return false;
  const ok = !!(snap && snap.mood) && mood.restore(snap.mood);
  moodSaver.seed(mood);
  return ok;
}
const panels = {
  sys: new SysPanel(),
  globe: new GlobePanel(),
  shell: new ShellPanel(mood),
  agent: new AgentPanel(),          // 心情挂在对话身上，面板不再接一份全局 mood（见 AgentConv）
  char: null,                       // 等素材包加载完再建
};
panels.agent._clearHidden = () => { hidden.value = ''; };   // 关闭配置框时清空隐藏输入框
panels.agent.onConvClosed = afterConvClosed;                // /del chat 关掉对话后收拾界面
panels.agent.onDelAsk = () => armConvClose();               // /del chat 命中：先弹红条，回车才真删
// 形象：① agent 要知道现在有哪些包（配置框的候选项）② 形象一变就换立绘。
// 这两件事只有主装配知道（packs / panels.char 都在这儿），agent.js 不认识它们。
panels.agent.getPacks = () => packs.map((p) => ({ id: p.id, name: p.name || p.id }));
panels.agent.onArtChange = applyConvArt;
// 调试/端到端验证入口：__panels 给面板对象，__grid 给字符缓冲（chs 是**逐格的字符**，
// 端到端要核对"屏幕上到底写了什么字"只能从这儿读 —— canvas 里的文字读不出来）。
if (typeof window !== 'undefined') { window.__panels = panels; window.__grid = grid; }

// ── 换语言后"立刻看见变化"是靠这两件事，不需要重启 ──
//   ① 静态文案（框线标题、状态行、按键提示、心情名、toast、标签名…）本来就是**每帧现取**
//      （`t()` 写在 draw 里）→ 下一帧自动就是新语言；
//   ② 面板里已经推进行缓冲的**历史行**存的是 key（pushT），得在这儿主动重译一遍 ——
//      真程序输出/agent 正文的行没有 key，原样不动（那是内容，不该翻）。
// 以前没有这条订阅，`lang` 切完屏上什么都不变，看起来就像"没生效"。
i18n.onLangChange(() => {
  panels.shell.retranslate();
  panels.agent.retranslate();
});
let packs = [], pack = null;

// 布局
//   左上 GLOBE │ 中上 SHELL │ 右列 MOOD + SYS(右下)
//   下半 AGENT 横跨左+中两列（延伸至最左），贴地
const L = { left: 34, right: 30, topH: 0.5 };
let rects = {};
let dragSplit = null;
const SPLIT_W = 1;
const SYS_H = 8;                  // 右下 SYS 小格高度
const CHROME_TOP = 2, CHROME_BOT = 2;   // 顶栏 / 底部提示各占的行数（放大态也保留）
let zoom = null;                  // 被放大到全屏的面板 key（null = 正常分栏）
let zoomHits = [];                // 每帧登记的「放大/还原」按钮命中区
let zoomAnim = null;              // 放大/还原的过场：{ key, dir, t, from, to }（非 null 时由它接管画面）
let zoomDur = ZOOM_DUR;           // 过场时长（秒），?zoomanim=N 可覆盖（调试用）
let baseRects = {};               // 还没顾上 zoom 时的原始分栏（动画起止要用它的矩形）

function layout() {
  const cols = grid.cols, rows = grid.rows;
  const topH = CHROME_TOP, botH = CHROME_BOT;
  const y0 = topH, mainH = rows - topH - botH;
  const midW = Math.max(20, cols - L.left - L.right - SPLIT_W * 2);
  const lx = 0, cx = L.left + SPLIT_W, rx = cx + midW + SPLIT_W;
  const rightW = Math.max(10, cols - rx);

  const halfH = Math.max(6, Math.floor((mainH - 1) * L.topH));
  // 右列：MOOD 在上，SYS 压成底部一小格（空间不够时只保 MOOD）
  const sysH = Math.max(0, Math.min(SYS_H, mainH - 16));
  const charH = mainH - sysH - (sysH > 0 ? 1 : 0);

  rects = {
    globe: { x: lx, y: y0, w: L.left, h: halfH },
    shell: { x: cx, y: y0, w: midW, h: halfH },
    agent: { x: lx, y: y0 + halfH + 1, w: cx + midW - lx, h: mainH - halfH - 1 },
    char: { x: rx, y: y0, w: rightW, h: charH },
    sys: { x: rx, y: y0 + charH + 1, w: rightW, h: sysH },
    s1: { x: L.left, y: y0, w: SPLIT_W, h: halfH },              // 只在上半（下半被 AGENT 横跨）
    s2: { x: rx - SPLIT_W, y: y0, w: SPLIT_W, h: mainH },
    hsplit: { x: lx, y: y0 + halfH, w: cx + midW - lx, h: 1 },
  };
  // 存档一份「没被放大」的原始分栏：还原动画的终点就是这里面的那个矩形。
  // 必须在下面被 zoom 覆盖之前存 —— 否则放大态下读到的已经是全屏矩形，点还原就原地不动了。
  baseRects = {};
  for (const k in rects) baseRects[k] = { ...rects[k] };
  for (const k in panels) {
    const p = panels[k];
    if (!p) continue;
    p.layout(rects[k]);
    const r = rects[k];
    // 进场动画：按宽高比决定展开方向——横框（宽≥高）左右展开，竖框（高>宽）上下展开
    if (r && r.w >= 4 && r.h >= 3) p.orient = (r.w >= r.h) ? 'h' : 'v';
    if (p.open === undefined) { p.open = 0; p.delay = OPEN_DELAY[k] ?? 0; p.contentFade = 0; }
  }
  // 放大态：把这个框的 rect 换成整个内容区（其它框的 rect 保持原样，只是不画）
  if (zoom && rects[zoom] && panels[zoom]) {
    const full = fullRect(grid, CHROME_TOP, CHROME_BOT);
    rects[zoom] = full;
    panels[zoom].layout(full);
    panels[zoom].orient = (full.w >= full.h) ? 'h' : 'v';
  }
}

// ── 单框放大：点框右下角的按钮把它拉满整个内容区，再点还原 ──
//
// 点下去不是"一帧到位"，而是走一整套过场（顺序见 zoomanim.js 顶部）：
//   放大 〔其它框由近及远依次淡出 + 内容淡出〕→〔位移〕→〔内容淡入〕
//   还原 〔内容淡出〕→〔位移〕→〔其它框由远及近依次淡入 + 内容淡入〕
// 逻辑态（焦点、底部提示）当场就切，不用等动画。
// 过场途中再点不接第二单 —— 那段里框的位置每帧都在变，命中区也跟着漂，
// 这时候去点一定会点歪（宁可吞掉这下点击）。
function toggleZoom(key) {
  if (!panels[key] || zoomAnim) return;
  const full = fullRect(grid, CHROME_TOP, CHROME_BOT);
  const base = baseRects[key] || full;
  selection.clear();          // 选区是画在正文上的，别让它跟过场同时在屏幕上
  // 其它框的出场次序按「离它多近」排：都用分栏态的矩形算，放大/还原两趟才对称
  const others = zoomOtherOrder(key, ZOOM_KEYS, baseRects);
  if (zoom === key) {
    const from = { ...(rects[key] || full) };
    zoomAnim = { key, dir: -1, t: 0, from, to: { ...base }, others };
  } else {
    const from = { ...(baseRects[key] ? baseRects[key] : full) };
    zoomAnim = { key, dir: 1, t: 0, from, to: { ...full }, others };
    zoom = key;
    // 不弹"已放大"：框已经吃满整个内容区了，右下角那个按钮也从 ⛶ 变成 〼，
    // 这两件事本身就是回执。再打一行字是把已经看得见的变化又说一遍。
    if (key === 'shell' || key === 'agent') focus = key;
  }
}

/** 过场走完：把 rect 落到终态，交还给面板自己画 */
function finishZoom() {
  const a = zoomAnim;
  zoomAnim = null;
  zoom = a.dir > 0 ? a.key : null;
  layout(); syncHidden();
  const p = panels[a.key];
  // 内容在最后的「淡入」段已经浮完了（见 drawZoomTransition），这里别再打回 0 重来一次
  if (p) p.contentFade = 1;
}

/** 立刻结束进行中的过场（ resize 之类必须马上用新布局的场合） */
function snapZoom() {
  if (zoomAnim) finishZoom();
}

/** 画各框右下角的 □ / 〼 按钮（在面板之后画，盖在底边线上）
 *  符号只有 1~2 格，所以平常态用比底边线亮一档的 lineHi 当底色，免得糊在 '─' 里看不见。 */
function drawZoomButtons(T) {
  zoomHits = [];
  // 过场中那个框还在移动，按钮会跟着一路漂（位置每帧都变，点了也点不准）→ 先撤掉
  if (zoomAnim) return;
  for (const k of ZOOM_KEYS) {
    const p = panels[k];
    if (!p || !p.rect) continue;
    if (zoom && zoom !== k) continue;                 // 放大态只画被放大那个框的按钮
    if ((p.open === undefined ? 1 : p.open) < 1) continue;   // 进场动画期间框还没成形
    const r = p.rect;
    if (r.w < 10 || r.h < 3) continue;                // 太小的框（比如被压扁的 SYS）不放按钮
    const on = zoom === k;
    const b = zoomBtnRect(grid, r, on);
    zoomHits.push({ x0: b.x0, x1: b.x1, y: b.y, key: k });
    grid.text(b.x0, b.y, b.label, on ? T.bg : T.dim, on ? T.accent : T.lineHi);
  }
}

function zoomBtnAt(c) {
  for (const h of zoomHits) if (c.y === h.y && c.x >= h.x0 && c.x <= h.x1) return h.key;
  return null;
}

// ── 焦点：SHELL 与 AGENT 共用一条隐藏输入线（IME 友好）
let focus = 'agent';
let prevPty = false;                 // 上一帧是否处于真终端模式（用于进入时自动把焦点给 shell）
function activeInputPanel() { return focus === 'shell' ? panels.shell : panels.agent; }

// ── 物理 Ctrl 键跟踪（左右都认）
//
// 为什么不能只看 e.ctrlKey：2026-10-18 用户报「Ctrl+Enter 发送，但只限左 Ctrl，右 Ctrl 没反应」。
// 端到端实测过：同一个浏览器里 ControlLeft / ControlRight 的 keydown 字段**一模一样**
// （只有 location 1/2 的区别，Enter 上都是 ctrlKey=true），代码路径本身没有偏袒左边。
// 所以问题只可能出在"事件送到页面之前"—— 右 Ctrl 在不少中文输入法里被设成中英文切换，
// 会被 IME 先一步吃掉；也可能被报成 AltGr。记一下物理键，Enter 那边就有第二道判据。
//
// ⚠ 必须挂**捕获**阶段：下面 #hidden-input 的 keydown 是冒泡，晚了也拿不到。
// ⚠ 失焦要清：keyup 可能落在别的窗口里，收不到就永远"按着 Ctrl"，之后 Enter 全变成发送。
let ctrlHeld = false;
const isCtrlKey = (e) => e.key === 'Control' || e.code === 'ControlLeft' || e.code === 'ControlRight';
window.addEventListener('keydown', (e) => { if (isCtrlKey(e)) ctrlHeld = true; }, true);
window.addEventListener('keyup', (e) => { if (isCtrlKey(e)) ctrlHeld = false; }, true);
window.addEventListener('blur', () => { ctrlHeld = false; });
document.addEventListener('visibilitychange', () => { if (document.hidden) ctrlHeld = false; });

// 配置框：把隐藏输入框内容同步到当前字段（字段态写值，按钮态清空）
function syncCfgHidden() {
  const a = panels.agent;
  // 换了字段就把光标挪到该字段末尾（点选/切换都算），否则上任字段的位置会串过来
  if (a._cfgIdx !== a.form.idx) { a._cfgIdx = a.form.idx; a.formCaretToEnd(); }
  // 循环字段（协议）不接受文本输入，靠 ←→ 切换，所以这里要把它清空
  if (a.form.idx >= 0 && a.form.idx < a.form.fields.length && a.cfgFieldEditable()) {
    hidden.value = a.form.fields[a.form.idx].value || '';
    // 原生光标也对到 form.caret，按退格/方向键时两边才在同一位置
    const pos = Math.max(0, Math.min(hidden.value.length, a.form.caret || 0));
    try { hidden.setSelectionRange(pos, pos); } catch (e) { /* 某些浏览器对 type 敏感 */ }
  } else hidden.value = '';
}

function syncHidden() {
  // 配置框编辑态：隐藏输入框内容由 syncCfgHidden 维护，位置仍贴在 agent 输入行即可
  if (focus === 'agent' && panels.agent.inConfig) {
    syncCfgHidden();
    panels.shell.focus = false;
    panels.agent.focus = true;
    return;
  }
  const p = activeInputPanel();
  const r = p.rect;
  if (!r) return;
  // agent 输入框可以是多行（Enter 换行），隐藏框要跟着长高并从输入框顶端对齐
  const rows = (p === panels.agent && !panels.agent.inConfig) ? panels.agent.inputRows(grid) : 1;
  const iy = p === panels.shell ? r.y + r.h - 2 : r.y + r.h - 3 - (rows - 1);
  hidden.style.left = grid.px(r.x + 1) + 'px';
  hidden.style.top = grid.py(iy) + 'px';
  hidden.style.width = Math.max(40, grid.px(r.x + r.w - 1) - grid.px(r.x + 1)) + 'px';
  hidden.style.height = grid.cellH * rows + 'px';
  hidden.style.fontSize = grid.fontSize + 'px';
  panels.shell.focus = focus === 'shell';
  panels.agent.focus = focus === 'agent';
}

// ── 真终端按键 → 控制序列（xterm 惯例，等同 eDEX-UI 交给 xterm.js 的那一套）
const PTY_KEYS = {
  Enter: '\r', Tab: '\t', Escape: '\x1b', Backspace: '\x7f',
  Delete: '\x1b[3~', Insert: '\x1b[2~',
  Home: '\x1b[H', End: '\x1b[F',
  PageUp: '\x1b[5~', PageDown: '\x1b[6~',
  ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
  F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS',
  F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~',
  F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~',
};

// 真终端输入：把隐藏输入框里刚攒下的一小段立刻倒进 PTY 并清空（做句柄是为了
// compositionend 和 input 两条路径复用同一份逻辑，避免中文被送两次或丢尾巴）
function drainToPty() {
  if (focus !== 'shell' || !panels.shell.inPty()) return;
  const typed = hidden.value;
  if (typed) panels.shell.ptyType(typed);
  hidden.value = '';
}

hidden.addEventListener('input', (e) => {
  // 开始打别的字 = 已经走开了 —— 作废挂着的删对话确认。
  // 这道保护很要紧：红条上写着"回车确认"，而这条输入框平时回车/^⏎就是"发消息"；
  // 要是打了半句话再按发送，结果把对话删了，那是事故不是功能。
  // 作废就是作废，不再回一句"你取消了" —— 红条自己消失了就是回执，那行红比这行字显眼得多。
  if (convClose) convClose = null;
  // 配置框编辑态：把隐藏输入框的内容写进当前字段（按钮态不接受文本）
  if (focus === 'agent' && panels.agent.inConfig) {
    const a = panels.agent;
    if (a.form.idx >= 0 && a.form.idx < a.form.fields.length && a.cfgFieldEditable()) {
      a.form.fields[a.form.idx].value = hidden.value;
    } else hidden.value = '';          // 按钮态/循环字段：文本一律丢弃
    return;
  }
  // 真终端模式：不在本地攒行。隐藏输入框只当 IME 合成面，敲/合成出来一个字符就立刻
  // 倒进 PTY（eDEX-UI 就是 xterm.onData → pty.write），回显与行编辑交给 shell 自己。
  if (focus === 'shell' && panels.shell.inPty()) {
    // 合成中先不动：IME 还没定稿，此刻送进去的是拼音串。真正的结果是 compositionend /
    // 随后的 input 事件，那时再把整段中文倒进 PTY。
    if (e && e.isComposing) return;
    drainToPty();
    return;
  }
  const p = activeInputPanel();
  p.input = hidden.value;
  p.caret = hidden.selectionStart ?? p.input.length;
  // 多行内容可能是粘贴进来的（没走 Enter 那条路），输入框高度得跟着变
  if (focus === 'agent' && !panels.agent.inConfig) syncHidden();
});
// 心情调试的**触发键**（Ctrl+M：循环切下一个心情）默认关掉。
// 为什么连入口一起关：终端里 ^M 就是回车，很容易误触；而界面上那几处痕迹现在都藏了，
// 误触就成了"没来由地自己变脸"，比显示出来还糟（用户 2026-10-17 问的「手动 · 生气」
// 多半就是这么来的）。调试时改 true —— 界面那半边在 char.js 的 SHOW_MOOD_CHIPS。
// `?mood=` 启动参数不受影响：要手改 URL 才用得上，不可能误触。
const MOOD_DEBUG_KEY = false;

hidden.addEventListener('keydown', (e) => {
  // 删对话的确认摆在最前面：这条确认一旦弹出，回车/ESC 的语义就临时改成"确认/取消"，
  // 别的分支（发送消息、中断、翻历史）都不该跟它抢。焦点不在 agent 上时自动作废。
  if (convClose) {
    if (focus !== 'agent') convClose = null;
    else if (!e.isComposing && e.key === 'Enter') { e.preventDefault(); confirmConvClose(); return; }
    else if (!e.isComposing && e.key === 'Escape') {
      e.preventDefault(); convClose = null; return;    // 红条消失就是回执，不另弹一行
    }
  }
  // 复制键在 window 捕获阶段统一处理（见 copySel 下方），这里不再重复。
  // 配置框编辑态：拦截 Tab/↑↓/Enter/Esc 走表单导航；其余按键（含中文 IME）照常进隐藏输入框
  if (focus === 'agent' && panels.agent.inConfig) {
    const a = panels.agent;
    if (e.isComposing) return;
    if (e.key === 'Tab' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); a.configNav(e.key === 'ArrowUp' ? -1 : 1); syncCfgHidden();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // ←→ 只管"协议"那种循环字段；文本字段（地址/Key/模型名）必须放行，
      // 否则 hidden input 收不到这两个键，光标在值里面根本挪不动。
      if (a.cfgCycleField()) {
        e.preventDefault(); a.configCycle(e.key === 'ArrowLeft' ? -1 : 1); syncCfgHidden();
      }
      // 文本字段：不 preventDefault，交给原生输入框移动光标（keyup 会把位置同步进 form.caret）
    } else if (e.key === 'Enter') {
      e.preventDefault(); a.configEnter(); syncCfgHidden();
    } else if (e.key === 'Escape') {
      // 交给 configCancel 统一处理：新建对话时按 ESC = 撤销新建（删掉刚建的那个标签）；
      // 编辑已有对话时按 ESC = 老样子（配好了就关，没配好不许关）。
      e.preventDefault(); a.configCancel();
    }
    return;
  }
  // ── 真终端：裸直通。只有 Ctrl+Shift+E 留给界面（退出真终端），其余按键一律按真实
  //    终端序列转发 —— python REPL 的补全/历史、vim、top、ssh 才真的能用。
  if (focus === 'shell' && panels.shell.inPty()) {
    if (e.isComposing) return;                        // IME 合成中不抢
    if (e.ctrlKey && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
      e.preventDefault();
      panels.shell.leavePty('ui.shell.leftPty');
      return;
    }
    // Alt+字符 → ESC + 字符（xterm 的 meta 惯例）
    if (e.altKey && !e.ctrlKey && e.key.length === 1) {
      e.preventDefault();
      panels.shell.ptyKey('\x1b' + e.key);
      return;
    }
    // Ctrl+字母 → 标准控制码 ^A..^Z（^C 中断 / ^D EOF / ^L 清屏 / ^R 反搜 / ^A ^E 行首行尾…）
    if (e.ctrlKey && !e.altKey && /^[a-zA-Z]$/.test(e.key)) {
      e.preventDefault();
      panels.shell.ptyKey(String.fromCharCode(e.key.toLowerCase().charCodeAt(0) - 96));
      return;
    }
    const seq = PTY_KEYS[e.key];
    if (seq !== undefined) { e.preventDefault(); panels.shell.ptyKey(seq); return; }
    // 可打印字符：就在 keydown 里转发，不等 input 事件。
    // 原因是中文 IME 开启时浏览器会把字母吞进合成缓冲 —— keydown 的 keyCode 变成 229、
    // e.key 变成 'Process'，input 事件根本不发（或被 isComposing 挡掉），于是"打字没反应，
    // 只有标点（IME 直接上屏的那些）能进"。这里绕开 input：非 IME 的按键按 e.key 直接送。
    if (e.keyCode !== 229 && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
      e.preventDefault();
      panels.shell.ptyType(e.key);
      return;
    }
    // 到这儿只剩"IME 正在处理"这一种情况：交给 composition 事件（见下方监听器）
  }
  const p = activeInputPanel();
  if (e.isComposing) return;
  if (e.key === 'Enter') {
    // AGENT 聊天输入框：Enter = 换行（交给 textarea 原生插入，input 事件会同步进面板），
    // Ctrl+Enter / Alt+Enter 才发送。shell 命令行仍然是 Enter 直接执行。
    //
    // 判据不能只看 e.ctrlKey：右 Ctrl 被输入法吃掉、或被系统报成 AltGr 时，Enter 上可能
    // 根本没带 ctrlKey —— 那样"右 Ctrl+Enter"会退化成普通 Enter（= 换行），看着就是
    // "右 Ctrl 没反应"（2026-10-18 报的）。ctrlHeld 是物理键那道兜底。
    // Alt+Enter 留作备用发送键：Alt 基本不会被输入法占用。
    const sendMod = e.ctrlKey || e.altKey || ctrlHeld;
    if (focus === 'agent' && !panels.agent.inConfig && !sendMod) {
      syncHidden();                      // 输入框长高一行，隐藏框跟着贴住
      return;
    }
    e.preventDefault();
    const text = hidden.value;
    hidden.value = ''; p.input = ''; p.caret = 0;
    if (focus === 'shell') panels.shell.exec(text);
    else panels.agent.send(text);
    syncHidden();                        // 发送后输入框缩回一行
  } else if (e.key === 'Tab') {
    e.preventDefault();
    // 管道模式下 Tab 是**补全**（跟任何 shell 一样）：输入框里有东西就补，空行才是老行为
    // （切焦点）—— 于是"Tab 切面板"那条肌肉记忆还在，但不会再把正在打的命令吃掉。
    // 真终端根本走不到这儿：上面裸直通那一段已经把 \t 发给程序了，补全归程序自己。
    if (focus === 'shell' && !panels.shell.inPty() && panels.shell.input.trim()) {
      const sh = panels.shell;
      const tab = sh.tab;
      sh.tabComplete().then((changed) => {
        // 等回包这几毫秒里可能已经切走标签 / 切了焦点 —— 那就别往隐藏输入框里写别人的字
        if (!changed || focus !== 'shell' || sh.tab !== tab) return;
        hidden.value = sh.input;
        try { hidden.setSelectionRange(sh.caret, sh.caret); } catch (err) { /* 忽略 */ }
        syncHidden();
      });
      return;
    }
    focus = focus === 'shell' ? 'agent' : 'shell';
    hidden.value = activeInputPanel().input;
    syncHidden();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (selection.active) { selection.clear(); return; }   // 有选区时先退选，别把 Esc 误当成中断
    if (focus === 'shell') panels.shell.abort(); else panels.agent.abort();
  } else if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
    // 终端惯例：Ctrl+C = 中断。真终端里转发 ^C 给 PTY（杀当前程序），
    // 管道模式里中止正在跑的命令；agent 面板则停止生成。
    e.preventDefault();
    if (focus === 'shell') panels.shell.abort(); else panels.agent.abort();
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const dir = e.key === 'ArrowUp' ? 1 : -1;
    const p = focus === 'shell' ? panels.shell : panels.agent;
    p.onArrow(dir);
    // 面板可能改了输入（shell 翻历史）：同步到隐藏输入框，回车才发得出翻出来的命令
    if (!(focus === 'agent' && panels.agent.inConfig)) {
      hidden.value = p.input || '';
      try { hidden.setSelectionRange(hidden.value.length, hidden.value.length); } catch (err) { /* 忽略 */ }
    }
  }
  // Ctrl+M = 循环切心情（调试入口，默认关，见文件上方 MOOD_DEBUG_KEY）
  if (MOOD_DEBUG_KEY && e.ctrlKey && (e.key === 'm' || e.key === 'M')) {
    e.preventDefault();
    const i = MOOD_KEYS.indexOf(mood.key);
    mood.force(MOOD_KEYS[(i + 1) % MOOD_KEYS.length]);
  }
});

// IME 定稿（中文/日文候选落地）：立刻把最终整段文本送进真终端。
// 光靠 input 事件不行——合成期间的 input 会把拼音串当正文发出去。
// ── 中文 IME：合成期间在终端光标处显示拼音预览（不发给程序，拼音不是正文），
//    定稿（compositionend）才把最终文本送进 PTY。这是 xterm.js / VSCode 的做法。
// 只移动光标的按键（←→ / Home / End / 鼠标点击）**不产生 input 事件**，
// 所以面板的 caret 永远停在最后一次输入的位置 —— 渲染出来的 █ 就一直贴在末尾。
// 这些时机单独捞一次 selectionStart 补上。
function syncCaretFromHidden() {
  if (focus === 'agent' && panels.agent.inConfig) { panels.agent.syncFormCaret(hidden.selectionStart); return; }
  if (focus === 'shell' && panels.shell.inPty()) return;      // 真终端光标由 VT 自己管
  const p = activeInputPanel();
  if (!p) return;
  const n = (p.input || '').length;
  p.caret = Math.max(0, Math.min(n, hidden.selectionStart ?? n));
}
for (const ev of ['keyup', 'click', 'select']) hidden.addEventListener(ev, syncCaretFromHidden);

hidden.addEventListener('compositionstart', () => {
  if (focus === 'shell' && panels.shell.inPty()) panels.shell.ime = '';
});
hidden.addEventListener('compositionupdate', (e) => {
  if (focus === 'shell' && panels.shell.inPty()) panels.shell.ime = e.data || '';
});
hidden.addEventListener('compositionend', (e) => {
  if (focus === 'shell' && panels.shell.inPty()) {
    const t = (e && e.data) || hidden.value || '';
    if (t) panels.shell.ptyType(t);
    panels.shell.ime = null;
    hidden.value = '';
    return;
  }
  drainToPty();
});

const selection = new Selection();      // 鼠标拖选（详见 selection.js）
/**
 * 左下角那一行提示。**只报"看不见的东西"，不报"已经看得见的变化"** ——
 * 删了对话（标签栏少一个，看得见）、放大/还原了（框都撑满了，看得见）、切了标签
 * （标签栏自己高亮了，看得见）都不该在这儿说一句；界面已经在说的事，再打一行字
 * 就是噪音。留着的只有三类不看不知道的：
 *   · 你按了但没发生（"最后一个对话不能关" / "标签数已达上限"）—— 得说为什么；
 *   · 屏幕外发生的操作结果（"已复制 N 字符" / "复制失败"）—— 否则不知道成没成；
 *   · 要你再动一下的（"再点一次「退出」确认" / "正在退出…"）。
 */
/**
 * 底部提示条（toast）。存的是**语言包 key + 参数**，绘制时现取现翻 —— 存成品句子的话，
 * 切语言那一刻屏上还挂着的那条提示会留在旧语言里。只有三类会用它（见上面那段说明）。
 */
let selToast = { key: '', args: null, until: 0 };
/** 记一条提示：key 是 ui.toast.* 里的某条 */
function toast(key, args, ms) { selToast = { key, args: args || null, until: performance.now() + ms }; }
// 删对话的两步确认（打了 /del chat 之后）：回车才真删、ESC 取消。关错了可没有回收站可找。
let convClose = null;                   // { id, title, until }
// 顶部右上角「退出」按钮：命中区（列范围，行 0）+ 两步确认时间戳
let exitBtn = { x0: -1, x1: -1, y: -1 };
let quitArmed = 0;
let quitting = false;        // 已确认退出：按钮定格在「退出中…」，后续点击一律忽略

async function copySel() {
  const text = selection.text(grid);
  if (!text) { toast('ui.toast.noSelection', null, 1200); return; }
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (e) { ok = false; }
  // 退回 execCommand。要点是**先 focus 再 select**：WebView2 里元素没焦点时
  // execCommand('copy') 会静默返回 false（不抛异常），看起来就是"复制没反应"。
  if (!ok) {
    const prev = document.activeElement;
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.top = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      try { ta.setSelectionRange(0, ta.value.length); } catch (e0) { /* 忽略 */ }
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e2) { ok = false; }
    try { if (prev && prev.focus) prev.focus(); } catch (e3) { /* 忽略 */ }
  }
  if (ok) toast('ui.toast.copied', { n: text.length }, 1600);
  else toast('ui.toast.copyFail', null, 1600);
}

// 复制快捷键统一挂 window 的**捕获阶段**。
// 之前挂在 #hidden-input 上，拖选之后焦点不一定还在它身上（点画布、拖分割条都会挪），
// 于是"选了却复制不了"。挂到 window 捕获就与焦点无关了，也早于 PTY 的裸直通逻辑。
//   · ^⇧C / Ctrl+Insert —— 永远复制（无选区则提示"没有选中内容"）
//   · ^C —— **有选区时 = 复制**（与 Windows Terminal 一致：选中状态下 ^C 是复制，
//          无选区才落回终端的中断语义）。这样用户的第一直觉 Ctrl+C 就是能用的。
window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.altKey || e.metaKey) return;
  const isC = e.key === 'c' || e.key === 'C';
  const explicit = (e.shiftKey && isC) || e.key === 'Insert';
  const plainC = !e.shiftKey && isC;
  if (!explicit && !(plainC && selection.active)) return;
  e.preventDefault(); e.stopPropagation();   // 拦住 PTY 裸直通，别让 ^C 又变成中断
  copySel();
}, true);

// 多标签终端 + 多标签对话：^⇧T 新建 / ^Tab、^⇧Tab 切换 —— **按焦点分派**：
// 焦点在 SHELL 就是终端标签，焦点在 AGENT 就是对话标签。Tab 键切换焦点，所以
// "我现在在哪个面板里，快捷键就管哪个面板的标签"这条规矩不用记第二套。
// 同样挂捕获阶段 —— 点过画布或标签栏之后焦点未必还在隐藏输入框上，挂在它身上会漏键。
// 切标签不播报：标签栏上那个色块已经挪了位、当前标签也自己亮了，
// 焦点框线也跟着过去了 —— 眼睛看到的就是答案，左下角再说一遍只是噪音。
function afterTabChange() {
  focus = 'shell';
  convClose = null;                     // 换到 shell 了，删对话的确认自然作废
  hidden.value = panels.shell.input || '';
  syncHidden();
}

function afterConvChange() {
  focus = 'agent';
  convClose = null;
  hidden.value = panels.agent.input || '';
  syncHidden();
  applyConvArt();        // 立绘跟着当前对话的形象走（每个对话一份，见 applyConvArt）
}

/**
 * 让右侧立绘跟着**当前对话**的形象走。
 *
 * 形象是**每个对话一份**的（`tab.charpack`）：选了具体包就用它；选「自动」就用那个对话的模型
 * 挑出来的那个包（`tab.charpackPicked`）；两者都没定（自动但还没挑过、或那个包被删了）
 * → 回退默认包（第一个），保证立绘区永远有东西可画。
 * 三个时机要叫它：切标签、配置保存完（含"自动"挑完）、启动恢复完。
 */
function applyConvArt() {
  if (!panels.char) return;
  const want = panels.agent.artId();
  const p = (want && packs.find((x) => x.id === want)) || pack;
  panels.char.setPack(p);
  // faces 挂在**每个对话自己的那份心情**上（心情现在是每对话一份）：所以不能只在
  // "包真的换了"时才灌 —— 切到另一个对话、包恰好相同的情况也要灌，否则那个对话的
  // "✗未收录"提示会失效（faces 是空的 → faceOk() 一律放行）。
  if (p) mood.setFaces(p.tags());
}

/**
 * 删对话的确认：先弹红条，红条上回车才真删（ESC 取消）。
 * 唯一入口是**在输入框里打 /del chat**（打字表达的是"想删哪个"，不是"现在立刻删"）——
 * 键盘快捷键那条路（^⇧W）2026-10-13 已按用户要求删掉：删对话这件事必须打得出来，
 * 不靠一手滑就生效的键位。
 * 只剩一个对话时也是"清空并换成一个新的空对话"（面板没有"零个对话"这个状态），
 * 同样是毁数据、同样要确认 —— 红条上把这次会发生什么说清楚。
 */
function armConvClose() {
  const a = panels.agent;
  const t = a.tab;
  if (!t) return;
  convClose = { title: t.title(), last: a.tabs.length <= 1, until: performance.now() + 6000 };
}

/** 红条上回车：真删。确认条是唯一的入口（打 /del chat），执行点就这一个 */
function confirmConvClose() {
  const a = panels.agent;
  convClose = null;
  // delChat = 关掉当前对话；只剩一个时它会先建一个新的再关旧的（面板不能空着）。
  // 收拾界面（焦点、隐藏输入框）与回执统一由 afterConvClosed 做。
  if (!a.delChat()) toast('ui.toast.lastConv', null, 1600);
}

/**
 * 对话被关掉/换掉之后，主装配要跟着收拾一遍：作废可能挂着的确认条、
 * 把隐藏输入框接到（新的）当前对话上。
 * 这儿**不给回执** —— 标签栏少一个（或换成新的空对话）就是回执，看得见的事不重复说。
 * （agent.js 那边仍会报 `onConvClosed(label, kind)`，留着给别处用。）
 */
function afterConvClosed() {
  convClose = null;
  focus = 'agent';
  hidden.value = panels.agent.input || '';
  syncHidden();
  applyConvArt();        // 换成了另一个对话 → 立绘也要跟着换
}

window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.altKey || e.metaKey) return;
  const k = e.key;
  const onAgent = focus === 'agent';
  if (e.shiftKey && (k === 'T' || k === 't')) {
    e.preventDefault(); e.stopPropagation();
    if (onAgent) {
      // 传 true = 用户主动新建：建好就弹配置框，并用当前对话那份配置预填
      if (!panels.agent.newTab(true)) { toast('ui.toast.maxConv', null, 1600); return; }
      afterConvChange();
      return;
    }
    if (!panels.shell.newTab()) {
      toast('ui.toast.maxTab', null, 1600);
      return;
    }
    afterTabChange();
    return;
  }
  // （这里原来还有 ^⇧W 关标签 / 删对话 —— 2026-10-13 按用户要求删掉：
  //   关标签在标签里打 exit，删对话在输入框里打 /del chat，都不占键位。）
  if (k === 'Tab') {                       // ^Tab 下一个 / ^⇧Tab 上一个
    e.preventDefault(); e.stopPropagation();
    if (onAgent) { if (panels.agent.nextTab(e.shiftKey ? -1 : 1)) afterConvChange(); return; }
    if (panels.shell.nextTab(e.shiftKey ? -1 : 1)) afterTabChange();
    return;
  }
  if (e.shiftKey && (k === 'Q' || k === 'q')) {   // ^⇧Q 退出（与右上角按钮同样的两步确认）
    e.preventDefault(); e.stopPropagation();
    requestQuit();
    return;
  }
}, true);

function drawToast(g, T, now) {
  if (!selToast.key || now > selToast.until) return;
  g.text(0, g.rows - 1, ` ${i18n.t(selToast.key, selToast.args)} `, T.panel, T.accent);
}

/**
 * 删对话的确认条：占满底部提示那一行（比普通 toast 更醒目 —— 这是要毁数据的一步）。
 * 顺带在这里做过期检查：屏幕上看不见的确认不该还拦着回车。
 */
function drawConvConfirm(g, T, now) {
  if (!convClose) return false;
  if (now > convClose.until) { convClose = null; return false; }
  // 只剩一个的方式不一样（换成新的空对话），红条上就别说得含糊
  const msg = i18n.t(convClose.last ? 'ui.convdel.last' : 'ui.convdel.one', { title: convClose.title });
  let s = '', w = 0;
  for (const ch of msg) {                  // 窗口太窄就截断，别让文字溢出画布
    const cw = g.chWidth(ch);
    if (w + cw > g.cols) break;
    s += ch; w += cw;
  }
  g.fill(0, g.rows - 1, g.cols, 1, ' ', T.bg, T.err);
  g.text(0, g.rows - 1, s, T.bg, T.err);
  return true;
}

// ── 退出应用：顶部右上角有个「✕ 退出」按钮（全屏无边框窗口没有标题栏，得给个出口）──
// 两步确认：第一次点只是"待确认"，3 秒内再点一次才真的退，防止误触把 HUD 关掉。
// 按下第二步后按钮切成「退出中…」并**一直保持**（不再变回「退出」，也不再吃点击）——
// 退出本身是异步的（要等 JS 桥、还要等后台收尾），期间按钮如果显示成「退出」，
// 看起来就像"我刚才那一下没生效"。
function requestQuit() {
  if (quitting) return;
  const now = performance.now();
  if (quitArmed && now - quitArmed < 3000) { quitArmed = 0; doQuit(); return; }
  quitArmed = now;
  toast('ui.toast.exitArm', null, 3000);
}

async function doQuit() {
  quitting = true;                         // 先切态：下一帧按钮就是「退出中…」
  quitArmed = 0;
  // 关窗前把防抖窗口里还没落盘的对话补上，并给它一点点时间跑完这次本地 POST
  // （不等的话，桥一关请求就被掐断，最后聊的那几句会丢）
  try { panels.agent.flushSaves(); await new Promise((r) => setTimeout(r, 120)); } catch (e) { /* 尽力而为 */ }
  toast('ui.toast.exiting', null, 8000);
  // 1) 原生窗口（pywebview + WebView2）：走宿主暴露的 JS 桥关掉窗口 —— 干净的退出路径，
  //    窗口一销毁 webview.start 就返回，宿主在 finally 里顺手把 node 后端也收掉。
  //    桥是页面加载后异步注入的，本机实测大约在 start() 后 2s 就绪，所以给它 3s 慢慢等
  //    （pywebview 造 api 时要扫一遍 js_api，宿主那边出问题时正是卡在这一步 —— 那种情况
  //     这里会老老实实超时，落到下面的兜底提示，不会假装"退出了"）。
  for (let i = 0; i < 30; i++) {
    const api = window.pywebview && window.pywebview.api;
    if (api && typeof api.quit === 'function') {
      try { await api.quit(); return; } catch (e) { /* 桥报错 → 落到兜底 */ }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // 2) 兜底：Edge --app 启动路径没有桥，让窗口关自己
  try { window.close(); } catch (e) { /* 忽略 */ }
  // 兜底也失败 → 回到可点击状态，别让按钮永远卡在「退出中…」骗人
  quitting = false;
  toast('ui.toast.exitManual', null, 8000);
}

// ── 鼠标：拖拽分割条 / 拖地球 / 点表情标签 / 滚轮
function cellAt(e) {
  const b = canvas.getBoundingClientRect();
  return { x: grid.gx(e.clientX - b.left), y: grid.gy(e.clientY - b.top) };
}
function inRect(r, c) { return r && c.x >= r.x && c.x < r.x + r.w && c.y >= r.y && c.y < r.y + r.h; }

/**
 * 面板内的单击（不是拖选）：切焦点，并把光标放到点击的那一列。
 * 之所以挪到 mouseup 再判 —— 按下 = 起选区（可能是拖选），松手时若压根没拖动过才算"点"。
 * PTY 模式例外：终端画面里的光标由 VT 自己管，别抢。
 */
// explicit >= 0 时用它（多行输入框已经自己算好了字符下标）
function placeCaret(p, iy, x0, c, explicit) {
  const ci = explicit === undefined || explicit === null
    ? Math.max(0, Math.min((p.input || '').length, c.x - x0))
    : Math.max(0, Math.min((p.input || '').length, explicit));
  p.caret = ci;
  hidden.value = p.input || '';
  try { hidden.selectionStart = hidden.selectionEnd = ci; } catch (e) { /* 忽略 */ }
}
function clickPanel(hit, c) {
  if (hit === 'shell') {
    focus = 'shell';
    const s = panels.shell;
    if (!s.inPty()) {
      const r = s.rect;
      if (r && c.y === r.y + r.h - 2) placeCaret(s, c.y, r.x + 1 + grid.strWidth(s.prompt), c);
    }
    syncHidden();
    return;
  }
  focus = 'agent';
  const a = panels.agent;
  if (a.inConfig) { a.configMouse(c); syncHidden(); return; }
  const ci = a.caretFromPoint(grid, c.x, c.y);      // 多行输入框：点哪落在哪个字符
  if (ci !== null) placeCaret(a, 0, 0, c, ci);
  syncHidden();
}
canvas.addEventListener('mousedown', (e) => {
  // 过场中：框还在位移，命中区每帧都在漂 —— 这时候点哪儿都可能点歪，干脆不接
  if (zoomAnim) return;
  const c = cellAt(e);
  // 顶部右上角「退出」按钮（chrome 栏，不属于任何面板）
  if (exitBtn.y === 0 && c.y === 0 && c.x >= exitBtn.x0 && c.x <= exitBtn.x1) {
    e.preventDefault();
    requestQuit();
    return;
  }
  // 各框右下角的「放大 / 还原」按钮（在底边线上，优先于框内的一切操作）
  const zb = zoomBtnAt(c);
  if (zb) { e.preventDefault(); toggleZoom(zb); return; }
  hidden.focus();
  // AGENT 标签栏也在框**外**（框顶线上面那一行）。分栏态下那一行正好是横向分割条，
  // 所以这里必须排在 hsplit 之前：点在标签上 = 切对话，点在空处才落回"拖分割条"。
  const ar = rects.agent;
  if ((!zoom || zoom === 'agent') && ar && c.y === panels.agent.tabBarRow() && c.x >= ar.x && c.x < ar.x + ar.w) {
    const i = panels.agent.tabAt(c.x, c.y);
    if (i !== null) {
      focus = 'agent';
      convClose = null;
      // 点「+」→ newTab(true)：建好就弹配置框（拿当前对话那份配置预填，见 agent.js）
      if (i === -1) panels.agent.newTab(true);
      else panels.agent.selectTab(i);
      hidden.value = panels.agent.input || '';
      syncHidden();
      applyConvArt();                     // 鼠标点标签切对话，跟 ^Tab 走同一条收尾
      e.preventDefault();
      return;
    }
  }
  // 放大态：分割条跟被盖住的框都不该再响应（它们的 rect 还在，但屏幕上没有）
  if (!zoom) {
    if (inRect(rects.s1, c)) { dragSplit = { k: 's1', x: c.x }; return; }
    if (inRect(rects.s2, c)) { dragSplit = { k: 's2', x: c.x }; return; }
    if (inRect(rects.hsplit, c)) { dragSplit = { k: 'h', y: c.y }; return; }
  }
  if ((!zoom || zoom === 'globe') && panels.globe.hit(c.x, c.y)) { panels.globe.onDown(c.x, c.y); return; }
  if ((!zoom || zoom === 'char') && panels.char) {
    // 点心情标签 = 手动覆盖，属于**调试入口**：默认那排标签不画（char.js 的 SHOW_MOOD_CHIPS），
    // 于是 chipAt 恒返回 null，这里自然不生效。留着是为了开发时把标签打开就能点。
    const key = panels.char.chipAt(c.x, c.y);
    if (key) { mood.force(key); return; }
  }
  // SHELL 标签栏在框**外**（顶线上方那一行），不在 rects.shell 里 —— 单独命中：
  // 点标签切过去、点 “+” 新开一个（都不动输入光标，也就无需走选区那套）
  const sr = rects.shell;
  if ((!zoom || zoom === 'shell') && sr && c.y === panels.shell.tabBarRow() && c.x >= sr.x && c.x < sr.x + sr.w) {
    const i = panels.shell.tabAt(c.x, c.y);
    focus = 'shell';
    if (i === -1) panels.shell.newTab();
    else if (i !== null && i >= 0) panels.shell.selectTab(i);
    hidden.value = panels.shell.input || '';
    syncHidden();
    e.preventDefault();
    return;
  }
  // 放大态下点哪都只算被放大那个框（其它框没画出来，选区不能落到它们身上）
  const hit = zoom
    ? (inRect(rects[zoom], c) ? zoom : null)
    : (inRect(rects.shell, c) ? 'shell' : inRect(rects.agent, c) ? 'agent' : null);
  if (!hit || (hit !== 'shell' && hit !== 'agent')) return;
  // SHELL / AGENT 面板正文：先起选区。到底是拖选还是单击，等松手时看有没有拖动过。
  selection.begin(c, rects[hit], hit);
  // 到底是拖选还是单击，松手时由 selection.end() 判定（见下方 mouseup）
  e.preventDefault();          // 别让浏览器起原生文本/元素拖拽，抢走 mousemove
});
window.addEventListener('mousemove', (e) => {
  // 松手发生在窗口外时会漏掉 mouseup：按钮已弹起就顺便收尾，免得选区一直跟着鼠标长
  if (selection.drag && !e.buttons) selection.end();
  if (!dragSplit && !panels.globe.dragging && !selection.drag) return;
  const c = cellAt(e);
  if (selection.drag) { selection.to(c); if (!dragSplit && !panels.globe.dragging) return; }
  if (dragSplit) {
    if (dragSplit.k === 's1') L.left = Math.max(20, Math.min(grid.cols - 40, L.left + (c.x - dragSplit.x)));
    else if (dragSplit.k === 's2') {
      const d = c.x - dragSplit.x;
      L.right = Math.max(20, Math.min(grid.cols - 50, L.right - d));
    } else if (dragSplit.k === 'h') {
      const d = c.y - dragSplit.y;
      L.topH = Math.max(0.2, Math.min(0.8, L.topH + d / Math.max(1, grid.rows - 5)));
    }
    layout(); syncHidden();
    dragSplit.x = c.x; dragSplit.y = c.y;
    return;
  }
  panels.globe.onMove(c.x, c.y);
});
window.addEventListener('mouseup', () => {
  // end() 返回 true = 这次按下压根没拖动，按"单击"处理（切焦点 / 挪光标）；
  // 拖出选区时返回 false，此时别动光标，否则选着文字光标却跑掉了
  const wasClick = selection.drag ? selection.end() : false;
  if (wasClick && selection.tag) clickPanel(selection.tag, selection.at);
  dragSplit = null; panels.globe.onUp();
});
canvas.addEventListener('wheel', (e) => {
  if (zoomAnim) return;                     // 过场中先别滚（框还在移动，滚给谁说不清）
  const c = cellAt(e);
  // 放大态：滚轮只给被放大那个框（放大 GLOBE 时在地球上面滚就不该滚到 SHELL 的历史）
  const p = zoom
    ? ((zoom === 'shell' || zoom === 'agent') ? panels[zoom] : null)
    : (inRect(rects.shell, c) ? panels.shell : inRect(rects.agent, c) ? panels.agent : null);
  if (p && p.onWheel(e.deltaY)) { e.preventDefault(); return; }
  if ((!zoom || zoom === 'globe') && panels.globe.hit(c.x, c.y)) {
    if (panels.globe.onWheel(e.deltaY, e.deltaX)) e.preventDefault();
  }
}, { passive: false });

// ── 主循环
let sys = null, last = performance.now(), t = 0, fps = 0;
// 进场动画起点（performance.now 时钟）。初值 Infinity 是刻意的：启动画面还没放完时
// 万一有一帧漏进常规绘制路径，elapsed 会是负数 → 所有面板都停在"没展开"，不会闪一下全开。
let bootAt = Infinity;
let openDur = 0.55;            // 每个面板“框从中心向外展开”的时长（秒），?bootdur=N 可覆盖
let contentDur = 0.5;          // 框展开后“内容淡入”的时长（秒），随 ?bootdur 同步
const OPEN_DELAY = { globe: 0, shell: 0.12, char: 0.06, sys: 0.2, agent: 0.16 };
let tokWindow = [], tokRate = 0;
setInterval(() => { tokRate = tokWindow.length; tokWindow = []; }, 1000);   // 粗估 tok/s
async function pollSys() {
  try { sys = await sysSnapshot(); } catch (e) { /* 后端没起来就保持上次数据 */ }
  setTimeout(pollSys, 1000);
}

// ── 网络地理：本机公网出口 + DNS 递归解析器，交给 GLOBE 面板打点
async function pollNet() {
  let delay = 5 * 60 * 1000;
  try {
    const g = await netgeo();
    panels.globe.setGeo(g);
    // 后端刚起来 / 网络正连着时数据还没到，下次早点补
    if (!g.self || !(g.dns || []).length) delay = 15000;
  } catch (e) { delay = 15000; }   // 后端没起来：装饰模式顶着，很快再试
  setTimeout(pollNet, delay);
}

// shell 输出里冒出来的公网 IP → 在地球上点一下（eDEX 的原版交互）
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
function looksPublic(ip) {
  const m = ip.match(/^(\d+)\.(\d+)\./);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  return true;
}
function scanIps(line) {
  const found = line.match(IP_RE);
  if (!found) return;
  for (const ip of found) {
    if (!looksPublic(ip)) continue;
    panels.globe.noteIp(ip);          // 面板内部去重 + 打后端地理查询
  }
}

// ── 进场动画：面板框从中心向两侧 / 上下展开，展开完成后才画内容 ──
function drawOpeningBox(g, r, o, orient, T) {
  if (!r || r.w < 2 || r.h < 2) return;
  let bx, by, bw, bh;
  if (orient === 'h') {                  // 横框：宽度从中心向左右展开，高度已满
    const cx = r.x + Math.floor(r.w / 2);
    bw = Math.max(1, Math.round(r.w * o));
    bx = cx - Math.floor(bw / 2);
    by = r.y; bh = r.h;
  } else {                               // 竖框：高度从中心向上下展开，宽度已满
    const cy = r.y + Math.floor(r.h / 2);
    bh = Math.max(1, Math.round(r.h * o));
    by = cy - Math.floor(bh / 2);
    bx = r.x; bw = r.w;
  }
  g.fill(bx, by, bw, bh, ' ', T.accent, T.panel);   // 实心面板从中心“长”出来
  if (bw >= 2 && bh >= 2) {
    g.set(bx, by, '┌', T.accent, T.panel);
    g.set(bx + bw - 1, by, '┐', T.accent, T.panel);
    g.set(bx, by + bh - 1, '└', T.accent, T.panel);
    g.set(bx + bw - 1, by + bh - 1, '┘', T.accent, T.panel);
    g.text(bx + 1, by, '─'.repeat(bw - 2), T.accent, T.panel);
    g.text(bx + 1, by + bh - 1, '─'.repeat(bw - 2), T.accent, T.panel);
    for (let yy = by + 1; yy < by + bh - 1; yy++) {
      g.set(bx, yy, '│', T.accent, T.panel);
      g.set(bx + bw - 1, yy, '│', T.accent, T.panel);
    }
  }
}
/**
 * @param fade     额外压上去的整体可见度（过场里用它把退场的框淡掉）
 * @param fadeBg   fade 往哪个底色收（默认是 panel：内容淡进面板底色；
 *                 过场时传 T.bg —— 整块连底色带边框一起淡掉，溶进屏幕背景）
 * @param fadeAll  true = 连底色和边框一起淡（退场的框用它，否则只剩一地空色块）
 */
function drawPanel(p, g, C, fade, fadeBg, fadeAll) {
  if (!p) return;
  const o = (p.open === undefined) ? 1 : p.open;
  if (o < 1) {                           // 展开中：只画框（边框清晰），不画内容；easeOut 让框“冲出后收住”
    drawOpeningBox(g, p.rect, 1 - (1 - o) * (1 - o), p.orient || 'h', C.theme);
    return;
  }
  // 展开完成：边框已经清晰，内容再“淡入”（颜色从融进背景渐变到正常）
  const own = (p.contentFade === undefined || p.contentFade >= 1) ? 1 : p.contentFade;
  g.fadeBg = fadeBg !== undefined ? fadeBg : C.theme.panel;
  g.fadeAll = !!fadeAll;
  g.fade = fade === undefined ? own : own * fade;
  p.draw(g, C);
  if (p === panels.char && p.ensureFrame) p.ensureFrame(Math.min(rects.char.w - 2, 40), t);
  g.fadeAll = false;                     // 复位，避免影响分割条 / 标题栏
  g.fade = 1;
}

// ── 单框放大 / 还原的过场画面 ────────────────────────────────────────────
// 一次过场分三段依次走（顺序见 zoomanim.js 顶部）：
//   out   其它框错开淡出（放大时）+ 主角内容淡出
//   move  主角框位移，只带框不带内容
//   in    主角内容淡入（还原时还要把其它框错开淡回来）
function drawSplit(T) {
  for (const k of ['s1', 's2']) {
    const r = rects[k];
    if (!r) continue;
    for (let y = r.y; y < r.y + r.h; y++) grid.set(r.x, y, '│', T.line, T.bg);
  }
  const hr = rects.hsplit;
  if (hr) grid.text(hr.x, hr.y, '╌'.repeat(hr.w), T.line, T.bg);
}

/** 位移中的那个框：实心面板底 + 描边（描边色最后一段从 accent 收回正常线色） */
function drawZoomBox(g, r, T, e) {
  if (!r || r.w < 2 || r.h < 2) return;
  const fg = mix(T.accent, T.line, zoomBorderMix(e));
  g.fill(r.x, r.y, r.w, r.h, ' ', fg, T.panel);
  const X2 = r.x + r.w - 1, Y2 = r.y + r.h - 1;
  g.set(r.x, r.y, '┌', fg, T.panel, 0, true);
  g.set(X2, r.y, '┐', fg, T.panel, 0, true);
  g.set(r.x, Y2, '└', fg, T.panel, 0, true);
  g.set(X2, Y2, '┘', fg, T.panel, 0, true);
  if (r.w > 2) {
    g.text(r.x + 1, r.y, '─'.repeat(r.w - 2), fg, T.panel);
    g.text(r.x + 1, Y2, '─'.repeat(r.w - 2), fg, T.panel);
  }
  for (let y = r.y + 1; y < Y2; y++) {
    g.set(r.x, y, '│', fg, T.panel, 0, true);
    g.set(X2, y, '│', fg, T.panel, 0, true);
  }
}

function drawZoomTransition(T, C) {
  const a = zoomAnim;
  const { seg, p } = zoomPhase(a.dir, a.t);
  const n = a.others.length;

  // ① 其它框：放大时在 out 段依次退场，还原时在 in 段依次回来。
  //    每个框有**自己的**进度（错开的），所以必须逐个设 fade 逐个画 ——
  //    共用一个 fade 值就成了"一起淡"，正是这套节奏要避免的。
  const othersOn = (a.dir > 0 && seg === 'out') || (a.dir < 0 && seg === 'in');
  if (othersOn && n > 0) {
    grid.fadeAll = true;                  // 连底色带边框一起溶进背景，不留空色块
    for (let i = 0; i < n; i++) {
      const f = zoomOtherFade(a.dir, seg, p, i, n);
      if (f <= 0.02) continue;            // 已经没了 / 还没轮到
      drawPanel(panels[a.others[i]], grid, C, f, T.bg, true);
    }
    // 分割条跟着最后一个框走：它是"分栏"这个结构本身，框都让位了才轮到它
    const fs = zoomOtherFade(a.dir, seg, p, n - 1, n);
    if (fs > 0.02) {
      grid.fadeBg = T.bg; grid.fade = fs; drawSplit(T); grid.fade = 1;
    }
    grid.fadeAll = false;
  }

  // ② 主角框
  if (seg === 'move') {                   // 位移段：只带框，不带内容
    drawZoomBox(grid, zoomAnimRect(a.from, a.to, zoomEase(p)), T, p);
    return;
  }
  const pnl = panels[a.key];
  if (!pnl) return;
  // out 段待在原位、in 段已经在终位 —— 两段里框都是静止的，内容按它排不会抖
  const r = seg === 'out' ? a.from : a.to;
  pnl.layout(r);
  grid.fadeBg = C.theme.panel;
  grid.fade = zoomSelfFade(seg, p);       // 只压内容：边框走 nofade，框本身始终清晰
  pnl.draw(grid, C);
  if (pnl === panels.char && pnl.ensureFrame) pnl.ensureFrame(Math.min(r.w - 2, 40), t);
  grid.fade = 1;
}

function drawChrome(T) {
  const cols = grid.cols, rows = grid.rows;
  const model = panels.agent && panels.agent.llmConfigured ? i18n.t('ui.status.llmOn') : i18n.t('ui.status.llmOff');
  const left = '▚ PONKO-HUD   GLOBE · SHELL · AGENT · MOOD · SYS';
  grid.text(0, 0, left, T.accent, T.bg);

  // 右上角：退出按钮（全屏无边框窗口没有系统标题栏，这里补一个出口）。
  // 三态（平常 / 待确认 / 退出中）**共用同一个宽度**，短的那句居中补空格 ——
  // 否则「再点一次」一出现按钮就变长、左边界往回缩，看着像在抖（详见 exitbutton.js）。
  // 待确认用琥珀色、退出中用深色（表示"已经按下去了，别再点"）。
  const armed = quitArmed && performance.now() - quitArmed < 3000;
  const exit = exitButtonRect(grid, quitting ? 'quitting' : armed ? 'armed' : 'idle');
  exitBtn = { x0: exit.x0, x1: exit.x1, y: 0 };
  grid.text(exit.x0, 0, exit.label, quitting ? T.dim : T.bg, quitting ? T.line : armed ? T.warn : T.err);

  const host = sys ? `${sys.user}@${sys.host}` : 'offline';
  const clock = new Date().toTimeString().slice(0, 8);
  let right = `${host}   ${clock}   ${fps | 0}fps`;
  grid.text(Math.max(0, exit.x0 - 2 - grid.strWidth(right)), 0, right, T.dim, T.bg);
  grid.text(0, 1, '─'.repeat(grid.cols), T.line, T.bg);

  const by = rows - 2;
  grid.text(0, by, '─'.repeat(cols), T.line, T.bg);
  const f = focus === 'shell' ? 'SHELL' : 'AGENT';
  const tip = zoom
    ? i18n.t('ui.hint.zoomOn', { panel: PANEL_NAME[zoom] || zoom })
    : i18n.t('ui.hint.zoomOff', { focus: f });
  // 右边键位提示先占右侧，左边状态提示从 0 画 —— 两者重叠时后画的 keys 会**覆盖** tip 的后半，
  // 效果等于"tip 自动裁到 keys 左边"，不用手工截断（网格是字符网格，覆盖就是覆盖）。
  const keys = i18n.t('ui.hotkeys');
  grid.text(0, by + 1, tip, T.dim, T.bg);
  grid.text(Math.max(0, cols - grid.strWidth(keys)), by + 1, keys, T.darker, T.bg);
}

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now; t += dt;
  fps = fps * 0.9 + (1 / Math.max(1e-3, dt)) * 0.1;
  mood.tick(dt);
  // 心情变了就排一次落盘（去抖；签名里不含 value，所以不是每帧都在写）。
  // 这里**不管启动画面有没有在放** —— 启动期 agent 不会动心情，代价是一次字符串比较。
  // 还没开闸（读快照那趟没回来）时它是空转的，见 moodSaver 那段注释。
  moodSaver.pump(mood);

  const T = themeFor(mood.key);

  // 启动画面期间：整幅画面交给它，HUD 一个像素都还没画（这样"刷屏 → 开框"是两段真事）
  if (bootScr && bootScr.active) {
    bootScr.advance(now);
    bootScr.draw(grid, T, now);        // now 传进去：最后那段整屏淡出按同一个时钟走
    const tDraw = performance.now();
    grid.render();
    // 整幅重绘耗时是真数字，但要等启动记录回放进来之后再记 —— 否则它会被排在整屏
    // 日志的最前面（那几帧画的是还没内容可画的启动画面），看着像"第一行就是渲染耗时"
    bootFrames++;
    if (!bootDrawLogged && bootFrames >= 3 && bootScr.serverCount > 0) {
      bootDrawLogged = true;
      bootScr.log('ui', i18n.t('boot.ui.repaint', {
        ms: (performance.now() - tDraw).toFixed(1), cells: grid.cols * grid.rows,
      }));
    }
    if (bootScr.done && bootWaiter) { const r = bootWaiter; bootWaiter = null; r(); }
    requestAnimationFrame(frame);
    return;
  }

  grid.clear(T.text, T.bg);
  grid.fill(0, 0, grid.cols, grid.rows, ' ', T.text, T.bg);

  const C = { theme: T, sys, mood, t, dt, tokRate };
  // 进入真终端时自动把输入焦点切到 shell：否则字会打到 AGENT 输入框（以前踩过这个坑）
  const inPtyNow = panels.shell.inPty();
  if (inPtyNow && !prevPty) { focus = 'shell'; syncHidden(); }
  prevPty = inPtyNow;
  // 进场动画：推进每个面板的展开进度（easeOut，框冲出后收住）
  const elapsed = (now - bootAt) / 1000;
  for (const k in panels) {
    const p = panels[k];
    if (!p || p.open === undefined) continue;
    if (p.open < 1) {
      const local = Math.max(0, elapsed - (p.delay || 0));
      p.open = Math.min(1, local / openDur);
    } else if (p.contentFade !== undefined && p.contentFade < 1) {
      p.contentFade = Math.min(1, p.contentFade + dt / (p.fadeDur || contentDur));
    }
  }
  // 放大态：只画被放大那一个框，其余连同分割条都不画（它们的 rect 还在，但屏幕上没有）
  if (zoomAnim) {
    zoomAnim.t = Math.min(1, zoomAnim.t + dt / zoomDur);
    if (zoomAnim.t >= 1) finishZoom();     // 到位 → 交还常规绘制路径，内容开始淡入
  }
  if (zoomAnim) {
    drawZoomTransition(T, C);            // 过场期间整幅画面由它接管
  } else if (zoom) {
    drawPanel(panels[zoom], grid, C);
  } else {
    drawPanel(panels.sys, grid, C);
    drawPanel(panels.globe, grid, C);
    drawPanel(panels.shell, grid, C);
    drawPanel(panels.agent, grid, C);
    drawPanel(panels.char, grid, C);
  }

  // 分割条
  if (!zoom && !zoomAnim) drawSplit(T);

  drawChrome(T);
  // SHELL / AGENT 的标签栏都画在框顶线**之上**（框外），必须晚于 chrome 的分隔线 ——
  // 否则那行 '─' 会盖掉它们。AGENT 的那一行在分栏态下就是横向分割条，所以它在
  // 鼠标判定里也必须排在分割条前面（见 canvas 的 mousedown）。
  grid.fadeBg = T.panel;
  if (!zoomAnim && (!zoom || zoom === 'shell') && panels.shell.open >= 1) {
    grid.fade = (panels.shell.contentFade === undefined || panels.shell.contentFade >= 1) ? 1 : panels.shell.contentFade;
    panels.shell.drawTabBar(grid, C);
  }
  if (!zoomAnim && (!zoom || zoom === 'agent') && panels.agent.open >= 1) {
    grid.fade = (panels.agent.contentFade === undefined || panels.agent.contentFade >= 1) ? 1 : panels.agent.contentFade;
    panels.agent.drawTabBar(grid, C);
  }
  grid.fade = 1;
  drawZoomButtons(T);   // 各框右下角的放大/还原按钮（盖在底边线上，所以必须最后画）
  selection.paint(grid);   // 选区反色：必须在所有面板画完之后、render 之前
  // 删对话的确认条比普通 toast 更优先：它是要毁数据的一步，别被别的提示盖住
  if (!drawConvConfirm(grid, T, now)) drawToast(grid, T, now);
  grid.render();

  requestAnimationFrame(frame);
}

// ── 启动
//
// 两段：先在画布上刷一遍**真实**的启动日志（宿主/后端哪一步做了什么 + 页面自己这一步
// 做了什么），放完再开 HUD 的进场动画。日志内容与来源见 boot.js 顶部注释。
async function boot() {
  const q = new URLSearchParams(location.search);
  const bd = parseFloat(q.get('bootdur'));   // 调试：?bootdur=N 拉长/缩短进场动画（默认 0.55s）
  if (!Number.isNaN(bd) && bd > 0) { openDur = bd; contentDur = bd; }
  const zd = parseFloat(q.get('zoomanim'));  // 调试：?zoomanim=N 拉长放大/还原过场（默认 0.3s）
  if (!Number.isNaN(zd) && zd >= 0) zoomDur = zd;
  // ?mood=think          手动覆盖（调试）
  // ?local=1             shell 成败允许反向影响心情（默认关闭：那是 agent 的活）
  //
  // （原来还有一个 ?nofallback=1，用来关掉"长时间无活动→瞌睡"。那条兜底已经整个删掉了 ——
  //   心情只由 agent 改，见 mood.js 文件头 —— 开关自然也就没了。）
  //
  // ⚠ 它们落在**当前对话**的心情上（心情每个对话一份）。这会儿点的是那个起手对话，
  //   而 restore() 随后会把标签整体换掉 —— 所以读档收尾还得再点一次（见文件后半段）。
  const dbgMood = q.get('mood') || '';
  const dbgLocal = q.get('local') === '1';
  const applyMoodDebug = () => {
    if (dbgMood) mood.force(dbgMood);
    if (dbgLocal) mood.localSignals = true;
  };
  applyMoodDebug();

  // 启动画面：?boot=0 跳过（自动化验证用）；?bootpace=N 改回放预算（毫秒）
  const pace = parseFloat(q.get('bootpace'));
  if (q.get('boot') !== '0') {
    bootScr = new BootScreen(grid, Number.isNaN(pace) ? {} : { budget: pace });
    bootScr.begin();
  }
  const blog = (tag, text) => { if (bootScr) bootScr.log(tag, text); };
  const msec = (t0) => `${(performance.now() - t0).toFixed(0)}ms`;

  // ⓪ 心情快照 + 落在哪个对话：重启后画面要跟关掉时**一样**（配色、立绘、停在哪个对话）。
  //    起手就发出去、谁都不挡 —— 本地后端，几十毫秒就回来了，正好赶在启动画面放完之前。
  //    ?mood=xxx 是明确指定，那就以它为准，不去读盘（也不让盘上那份盖掉它）。
  //    **一趟请求两处用**：这里决定心情，⑤ 恢复对话那一段决定激活哪个标签（见 uiStateP）。
  //    带超时：后端没起来 / 请求卡住时按"没有快照"走 —— 否则 ⑤ 那边一 await 就把
  //    "落在哪个对话"这件事跟着一起卡住，启动画面早放完了，界面却停在一个没人选的标签上。
  //
  //    素材包也**起手就发**：下面那行日志要报出心情的显示名，而**名字在素材包里、不在语言包里**
  //    （见 mood.js 的 moodLabel）。同样不挡任何东西 —— 真正用它建面板还是 ④ 那一处。
  const packsP = loadPacks().catch(() => []);
  const uiStateP = q.get('mood')
    ? Promise.resolve(null)
    : Promise.race([
      getUiState().catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 2500)),
    ]);
  if (q.get('mood')) {
    moodBooted(null);                          // seed 掉当前的（= 强制那个），之后就可以写盘了
  } else {
    const tMood = performance.now();
    uiStateP.then(async (s) => {
      if (!moodBooted(s)) return;              // 没快照 / 读失败：这一步顺手把 saver 的闸开了
      // 本地几十毫秒，只为把心情名说对；不等它的话这行会退化成裸 state id（"此刻 error"）
      packs = await packsP;
      pack = pack || packs[0] || null;
      blog('ui', i18n.t('boot.ui.moodRestored', {
        ms: msec(tMood), mood: moodLabel(pack, mood.key),
      }));
    }).catch(() => { moodBooted(null); });
  }

  // ① 主循环**先起**：启动画面靠它每帧推进，所以它必须在任何可能慢的 await 之前。
  //    （反例：一开始把 requestAnimationFrame 放在 netgeo 之后 —— 外网查询要好几秒，
  //      那几秒里画布是空的，启动画面压根没上屏。）
  layout(); syncHidden(); hidden.focus();
  requestAnimationFrame(frame);

  // ② 取宿主 + 后端的真实启动记录（这一趟本身就是一次真请求，耗时照实记）
  if (bootScr) {
    const t0 = performance.now();
    try {
      const snap = await bootLog();
      blog('ui', i18n.t('boot.ui.bootlog', { ms: msec(t0), n: snap.lines.length, pid: snap.pid }));
      bootScr.replay(snap);
    } catch (e) { blog('ui', i18n.t('boot.ui.bootlog.fail', { err: String((e && e.message) || e) })); }
  }

  // ③ 画布与等宽字体的真实度量
  grid.resize();
  blog('ui', i18n.t('boot.ui.canvas', {
    w: canvas.clientWidth, h: canvas.clientHeight, dpr: grid.dpr,
    cw: grid.cellW.toFixed(2), ch: grid.cellH, cols: grid.cols, rows: grid.rows,
  }));
  const ua = navigator.userAgent.match(/(Edg|Chrome)\/[\d.]+/);
  blog('ui', i18n.t('boot.ui.engine', {
    ua: ua ? ua[0] : i18n.t('boot.ui.engine.unknown'),
    cores: navigator.hardwareConcurrency || '?',
  }));

  // ④ 素材包（本地小文件，很快）—— 起手就发过了，这里只是**等它到**（见 ⓪）
  packs = await packsP;
  pack = packs[0] || null;
  panels.agent.refreshArtOpts();          // 配置框那时可能已经摊开了（起手那个没配的对话）→ 补齐候选项
  if (pack) {
    mood.setFaces(pack.tags());           // 让面板能提示 agent 指定的表情是否收录
    panels.char = new CharPanel(mood, pack);
    blog('pack', i18n.t('boot.pack.loaded', { id: pack.id, n: pack.tags().length }));
  } else {
    blog('pack', i18n.t('boot.pack.none'));
  }
  layout();                              // 角色面板是刚建的，得再排一次才有 rect
  blog('ui', i18n.t('boot.ui.layout', {
    cols: grid.cols, rows: grid.rows,
    panels: Object.values(panels).filter(Boolean).length,
    rects: Object.keys(rects).length,
  }));

  panels.agent.onToken = () => tokWindow.push(1);
  panels.shell.onLine = scanIps;

  // ⑤ 慢活**不挡启动**：结果什么时候到就什么时候补一行 —— 真等它们（外网地理查询
  //    可能要几秒）就等于启动画面卡住不动。放到最后还能被第二趟 replay 捞进日志。
  const tSys = performance.now();
  sysSnapshot().then((s0) => {
    sys = s0;
    const disk = s0.disk ? i18n.t('boot.sys.disk', { pct: s0.disk.pct.toFixed(0) }) : '';
    const gpu = s0.gpu ? i18n.t('boot.sys.gpu', { util: s0.gpu.util }) : '';
    blog('sys', i18n.t('boot.sys.ok', {
      ms: msec(tSys),
      cpu: s0.cpu.usage.toFixed(0),
      used: (s0.mem.used / 1073741824).toFixed(1),
      total: (s0.mem.total / 1073741824).toFixed(1),
      pct: s0.mem.pct.toFixed(0),
      disk, gpu,
      up: (s0.uptime / 3600).toFixed(1),
    }));
  }).catch((e) => blog('sys', i18n.t('boot.sys.fail', { ms: msec(tSys) })));

  const tNet = performance.now();
  netgeo().then((g0) => {
    panels.globe.setGeo(g0);
    const self = g0 && g0.self;
    blog('net', i18n.t('boot.net.ok', {
      ms: msec(tNet),
      place: (self && self.ip)
        ? `${self.ip} ${[self.country, self.city].filter(Boolean).join(' ')}`
        : i18n.t('boot.net.nogeo'),
      dns: ((g0 && g0.dns) || []).length,
    }));
  }).catch((e) => blog('net', i18n.t('boot.net.fail', { ms: msec(tNet) })));

  // 恢复上次的对话：存档在 run/conversations/（该目录不入库）。同样不挡启动画面。
  panels.agent.restore().then(async () => {
    const restored = panels.agent.tabs.filter((t) => t.msgs.length).length;
    const msgs = panels.agent.tabs.reduce((n, t) => n + t.msgs.length, 0);
    // 落在**退出前那个**对话上。restore() 自己只会落"最近更新的那个"，
    // 人手切走的对话就被盖掉了（2026-10-17 用户报的："我切到第一个对话，关掉再开它是第二个"）。
    // ui-state 里只存了 id：标签顺序按 updatedAt 排，位置每次开都可能不一样。
    // 它通常在 restore 之前就到了（同一趟请求，起手就发出去的）；没到就等它 —— 带超时。
    // 找不到那个 id（对话被删了 / 那次没写进去）→ 保持 restore 的默认落点，不报错、不空屏。
    const ui = await uiStateP;
    if (ui && ui.active) panels.agent.selectSavedConv(ui.active);
    blog('conv', restored
      ? i18n.t('boot.conv.restored', { n: restored, msgs })
      : i18n.t('boot.conv.none'));
    panels.agent.refreshArtOpts();       // 恢复出来的对话可能停着配置界面 → 候选项补齐
    applyConvArt();                      // 落在的那个对话自己带的形象才是该显示的那个（必须在选完标签之后）
    // 标签被整体换掉了 → 调试参数重新落到"现在这个对话"身上（不然 ?mood= 只作用在一份
    // 马上就被丢弃的起手对话上，看着像没生效）
    applyMoodDebug();
  }).catch(() => {});

  // 页面被隐藏 / 关掉时，把防抖窗口里剩下的内容立刻落盘（刷新、关窗都算）
  window.addEventListener('pagehide', () => {
    try { panels.agent.flushSaves(); } catch (e) { /* 尽力而为 */ }
    try { moodSaver.flush(); } catch (e) { /* 同上 */ }
  });
  // 过场走到一半改窗口大小的话，起止矩形都作废了 —— 直接跳到终态再按新尺寸排
  window.addEventListener('resize', () => { snapZoom(); grid.resize(); layout(); syncHidden(); });
  // 调试：?hscroll=N 让地球面板 IP 说明初始横向偏移 N 列（验证左右滚动用，永久固定不自动）
  const hs = parseInt(q.get('hscroll'), 10);
  if (!Number.isNaN(hs)) { panels.globe._manualTarget = hs; panels.globe._manualUntil = 1e12; }
  // 调试：?sphase=T 把自动跑马灯的累计时钟直接设到 T 秒（验证缓动起停用），例如 ?sphase=1 看刚起步、?sphase=7.5 看将到末端
  const sp = parseFloat(q.get('sphase'));
  if (!Number.isNaN(sp)) { panels.globe._autoClock = sp; panels.globe._frozen = true; }

  pollSys();
  pollNet();
  if (!bootScr) { bootAt = performance.now(); return runDemo(q); }

  // ⑥ 日志还没放完就等它（放完 + 停顿后 done 才会变 true）。这段时间里再取一趟启动
  //    记录，把"演到一半才落进 boot.log 的行"（如地理查询）补进日志。
  try {
    const n = bootScr.replay(await bootLog());
    if (n) blog('net', i18n.t('boot.net.more', { n }));
  } catch (e) { /* 补不到就算了，前面那趟已经有一份 */ }
  bootScr.finish();
  // 等它自己放完。兜底 6s：万一 rAF 被节流到不触发（窗口建出来时不可见等），
  // 就一次性把剩下的行摆上去收工 —— 绝不把界面卡在启动画面上。
  await Promise.race([
    new Promise((r) => { bootWaiter = r; }),
    new Promise((r) => setTimeout(r, 6000)),
  ]);
  if (!bootScr.done) bootScr.forceDone();
  bootAt = performance.now();          // 进场动画从这里开始（面板从中心展开）
  runDemo(q);
}

// 调试入口：?demo=1 自动跑一轮（shell 真命令 + agent 假流式）
//           ?demo=pty 自动进真终端跑一次 python REPL（看 VT 渲染对不对）
function runDemo(q) {
  if (!q.get('demo')) return;
  if (q.get('demo') === 'pty') {
    setTimeout(() => panels.shell.exec('python'), 900);
    setTimeout(() => panels.shell.sendToPty('print("中文 6*7 =", 6*7)'), 7000);
    return;
  }
  const asCmd = q.get('shell') === 'cmd';
  if (asCmd) {
    // 演示 CMD 模式：切换 → cd 中文目录 → 列目录 → 触发一次错误退出码
    setTimeout(() => panels.shell.exec('cmd'), 500);
    setTimeout(() => panels.shell.exec('cd "C:\\Users\\Administrator\\WorkBuddy\\智能Agent\\Ponko-HUD"'), 1100);
    setTimeout(() => panels.shell.exec('dir /b'), 1700);
    setTimeout(() => panels.shell.exec('echo 中文正常 显示测试'), 2300);
  } else {
    setTimeout(() => panels.shell.exec('cd C:\\Users\\Administrator\\WorkBuddy; Get-ChildItem -Directory | Select-Object -First 3 -ExpandProperty Name'), 600);
    setTimeout(() => panels.shell.exec('Resolve-DnsName www.qq.com -Type A -ErrorAction SilentlyContinue | Select-Object -ExpandProperty IPAddress'), 1500);
  }
  setTimeout(() => panels.agent.send('帮我看下构建为什么失败'), 1400);
}
boot();
