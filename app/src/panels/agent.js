// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// AGENT：对话流（thinking 块 / tool_call 卡 / 流式回复）+ 底部状态条
//        未接入 LLM 时，面板正中弹配置框（API 地址 / Key / 模型 + 保存）
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
import {
  askAgent, getLlmConfig, saveLlmConfig, testLlmConfig,
  listConvs, getConv, saveConv, deleteConv,
} from '../api.js';

// 作为上下文回灌给 LLM 的近期消息条数（约等于一半轮数的对话）
const MAX_CTX_MSGS = 20;
const MAX_CONVS = TAB_COLORS.length;   // 对话标签上限 = 色板容量（每个对话一个独有色）
const SAVE_DEBOUNCE = 800;             // 落盘防抖：流式期间每条事件都写盘就太吵了
const TITLE_MAX = 12;                  // 标签栏标题最多占几列
const HDR_GAP = 2;                     // 框顶线右端：色标与右上角状态字之间空几列（贴着会看成一坨）
const HDR_MIN = 6;                     // 状态字再挤也至少给这么多列（否则截得没法认）

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
  constructor(mood, id, ci) {
    this.mood = mood;
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
    this.showMoodTags = false; // 面板同步过来的本地偏好（显示/隐藏 [[mood:...]] 原文）
    this.onDirty = null;       // 内容变了 → 面板排一次落盘
    this.onToken = null;       // 吐字节拍（面板统计 tok/s）
  }

  /** 本对话的颜色（标签栏色标、面板顶线小方块都用它认标签） */
  color() { return TAB_COLORS[this.ci % TAB_COLORS.length]; }

  /** 标签栏上的名字：存档标题 → 第一条用户消息 → 「新对话」（空对话时那个占位名走语言包） */
  title() {
    if (this._title) return clampTitle(this._title);
    const first = this.msgs.find((m) => m.role === 'user' && m.text.trim());
    return first ? clampTitle(first.text) : t('ui.agent.newConv');
  }

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

  /** 把 agent 的心情控制语句记进对话流（开关关掉就不记，协议本身照常生效） */
  noteMood(e) {
    if (!this.showMoodTags) return false;
    if (!e || !e.raw) return false;              // 没有原文（本地兜底心情）就没什么可显示的
    this.push('mood', e.raw);
    return true;
  }

  send(text) {
    const t = text.trim();
    if (!t || this.busy) return;
    if (!this.llmOk) { if (this.onNeedConfig) this.onNeedConfig(); return; }   // 没接 LLM：先弹配置框
    this.push('user', t);
    this.busy = true;
    this.tokens = 0;
    if (this.mood && this.mood.touch) this.mood.touch();   // 用户活动只记时间戳，情绪不该由界面推断
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
    this._cancel = askAgent(t, (e) => {
      switch (e.t) {
        case 'mood':
          // 心情是 agent 的声明直接落地：state 决定配色，face 决定角色立绘
          if (this.mood && this.mood.fromAgent && !this.mood.fromAgent(e)) break;
          // 控制语句本身也显示出来（后端随心情事件带回 raw = 标记原文）：
          // 用户要看见 agent 到底给自己下了什么指令，而不是只看见被剥干净的正文。
          this.noteMood(e);
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
    }, () => { this.busy = false; if (this.onDirty) this.onDirty(this); }, history);
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
      // 心情语句隐藏时是**整行不生成**（对已经攒下来的历史行同样生效）——
      // 只在绘制时把文字换成空白的话，对话里会留下一条莫名其妙的空行。
      if (m.role === 'mood' && !this.showMoodTags) continue;
      const pre = m.role === 'user' ? '› '
        : m.role === 'mood' ? '♥ '
        : m.role === 'think' ? '◐ '
        : m.role === 'tool' ? '⚙ ' : '▌ ';
      const col = m.role === 'user' ? T.accent
        : m.role === 'mood' ? T.warn
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
  constructor(mood) {
    this.mood = mood;
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
    this.llmConfigured = false;  // 后端是否配好了真 LLM
    this.llmModel = '';          // 接的是哪个模型（框顶右上角显示它，不写死一个 "llm"）
    this.inConfig = false;       // 是否正在显示配置框（面板级：LLM 配置跟哪个对话无关）
    this._cfg = null;
    this._cfgIdx = null;
    this._clearHidden = null;    // main.js 注入：关闭配置框时清空隐藏输入框
    this.onConvClosed = null;    // main.js 注入：/del chat 关掉/换掉对话之后，主装配要跟着收拾
    this.onDelAsk = null;        // main.js 注入：/del chat 命中时先弹那道红条确认（不直接删）
    // 字段名 / 候选项名都存**语言包 key**（`labelKey` / opts 第二项），绘制时现取现翻 ——
    // 存成品文案的话，配置框开着的时候切语言它不会跟着变。labelKey 只给显示用，值本身是数据。
    this.form = {
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
        // 心情控制语句 [[mood:...]] 是否原样显示在对话里（默认隐藏：多数时候只看正文；
        // 想确认 agent 给自己下了什么指令时再打开）。它只影响显示，不影响协议本身 ——
        // 隐藏是**整行不渲染**，不是把文字抹成空白（那会留下一条空行）。
        {
          key: 'moodTags', labelKey: 'ui.agent.field.moodTags', value: 'hide', mask: false, cycle: true,
          opts: [['show', 'ui.agent.opt.show'], ['hide', 'ui.agent.opt.hide']],
        },
      ],
      idx: -1,                 // -1 未编辑；0..3 字段；4 保存；5 取消
      caret: 0,                // 当前字段里的光标位置（字符索引）
      msgKey: '',              // 状态行存的是 key + 参数（现取现翻，见 setMsg）
      msgArgs: null,
      busy: false,
    };
    // 心情语句显示开关：本地偏好，不进 LLM 配置（跟后端无关），存 localStorage
    this.showMoodTags = readMoodPref();
    this.form.fields[4].value = this.showMoodTags ? 'show' : 'hide';
    this.newTab();
    this.tab.pushT('agent', 'ui.agent.ready');
    // 启动即拉一次后端配置：没配过就自动弹配置框
    getLlmConfig().then((s) => {
      if (!s) return;
      this.llmConfigured = !!s.configured;
      this._syncLlm();
      if (s.baseUrl) this.form.fields[0].value = s.baseUrl;
      if (s.model) { this.llmModel = s.model; this.form.fields[2].value = s.model; }
      if (s.provider) this.form.fields[3].value = normProvider(s.provider);
      if (!this.llmConfigured) this.configOpen();
    }).catch(() => { this.configOpen(); });
  }

  /** 状态行文案：存 key + 参数，绘制时现取现翻（配置框开着时切语言也能跟着变） */
  setMsg(key, args) { this.form.msgKey = key || ''; this.form.msgArgs = args || null; }

  /** 把"接没接 LLM"同步给每个对话（对话自己不知道后端配置） */
  _syncLlm() { for (const t of this.tabs) t.llmOk = this._llmOk; }

  /** 后端有没有配好 LLM —— 面板级状态，一改就同步给所有对话（含之后新建的） */
  get llmConfigured() { return !!this._llmOk; }
  set llmConfigured(v) { this._llmOk = !!v; this._syncLlm(); }

  // ── 当前对话 ──
  get tab() { return this.tabs[this.active] || null; }
  _nextId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

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
  noteMood(e) { return this.tab ? this.tab.noteMood(e) : false; }
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

  _mkTab(id) {
    const t = new AgentConv(this.mood, id, this._pickColor());
    t.showMoodTags = this.showMoodTags;
    t.llmOk = this.llmConfigured;
    t.focus = this._focus;
    t.onDirty = (c) => this._markDirty(c);
    t.onToken = this._onToken;
    t.onNeedConfig = () => this.configOpen();
    t.rect = this.rect ? { ...this.rect } : null;
    return t;
  }

  // ── 对话管理 ──
  newTab() {
    if (this.tabs.length >= MAX_CONVS) return null;
    const t = this._mkTab(this._nextId());
    this.tabs.push(t);
    this.active = this.tabs.length - 1;
    this.syncFocus();
    return t;
  }

  selectTab(i) {
    if (typeof i !== 'number' || i < 0 || i >= this.tabs.length) return false;
    if (i === this.active) return false;
    this.active = i;
    this.syncFocus();
    return true;
  }

  /** dir>0 下一个，dir<0 上一个（循环） */
  nextTab(dir) {
    const n = this.tabs.length;
    if (n < 2) return false;
    this.active = (this.active + (dir > 0 ? 1 : -1) + n) % n;
    this.syncFocus();
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
        saveConv({ id: conv.id, title: conv.title(), msgs });
      } catch (e) { /* 后端没起来就算了 */ }
    }
  }

  /**
   * 启动时从后端恢复：把存档的对话重新变成标签。
   * 一个都没存过（或后端没起来）就保留构造函数里那个空对话，什么都不做。
   */
  async restore() {
    let r = null;
    try { r = await listConvs(); } catch (e) { return; }
    const metas = (r && Array.isArray(r.convs)) ? r.convs : [];
    if (!metas.length) return;
    const loaded = [];
    for (const m of metas.slice(-MAX_CONVS)) {
      let c = null;
      try { c = await getConv(m.id); } catch (e) { c = null; }
      if (c && Array.isArray(c.msgs) && c.msgs.length) loaded.push(c);
    }
    if (!loaded.length) return;
    for (const t of this.tabs) t.dispose();
    this.tabs = [];
    this._dirty.clear();
    this._colorSeq = 0;                        // 重新按色轮从头上派色，颜色才稳定
    for (const c of loaded) {
      const t = this._mkTab(c.id);
      t._title = c.title || '';
      t.msgs = c.msgs.map((m) => {
        const o = { role: m.role, text: String(m.text || '') };
        if (m.result) o.result = String(m.result);
        return o;                              // 存档里没有 stream/done —— 半截流不会残留
      });
      this.tabs.push(t);
    }
    this.active = this.tabs.length - 1;        // 落在最近更新的那个对话上
    this.syncFocus();
  }

  // ── 配置框 ────────────────────────────────────────
  configOpen() {
    this.inConfig = true;
    this.form.idx = 0;
    this.form.bad = false;
    this.setMsg('ui.agent.form.hint');
    if (this._clearHidden) this._clearHidden();   // 清空可能残留的聊天输入框文本
  }
  configClose() {
    this.inConfig = false;
    this.form.idx = -1;
    this.setMsg('');
    if (this._clearHidden) this._clearHidden();   // 清掉残留的字段文本，免得污染聊天输入框
  }
  configNav(dir) {
    const n = this.form.fields.length + 2;     // 4 字段 + 保存 + 取消
    this.form.idx = (this.form.idx + dir + n) % n;
  }
  // 循环字段（协议 / 心情语句）：←→ 在候选值里转一圈
  configCycle(dir) {
    const f = this.form.fields[this.form.idx];
    if (!f || !f.cycle || !f.opts) return;
    const i = f.opts.findIndex((o) => o[0] === f.value);
    const n = (i + dir + f.opts.length) % f.opts.length;
    f.value = f.opts[n][0];
    if (f.key === 'moodTags') this.applyMoodPref();     // 立刻生效，不用等保存
  }

  /** 把配置框里的「心情语句」选择落到运行时偏好并记住（顺便同步给每个对话） */
  applyMoodPref() {
    const f = this.form.fields.find((x) => x.key === 'moodTags');
    this.showMoodTags = (f ? f.value : 'hide') === 'show';   // 兜底也走隐藏，跟默认值一致
    for (const t of this.tabs) t.showMoodTags = this.showMoodTags;
    writeMoodPref(this.showMoodTags);
  }
  // 当前字段是否接受文本输入（循环字段不接受，交给 ←→）
  cfgFieldEditable() {
    const f = this.form.fields[this.form.idx];
    return !!(f && !f.cycle);
  }
  /** 当前字段是不是"循环选择"型（协议）——只有它才吃 ←→ */
  cfgCycleField() {
    const f = this.form.fields[this.form.idx];
    return !!(f && f.cycle);
  }
  /** 隐藏输入框的光标变了（←→ / Home / End / 点击），同步到当前字段 */
  syncFormCaret(pos) {
    const f = this.form.fields[this.form.idx];
    if (!f || f.cycle) return;
    const n = (f.value || '').length;
    this.form.caret = Math.max(0, Math.min(n, pos ?? n));
  }
  /** 切到另一个字段时，光标默认停在该字段末尾 */
  formCaretToEnd() {
    const f = this.form.fields[this.form.idx];
    this.form.caret = f ? (f.value || '').length : 0;
  }
  configEnter() {
    const b = this.form.fields.length;
    // 没接 LLM 时这张表单会盖住对话区，键盘其实是落在字段上的（输入框就是字段本身）——
    // 那种状态下也得删得掉不想要的对话，否则"打 /del chat 就能删"这条规矩就成了有时灵有时不灵。
    // 命中了就把字段让出来：那是 API 地址/Key 的位置，不能留一行命令在里头。
    const i = this.form.idx;
    if (i >= 0 && i < b && this.command(this.form.fields[i].value)) {
      this.form.fields[i].value = '';
      this.form.caret = 0;
      if (this._clearHidden) this._clearHidden();   // syncCfgHidden 刚才可能又把它填回去了
      return;
    }
    if (i >= 0 && i < b) {
      // 字段上回车：最后一个字段→跳到保存按钮，否则下一个字段
      this.form.idx = (i === b - 1) ? b : i + 1;
    } else if (i === b) {
      this.configSave();
    } else if (i === b + 1) {
      if (this.llmConfigured) this.configClose();
    }
  }
  // 保存前必须先连通验证；验证不过就**不写盘**——只放过一个真能用的配置
  async configSave() {
    if (this.form.busy) return;
    const get = (k) => {
      const f = this.form.fields.find((x) => x.key === k);
      return (f ? f.value : '').trim();
    };
    const body = {
      baseUrl: get('baseUrl'),
      apiKey: get('apiKey'),
      model: get('model'),
      provider: normProvider(get('provider')),
    };
    if (!body.baseUrl || !body.apiKey) { this.form.bad = true; this.setMsg('ui.agent.form.needBoth'); return; }

    this.form.busy = true;
    this.form.bad = false;
    this.setMsg('ui.agent.form.testing');
    // 变量名不能叫 t —— 那是 i18n 的取词函数（本文件顶部 import 的），撞名后 t('ui...') 就炸了
    let res;
    try { res = await testLlmConfig(body); } catch (e) { res = { ok: false, error: String(e.message) }; }

    if (!res || !res.ok) {
      // 验证失败：保留原输入框内容让用户改，已有配置（若之前配通过）不受影响
      this.form.busy = false;
      this.form.bad = true;
      this.setMsg('ui.agent.form.testFail', { err: (res && res.error) || t('ui.shell.unknownError') });
      return;
    }

    try {
      // 自动识别成功时把认出来的协议一起存下来，之后对话就不用再猜
      if (res.provider) body.resolved = res.provider;
      const r = await saveLlmConfig(body);
      this.llmConfigured = !!(r && r.configured);
      this._syncLlm();
      if (this.llmConfigured) {
        if (r.baseUrl) this.form.fields[0].value = r.baseUrl;
        if (r.model) { this.llmModel = r.model; this.form.fields[2].value = r.model; }
        this.form.busy = false;
        this.form.bad = false;
        // via / pname 是**片段**：由各自的语言包拼进整句（别的语言语序不同，不能按片段硬拼）
        const via = res.via === 'models' ? t('ui.agent.form.modelChecked') : '';
        const pname = res.provider ? ` · ${providerLabel(res.provider)}` : '';
        this.setMsg('ui.agent.verifyOk', { ms: res.ms, via, pname });
        setTimeout(() => {
          this.configClose();
          this.pushT('info', 'ui.agent.llmOn', { model: r.model || '' });
        }, 900);
      } else { this.form.busy = false; this.form.bad = true; this.setMsg('ui.agent.form.saveFail'); }
    } catch (e) { this.form.busy = false; this.form.bad = true; this.setMsg('ui.agent.form.saveError', { err: e.message }); }
  }

  // 鼠标点击配置框：命中字段→聚焦该字段；命中保存/取消→执行对应动作
  configMouse(c) {
    const h = this._cfg;
    if (!h) return false;
    for (const fd of h.fields) {
      if (c.y === fd.y && c.x >= fd.x0 && c.x < fd.x1) {
        this.form.idx = this.form.fields.findIndex((f) => f.key === fd.key);
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
          this.form.caret = Math.min(fd.val.length, fd.off + i);
        }
        return true;
      }
    }
    if (c.y === h.save.y && c.x >= h.save.x0 && c.x < h.save.x1) { this.configSave(); return true; }
    if (c.y === h.cancel.y && c.x >= h.cancel.x0 && c.x < h.cancel.x1) {
      if (this.llmConfigured) this.configClose();
      else this.setMsg('ui.agent.form.cantCancel');
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

    const f = this.form.fields;
    // 标签列宽取最长标签（'心情语句' 比 '协议' 宽），箭头与输入框才不会各歪一列
    const labelW = Math.max(1, ...f.map((x) => g.strWidth(t(x.labelKey))));
    const rowHits = [];
    for (let k = 0; k < f.length; k++) {
      const field = f[k];
      const active = this.form.idx === k;
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
        const c = active ? Math.max(0, Math.min(disp.length, this.form.caret)) : 0;
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
    const bY = midY - 3 + f.length;
    const b = f.length;
    const saveLabel = this.form.busy ? t('ui.agent.btn.testing') : t('ui.agent.btn.save');
    const cancelLabel = t('ui.agent.btn.cancel');
    this._btn(g, T, x + 2, bY, saveLabel, this.form.idx === b);
    this._btn(g, T, x + 2 + 14, bY, cancelLabel, this.form.idx === b + 1);

    // 提示可能很长（比如可用模型清单）：折两行、超出面板宽度截断，别溢到邻面板
    const msgW = Math.max(4, iw - 4);
    const msgText = this.form.msgKey ? t(this.form.msgKey, this.form.msgArgs) : '';
    const mLines = wrapText(g, msgText, msgW).slice(0, 2);
    const mColor = this.form.bad ? T.err : T.warn;
    for (let i = 0; i < mLines.length; i++) g.text(x + 2, bY + 2 + i, mLines[i], mColor, T.panel);
    g.text(x + 2, bY + 4, t('ui.agent.form.keys'), T.dim, T.panel);
    // 记录可点击区域（网格坐标），供鼠标点击命中
    this._cfg = {
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

// 「心情语句 显示/隐藏」是纯本地偏好（跟后端无关），记在 localStorage 里跨会话保留。
// WebView2 里 localStorage 未必可用（隐私模式/异常状态），所以读写都要裹 try。
const MOOD_PREF_KEY = 'ponko.moodTags';
// 默认隐藏：只有用户显式选过「显示」才显示（记不住时回到隐藏，不给正文添乱）
function readMoodPref() {
  try { return localStorage.getItem(MOOD_PREF_KEY) === 'show'; } catch (e) { return false; }
}
function writeMoodPref(show) {
  try { localStorage.setItem(MOOD_PREF_KEY, show ? 'show' : 'hide'); } catch (e) { /* 记不住就算了 */ }
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
