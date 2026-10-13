// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 启动刷屏：eDEX-UI 那种开机日志，但**每一行都是真的**。
//
// 数据只有两个来源，全部现场测出来：
//   host / node / llm / pack / pty / conv / sys / net
//       宿主 native_host.py 与后端 server.js 写进 run/boot.log，前端 GET /api/bootlog
//       取回来回放（见 server/bootlog.js）
//   ui  页面自己这一步真的做了什么：画布尺寸、字体度量、素材包装载、恢复对话…（log()）
//
// 唯一的"演出成分"是**把行与行之间的间隔压缩进预算**——真实间隔是 3ms 还是 400ms，
// 原样照放会让一屏字瞬间闪完；所以按真实间隔的比例压缩，整体收进 ~1.5s（见 BOOT_BUDGET）。
// 每行左边显示的时间戳是**真实的**，一个字都不动。
//
// 放完之后整屏**同时**淡出（不是逐行散场），溶进主题背景再接 HUD 的进场动画 ——
// 走的是 grid 既有的 fadeAll 通道，见 draw()。
import { rgb } from './grid.js';
import { t } from './i18n/index.js';

// 标签色只做语义区分（谁说的话），不参与主题换色
const TAGS = {
  host: { c: rgb(110, 172, 250), w: 4 },
  node: { c: rgb(126, 224, 152), w: 4 },
  llm: { c: rgb(240, 186, 80), w: 3 },
  pack: { c: rgb(198, 140, 252), w: 4 },
  pty: { c: rgb(248, 146, 200), w: 3 },
  conv: { c: rgb(190, 226, 104), w: 4 },
  sys: { c: rgb(140, 168, 182), w: 3 },
  net: { c: rgb(86, 214, 208), w: 3 },
  ui: { c: rgb(96, 232, 200), w: 2 },
  ready: { c: rgb(88, 214, 141), w: 5 },
};
const TAG_W = 5;                 // 标签列宽（含左空格）

export const BOOT_BUDGET = 1500; // 后端日志回放的总时长目标（ms）
const MIN_GAP = 35;              // 相邻两行的展示间隔下限（额度不够时可以为 0）
const MAX_GAP = 260;             // 单行间隔上限：真实等再久也不干等
const CPS = 900;                 // 打字速度（字符/秒）
const LINE_MIN = 42;             // 一行至少停留这么久，再快也要看得见
const HOLD_MS = 300;             // 全部放完到开始淡出之间的停顿（让最后一行看得清）
const FADE_MS = 340;             // 整屏同时淡出的时长

const p2 = (n, w = 2) => String(n).padStart(w, '0');
/** 真实时间戳 → 屏上的 HH:MM:SS.mmm */
export function clockOf(ts) {
  const d = new Date(ts);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p2(d.getMilliseconds(), 3)}`;
}

/**
 * 一行启动日志 → 屏上的文本。
 *   {key, args} —— 宿主/后端写下的行（事件 id + 参数）→ 按**当前语言**渲染；
 *                 语言包没有这条 key 就落 en（见 i18n/index.js 第 2 条），再没有就把 key 亮出来。
 *   {text}      —— 手写行 / 历史格式 → 原样显示，不翻译。
 * 语言包决定了启动画面（含日志）用哪种语言 —— 这也是"日志行只存 id"的原因：
 * 那些行在页面拿到语言包之前就落盘了，只有存 id 才能在屏上按当前语言重渲。
 */
function lineText(l) {
  if (l && l.key) return t(String(l.key), l.args || {});
  return String((l && l.text) === undefined ? '' : l.text);
}

/**
 * 按**列**截断（中文 2 列、西文 1 列）。不能用 String#slice —— 那是按码元切，
 * 一行中文会被切成"两倍宽"，直接盖到框外去。
 */
function cutCols(grid, text, maxCols) {
  const w1 = (ch) => (typeof grid.chWidth === 'function'
    ? grid.chWidth(ch) : (ch.charCodeAt(0) > 0x1100 ? 2 : 1));
  let n = 0, out = '';
  for (const ch of String(text)) {
    const w = w1(ch);
    if (n + w > maxCols) break;
    n += w; out += ch;
  }
  return out;
}

export class BootScreen {
  /**
   * @param {Grid} grid
   * @param {{now?:()=>number, budget?:number, cps?:number, fadeMs?:number}} opts
   *        now 可注入（离线测试用假时钟驱动，不必真等 1.5 秒）
   */
  constructor(grid, opts = {}) {
    this.grid = grid;
    this.now = opts.now || (() => performance.now());
    this.budget = opts.budget === undefined ? BOOT_BUDGET : opts.budget;
    this.perChar = opts.cps === undefined ? CPS : opts.cps;
    this.fadeMs = opts.fadeMs === undefined ? FADE_MS : opts.fadeMs;

    this.active = false;       // 还在刷屏（含最后那段淡出）
    this.done = false;         // 刷完 + 淡出完，可以进 HUD
    this.t0 = 0;
    this.queue = [];           // 待上屏
    this.lines = [];           // 已上屏（含正在打字的）
    this.cur = null;
    this.nextAt = 0;
    this.drainAt = 0;
    this.fading = false;       // 正在整屏淡出（此时不再上新的行）
    this.fadeAt = 0;
    this.pendingDone = false;
    this.backendMs = 0;        // 后端自报的自检耗时（真实）
    this.serverCount = 0;      // 来自 /api/bootlog 的行数
    this.liveCount = 0;        // 页面自己记的行数
    this._seen = new Set();
    this._seq = 0;
    if (typeof window !== 'undefined') window.__ponkoBoot = this;   // 调试/端到端验证入口
  }

  begin() {
    this.active = true;
    this.t0 = this.now();
    return this;
  }

  /**
   * 回放后端启动记录（GET /api/bootlog 的返回）。
   * 可以调多次：第二趟用来把"启动画面演到一半才落进 boot.log 的行"（如地理查询）补上。
   *
   * 节奏算法（"按真实耗时、但总时长可控"）：
   *   每行先占掉自己的**打字时间**（由真实文本长度决定，短行不低于 LINE_MIN），
   *   剩下的额度按**真实间隔的比例**分给"行与行之间"。所以真实等过 600ms 的那一步
   *   在屏上也会明显停顿一下，而整段回放的总时长被 budget 兜住 —— 行多就自动压间隔。
   * @returns {number} 这次新增的行数
   */
  replay(snap) {
    const src = (((snap && snap.lines) || [])).slice().sort((a, b) => a.ts - b.ts);
    // 后端自检耗时用"到开始监听为止"那个真数字（selfMs），没有就退回进程年龄
    if (snap && (snap.selfMs || snap.elapsedMs)) this.backendMs = snap.selfMs || snap.elapsedMs;
    const first = !this._firstReplay;          // 第一趟才做预算分配（第二趟只补零星几行）

    const items = [];
    for (let i = 0; i < src.length; i++) {
      const l = src[i];
      const text = lineText(l);
      const key = `${l.ts}|${l.tag}|${l.key || l.text}`;
      if (this._seen.has(key)) continue;       // 两趟拉回来的重复行只上一次屏
      this._seen.add(key);
      items.push({
        ts: l.ts, tag: l.tag, text, src: 'server', gap: 0,
        reveal: 0, seq: this._seq++, typeMs: this._typeMs(text),
      });
    }
    if (!items.length) return 0;

    // 真实间隔（相邻两行的真实时差）→ 展示间隔
    const raw = items.map((_, i) => (i ? Math.max(0, items[i].ts - items[i - 1].ts) : 0));
    const rawSum = raw.reduce((a, b) => a + b, 0);
    if (first && rawSum > 0) {
      const base = items.reduce((a, it) => a + it.typeMs, 0);
      let free = Math.max(0, this.budget - base);         // 预算减去打字时间 = 分给间隔的额度
      for (let i = 1; i < items.length; i++) {
        items[i].gap = Math.min(MAX_GAP, Math.round((free * raw[i]) / rawSum));
        free -= items[i].gap;                             // 上限截掉的部分不再补给别人（总时长只会更短）
      }
    } else {
      for (let i = 1; i < items.length; i++) {
        items[i].gap = Math.min(MAX_GAP, Math.max(MIN_GAP, raw[i]));
      }
    }
    this._firstReplay = true;

    for (const it of items) this.queue.push(it);
    // 第二趟补进来的行可能比已排队的还早（例如地理查询），按真实时间插回去
    this.queue.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    this.serverCount += items.length;
    return items.length;
  }

  /** 一行要占多久：真实文本长度决定打字时间，短行也不低于 LINE_MIN */
  _typeMs(text) {
    return Math.max(LINE_MIN, (String(text).length * 1000) / this.perChar);
  }

  /** 页面这一步真的做了什么事 —— 现在就记，按到达顺序上屏 */
  log(tag, text) {
    const t = String(text);
    const item = {
      ts: Date.now(), tag, text: t, gap: 0, src: 'live', reveal: 0,
      seq: this._seq++, typeMs: this._typeMs(t),
    };
    this.queue.push(item);
    this.liveCount++;
    return item;
  }

  /** 主流程已经就绪（日志可能还没放完）。放完并停顿之后 done 才会变 true */
  finish() {
    if (!this.pendingDone) {
      this.pendingDone = true;
      const pageS = ((this.now() - this.t0) / 1000).toFixed(2);
      // boot.* 走语言包（默认英文，见 i18n/index.js 第 2 条约定）
      const text = t('boot.done', {
        backend: (this.backendMs / 1000).toFixed(2),
        page: pageS,
        logs: this.lines.length + this.queue.length + 1,
      });
      this.queue.push({
        ts: Date.now(), tag: 'ready', text, gap: 0, src: 'live', reveal: 0,
        seq: this._seq++, typeMs: this._typeMs(text),
      });
    }
    return this.done;
  }

  /**
   * 兜底：不管放没放完，立刻把剩下的一次性摆到屏上然后收工（不淡出，直接换 HUD）。
   * 只给"主循环压根没在跑"的极端情况用（比如窗口建出来时不可见、rAF 被节流到不触发），
   * 否则 boot() 会一直等它 —— 界面就卡在启动画面上了。
   */
  forceDone() {
    while (this.queue.length) {
      const it = this.queue.shift();
      it.reveal = it.text.length;
      this.lines.push(it);
    }
    this.cur = null;
    this.fading = false;
    this.done = true;
    this.active = false;
    return this;
  }

  /**
   * 整屏的可见度：1 = 正常，0 = 完全溶进主题背景。
   * **放完之前恒为 1**，进入淡出之后才按 fadeMs 线性掉到 0 ——
   * 全屏共用这一个值，所以是"所有元素同时淡出"，不是逐行散场。
   */
  alpha(now) {
    if (!this.fading) return 1;
    const t = ((now === undefined ? this.now() : now) - this.fadeAt) / this.fadeMs;
    return Math.max(0, Math.min(1, 1 - t));
  }

  /** 推进打字与节奏。由主循环每帧调用（传当帧的 now，与构造时的时钟同源） */
  advance(now) {
    if (!this.active || this.done) return;
    if (!this.cur && now >= this.nextAt && this.queue.length) {
      this.cur = this.queue.shift();
      this.cur.at = now;
      this.lines.push(this.cur);
    }
    if (this.cur) {
      const dt = (now - this.cur.at) / 1000;
      this.cur.reveal = Math.min(this.cur.text.length, Math.max(1, Math.ceil(dt * this.perChar)));
      // 长行打字占的时间长、短行至少 LINE_MIN，两者都由 typeMs 兜住
      if (this.cur.reveal >= this.cur.text.length && now - this.cur.at >= (this.cur.typeMs || LINE_MIN)) {
        this.cur = null;
        const nxt = this.queue[0];
        this.nextAt = now + (nxt ? nxt.gap : 0);
      }
    }
    if (this.queue.length) this.drainAt = 0;      // 又有新行进来（比如第二趟补的），重新计时
    if (this.cur || this.queue.length || !this.pendingDone) return;
    // 全部上屏 → 停 HOLD_MS 让人看清最后一屏 → 整屏淡出 FADE_MS → 才 done
    if (!this.drainAt) this.drainAt = now;
    if (!this.fading) {
      if (now - this.drainAt >= HOLD_MS) { this.fading = true; this.fadeAt = now; }
      return;
    }
    if (now - this.fadeAt >= this.fadeMs) { this.fading = false; this.done = true; this.active = false; }
  }

  /** 全屏绘制。T 用当前主题（启动时是 idle）；now 与 advance 同源（缺省用注入的时钟） */
  draw(grid, T, now) {
    const cols = grid.cols, rows = grid.rows;
    // 整屏同时淡出：连底色一起溶进主题背景（fadeAll）—— 只淡字的话会剩一地
    // 标题块和分隔线拖到最后，看着像"擦屏幕"而不是"淡出"。画完立刻复位，
    // 别让这几个字段漏给 HUD 的绘制路径。
    const a = this.alpha(now);
    const fading = a < 1;
    if (fading) { grid.fadeBg = T.bg; grid.fadeAll = true; grid.fade = a; }
    grid.fill(0, 0, cols, rows, ' ', T.text, T.bg);

    // ── 头部：只有标题 + 分隔线（第 2 行留空，给标题块一点呼吸）
    const title = ' PONKO-HUD ';
    grid.text(Math.max(1, Math.floor((cols - title.length) / 2)), 1, title, T.bg, T.accent);
    grid.text(0, 3, '─'.repeat(cols), T.line, T.bg);

    // ── 日志区
    const top = 5;
    const bottom = Math.max(top + 3, rows - 3);
    const show = this.lines.slice(-(bottom - top));
    let y = top;
    for (const l of show) {
      const tag = TAGS[l.tag] || TAGS.ui;
      grid.text(0, y, clockOf(l.ts), T.darker, T.bg);
      grid.text(12, y, ' ', T.text, T.bg);
      grid.text(13, y, String(l.tag || 'ui').slice(0, TAG_W - 1).padEnd(TAG_W - 1), tag.c, T.bg);
      const shown = l === this.cur
        ? cutCols(grid, l.text.slice(0, l.reveal), cols - (12 + TAG_W))
        : cutCols(grid, l.text, cols - (12 + TAG_W));
      grid.text(12 + TAG_W, y, shown, l.tag === 'ready' ? tag.c : T.text, T.bg);
      // 正在打字的那行末尾放个光标块
      if (l === this.cur) {
        const cx = 12 + TAG_W + grid.strWidth(shown);
        if (cx < cols) grid.set(cx, y, '█', T.accent, T.bg);
      }
      y++;
    }

    // ── 底部：真实进度（分子分母都是实际行数，不是估的）
    const by = rows - 2;
    grid.text(0, by, '─'.repeat(cols), T.line, T.bg);
    const total = this.lines.length + this.queue.length;
    const shownN = this.lines.length;
    const frac = total ? shownN / total : 1;
    const w = Math.max(8, Math.min(28, Math.floor(cols / 4)));
    const full = Math.round(frac * w);
    // 标签列数随语言变（中文「进度」4 列、英文 "progress" 8 列）→ 进度条起点按**真实列宽**排，
    // 写死 6 的话英文标签会被进度条盖住。
    const label = t('boot.progress');
    const barX = 1 + grid.strWidth(label) + 1;
    grid.text(1, by + 1, label, T.dim, T.bg);
    grid.text(barX, by + 1, '█'.repeat(full), T.accent, T.bg);
    grid.text(barX + full, by + 1, '░'.repeat(w - full), T.line, T.bg);
    const info = t('boot.pbar.info', {
      shown: shownN,
      total,
      backend: (this.backendMs / 1000).toFixed(2),
      server: this.serverCount,
      live: this.liveCount,
    });
    grid.text(barX + w + 1, by + 1, info, T.dim, T.bg);

    if (fading) { grid.fade = 1; grid.fadeAll = false; }   // 复位：淡出只属于启动画面
  }
}
