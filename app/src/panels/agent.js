// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// AGENT：对话流（thinking 块 / tool_call 卡 / 流式回复）+ 底部状态条
//        某个对话没配 LLM 时，面板正中弹配置框（API 地址 / Key / 模型 + 保存）
//
// **LLM 配置是每个对话一份的**（2026-10-14 改）：以前整块面板共用一份全局配置，
// 想换个模型就得改全局、改完所有对话跟着变。现在配置存在对话自己的存档里，
// 点「+」新建时拿**按 + 那一刻正看着的那个对话**那份预填（那个没配过就留空，见 _llmOfTab）
// —— 想换模型就新开一个对话改，老对话不受影响。
//
// 多标签（对齐 SHELL 的终端标签）：AgentConv = 一个对话的全部状态，AgentPanel = 标签栏 +
// 当前对话。标签栏上认颜色不认编号，名字取该对话的第一条用户消息。
//
// 对话内容落盘到后端 run/conversations/<id>.json —— run/ 在 .gitignore 与推送脚本的排除表里，
// 所以这些内容只留在本机，绝不会跟着代码推上 GitHub。重启后 restore() 一次 GET 就把标签栏
// 原样恢复（包括内容）。
import { ATTR, mix } from '../grid.js';
import { TAB_COLORS } from '../tabcolors.js';
import { t } from '../i18n/index.js';
import { Mood } from '../mood.js';        // 每个对话自己持有的一份心情（见 AgentConv 构造函数）
import {
  askAgent, testLlmConfig, pickArt,
  listConvs, getConv, saveConv, deleteConv, saveUiState,
} from '../api.js';

// 作为上下文回灌给 LLM 的近期消息条数（约等于一半轮数的对话）
const MAX_CTX_MSGS = 20;
const MAX_CONVS = TAB_COLORS.length;   // 对话标签上限 = 色板容量（每个对话一个独有色）
const SAVE_DEBOUNCE = 800;             // 落盘防抖：流式期间每条事件都写盘就太吵了
const TITLE_MAX = 12;                  // 标签栏标题最多占几列
const HDR_GAP = 2;                     // 框顶线右端：色标与右上角状态字之间空几列（贴着会看成一坨）
const HDR_MIN = 6;                     // 状态字再挤也至少给这么多列（否则截得没法认）

// 性格候选项（id + 语言包 key）。
// ⚠️ **必须和 server/moodprotocol.js 的 PERSONA_KEYS 一一对应** —— 前端跑在浏览器里、
// 后端是 CommonJS，没法共用一份常量表，所以两边各存一份，由
// tools/test_mood_strip.mjs 的一致性守卫盯着，不许单边加人。
const PERSONA_OPTS = [
  ['default', 'ui.agent.opt.personaDefault'],
  ['tsundere', 'ui.agent.opt.personaTsundere'],
  ['genki', 'ui.agent.opt.personaGenki'],
  ['sarcastic', 'ui.agent.opt.personaSarcastic'],
  ['gentle', 'ui.agent.opt.personaGentle'],
];
const PERSONA_KEYS = PERSONA_OPTS.map((o) => o[0]);

/**
 * 按**显示宽度**截到 max 列（中文算 2 列），放不下就砍掉尾巴换成 '…'。
 * 模型 id 是 ASCII，但别假设 —— 万一是中文别名也得算对宽度。
 */
function clipCols(g, s, max) {
  const str = String(s === undefined || s === null ? '' : s);
  if (max <= 0) return '';
  if (g.strWidth(str) <= max) return str;
  if (max === 1) return '…';
  let out = '', w = 0;
  for (const ch of str) {
    const cw = g.strWidth(ch);
    if (w + cw > max - 1) break;
    out += ch; w += cw;
  }
  return out + '…';
}

// ── 一个对话：所有状态都在实例上，对话之间互不共享 ──────────────────────
export class AgentConv {
  constructor(id, ci, savedMood) {
    // 心情是**这个对话自己的**（2026-10-17 改）。以前整个面板共用一个 Mood 实例，
    // 于是：① 按 + 建的新对话会继承上一段对话的火气（用户报的原话）；
    // ② 后台对话还在流式输出时，它的 [[mood:...]] 会直接改**前台**的脸色；
    // ③ 新对话的模型在 system 提示词里收到的是别的对话的心里话。
    // 形象 / 性格 / LLM 配置早就每对话一份，心情跟着走才是一致的。
    this.mood = new Mood();
    if (savedMood) this.mood.restore(savedMood);   // 存档带回来的那份（脏值 restore 自己会拒）
    this.id = id;              // 存档 id（也是 run/conversations/<id>.json 的文件名）
    this.ci = ci;              // 色标下标 —— 这个对话的"身份色"，替代数字编号
    this.msgs = [];            // {role:'user'|'agent'|'think'|'tool'|'mood', text, result?}
    this.busy = false;
    this.tokens = 0;
    this.scroll = 0;
    this.input = '';
    this.caret = 0;
    this.focus = false;
    this.rect = null;
    this._cancel = null;
    this._title = '';          // 存档里带回来的标题（空 = 按第一条用户消息现取）
    // 这个对话**自己的** LLM 配置（null = 还没配）。每个对话一份，见文件头那一节：
    // 换对话就等于换配置，不用改全局，也不会互相覆盖。
    this.llm = null;
    // 这个对话的**形象**（角色素材包）：'auto' = 让配好的模型自己挑，否则是包 id。
    // 也是**每个对话一份** —— 右侧立绘跟着当前对话走，切标签就换人。
    // charpackWanted 是用户选的那个值，charpackPicked 是"自动"时模型挑出来的结果
    // （分开存是因为用户想重挑时把 wanted 留着，也能看出模型当时选了什么）。
    this.charpack = 'auto';
    this.charpackPicked = '';
    // 这个对话的**性格**（2026-10-15 加）：也是**每个对话一份**的，跟形象同一层。
    // 它喂进 system 提示词里那段人设 —— 同一套心情机制，换个性格就是另一个人
    // （用户："要让 llm 的情绪更拟人……要像具有情感那样"，并选择"配置时设置"）。
    this.persona = 'default';
    // 摊开着的**配置表单**（null = 这个对话没在配）。跟着对话走而不是跟着面板走：
    // 切走只是看不见，填到一半的内容不会丢、也不会被当成别的对话的配置。
    this.cfg = null;
    // 这个标签是"用户真实开着的对话"（点「+」建的、或启动时留下的那个空标签）→
    // 落盘时带上 keep，让后端即使"没说过话也没配过"也把它存下来。
    // 不这样做的话，关掉 HUD 再开标签数会悄悄少（2026-10-14 用户报的）。
    this.keepOpen = false;
    this.onDirty = null;       // 内容变了 → 面板排一次落盘
    this.onToken = null;       // 吐字节拍（面板统计 tok/s）
  }

  /** 这个对话接没接真 LLM —— 由"自己有没有配置"直接派生，不需要面板往回同步 */
  get llmOk() { return !!this.llm; }

  /** 本对话的颜色（标签栏色标、面板顶线小方块都用它认标签） */
  color() { return TAB_COLORS[this.ci % TAB_COLORS.length]; }

  /**
   * 真正要写进存档的标题（**没有就返回空串**）。
   * 不要拿 title() 去存 —— 那个在没名字时会返回 `t('ui.agent.newConv')`，
   * 于是"新对话"这种**界面文案**会被写进存档；用户切到日语以后，
   * 那个老标签还叫中文的「新对话」（存档里存的是成品句子，没法重译）。
   */
  saveTitle() {
    if (this._title) return clampTitle(this._title);
    const first = this.msgs.find((m) => m.role === 'user' && m.text.trim());
    return first ? clampTitle(first.text) : '';
  }

  /** 标签栏上的名字：存档标题 → 第一条用户消息 → 「新对话」（空对话时那个占位名走语言包） */
  title() { return this.saveTitle() || t('ui.agent.newConv'); }

  /** 关标签时调用：中止在飞的请求，别再往上写 */
  dispose() {
    try { this._cancel && this._cancel(); } catch (e) { /* 已经结束了 */ }
    this._cancel = null;
    this.busy = false;
    this.onDirty = null;
    this.onToken = null;
  }

  layout(r) { this.rect = r; }

  // ── 多行输入 ─────────────────────────────────────────────────
  // Enter 换行 / Ctrl+Enter 发送，所以输入框要能容多行：先按 '\n' 切硬行，
  // 每行再按面板宽度软换行；caret 落在（第几显示行, 第几列）由此推出。
  // 行数超过上限时以光标所在行为准开一个纵向滚动窗口。
  inputLines(g, w) {
    const out = [];
    let base = 0;
    for (const seg of this.input.split('\n')) {
      for (const p of wrapIndexed(g, seg, w)) out.push({ text: p.text, start: base + p.start });
      base += seg.length + 1;
    }
    return out;
  }

  /** 输入框最多占几行（给上方对话至少留 3 行） */
  maxInputRows() {
    const r = this.rect;
    if (!r) return 1;
    return Math.max(1, Math.min(6, r.h - 6));
  }

  /** 当前输入应该占几行（供 main.js 同步隐藏输入框的高度） */
  inputRows(g) {
    if (!this.rect) return 1;
    const avail = Math.max(4, this.rect.w - 5);
    return Math.min(this.maxInputRows(), Math.max(1, this.inputLines(g, avail).length));
  }

  /** 输入框的显示布局：可视行、滚动偏移、文本起始列… 绘制和点击定位共用一份算法 */
  inputWindow(g) {
    const r = this.rect;
    const x = r.x + 1, iw = r.w - 2;
    const tx0 = x + 2, avail = Math.max(1, iw - 3);
    const lines = this.inputLines(g, avail);
    const rows = Math.min(this.maxInputRows(), Math.max(1, lines.length));
    const caret = Math.max(0, Math.min(this.caret, this.input.length));
    let cRow = 0;
    for (let i = 0; i < lines.length; i++) { if (lines[i].start <= caret) cRow = i; else break; }
    let top = 0;
    if (cRow >= rows) top = cRow - rows + 1;
    if (top > lines.length - rows) top = Math.max(0, lines.length - rows);
    return { lines, rows, top, cRow, iyTop: r.y + r.h - 3 - (rows - 1), tx0, avail, x, iw, caret };
  }

  /** 鼠标点在哪一格 → 对应的字符索引（点了输入框外返回 null） */
  caretFromPoint(g, cx, cy) {
    if (!this.rect) return null;
    const w = this.inputWindow(g);
    if (cy < w.iyTop || cy > this.rect.y + this.rect.h - 3) return null;
    const L = w.lines[w.top + (cy - w.iyTop)];
    if (!L) return this.input.length;
    const rel = cx - w.tx0;
    let acc = 0, i = 0;
    for (; i < L.text.length; i++) {
      const cw = g.chWidth(L.text[i]);
      if (rel < acc + cw) { if (rel > acc) i++; break; }   // 点在后半格（宽字符）→ 落在该字符之后
      acc += cw;
    }
    return L.start + i;
  }

  /** 正文/程序输出/agent 的话 —— 都是**内容**，不翻 */
  push(role, text) {
    this.msgs.push({ role, text: String(text === undefined || text === null ? '' : text), t: performance.now() });
    if (this.msgs.length > 300) this.msgs.splice(0, this.msgs.length - 300);
    if (this.onDirty) this.onDirty(this);
  }

  /**
   * 记一条**界面文案**（错误话术、状态提示这类）：存 key + 参数，切语言时能重译。
   * 与 shell 的 pushT 同一思路 —— 存成品句子的话，老消息会留在旧语言里，屏幕上一半中一半英。
   * （落盘时这两个字段会被剥掉，见 flushSaves：存档格式不变。）
   */
  pushT(role, key, args) {
    this.msgs.push({ role, text: t(key, args), k: key, a: args, t: performance.now() });
    if (this.msgs.length > 300) this.msgs.splice(0, this.msgs.length - 300);
    if (this.onDirty) this.onDirty(this);
  }

  /** 语言变了：把带 key 的消息重译一遍（用户/agent 的正文没有 key，原样不动） */
  retranslate() {
    for (const m of this.msgs) if (m.k) m.text = t(m.k, m.a);
  }

  /**
   * 这个对话现在该用哪个形象包：用户直接选了就用那个，选「自动」就用模型挑的。
   * 都没定（自动但还没挑 / 挑的那个包被删了）→ 返回 ''，由主装配回退到默认包。
   */
  artId() {
    return this.charpack === 'auto' ? (this.charpackPicked || '') : (this.charpack || '');
  }

  send(text) {
    const t = text.trim();
    if (!t || this.busy) return;
    if (!this.llmOk) { if (this.onNeedConfig) this.onNeedConfig(); return; }   // 没接 LLM：先弹配置框
    this.push('user', t);
    this.busy = true;
    this.tokens = 0;
    // 近期对话作为上下文发给真 LLM（剥掉 [[mood:...]] 标记，别把情绪回灌给模型）。
    // 两个必须小心的地方：
    //   ① 后端会自己把本次提问追加到 messages 末尾，所以这里要排除刚 push 的那条，
    //      否则同一句提问会被发两遍（模型的表现是复读 / 答非所问）。
    //   ② 这条 history 必须真的传给 askAgent —— 之前漏传，导致每轮都是全新会话，
    //      用户体感就是"对面完全没有记忆"。
    const history = this.msgs
      .slice(0, -1)
      .filter((m) => (m.role === 'user' || m.role === 'agent') && m.text.trim())
      .slice(-MAX_CTX_MSGS)
      .map((m) => ({ role: m.role, content: stripMood(m.text).trim() }))
      .filter((m) => m.content);
    // ③ 还要把"我此刻的心情"一起带过去。模型的 mood 标记只往界面走（上面 stripMood
    //    剥掉的就是它），不给这份快照，它每轮都从白纸开始按表推情绪 —— 表现就是机械、
    //    每轮重置（用户 2026-10-15："不像人"）。接住它的地方见 server 的 moodBriefing()。
    this._cancel = askAgent(t, (e) => {
      switch (e.t) {
        case 'mood':
          // 心情是 agent 的声明直接落地：state 决定配色，face 决定角色立绘。
          // 控制语句本身**不进对话流** —— 它是给 mood 的指令，不是给用户看的内容
          // （2026-10-15 用户：那个"显示/隐藏"开关本来就是给开发时看一眼用的，删掉）。
          if (this.mood && this.mood.fromAgent) this.mood.fromAgent(e);
          break;
        case 'thinking':
          this.push('think', e.text);
          break;
        case 'tool':
          this.push('tool', `${e.name}(${e.arg})`);
          break;
        case 'tool_result': {
          const last = this.msgs[this.msgs.length - 1];
          if (last && last.role === 'tool') last.result = e.text;
          else this.push('tool', e.text);
          break;
        }
        case 'token': {
          if (this.onToken) this.onToken();
          let last = this.msgs[this.msgs.length - 1];
          if (!last || last.role !== 'agent' || last.streamDone) { this.push('agent', ''); last = this.msgs[this.msgs.length - 1]; last.stream = true; }
          last.text += e.text;
          this.tokens++;
          break;
        }
        case 'done': {
          this.busy = false;
          this.tokens = e.tokens || this.tokens;
          // 收尾心情：后端把本轮最后一条心情声明随 done 带回来，这里重新落地一次，
          // 让"输出过程中"声明的表情/配色在回复结束后继续站住（不会立刻回落成待机）。
          // agent 没声明就不替它收尾 —— 仍然是 agent 唯一权威。
          const fin = (e.mood && typeof e.mood === 'object') ? e.mood : e;
          if (fin && fin.state && this.mood && this.mood.fromAgent) this.mood.fromAgent(fin);
          break;
        }
        case 'error':
          this.busy = false;
          this.pushT('think', 'ui.agent.backendError', { msg: e.text });
          if (this.mood && this.mood.fromLocal) this.mood.fromLocal('error', 'ui.agent.noBackend');   // 标清是本地兜底
          break;
      }
      this.scroll = 0;
      // 流式期间 token 是直接追加到上一条上的（不经过 push），所以这里统一再报一次"内容变了"，
      // 否则回复写完就再没人触发落盘，重启后只剩提问没有回答。
      if (this.onDirty) this.onDirty(this);
      // llm = **这个对话自己的**配置。不传的话后端无从判断这个对话接的哪家，
    // 只能退回演示用的假 agent —— 那正是"明明配过却还在演示"的老毛病。
    }, () => { this.busy = false; if (this.onDirty) this.onDirty(this); }, history, this.llm,
    { persona: this.persona, mood: this._moodBrief() });
  }

  /**
   * 发给后端的"此刻心情"快照 —— 让模型接住自己的情绪（情绪记忆，见 server 的 moodBriefing）。
   * 只带三样：state、它自己写过的心里话、这份心情保持了多久。
   *
   * note 只取 **agent 自己写的**那句（noteText）：noteKey 那种是本地兜底 / 界面文案，
   * 拿它去当"你心里想的是…"等于凭空给模型塞一句它根本没说过的话。
   *
   * ⚠ 2026-10-17 起 **source 不是 agent 的一律不发**（新对话的初始待机、调试旁路、
   *   本地兜底）。理由：这段提示词写的是"你给自己定的是…"，只有 agent 真声明过才成立。
   *   以前会把"本地兜底进的瞌睡"当成它的心情发过去，模型于是回一句"我本来还困着" ——
   *   看着像它自己设的，其实是程序塞给它的（用户当天问的"它会自动变成无聊"就是这个）。
   */
  _moodBrief() {
    const m = this.mood;
    if (!m || !m.state || m.source !== 'agent') return null;
    const held = Number(m.lastAgent) > 0 ? (performance.now() - m.lastAgent) / 60000 : 0;
    return {
      state: m.state,
      note: String(m.noteText || '').slice(0, 40),
      minutes: Math.max(0, Math.round(held * 10) / 10),
    };
  }

  abort() {
    if (!this.busy) return;
    try { this._cancel && this._cancel(); } catch (e) {}
    this.busy = false;
    this.pushT('think', 'ui.agent.aborted');
  }

  onWheel(d) { this.scroll = Math.max(0, Math.min(400, this.scroll + (d > 0 ? -1 : 1))); return true; }
  onArrow(dir) { return this.onWheel(-dir); }

  /** 面板主体（不含外框：外框与标签栏都由 AgentPanel 画） */
  body(g, C) {
    const r = this.rect, T = C.theme;
    if (!r || r.w < 10 || r.h < 5) return;

    const x = r.x + 1, iw = r.w - 2;
    const win = this.inputWindow(g);
    const viewH = win.iyTop - (r.y + 1);        // 消息区行数（输入框变高就自动让位）

    // 展开成可显示行
    const lines = [];
    for (const m of this.msgs) {
      // 心情控制语句不进对话流（它是给 mood 的指令，协议本身照常生效）。
      // 旧存档里可能还留着 role='mood' 的行，读回来一律**整行不生成** ——
      // 只在绘制时把文字换成空白的话，对话里会留下一条莫名其妙的空行。
      if (m.role === 'mood') continue;
      const pre = m.role === 'user' ? '› '
        : m.role === 'think' ? '◐ '
        : m.role === 'tool' ? '⚙ ' : '▌ ';
      const col = m.role === 'user' ? T.accent
        : m.role === 'think' ? T.dim : m.role === 'tool' ? T.warn : T.text;
      // 正文里的 '\n' 必须切成硬行：直接喂给 wrapText 的话换行符会被当成 1 列宽的普通字符
      // 画进网格（用户发 "1\n2" 就显示成 "1  2"，换行丢了只剩一格空白）。
      // 续行前缀用等宽空格对齐，保证视觉上是一个块。
      const indent = ' '.repeat(g.strWidth(pre));
      // 心情标记被剥掉后，它占的那一行会留下一段纯空白 —— 3 个以上连续换行压成 2 个，
      // 免得回复里出现莫名其妙的一大段空行（正文里正常的单/双换行不受影响）。
      const parts = String(m.text).replace(/\n{3,}/g, '\n\n').split('\n');
      for (let pi = 0; pi < parts.length; pi++) {
        const wrap = wrapText(g, (pi === 0 ? pre : indent) + parts[pi], iw);
        for (const l of wrap) lines.push({ text: l, col, role: m.role });
      }
      if (m.result) {
        for (const l of String(m.result).split('\n').slice(0, 3)) {
          lines.push({ text: '  ✓ ' + l.slice(0, Math.max(0, iw - 4)), col: T.ok, role: 'tool' });
        }
      }
    }
    const start = Math.max(0, lines.length - viewH - this.scroll);
    let y = r.y + 1;
    for (let i = start; i < Math.min(lines.length, start + viewH); i++) {
      g.text(x, y, lines[i].text, lines[i].col, T.panel);
      y++;
    }
    while (y < win.iyTop) { g.text(x, y, ' '.repeat(iw), T.text, T.panel); y++; }

    // 输入框：整块用 panelHi 底色画成一个真输入框（之前只有孤零零一个 ▌，
    // 看不出哪里能打字 —— 用户报"能输入但没有输入框 UI"）。多行时向上长高。
    for (let k = 0; k < win.rows; k++) g.text(x, win.iyTop + k, ' '.repeat(iw), T.text, T.panelHi);
    g.text(x, win.iyTop, '▌', this.focus ? T.accent : T.dim, T.panelHi);
    const blink = this.focus && Math.floor(C.t * 2) % 2 === 0;
    for (let k = 0; k < win.rows; k++) {
      const idx = win.top + k;
      const L = win.lines[idx];
      const yy = win.iyTop + k;
      if (!this.input) {
        // 空输入：占位提示（暗色），按可用宽度截断
        let s = '', wsum = 0;
        for (const ch of t('ui.agent.placeholder')) {
          const cw = g.chWidth(ch);
          if (wsum + cw > win.avail) break;
          s += ch; wsum += cw;
        }
        g.text(win.tx0, yy, s, T.darker, T.panelHi);
      } else if (L) {
        g.text(win.tx0, yy, L.text, T.text, T.panelHi);
      }
      // 光标跟着 caret 走（原来画在 g.text 的返回列，等于永远贴在末尾）
      if (blink && idx === win.cRow) {
        const col = win.tx0 + g.strWidth(L ? L.text.slice(0, win.caret - L.start) : '');
        if (col < r.x + r.w - 1) g.set(col, yy, '█', T.accent, T.accent);
      }
    }

    // 状态条
    const sy = r.y + r.h - 2;
    g.text(x, sy, '╌'.repeat(iw), T.line);
    const st = this.busy ? t('ui.agent.streaming', { rate: C.tokRate || 0 }) : t('ui.agent.idle');
    g.text(x, sy, ` ${st}`, this.busy ? T.accent : T.dim, T.panel);
    const right = `tokens ${this.tokens}  ¥0.00`;
    g.text(Math.max(0, r.x + r.w - 1 - g.strWidth(right)), sy, right, T.dim, T.panel);
  }
}

// ── 面板：标签栏 + 当前对话（对外 API 与单对话时代完全一致，主装配不用改）──
export class AgentPanel {
  // 注意：**不接 mood 参数**（2026-10-17 起）。心情挂在每个对话身上（AgentConv.mood），
  // 面板只负责回答"现在该显示哪一份"—— activeMood()。屏幕那层视图由 main.js 用
  // moodView() 造，主装配照旧把一个 `mood` 对象交给 SHELL / CHAR 面板即可。
  constructor() {
    this.rect = null;
    this.tabs = [];
    this.active = 0;
    this._focus = true;          // 老行为：agent 起手就带焦点
    this._onToken = null;
    this._tabHits = [];          // 最近一帧标签栏的命中区 [{x0,x1,idx}]，idx=-1 是“+”
    this._seq = 0;
    this._colorSeq = 0;
    this._dirty = new Set();     // 待落盘的对话
    this._saveTimer = null;
    // "存档恢复完了没有"。恢复完之前**一律不许往 ui-state 写 active** ——
    // 构造函数里那个起手对话会在恢复前先建出来，那一笔要是写了，就会把盘上"上次落在哪个
    // 对话"盖成一个**还没读档、注定要被丢弃**的新 id，于是重开永远落回默认（2026-10-17 踩过）。
    this._restored = false;
    this._cfgHits = null;        // 配置框的鼠标命中缓存（drawConfig 每帧重建）
    this._clearHidden = null;    // main.js 注入：关闭配置框时清空隐藏输入框
    this.onConvClosed = null;    // main.js 注入：/del chat 关掉/换掉对话之后，主装配要跟着收拾
    this.onDelAsk = null;        // main.js 注入：/del chat 命中时先弹那道红条确认（不直接删）
    // main.js 注入：① 问当前有哪些形象包（配置框的候选项）② 形象变了就换立绘
    this.getPacks = null;
    this.onArtChange = null;
    this.newTab();
    this.tab.pushT('agent', 'ui.agent.ready');
    // 起手那个对话没配 LLM → 它就是**配置界面**（newTab 已经把表单摊开了）。
    // 理由：没配的对话一句话都发不出去（发了也会被弹回配置框），摆个空聊天框是在骗人；
    // 想先看一眼界面就按 ESC / 点「取消」收起来，/llm 还能再叫回来。
  }

  /**
   * 造一份**新的空表单**。配置框是**每个对话一份**的（存在 tab.cfg 上）：
   * 切走只是看不见了，填到一半的地址/Key、选到第几行，全都留在这个对话身上 ——
   * 切回来还是刚才那个样子，不会因为去隔壁看一眼就被清空，更不会被当成"编到别人身上"。
   * 字段名 / 候选项名都存**语言包 key**（`labelKey` / opts 第二项），绘制时现取现翻 ——
   * 存成品文案的话，配置框开着的时候切语言它不会跟着变。labelKey 只给显示用，值本身是数据。
   */
  _mkForm() {
    const f = {
      fields: [
        { key: 'baseUrl', labelKey: 'ui.agent.field.apiAddr', value: '', ph: 'https://api.openai.com/v1', mask: false },
        { key: 'apiKey', labelKey: 'ui.agent.field.apiKey', value: '', ph: 'sk-...', mask: true },
        { key: 'model', labelKey: 'ui.agent.field.model', value: '', ph: 'gpt-3.5-turbo', mask: false },
        // 循环选择字段（←→ 切换，不接受文本输入）：
        // auto=两种协议各试一次谁通用谁；openai/anthropic=手动指定，跳过识别
        {
          key: 'provider', labelKey: 'ui.agent.field.provider', value: 'auto', mask: false, cycle: true,
          opts: [['auto', 'ui.agent.opt.auto'], ['openai', 'ui.agent.opt.openai'], ['anthropic', 'ui.agent.opt.anthropic']],
        },
        // 形象（角色素材包）：候选项 = 「自动」+ 所有已保存的形象包（characters/<id>）。
        // 「自动」不是"选第一个包"，而是**保存时让这个对话配好的模型自己挑一个**
        // （见 configSave / pickArt）。挑的结果存 tab.charpackPicked，包还在就一直是它。
        {
          key: 'charpack', labelKey: 'ui.agent.field.charpack', value: 'auto', mask: false, cycle: true,
          opts: this._artOpts(),
        },
        // 性格：跟形象同一层（每个对话一份，随存档走）。这是**喂给模型的人设**，
        // 决定它情绪表达的路子 —— 'default' 是留白，不额外加人设
        // （见 server/moodprotocol.js 的 PERSONAS 那份表）。
        {
          key: 'persona', labelKey: 'ui.agent.field.persona', value: 'default', mask: false, cycle: true,
          opts: PERSONA_OPTS,
        },
      ],
      idx: -1,                 // -1 未编辑；0..4 字段；5 保存；6 取消
      caret: 0,                // 当前字段里的光标位置（字符索引）
      msgKey: '',              // 状态行存的是 key + 参数（现取现翻，见 setMsg）
      msgArgs: null,
      busy: false,
      bad: false,
      isNew: false,            // 这份表单是不是"刚点 + 建出来的对话"→ 那种情况下取消 = 撤销新建
      auto: false,             // 是不是"这个对话还没配 LLM，自己摊开的"（区别于人手点出来的）
      _syncedIdx: null,        // main.js 用：上次同步过隐藏输入框的字段序号（换字段才挪光标）
    };
    return f;
  }

  /**
   * 形象字段的候选项：「自动」+ 所有已保存的包。
   * 包清单由主装配注入（`getPacks`）—— agent.js 不认识素材包加载那套，也不该认识。
   * 一个包都没有（后端没起来 / characters/ 是空的）就只剩「自动」，字段仍然可用。
   */
  _artOpts() {
    const list = (this.getPacks && this.getPacks()) || [];
    return [['auto', 'ui.agent.opt.charpackAuto']]
      .concat(list.map((p) => [p.id, p.name || p.id]));
  }

  /** 交给模型挑的那些形象（不带「自动」）：只要 id + 名字，模型不需要别的 */
  _artCands() {
    const list = (this.getPacks && this.getPacks()) || [];
    return list.map((p) => ({ id: p.id, name: p.name || p.id }));
  }

  /**
   * 重建**所有**对话里那份表单的形象候选项。
   * 启动时素材包是异步加载的，而配置框可能在此之前就建好了（起手那个没配的对话会自己摊开）——
   * 所以包加载完、或包清单有变化时，主装配叫一次这里补齐候选项。
   */
  refreshArtOpts() {
    for (const tab of this.tabs) {
      const f = tab.cfg;
      if (!f) continue;
      const fd = f.fields.find((x) => x.key === 'charpack');
      if (fd) fd.opts = this._artOpts();
    }
  }
  /** 状态行文案：存 key + 参数，绘制时现取现翻（配置框开着时切语言也能跟着变） */
  setMsg(key, args) {
    const f = this.form;
    if (!f) return;                      // 没人在配：那行本来就是配置框里的状态行，没人看得见
    f.msgKey = key || '';
    f.msgArgs = args || null;
  }

  // ── 配置框：状态挂在**对话**身上（tab.cfg），不在面板上 ─────────────────
  // 这样"切走"就只是看不见而已：填到一半的地址 / Key、焦点停在第几行，全都跟着对话留着，
  // 切回来还是原样；也不会出现"面板这份表单被当成隔壁对话的配置读走 / 存错"的串台。
  get form() { return (this.tab && this.tab.cfg) || null; }
  /** 面板现在是以配置框的形态在显示吗（由当前对话有没有摊开的表单直接派生） */
  get inConfig() { return !!this.form; }
  /** 这份表单是"刚点 + 建出来的对话"吗 → 那种情况下取消 = 撤销新建 */
  get _cfgNew() { return !!(this.form && this.form.isNew); }
  set _cfgNew(v) { const f = this.form; if (f) f.isNew = !!v; }
  /** main.js 用它记住"上次同步过隐藏输入框的字段序号"——得跟着各自那份表单走 */
  get _cfgIdx() { return this.form ? this.form._syncedIdx : null; }
  set _cfgIdx(v) { const f = this.form; if (f) f._syncedIdx = v; }

  /**
   * 当前对话接没接 LLM。注意这是**按对话**的：别的对话配没配跟当前这个无关
   * （所以没有 setter —— 想配就往 tab.llm 里写，见 configSave）。
   */
  get llmConfigured() { return !!(this.tab && this.tab.llm); }

  /** 框顶右上角显示的模型 id：取**当前对话**那份配置里的（不同对话可能接不同模型） */
  get llmModel() { return (this.tab && this.tab.llm) ? this.tab.llm.model : ''; }

  // ── 当前对话 ──
  get tab() { return this.tabs[this.active] || null; }
  _nextId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  /**
   * 记住"现在落在哪个对话上"（存进 ui-state，见 server 的 UI_PATH 那段）。
   * 用户 2026-10-17 报的：「切到第一个对话，关掉 HUD 再开，它是第二个对话」——
   * restore() 原来一律落在"最近更新的那个"，把人手切走的选择盖掉了。
   *
   * 只记 **id**，不记下标：标签顺序每次重开都可能不一样（restore 按 updatedAt 排），
   * 记位置下次就指到别人身上。存的是"哪个对话"，不是"第几个标签"。
   * 失败（后端没起来）就算了：下次开回去按默认落，顶多这一次不跟手，不该因此报错。
   */
  _saveActive() {
    if (!this._restored) return;      // 还没读档：此刻的落点不算数（见构造函数里 _restored 那段）
    const t = this.tab;
    try { Promise.resolve(saveUiState({ active: t ? t.id : '' })).catch(() => {}); } catch (e) { /* 同上 */ }
  }

  /**
   * 落在"上次退出时那个对话"上（main.js 读完 ui-state 后调）。
   * 找不到（那个对话被删了 / 存档读不出来 / 没存过）就保持 restore() 的默认落点。
   * 只认 id：同色号可能被复用、标题会变、位置会动，只有 id 是那个对话本身。
   */
  selectSavedConv(id) {
    const want = String(id || '');
    if (!want) return false;
    const i = this.tabs.findIndex((t) => t.id === want);
    if (i < 0) return false;
    if (i === this.active) { this._saveActive(); return true; }   // 已经在那儿：不用切，但记一笔
    return this.selectTab(i);
  }

  // ── 转发给当前对话的属性（主装配按老接口用，不用感知多标签）──
  get focus() { return this._focus; }
  set focus(v) {
    this._focus = !!v;
    for (const t of this.tabs) t.focus = this._focus && t === this.tab;
  }
  get onToken() { return this._onToken; }
  set onToken(fn) { this._onToken = fn; for (const t of this.tabs) t.onToken = fn; }
  get input() { return this.tab ? this.tab.input : ''; }
  set input(v) { if (this.tab) this.tab.input = v; }
  get caret() { return this.tab ? this.tab.caret : 0; }
  set caret(v) { if (this.tab) this.tab.caret = v; }
  get msgs() { return this.tab ? this.tab.msgs : []; }
  set msgs(v) { if (this.tab) this.tab.msgs = Array.isArray(v) ? v : []; }
  get busy() { return this.tab ? this.tab.busy : false; }
  set busy(v) { if (this.tab) this.tab.busy = !!v; }
  get tokens() { return this.tab ? this.tab.tokens : 0; }
  get scroll() { return this.tab ? this.tab.scroll : 0; }
  set scroll(v) { if (this.tab) this.tab.scroll = v; }

  // ── 转发给当前对话的方法 ──
  layout(r) { this.rect = r; this._syncRect(); }
  inputRows(g) { return (this.inConfig || !this.tab) ? 1 : this.tab.inputRows(g); }
  inputWindow(g) { return this.tab ? this.tab.inputWindow(g) : null; }
  caretFromPoint(g, cx, cy) { return this.tab ? this.tab.caretFromPoint(g, cx, cy) : null; }
  push(role, text) { if (this.tab) this.tab.push(role, text); }
  pushT(role, key, args) { if (this.tab) this.tab.pushT(role, key, args); }
  /** 语言变了：**所有**对话（含后台标签）里的界面消息都要重译 */
  retranslate() { for (const conv of this.tabs) conv.retranslate(); }
  // 先过斜杠命令 —— 必须在 tab.send 之前：那儿有"没接 LLM 就弹配置框""正在流式就不收"
  // 两道闸，而删对话跟这两件事都没关系（流式中的对话也应该删得掉）。
  send(text) {
    if (this.command(text)) return true;               // 命中命令：不发给模型、不进上下文
    return this.tab ? this.tab.send(text) : undefined;
  }
  abort() { if (this.tab) this.tab.abort(); }
  /** 当前该显示的那份心情（整个应用只有一块屏幕，见 mood.js 的 moodView） */
  activeMood() { return this.tab ? this.tab.mood : null; }
  /**
   * `panel.mood` 的兼容写法 = **当前对话**的心情（只读快照，**不是**一个可长期持有的对象：
   * 切个标签它就换人了）。要"跟着当前对话走"的视图用 mood.js 的 moodView()（main.js 就是这么做的），
   * 要某个对话自己的那份用 `tab.mood`。调试时 `__panels.agent.mood.state` 这么读没问题。
   */
  get mood() { return this.activeMood(); }
  /** 当前对话该用的形象包 id（'' = 还没定，主装配回退默认包）。见 AgentConv.artId */
  artId() { return this.tab ? this.tab.artId() : ''; }
  onArrow(dir) { return this.tab ? this.tab.onArrow(dir) : true; }
  onWheel(d) { return this.tab ? this.tab.onWheel(d) : false; }

  /**
   * 取一个当前没人用的颜色（全占满才复用）。
   * 关键是"不按位置分配"：关掉中间某个对话时，剩下的颜色不会跟着重排，
   * 否则"那个颜色 = 那个对话"的对应关系就断了。
   */
  _pickColor() {
    const used = new Set(this.tabs.map((t) => t.ci));
    for (let k = 0; k < TAB_COLORS.length; k++) {
      const ci = (this._colorSeq + k) % TAB_COLORS.length;
      if (!used.has(ci)) { this._colorSeq = (ci + 1) % TAB_COLORS.length; return ci; }
    }
    return this._colorSeq++ % TAB_COLORS.length;
  }

  _mkTab(id, ci, savedMood) {
    // ci 传了就用它（**恢复存档时必须用回来的那个**，见 restore：色号是认标签的记号，
    // 每次重开都重新派一遍的话，用户看到的"蓝的那个 = 我刚才问问题那个"就废了）；
    // 没传（新建对话）才现派一个。
    // savedMood = 存档里这个对话自己的心情快照；**不传就是新对话 → 从待机开始**
    // （用户 2026-10-17："我现在第一个对话是生气，然后我按 +，怎么还是生气"）。
    const t = new AgentConv(id, (ci === undefined || ci === null) ? this._pickColor() : ci, savedMood);
    t.focus = this._focus;
    t.onDirty = (c) => this._markDirty(c);
    t.onToken = this._onToken;
    t.onNeedConfig = () => this.configOpen();
    t.rect = this.rect ? { ...this.rect } : null;
    return t;
  }

  // ── 对话管理 ──
  /**
   * 「按「+」那一刻，这个对话身上是什么配置」—— 新对话拿它预填。**只看传进来的这个对话**：
   * 它正摊着配置框就以框里的内容为准（你看着什么就继承什么），框收着就用它已保存的那份；
   * 两者都没有 → null，新表单留空。
   * **不去翻别的对话、也不留"最近配好的那份"当兜底**：那不是"按 + 时所在的会话"，
   * 拿它预填会让人以为点错了对话（2026-10-14 用户指出："应该是按 + 时所在的会话才对"）。
   */
  _llmOfTab(tab) {
    const f = tab && tab.cfg;
    if (f) {
      const v = (k) => { const x = f.fields.find((y) => y.key === k); return x ? String(x.value || '').trim() : ''; };
      // 半填的也认：预填不是配置，真不真用得点了「保存」（那里会先验连通）
      const live = { baseUrl: v('baseUrl'), apiKey: v('apiKey'), model: v('model'), provider: normProvider(v('provider')) };
      if (live.baseUrl || live.apiKey) return live;
    }
    return (tab && tab.llm) ? { ...tab.llm } : null;   // 一律拷一份：改新对话不该动到老对话那份
  }

  /**
   * 新建一个对话标签。
   * fromUser = true 表示是**用户主动点的「+」/ 按的 ^⇧T** —— 那种情况建好就弹配置框，
   * 并且用"按 + 那一刻正看着的那个对话"那份配置预填：想换个模型 / 换个中转站，
   * 就在这个新对话里改，老对话照旧用自己那份，互不干扰。当前那个没配过就留空表单。
   * 内部新建（构造函数里那个起手对话、/del chat 之后补的那个）走另一条：它没配 LLM，
   * 也就同样是停在配置界面 —— 见 _openFormIfUnset。
   */
  newTab(fromUser) {
    if (this.tabs.length >= MAX_CONVS) return null;
    // 预填来源：**按 + 时所在的那个对话**（不是"最后建的那个"、也不是"最近配好的那份"）
    const src = this.tab;                        // 先抓住它：下面 push 之后 this.tab 就成新的了
    const seed = this._llmOfTab(src);
    const seedArt = src ? src.charpack : 'auto';  // 形象跟 LLM 配置同一个来源
    const seedPersona = src ? src.persona : 'default';   // 性格同理：按 + 时看着的那个对话是谁，新对话就先是谁
    const t = this._mkTab(this._nextId());
    this.tabs.push(t);
    this.active = this.tabs.length - 1;
    this.syncFocus();
    this._saveActive();          // 按完「+」落在新对话上；关掉再开也该是它
    // seed 只是**灌进表单**，不写进 t.llm —— 新对话得真的点了「保存」才算配好：
    //   ① 拷一份给表单（不是共用引用）：在新对话里改地址 / Key 不该把上一份也改了
    //   ② 不替他先配好：万一没配就切走，这个空对话要能被干净地撤销掉，
    //      不能因为"继承过一份配置"反而落进存档里（现在 t.llm 一直是空的，写盘会跳过它）
    if (fromUser) this.configOpen({ isNew: true, seed, seedArt, seedPersona });
    // 内部新建（冷启动那个、/del chat 之后补的）：没带走任何配置 → 停在配置界面
    else this._openFormIfUnset(t, seed, seedArt, seedPersona);
    // 用户点「+」建的标签**立刻记一笔账**：他要这个对话，关掉 HUD 再开也得在。
    // 不能等"说了话"才存 —— 没配完就关掉是最常见的情形，那正好是最该留住的时候。
    if (fromUser) { t.keepOpen = true; this._markDirty(t); }
    return t;
  }

  // 切对话**不做任何清理**：配置表单挂在对话身上（tab.cfg），跟着对话自己走。
  // 切走只是看不见，切回来还是刚才那个样子（填到一半的 Key 也在）；想撤销得明确点「取消」。
  selectTab(i) {
    if (typeof i !== 'number' || i < 0 || i >= this.tabs.length) return false;
    if (i === this.active) return false;
    this.active = i;
    this.syncFocus();
    this._saveActive();                        // 关掉 HUD 再开，还得是这一个（见 _saveActive）
    return true;
  }

  /** dir>0 下一个，dir<0 上一个（循环） */
  nextTab(dir) {
    const n = this.tabs.length;
    if (n < 2) return false;
    this.active = (this.active + (dir > 0 ? 1 : -1) + n) % n;
    this.syncFocus();
    this._saveActive();
    return true;
  }

  /**
   * 关掉一个对话标签。留最后一个（面板不能空着没法用）。
   * 存档一并删除 —— 关错了可没有回收站可找，所以**入口都先弹一行红条**（main.js），
   * 在红条上回车才走到这儿。入口只有一个：输入框里打 /del chat（见 command）——
   * 原来那条 ^⇧W 键位 2026-10-13 按用户要求删掉了。
   * 也就是说这个函数是"执行器"，不做确认 —— 确认在 main.js 的 convClose 那一套里。
   */
  closeTab(i) {
    if (this.tabs.length <= 1) return false;
    const k = (i === undefined || i === null) ? this.active : i;
    if (k < 0 || k >= this.tabs.length) return false;
    const t = this.tabs[k];
    this._dirty.delete(t);
    t.dispose();
    const id = t.id;
    try { deleteConv(id); } catch (e) { /* 后端没起来：文件留着，下次开还会出现 */ }
    this.tabs.splice(k, 1);
    if (k < this.active) this.active--;
    if (this.active >= this.tabs.length) this.active = this.tabs.length - 1;
    this.syncFocus();
    this._saveActive();          // 关掉的是当前那个 → 落在谁身上，下次开就得是谁
    return true;
  }

  // ── 斜杠命令 ──────────────────────────────────────────────────
  /**
   * 在输入框里打一条命令、Ctrl+Enter 发出去。目前只有 /del chat（关掉当前对话）。
   * 两个入口都过这里：聊天输入框（AgentPanel.send）和没接 LLM 时盖住面板的配置表单
   * （configEnter → 字段里打着同一句话）。
   *
   * 为什么用打字而不是快捷键：不用记键位，也说得出"我要删哪一个"。
   * 但**打出命令不等于立刻删** —— 这里只把请求交出去（onDelAsk），由 main.js 弹那道红条，
   * 在红条上回车才真删。删的是磁盘上的存档、没有回收站，多一次回车只花时间不花判断力。
   *
   * 只认「整条输入恰好是命令」：带别的字（`/del chat 吧`）、认不出的命令（`/foo`）
   * 一律当普通正文交给模型 —— 绝不能吞用户的话。
   */
  command(text) {
    const s = String(text === undefined || text === null ? '' : text).trim();
    if (!s.startsWith('/')) return false;
    const [name, ...args] = s.slice(1).split(/\s+/).map((x) => x.toLowerCase());
    if (name === 'del' && args.length === 1 && args[0] === 'chat') {
      // 没有装配钩子（理论上不会）时**什么都不做**：删存档这种事不能有"静默兜底"，
      // 宁可这条命令看起来没反应，也不能在没有确认的情况下把对话删掉。
      if (this.onDelAsk) this.onDelAsk();
      return true;
    }
    // /llm：把当前对话的配置框叫回来。配置框可以随手收起来（ESC / 取消）去看历史，
    // 没有这个入口的话，收起来就再也找不回了。
    if (name === 'llm' && args.length === 0) {
      this.configOpen();
      return true;
    }
    return false;
  }

  /**
   * /del chat 的执行步骤：关掉当前对话（连存档一起删）。**只由确认之后调用**
   * （main.js 的 confirmConvClose），命令解析本身不碰它。
   * 只剩一个时关不掉 —— 面板没有"零个对话"这个状态；那就**先开一个新的再关旧的**，
   * 结果一样（旧内容连同存档一起没了），面板还能继续用。
   */
  delChat() {
    const t = this.tab;
    if (!t) return false;
    const label = t.title();
    if (this.tabs.length <= 1) {
      const fresh = this.newTab();                     // 先建后删：任何一帧都至少有一个对话
      if (!fresh) return false;                        // 真到上限（8 个）才可能失败
      this.closeTab(0);                                // 关掉那个旧的（存档也删）
      fresh.pushT('info', 'ui.agent.cleared');
      if (this.onConvClosed) this.onConvClosed(label, 'replaced');
      return true;
    }
    if (!this.closeTab()) return false;
    if (this.onConvClosed) this.onConvClosed(label, 'closed');
    return true;
  }

  // ── 落盘 ──────────────────────────────────────────────────────
  _markDirty(t) {
    if (!t || !t.id) return;
    this._dirty.add(t);
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.flushSaves(); }, SAVE_DEBOUNCE);
  }

  /** 把改过的对话写盘（后端只收下"用户说过话"的对话，见 server 的 writeConv） */
  flushSaves() {
    if (!this._dirty.size) return;
    const todo = [...this._dirty];
    this._dirty.clear();
    for (const conv of todo) {
      try {
        // 存盘时把 k / a（i18n 的 key + 参数）剥掉 —— 存档格式跟以前完全一样，
        // 语言包换了以后旧存档也能正常读（读回来就只剩 text，按当时那句显示）。
        const msgs = conv.msgs.map(({ k, a, ...rest }) => rest);
        // llm = 这个对话自己的 API 配置。**明文落盘**，但 run/ 在 .gitignore 与推送脚本的排除表里
        // —— 它只存在于本机，绝不会跟着代码推上 GitHub（这条在 README 里也写了）。
        // keep = "这个标签真的开着"：让后端在"既没说过话也没配过"时也存下来，
        // 免得关掉 HUD 再开标签数对不上（见 AgentConv.keepOpen）。
        // charpack = 这个对话的形象（'auto' = 让模型挑），charpackPicked = 模型挑出来的那个包。
        saveConv({
          id: conv.id, title: conv.saveTitle(), msgs, llm: conv.llm || null,
          keep: !!conv.keepOpen, charpack: normArt(conv.charpack), charpackPicked: normArtPick(conv.charpackPicked),
          // persona = 这个对话的性格（见 AgentConv.persona）；脏值收敛成 default，不猜
          persona: normPersona(conv.persona),
          // mood = 这个对话自己的心情（state/表情/强度/心里话/配色值）。
          // 跟形象、性格同一个道理：**它属于这一段对话**，不是全局的（见 AgentConv 构造函数）。
          // 不存的话，重启一次所有对话都回待机 —— "关掉再开跟退出前一样"就废了。
          mood: conv.mood ? conv.mood.snapshot() : null,
          // 色号跟着对话存：重启后"那个颜色 = 那个对话"的对应关系不能断（2026-10-15 用户报的）。
          ci: conv.ci,
        });
      } catch (e) { /* 后端没起来就算了 */ }
    }
  }

  /**
   * 启动时从后端恢复：把存档的对话重新变成标签。
   * 一个都没存过（或后端没起来）就保留构造函数里那个空对话 —— 但**要把它记进存档**，
   * 否则"我开着 2 个没配的标签、关掉 HUD 再开只剩 1 个"就没法避免（2026-10-14 用户报的）。
   */
  async restore() {
    // 恢复这一趟**无论怎么收尾**（后端没起来、一个存档都没有、正常恢复）都要开闸：
    // 开了闸，切标签才允许把"落在哪个对话"记进 ui-state（见 _saveActive / _restored）。
    // 不开的话，后端那次刚好慢一点，往后一整趟运行都不记账 —— 那正是要修的症状。
    try { await this._restoreTabs(); } finally { this._restored = true; }
  }

  async _restoreTabs() {
    let r = null;
    try { r = await listConvs(); } catch (e) { return; }   // 后端没起来：不落盘（落了也写不进去）
    const metas = (r && Array.isArray(r.convs)) ? r.convs : [];
    if (!metas.length) return this._keepBootTab();
    const loaded = [];
    for (const m of metas.slice(-MAX_CONVS)) {
      let c = null;
      try { c = await getConv(m.id); } catch (e) { c = null; }
      // 空的也要收：那个标签可能是"用户开着、还没来得及配/说话"的（keep 存下来的）
      if (c && Array.isArray(c.msgs)) loaded.push(c);
    }
    if (!loaded.length) return this._keepBootTab();
    for (const t of this.tabs) t.dispose();
    this.tabs = [];
    this._dirty.clear();
    this._colorSeq = 0;                        // 只影响"之后新开的"对话；恢复出来的用存档里那个
    // 恢复时没有"按 + 时所在的对话"这回事，只能拿**前面那个对话**当参照：
    // 它自己那份配置（最近配好的那份）给后面没配的对话预填一下，省得每个都重贴。
    let prevLlm = null, prevArt = 'auto', prevPersona = 'default';
    for (const c of loaded) {
      // 颜色：存档里那个才是"认标签的记号"，得原样还回来（不然重启一次颜色就洗牌 ——
      // 标签顺序是按 updatedAt 排的，跟当初的创建顺序不一样）。老存档没这个字段、值坏了、
      // 或者跟前面某个对话撞了 → 现派一个（_pickColor 会跳过已经用掉的）。
      const want = normCi(c.ci);
      const ci = (want !== null && !this.tabs.some((x) => x.ci === want)) ? want : this._pickColor();
      const t = this._mkTab(c.id, ci, c.mood);
      t._title = c.title || '';
      t.keepOpen = true;                       // 它在存档里 —— 以后再落盘也带着 keep，不会被判成"空对话"丢掉
      // 每个对话带回自己那份配置
      if (c.llm) { t.llm = { ...c.llm }; prevLlm = { ...c.llm }; }
      // 以及自己那个形象（'auto' 或包 id，见 AgentConv.charpack）
      t.charpack = normArt(c.charpack);
      t.charpackPicked = normArtPick(c.charpackPicked);
      prevArt = t.charpack;
      // 以及性格（见 AgentConv.persona）——脏值一律回落 default，不猜
      t.persona = normPersona(c.persona);
      prevPersona = t.persona;
      t.msgs = c.msgs.map((m) => {
        const o = { role: m.role, text: String(m.text || '') };
        if (m.result) o.result = String(m.result);
        return o;                              // 存档里没有 stream/done —— 半截流不会残留
      });
      this.tabs.push(t);
      // 带回了自己的配置就没事；没带回来（老存档、或在配置前就关掉的那次）→ 照规矩停在配置界面。
      this._openFormIfUnset(t, prevLlm, prevArt, prevPersona);
    }
    // 默认落在最近更新的那个对话上 —— 这只是**兜底**：真正常用的是"上次退出前那个"，
    // 由 main.js 读完 ui-state 后调 selectSavedConv() 拨过去（2026-10-17 用户报的：
    // 切到第一个对话关掉，重开却落在第二个）。这里不调 _saveActive：此刻还不知道该落哪，
    // 早写一笔只会把盘上那份正确答案盖掉。
    this.active = this.tabs.length - 1;
    this.syncFocus();
  }

  /**
   * 启动时一个存档都没恢复出来（第一次开、存档被删光、或全读不出来）：
   * 把构造函数留下的那个空标签**记进存档**再收工。
   * 这样下次开 HUD 就恢复出它 —— 标签数跟关之前一样，不会再"自己少一个"。
   */
  _keepBootTab() {
    const t = this.tab;
    if (!t) return;
    t.keepOpen = true;
    this._markDirty(t);                        // 立刻排一次落盘（debounce 之后真正写）
    // 这里没有"上一个对话"可以预填（存档一个都没读出来）→ 空表单，等人自己填
    this._openFormIfUnset(t, null, null, 'default');
  }

  // ── 配置框 ────────────────────────────────────────
  /**
   * 把一份配置灌进**指定那份表单**（表单在对话身上，所以要显式传，不能默认用"当前"那份）。
   * llm 为 null（这个对话还没配过）→ 字段全清空。
   * art = 形象那一栏预填成什么（'auto' 或包 id）。它跟 llm 来源**同一个对话** ——
   * 新对话继承的是"按 + 时看着的那个对话"的形象设置；「自动」继承过去还是「自动」，
   * 新对话的模型会自己再挑一个（挑的结果不继承：那是它自己的形象）。
   * persona = 性格那一栏预填成什么（'default' 或某个性格 id），同样跟 llm 来源同一个对话。
   */
  _fillForm(form, llm, art, persona) {
    if (!form) return;
    const set = (k, v) => { const f = form.fields.find((x) => x.key === k); if (f) f.value = v || ''; };
    set('baseUrl', llm ? llm.baseUrl : '');
    set('apiKey', llm ? llm.apiKey : '');
    set('model', llm ? llm.model : '');
    set('provider', normProvider(llm ? llm.provider : 'auto'));
    set('charpack', art || 'auto');
    set('persona', normPersona(persona));
    form.caret = 0;
  }

  /**
   * 把**指定对话**的配置表单摊开（returns 那份表单）。configOpen 是它对外的壳 ——
   * restore() 重建对话时还不能改 this.active，所以需要这种显式传目标的形式。
   * opts.isNew：这是刚点「+」建出来的对话 → 取消 = 撤销新建（删标签）
   * opts.seed：首次摊开时按它预填（优先于这个对话自己那份）
   */
  _openForm(tab, opts) {
    const o = opts || {};
    if (!tab) return null;
    const reuse = !!tab.cfg;
    const f = tab.cfg || this._mkForm();      // 已经在配了就接着用那份，别把人填的东西冲掉
    f.isNew = !!o.isNew;
    f.auto = !!o.auto;
    f.idx = 0;
    f.bad = false;
    f.busy = false;
    tab.cfg = f;
    if (!reuse) {
      this._fillForm(f, o.seed || tab.llm, o.seedArt || (tab ? tab.charpack : 'auto'),
        o.seedPersona || (tab ? tab.persona : 'default'));
    }
    f.msgKey = o.isNew ? 'ui.agent.form.hintNew' : 'ui.agent.form.hint';
    f.msgArgs = null;
    // 隐藏输入框只服务于**当前**这个对话（别的表单用不上，也不该被它的内容带跑）
    if (tab === this.tab && this._clearHidden) this._clearHidden();
    return f;
  }

  /**
   * 没配 LLM 的对话**就该停在配置界面**，而不是摆一个能打字、发出去却被弹回来的空聊天框。
   * 适用：冷启动那个起手对话、/del chat 之后补的那个、restore 出来没带回配置的那些。
   * seed 是拿来预填的那份配置（**由调用方决定是谁的**：新建走 _llmOfTab，恢复走前面那个对话；
   * 没有就留空表单）。
   */
  _openFormIfUnset(tab, seed, seedArt, seedPersona) {
    if (!tab || tab.llm || tab.cfg) return null;
    return this._openForm(tab, { seed, seedArt, seedPersona, auto: true });
  }

  /**
   * 打开配置框。编的是**当前对话自己的**那份配置，表单也存在这个对话上 ——
   * 所以切走不需要"收拾现场"：回来时刚才填的一半还在。
   * opts.isNew = true：这是刚点「+」建出来的对话 —— 那种情况下点取消 = 撤销新建（删掉这个标签）。
   */
  configOpen(opts) { return this._openForm(this.tab, opts); }
  /** 收起配置框：把这个对话身上那份表单摘掉（连同状态行一起消失） */
  configClose() {
    const f = this.form;
    if (f) f.idx = -1;
    if (this.tab) this.tab.cfg = null;
    if (this._clearHidden) this._clearHidden();   // 清掉残留的字段文本，免得污染聊天输入框
  }
  /**
   * 点「取消」会怎样，取决于这个配置框是怎么打开的：
   *   新建对话时打开的（isNew）→ 撤销新建，直接删掉这个刚建的标签（结果等同 /del chat）。
   *     "建了又不配"只会留下一个没用的空对话，所以不留。唯一例外是**它已是最后一个标签**：
   *     删了面板就空着没法用，那种情况退化成普通关闭。
   *   其余（自动摊开的、/llm 手动打开的）→ 只收起来：这个对话还能看历史、还能切走，
   *     但它没配 LLM 就是发不出消息，所以补一句提示告诉人怎么回来。
   */
  configCancel() {
    const f = this.form;
    if (!f) return;
    const victim = (f.isNew && this.tabs.length > 1) ? this.tab : null;
    this.configClose();
    // 新建的对话还没内容，删它不用弹那道红条确认 —— 那道确认是给"已经有内容的对话"用的
    if (victim) { this.closeTab(this.tabs.indexOf(victim)); return; }
    // 状态行随着配置框一起没了，这句话得落在对话里才看得见
    if (!this.llmConfigured) this.tab.pushT('info', 'ui.agent.form.hintSkip');
  }
  configNav(dir) {
    const f = this.form;
    if (!f) return;
    const n = f.fields.length + 2;     // 字段 + 保存 + 取消
    f.idx = (f.idx + dir + n) % n;
  }
  // 循环字段（协议 / 形象）：←→ 在候选值里转一圈
  // 注意形象这一栏**不立刻生效** —— 它跟 LLM 配置一样，点了「保存」才算数
  // （「自动」还得等保存时问过模型才知道是哪个包）。
  configCycle(dir) {
    const form = this.form;
    if (!form) return;
    const f = form.fields[form.idx];
    if (!f || !f.cycle || !f.opts) return;
    const i = f.opts.findIndex((o) => o[0] === f.value);
    const n = (i + dir + f.opts.length) % f.opts.length;
    f.value = f.opts[n][0];
  }

  // 当前字段是否接受文本输入（循环字段不接受，交给 ←→）
  cfgFieldEditable() {
    const form = this.form;
    const f = form ? form.fields[form.idx] : null;
    return !!(f && !f.cycle);
  }
  /** 当前字段是不是"循环选择"型（协议）——只有它才吃 ←→ */
  cfgCycleField() {
    const form = this.form;
    const f = form ? form.fields[form.idx] : null;
    return !!(f && f.cycle);
  }
  /** 隐藏输入框的光标变了（←→ / Home / End / 点击），同步到当前字段 */
  syncFormCaret(pos) {
    const form = this.form;
    if (!form) return;
    const f = form.fields[form.idx];
    if (!f || f.cycle) return;
    const n = (f.value || '').length;
    form.caret = Math.max(0, Math.min(n, pos ?? n));
  }
  /** 切到另一个字段时，光标默认停在该字段末尾 */
  formCaretToEnd() {
    const form = this.form;
    if (!form) return;
    const f = form.fields[form.idx];
    form.caret = f ? (f.value || '').length : 0;
  }
  configEnter() {
    const form = this.form;
    if (!form) return;
    const b = form.fields.length;
    // 没接 LLM 时这张表单会盖住对话区，键盘其实是落在字段上的（输入框就是字段本身）——
    // 那种状态下也得删得掉不想要的对话，否则"打 /del chat 就能删"这条规矩就成了有时灵有时不灵。
    // 命中了就把字段让出来：那是 API 地址/Key 的位置，不能留一行命令在里头。
    const i = form.idx;
    if (i >= 0 && i < b && this.command(form.fields[i].value)) {
      form.fields[i].value = '';
      form.caret = 0;
      if (this._clearHidden) this._clearHidden();   // syncCfgHidden 刚才可能又把它填回去了
      return;
    }
    if (i >= 0 && i < b) {
      // 字段上回车：最后一个字段→跳到保存按钮，否则下一个字段
      form.idx = (i === b - 1) ? b : i + 1;
    } else if (i === b) {
      this.configSave();
    } else if (i === b + 1) {
      this.configCancel();
    }
  }
  // 保存前必须先连通验证；验证不过就**不写盘**——只放过一个真能用的配置
  async configSave() {
    const form = this.form;
    if (!form || form.busy) return;
    const tab = this.tab;                     // 认准触发保存的那个对话：中途可能切走过
    const get = (k) => {
      const f = form.fields.find((x) => x.key === k);
      return (f ? f.value : '').trim();
    };
    const say = (key, args) => {              // 状态行只写这份表单，不会串到别的对话去
      form.msgKey = key || '';
      form.msgArgs = args || null;
    };
    const body = {
      baseUrl: get('baseUrl'),
      apiKey: get('apiKey'),
      model: get('model'),
      provider: normProvider(get('provider')),
    };
    if (!body.baseUrl || !body.apiKey) { form.bad = true; say('ui.agent.form.needBoth'); return; }

    form.busy = true;
    form.bad = false;
    say('ui.agent.form.testing');
    // 变量名不能叫 t —— 那是 i18n 的取词函数（本文件顶部 import 的），撞名后 t('ui...') 就炸了
    let res;
    try { res = await testLlmConfig(body); } catch (e) { res = { ok: false, error: String(e.message) }; }

    if (!res || !res.ok) {
      // 验证失败：保留原输入框内容让用户改，已有配置（若之前配通过）不受影响
      form.busy = false;
      form.bad = true;
      say('ui.agent.form.testFail', { err: (res && res.error) || t('ui.shell.unknownError') });
      return;
    }

    try {
      // 自动识别成功时把认出来的协议一起存下来，之后对话就不用再猜
      if (res.provider) body.resolved = res.provider;
      const cfg = {
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
        model: body.model || 'gpt-3.5-turbo',
        provider: body.provider,
        resolved: body.resolved || '',
      };
      if (!tab) { form.busy = false; form.bad = true; say('ui.agent.form.saveFail'); return; }
      // 只写**这个对话**：不动别的对话、也不再往后端写任何全局文件
      tab.llm = cfg;
      // 形象：用户选的那个值先落下来（'auto' 或包 id）
      const want = normArt(get('charpack'));
      tab.charpack = want;
      tab.charpackPicked = '';                 // 重挑：上一次的结果不沿用
      // 性格：选到哪个存哪个（不用额外请求 —— 它只是一段喂给模型的文本）
      tab.persona = normPersona(get('persona'));
      form.isNew = false;                   // 配好了，取消键回到普通语义（不再删标签）
      this._markDirty(tab);                 // 立刻落盘：别等到说过话才存，白填一遍太亏

      // 「自动」= 让**刚配好的这个模型**自己挑一个形象。放在这里（验证通过之后、收起表单之前）
      // 是因为：① 挑不挑得出来取决于这份配置真的能用；② 状态行还开着，结果看得见。
      // 只有一个包时不必问 —— 没得挑，浪费一次请求。
      let pickErr = '';
      if (want === 'auto') {
        const cands = this._artCands();
        if (cands.length > 1) {
          say('ui.agent.form.pickArt');
          let pr = null;
          try { pr = await pickArt({ ...cfg, packs: cands }); } catch (e) { pr = { ok: false, error: String(e.message) }; }
          if (pr && pr.ok) tab.charpackPicked = normArtPick(pr.id);
          else pickErr = (pr && pr.error) || t('ui.shell.unknownError');
          this._markDirty(tab);              // 挑出来了立刻存 —— 别等下次说话
        }
      }
      if (this.onArtChange) this.onArtChange();   // 立绘跟着当前对话换（选的是别的对话也不亏，幂等）
      form.busy = false;
      form.bad = false;
      // via / pname 是**片段**：由各自的语言包拼进整句（别的语言语序不同，不能按片段硬拼）
      const via = res.via === 'models' ? t('ui.agent.form.modelChecked') : '';
      const pname = res.provider ? ` · ${providerLabel(res.provider)}` : '';
      // 挑形象失败**不影响保存**：配置本身是好的，形象退回默认包（自动但没挑到 → artId() 为空）
      if (pickErr) say('ui.agent.form.pickArtFail', { err: pickErr });
      else say('ui.agent.verifyOk', { ms: res.ms, via, pname });
      setTimeout(() => {
        // 还在这一份表单上（中途没被别的表单顶掉、也没被删）才收起来
        if (this.form !== form) return;
        this.configClose();
        // 收尾那句系统提示进**这个对话**：期间可能切走过，别写进别人身上
        if (tab) tab.pushT('info', 'ui.agent.llmOn', { model: cfg.model });
        // 「自动」挑出来了就在对话里留一句：状态行一会儿就没了，
        // 但"这个形象是它自己挑的 / 挑的是哪个"是该看得见、也留得住的事。
        if (tab && want === 'auto' && tab.charpackPicked) {
          tab.pushT('info', 'ui.agent.artAuto', { id: tab.charpackPicked, model: cfg.model });
        }
      }, 900);
    } catch (e) { form.busy = false; form.bad = true; say('ui.agent.form.saveError', { err: e.message }); }
  }

  // 鼠标点击配置框：命中字段→聚焦该字段；命中保存/取消→执行对应动作
  configMouse(c) {
    const h = this._cfgHits;
    const form = this.form;
    if (!h || !form) return false;
    for (const fd of h.fields) {
      if (c.y === fd.y && c.x >= fd.x0 && c.x < fd.x1) {
        form.idx = form.fields.findIndex((f) => f.key === fd.key);
        // 循环字段：点 ‹ 往回翻、点 › 往后翻，点中间的文字只是聚焦
        // cols 只在文本字段上有值（循环字段没有 text 区，见 drawConfig）
        if (fd.cycle) {
          if (c.x < fd.txtStart) this.configCycle(-1);
          else if (c.x >= fd.txtEnd + 1) this.configCycle(1);
        } else if (fd.cols) {
          const rel = c.x - fd.txtStart;
          // 点在字符起始列 → 光标落在它**前面**；点在后半格（宽字符）→ 落在它后面
          let i = 0;
          for (let k = 0; k < fd.cols.length; k++) { if (fd.cols[k] < rel) i = k + 1; else break; }
          form.caret = Math.min(fd.val.length, fd.off + i);
        }
        return true;
      }
    }
    if (c.y === h.save.y && c.x >= h.save.x0 && c.x < h.save.x1) { this.configSave(); return true; }
    if (c.y === h.cancel.y && c.x >= h.cancel.x0 && c.x < h.cancel.x1) {
      this.configCancel();
      return true;
    }
    return false;
  }

  // ── 标签栏 ────────────────────────────────────────────────────
  /** 命中标签栏：返回对话下标；-1 = “+”新建；null = 没点标签栏 */
  tabAt(x, y) {
    for (const h of this._tabHits) if (x >= h.x0 && x <= h.x1) return h.idx;
    return null;
  }

  /** 标签栏在 AGENT 框**外**：紧贴在框顶线上面那一行 */
  tabBarRow() { return this.rect ? this.rect.y - 1 : -1; }

  syncFocus() {
    for (const t of this.tabs) t.focus = this._focus && t === this.tab;
    this._syncRect();
  }

  _syncRect() {
    const r = this.rect;
    if (!r) return;
    for (const t of this.tabs) t.rect = { x: r.x, y: r.y, w: r.w, h: r.h };
  }

  draw(g, C) {
    const r = this.rect, T = C.theme;
    if (!r || r.w < 10 || r.h < 5) return;
    this._hdr = this._hdrText(g);
    g.box(r.x, r.y, r.w, r.h, this._focus ? T.accent : T.line, T.panel, 'AGENT', T.accent, this._hdr);
    this._drawTabMarks(g, C, r);
    if (this.inConfig) { this.drawConfig(g, C); return; }   // 配置框盖住对话区
    const t = this.tab;
    if (t) { t.rect = { x: r.x, y: r.y, w: r.w, h: r.h }; t.focus = this._focus; t.body(g, C); }
  }

  /**
   * 框顶右上角显示什么：**接上就显示真在用的模型 id**（从后端配置读回来的，不是写死的 "llm"）。
   * 流式输出中不再换成 "streaming" —— 底部状态行本来就在报「流式输出中 · N tok/s」，
   * 右上角那点地方留给"到底在跟谁说话"更有用。
   * 宽度按"标题 + 色标 + 间隔"剩下的算，放不下就截断。
   */
  _hdrText(g) {
    if (!this.llmConfigured) return t('ui.agent.status.off');
    const m = String(this.llmModel || '').trim();
    if (!m) return t('ui.agent.status.on');     // 配好了但后端没给模型名（不该发生，别显示空白）
    const r = this.rect;
    const need = this.tabs.length ? this.tabs.length * 2 - 1 : 0;
    // 标题 'AGENT' 占 5 列 + 与状态字之间至少 1 列 + 右侧边框前后各 1 列
    const avail = r.w - 10 - need - HDR_GAP;
    return clipCols(g, m, Math.max(HDR_MIN, avail));
  }

  /**
   * 框顶线右端：每个对话一个属于自己的小方块（当前那个点亮成实心），
   * 取代数字编号 —— 认对话靠颜色，"是第几个"本来就没意义。
   * 要往左让出状态字（模型 id），并且**中间空 HDR_GAP 列**：色块是有颜色的方块，
   * 跟文字贴在一起会被看成一坨。
   */
  _drawTabMarks(g, C, r) {
    const T = C.theme, n = this.tabs.length;
    this._marksX0 = null;                        // 端到端/回归要看色块到底落在哪一列
    if (n < 1) return;
    const need = n * 2 - 1;                      // 方块之间空一格
    const rw = this._hdr ? g.strWidth(this._hdr) : 0;
    const hdrStart = (r.x + r.w - 1) - 1 - rw;   // 状态字第一列（box() 里 right 就画在这儿）
    const x0 = hdrStart - (rw ? HDR_GAP : 0) - need;
    const titleEnd = r.x + 2 + g.strWidth('AGENT');   // 标题占的最后一列
    // 太窄就不画：色块既不能压到标题（至少空一列），也不能碰到状态字
    if (x0 <= titleEnd || x0 + need > hdrStart - 1) return;
    this._marksX0 = x0;
    for (let i = 0; i < n; i++) {
      const on = i === this.active;
      const x = x0 + i * 2;
      const col = this.tabs[i].color();
      // 颜色就是身份，别再压暗：只要实心/半块就能分出是不是当前对话
      g.set(x, r.y, on ? '█' : '▄', col, T.panel);
      if (i < n - 1) g.set(x + 1, r.y, ' ', T.accent, T.panel);
    }
  }

  /**
   * 标签栏画在 AGENT 框的顶部边缘线**之上**那一行（框外）。
   * 分栏态下那一行就是横向分割条，所以 main.js 里它必须先于分割条的命中判定。
   * 必须晚于全局 chrome 的分隔线绘制，否则会被那行 '─' 盖掉。
   */
  drawTabBar(g, C) {
    const r = this.rect, T = C.theme;
    if (!r) return;
    const y = r.y - 1;
    if (y < 0) return;
    this._tabHits = [];
    const maxX = r.x + r.w;                      // 独占：[r.x, r.x+r.w)
    let x = r.x;
    for (let i = 0; i < this.tabs.length; i++) {
      const t = this.tabs[i];
      const name = t.title();
      const w = 2 + g.strWidth(name) + 1;        // 色标 + 空格 + 名字 + 空格
      if (x + w > maxX - 3) { g.text(x, y, '…', T.darker, T.bg); x += 1; break; }
      const on = i === this.active;
      const col = t.color();
      // 当前对话：淡染一层自己的颜色当底；其余保持底色，只靠色标/字色区分
      const bg = on ? mix(T.panel, col, 0.16) : T.panel;
      for (let k = 0; k < w; k++) g.set(x + k, y, ' ', T.dim, bg);
      // 色标实心 = 当前；半块 = 后台。形状 + 颜色两条通道，都不用数数
      g.set(x, y, on ? '█' : '▄', col, bg);
      g.text(x + 2, y, name, on ? col : T.dim, bg, on ? ATTR.BOLD : 0);
      this._tabHits.push({ x0: x, x1: x + w - 1, idx: i });
      x += w;
    }
    if (this.tabs.length < MAX_CONVS && x + 3 <= maxX) {
      g.text(x, y, ' + ', T.dim, T.bg);
      this._tabHits.push({ x0: x, x1: x + 2, idx: -1 });
    }
    // 剩下的空位**不用补线**：这一行本来就是分割条 / 顶部分隔线，留给它自己
  }

  // 配置框：在面板正中画一个表单（字段 + 保存/取消 + 状态），盖住对话区
  drawConfig(g, C) {
    const r = this.rect, T = C.theme;
    const x = r.x + 1, iw = r.w - 2;
    // 先把对话区刷成面板底色，避免文字从背后漏出来
    for (let yy = r.y + 1; yy < r.y + r.h - 1; yy++) g.text(x, yy, ' '.repeat(iw), T.text, T.panel);

    const cx = r.x + Math.floor((r.w - 2) / 2);
    const midY = r.y + Math.floor((r.h - 1) / 2);
    const title = t('ui.agent.formTitle');
    g.text(cx - Math.floor(g.strWidth(title) / 2), midY - 6, title, T.accent, T.panel);
    g.text(x + 2, midY - 5, '─'.repeat(Math.max(0, iw - 4)), T.line, T.panel);

    const form = this.form;
    if (!form) return;
    const fields = form.fields;
    const labelW = Math.max(1, ...fields.map((x) => g.strWidth(t(x.labelKey))));
    const rowHits = [];
    for (let k = 0; k < fields.length; k++) {
      const field = fields[k];
      const active = form.idx === k;
      let disp = field.value;
      let txtStart = 0, txtEnd = 0, off0 = 0;       // 文本区起止列（点击命中/定位光标）；off0 = 长值的滚动偏移
      let cols = null;                              // 每个可见字符的起始列（只有文本字段有）
      if (field.cycle) {
        // 箭头始终画出来（未选中也画，用暗色），否则用户看不出这两个字符是可点的
        const wOf = (s) => [...s].reduce((n, ch) => n + g.chWidth(ch), 0);
        // 按最长候选名占列：切换时 › 的位置要恒定，否则鼠标点一次就得换个地方点
        const maxW = Math.max(1, ...(field.opts || []).map((o) => wOf(t(o[1]))));
        const txt = cycleLabel(field, disp);
        const txtW = wOf(txt);
        const base = x + 2 + 2 + labelW;            // 行首 = 光标(1) + 空格(1) + 标签列
        txtStart = base + 2;
        txtEnd = txtStart + maxW;
        // 文本在固定宽度的格子内居中：箭头位置不动，同时名字也不会偏到一边
        const padL = Math.max(0, Math.floor((maxW - txtW) / 2));
        const padR = Math.max(0, maxW - txtW - padL);
        const cell = ' '.repeat(padL) + txt + ' '.repeat(padR);
        g.text(x + 2, midY - 3 + k, `${active ? '▸' : ' '} ${padToWidth(g, t(field.labelKey), labelW)}`, active ? T.accent : T.text, T.panel);
        g.text(base, midY - 3 + k, '‹', active ? T.accent : T.dim, T.panel);
        g.text(txtStart, midY - 3 + k, cell, active ? T.accent : T.text, T.panel);
        g.text(txtEnd + 1, midY - 3 + k, '›', active ? T.accent : T.dim, T.panel);
      } else {
        if (field.mask && !active) disp = '*'.repeat(Math.min(disp.length, 22));   // 非编辑态遮住 Key
        const lbl = padToWidth(g, t(field.labelKey), labelW);
        const tx0 = x + 2 + 2 + labelW;        // 行 = 光标(1) + 空格(1) + 标签列
        const avail = Math.max(1, r.x + r.w - 1 - tx0 - 1);
        // 值长过一行就让可视窗口跟着光标滑，光标落在哪一列由 caret 决定
        const c = active ? Math.max(0, Math.min(disp.length, form.caret)) : 0;
        const off = Math.max(0, c - avail + 1);
        g.text(x + 2, midY - 3 + k, `${active ? '▸' : ' '} ${lbl}`, active ? T.accent : T.text, T.panel);
        const vis = disp.slice(off, off + avail);
        // 记录每个可见字符的起始列，鼠标点击才能把光标放到点到那个字符
        cols = [];
        for (let acc = 0, i = 0; i < vis.length; i++) { cols.push(acc); acc += g.chWidth(vis[i]); }
        g.text(tx0, midY - 3 + k, vis, active ? T.accent : T.text, T.panel);
        if (active) {
          const col = tx0 + g.strWidth(disp.slice(off, c));
          if (col < r.x + r.w - 1 && Math.floor(C.t * 2) % 2 === 0) {
            // 光标压在字符上（末尾则是空格），用反色块表示，比固定追加 █ 更接近真输入框
            g.set(col, midY - 3 + k, c < disp.length ? disp[c] : ' ', T.panel, T.accent);
          }
        } else if (!field.value) g.text(tx0, midY - 3 + k, '(' + field.ph + ')', T.darker, T.panel);
        txtStart = tx0; txtEnd = tx0 + avail; off0 = off;
      }
      rowHits.push({ key: field.key, cycle: !!field.cycle, txtStart, txtEnd, off: off0, val: disp, cols });
    }

    // 按钮紧跟最后一个字段（字段数量会变，别写死在 midY+1，否则第 5 行会压到按钮上）
    const bY = midY - 3 + fields.length;
    const b = fields.length;
    const saveLabel = form.busy ? t('ui.agent.btn.testing') : t('ui.agent.btn.save');
    const cancelLabel = t('ui.agent.btn.cancel');
    this._btn(g, T, x + 2, bY, saveLabel, form.idx === b);
    this._btn(g, T, x + 2 + 14, bY, cancelLabel, form.idx === b + 1);

    // 提示可能很长（比如可用模型清单）：折两行、超出面板宽度截断，别溢到邻面板
    const msgW = Math.max(4, iw - 4);
    const msgText = form.msgKey ? t(form.msgKey, form.msgArgs) : '';
    const mLines = wrapText(g, msgText, msgW).slice(0, 2);
    const mColor = form.bad ? T.err : T.warn;
    for (let i = 0; i < mLines.length; i++) g.text(x + 2, bY + 2 + i, mLines[i], mColor, T.panel);
    g.text(x + 2, bY + 4, t('ui.agent.form.keys'), T.dim, T.panel);
    // 记录可点击区域（网格坐标），供鼠标点击命中
    this._cfgHits = {
      fields: rowHits.map((h, k) => ({ ...h, y: midY - 3 + k, x0: x + 1, x1: r.x + r.w - 1 })),
      save: { y: bY, x0: x + 2, x1: x + 2 + g.strWidth(saveLabel) },
      cancel: { y: bY, x0: x + 2 + 14, x1: x + 2 + 14 + g.strWidth(cancelLabel) },
    };
  }

  // 按钮：选中态用反色（panel 字 + accent 底），未选中用暗字
  _btn(g, T, col, y, label, active) {
    if (active) { for (let i = 0; i < label.length; i++) g.set(col + i, y, label[i], T.panel, T.accent); }
    else g.text(col, y, label, T.dim, T.panel);
  }
}

// 标签栏标题：只取第一行、压平空白，超宽就截断（宽字符按 2 列算）。
// 不用 grid 实例 —— 标题在没布局时也要能算（restore() 就发生在 layout 之前）。
function clampTitle(s) {
  const one = String(s === undefined || s === null ? '' : s).split('\n')[0].replace(/\s+/g, ' ').trim();
  if (!one) return t('ui.agent.newConv');
  let out = '', w = 0;
  for (const ch of one) {
    const cw = ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
    if (w + cw > TITLE_MAX) return out + '…';
    out += ch; w += cw;
  }
  return out;
}

// 剥掉心情标记，发历史给真 LLM 时避免把标记回灌给模型。
// 后端流式解析已经剥过一遍，这里是双保险：模型偶尔会写出全角冒号 / 单括号 / 中文键名
// 之类的变体（后端认得，但这条历史可能是旧版本留下来的），所以正则要写得跟后端一样宽：
// 宁可多删一句疑似正文，也不能让 [[mood:...]] 这种控制符在界面上或回灌给模型。
const MOOD_TAG_RE = /\[?\[\s*(?:mood|心情|情绪|emo|emotion|state|status)\s*[:：=][\s\S]*?(?:\]\]|\]|$)/gi;
function stripMood(s) { return String(s || '').replace(MOOD_TAG_RE, '').trim(); }

// 形象字段的值：'auto' 或素材包 id。只认这两种形状 ——
// 存档里可能带着手改过的怪值（空串、别的类型、"../" 之类），一律收敛成 'auto'，
// 免得把脏值一路带到 /api/charpacks 的匹配上。后端 writeConv 也做同样的规范化，两边不会各说各话。
const ART_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
function normArt(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (s === 'auto') return 'auto';
  return ART_ID_RE.test(s) ? s : 'auto';
}
/**
 * 「自动」时模型挑出来的那个包：脏值一律收敛成 **空串**（不是 'auto'）——
 * 空串的含义是"还没挑到"，artId() 会据此让主装配回退默认包；
 * 收敛成 'auto' 反而会造出"包名叫 auto"的假象。
 */
function normArtPick(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return ART_ID_RE.test(s) ? s : '';
}

// 性格字段：只认这五个 id，脏值一律回落 default。
// 跟形象不同，这里**没有「自动」**：性格不是让别人替你挑的东西，只有"没设置"（= default）。
// 后端 normPersona 做同样的收敛，两边不会各说各话。
function normPersona(v) {
  const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  return PERSONA_KEYS.includes(s) ? s : 'default';
}

// 协议字段：只认这三个值，脏值一律回落 auto（后端也做同样的规范化，两边不会各说各话）
const PROVIDER_KEYS = ['auto', 'openai', 'anthropic'];
function normProvider(p) {
  const s = String(p || '').trim().toLowerCase();
  return PROVIDER_KEYS.includes(s) ? s : 'auto';
}
function providerLabel(v) {
  const k = normProvider(v);
  return t(k === 'anthropic' ? 'ui.agent.opt.anthropic' : (k === 'openai' ? 'ui.agent.opt.openai' : 'ui.agent.opt.auto'));
}

/**
 * 存档里带回来的标签色号：合法的（非负整数 + 在色板内）才认，否则 null。
 * 跟 normArtPick 一个道理 —— 脏值不能收敛成某个"看起来合理"的色号，
 * 那会凭空把两个对话染成同一个颜色。
 */
function normCi(v) {
  const n = Number(v);
  return (Number.isInteger(n) && n >= 0 && n < TAB_COLORS.length) ? n : null;
}

/** 循环字段当前值的显示名（协议、心情语句都走这里）—— 候选项第二项存的是语言包 key，现取现翻 */
function cycleLabel(field, value) {
  const o = (field.opts || []).find((x) => x[0] === value);
  return o ? t(o[1]) : String(value);
}

/** 按**显示列宽**补空格（自绘网格里汉字占 2 列，padEnd 按字符数补会对不齐） */
function padToWidth(g, s, w) {
  let out = String(s || '');
  let n = g.strWidth(out);
  while (n < w) { out += ' '; n++; }
  return out;
}

// 像 wrapText，但额外记录每行首字符在原串里的索引 —— 多行输入要靠它把
// 屏幕上的第几行第几列换算回 input 的字符下标。
function wrapIndexed(g, s, w) {
  const out = [];
  let cur = '', cw = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = g.chWidth(s[i]);
    if (cw + c > w && cur !== '') { out.push({ text: cur, start }); start = i; cur = ''; cw = 0; }
    cur += s[i]; cw += c;
  }
  out.push({ text: cur, start });
  return out.length ? out : [{ text: '', start: 0 }];
}

function wrapText(g, s, w) {
  const out = [];
  let cur = '', cw = 0;
  for (const ch of s) {
    const c = g.chWidth(ch);
    if (cw + c > w) { out.push(cur); cur = ''; cw = 0; }
    cur += ch; cw += c;
  }
  out.push(cur);
  return out.length ? out : [''];
}
