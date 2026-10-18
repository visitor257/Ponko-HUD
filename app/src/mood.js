// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 心情：agent 是唯一权威。前端不推断情绪，只做两件事——
//   1) 执行 agent 的声明（state / face / intensity / note）
//   2) 把数值平滑友（避免配色跳变）
//
// ⚠ 2026-10-17 用户："心情应该完全由 agent 控制" —— 于是这里**不再有任何自动改心情的路径**：
//   静默两分钟变瞌睡、声明过期回待机，这两条都是程序替 agent 做主，全部删掉。
//   现在能改 state 的只有：agent 的声明 / 从存档恢复它自己声明过的那份 / 新对话的初始待机
//   / 调试旁路（?mood=，只活一趟运行）。心情停多久就是多久，直到 agent 下一次开口。
//   副作用是这条兜底原本还会被当成"你此刻的心情"喂给模型（见 agent.js 的 _moodBrief），
//   模型于是凭空演"我本来还困着" —— 一起断了。
//
// state  内部状态 → 决定全局配色（封闭枚举）
// face   表情标签 → 决定角色立绘（开放词汇，素材文件名）
// 二者正交：agent 可以"state=error 却配一副 thinking 的脸"（正为难地查问题）。

import { t, langOf } from './i18n/index.js';

export const MOOD_STATES = {
  idle:   { base: 62 },
  think:  { base: 70 },
  stream: { base: 88 },
  sleepy: { base: 30 },
  // base = 心情条的目标高度。生气是**高唤醒**（心跳快、憋着一股劲），所以给高分，
  // 别跟 error(24, 蔫下去) 混为一谈 —— 这俩数值差得越开，"上火"和"低落"在条上越一眼能认。
  angry:  { base: 78 },
  error:  { base: 24 },
};
export const MOOD_KEYS = Object.keys(MOOD_STATES);

/**
 * 心情在界面上显示的名字。**来源是角色素材包**，不是语言包（用户 2026-10-17：
 * "心情标签的翻译……写在角色形象的配置文件里。必填英文，其他语言选填"）。
 *
 * 名字属于这个角色、跟素材一起分发 —— 换一个角色包就是另一套叫法，不用动任何语言文件。
 * 词条在 `characters/<pack>/frames/pack.json` 的 `moods.<标签>.label`：
 *   "idle": { "frames": [...], "label": { "en": "idle", "zh-cn": "待机", "ja": "待機" } }
 *
 * 回退链（由 charpack.labelOf 实现）：当前语言 → 英文（**包作者必填**）→ 标签本身。
 * pack 还没扫到（启动最早期）→ 退回 state 本身，绝不拿别的语言顶上。
 *
 * @param {object|null} pack CharPack 实例（允许 null：素材包还没加载完）
 * @param {string} state 心情 state（idle / think / stream / sleepy / angry / error）
 */
export function moodLabel(pack, state) {
  const k = MOOD_STATES[state] ? state : 'idle';
  if (!pack || !pack.labelOf) return k;
  // 走 stateTag 而不是 tagFor：包没有这个表情时，不拿 idle 的名字顶包（见 stateTag 的注释）
  return pack.labelOf(pack.stateTag(k) || k, langOf()) || k;
}
// agent 声明之后，**多久之内本地兜底不许顶掉它**。
// （它不再是"心情的有效期" —— 过期也不会自己变回待机，见文件头。心情只由 agent 改。）
// 之前是 20s，结果"输出过程中声明的心情"一回复完就被兜底盖掉；放宽到 5 分钟
// （agent 仍可用 until 自己指定，上限 10 分钟）。
const DEFAULT_HOLD = 300000;

export class Mood {
  constructor() {
    this.state = 'idle';
    this.face = null;            // null → 由 state 推导素材标签
    this.value = 62;
    this.intensity = 0.45;
    this.noteKey = 'ui.mood.waiting';   // 面板上那句说明：存的是**语言包 key**（现取现翻）
    this.noteText = '';                 // agent 自己给的 note 原文（agent 说了就以它为准）
    this.source = 'auto';        // agent | auto | manual
    this.lastAgent = 0;
    this.holdUntil = 0;
    this.localSignals = false;   // shell 成败是否反向影响心情（默认否：那是 agent 的活）
    this.faces = [];             // 素材包可用标签，注入后用于提示 face 是否命中
    this._forced = null;
  }

  // （原来这里有个 touch()，记"用户最近一次活动"给静默兜底用。
  //  兜底既然删了，这个时间戳就没人看 —— 一并下线，别留一个假装在工作的字段。）

  /**
   * 硬回到"刚开了一个新对话"的样子：待机、没有心里话、没有锁。
   *
   * 跟 restore() 的区别是**不做平滑**（value 直接落到待机高度），也**不认任何外来快照**：
   * 新建对话时屏幕是"换了一段关系"，不是"同一个画面缓缓淡过去"。
   * 2026-10-17 用户报："我现在第一个对话是生气，然后我按 +，怎么还是生气" —— 见 moodView 的注释。
   */
  reset() {
    this.state = 'idle';
    this.face = null;
    this.value = MOOD_STATES.idle.base;
    this.intensity = 0.45;
    this.noteKey = 'ui.mood.waiting';
    this.noteText = '';
    this.source = 'auto';
    this.lastAgent = 0;
    this.holdUntil = 0;
    this._forced = null;
  }

  setFaces(list) { this.faces = Array.isArray(list) ? list : []; }

  /**
   * agent 权威写入。ev = {state, face, intensity, note, until}
   * @returns {boolean} 是否生效（state 非法则丢弃，绝不猜）
   *
   * `until` 的语义是**下限**不是有效期：它只管"这期间本地兜底不许来抢"，过了也不会自己变回去。
   * 心情停多久就是多久，直到 agent 下一次开口（2026-10-17："心情应该完全由 agent 控制"）。
   */
  fromAgent(ev = {}) {
    const s = MOOD_STATES[ev.state] ? ev.state : null;
    if (!s) return false;
    const now = performance.now();
    this.state = s;
    this.source = 'agent';
    this.lastAgent = now;
    this.intensity = typeof ev.intensity === 'number'
      ? Math.max(0, Math.min(1, ev.intensity))
      : MOOD_STATES[s].base / 100;
    // face 省略 = 用 STATE 的默认表情（frameTag 会拿 state 顶）。
    // ⚠ 这里**不能沿用上一次的 face**：以前只在带 face 时才覆盖，于是
    // "先 angry（face:angry）→ 再声明 error（没写 face）"会变成"状态是 error、立绘还是 angry"，
    // 用户看到的就是"心情设错了"（2026-10-18 报的）。
    this.face = (ev.face === undefined || ev.face === null || ev.face === '') ? null : String(ev.face);
    // agent 给的 note 是**内容**（不是界面文案），原样留着；同时把本地兜底那句作废
    if (ev.note !== undefined) { this.noteText = String(ev.note || ''); this.noteKey = ''; }
    this.holdUntil = now + Math.min(600000, Number(ev.until) || DEFAULT_HOLD);
    return true;
  }

  /**
   * 本地兜底通道（断连、超时展示等），明确标成「本地」，被任何 agent 声明覆盖。
   * @param {string} note 说明文字 —— 传**语言包 key**（'ui.mood.xxx'）就能跟着语言走；
   *   传普通字符串也行（t() 查不到原样返回），那就固定成那串字。
   */
  fromLocal(state, note, ms = 6000) {
    if (this._forced) return;
    if (this.source === 'agent' && performance.now() < this.holdUntil) return;
    if (!MOOD_STATES[state]) return;
    this.state = state;
    this.source = 'auto';
    this.noteKey = note || '';
    this.noteText = '';
    this.intensity = MOOD_STATES[state].base / 100;
    this.holdUntil = performance.now() + ms;
  }

  /**
   * 手动覆盖（?mood= / 点表情标签 / ^M）。有 lock 时不让位给兜底，但 agent 仍优先。
   *
   * ⚠ 它是**调试旁路，只活在这一趟运行里**：不存档、开机不还原（见 snapshot / restore）。
   *   2026-10-17 用户问"为什么是手动·生气？手动是什么？" —— 就是因为早先它被写进了快照，
   *   于是每次开机都重新锁死一颗调试心情，看着像"HUD 自己在手动控制"。
   */
  force(key) {
    if (!MOOD_STATES[key]) return;
    this._forced = key;
    this.state = key;
    this.source = 'manual';
    this.face = null;
    this.noteKey = 'ui.mood.manualOverride';
    this.noteText = '';
    this.holdUntil = performance.now() + 1e9;
  }

  clearForce() { this._forced = null; this.holdUntil = 0; }

  /** 给素材包的表情标签：优先 agent 指定的 face，不存在则回退 state 默认 */
  frameTag() { return this.face || this.state; }

  faceOk() {
    if (!this.face || !this.faces.length) return true;
    return this.faces.some((f) => f.toLowerCase() === this.face.toLowerCase());
  }

  /**
   * 来源的**文本形态**：agent 自己声明的就写 AGENT（专有名词，不翻），其余走语言包。
   *
   * ⚠ 2026-10-17 起**面板不再用它** —— CHAR 面板那行改成了「TAG · <心情 id>」，来源不上屏
   *   （用户：「算了，那行改成 TAG·<mood_id>」）。这里留着，是因为它是来源唯一的文本出口：
   *   以后要在日志/调试面板里看"谁说了算"，用它就行，不必再造一份。字段 `source` 本身
   *   是逻辑要用的（fromLocal / fromAgent / agent.js 的 _moodBrief 都在判），跟"要不要显示"无关。
   */
  get sourceTag() {
    if (this.source === 'agent') return 'AGENT';
    if (this.source === 'manual') return t('ui.mood.srcManual');
    if (this.source === 'auto') return t('ui.mood.srcLocal');
    return this.source;
  }

  /** 面板上那句说明：agent 给过原文就用原文，否则翻本地那条 key（现取，切语言立刻变） */
  get note() { return this.noteText || (this.noteKey ? t(this.noteKey) : ''); }

  // 显示名不再挂在 Mood 上：它要问**角色包**（同一个 state，换个包就是另一个叫法），
  // 而 Mood 不认识包。用导出的 moodLabel(pack, state)，面板与启动日志都走它。
  get key() { return this.state; }        // 兼容 themeFor(mood.key)

  // ── 跨重启的快照（"关掉再开，画面跟退出前一样"）─────────────────────
  //
  // 心情是**每个对话一份**的（2026-10-17 改）：形象 / 性格 / LLM 配置早就是每对话一份，
  // 心情却是全局一份 —— 结果是"新开一个对话，火气还在"，而那个对话的模型还会在 system
  // 提示词里收到上一段对话的心里话（跨对话串味）。现在每份 AgentConv 自己持有一个 Mood，
  // 屏幕上的 `mood` 只是一层**指向当前对话**的视图（见下面的 moodView）。
  //
  // 因此快照也跟着对话走：存进 `run/conversations/<id>.json` 的 `mood` 字段（见 writeConv）。
  // ui-state 里那份心情快照仍然保留，但**降级成"启动早期的一帧缓存"**：对话还没读回来时，
  // 先按它把配色定住；对话一加载，各自的快照才是权威。存哪、什么时候存由 main.js 决定
  // （uistate.js 负责去抖），这里只管"取/还"。

  /**
   * 存盘用的快照。value 只是配色平滑的当前值 —— 带上它，恢复时不会从 62 淡过去。
   *
   * ⚠ manual（调试旁路）**不落盘**：来源折成 auto、那句调试说明也清空。
   *   理由是它会"粘住"—— 一旦进档，下次开机 restore 就会把它当成用户的选择重新锁死，
   *   agent 之外的通道全被挡在外面（用户 2026-10-17 报的症状：面板上一直挂着「手动 · 生气」）。
   *   画面本身（state/face/配色）照存：那是"关掉再开一样"要的东西，跟"谁说了算"是两回事。
   */
  snapshot() {
    const manual = this.source === 'manual';
    return {
      state: this.state,
      face: this.face,
      intensity: this.intensity,
      noteText: manual ? '' : this.noteText,
      noteKey: manual ? '' : this.noteKey,
      source: manual ? 'auto' : this.source,
      value: Math.round(this.value * 100) / 100,
      savedAt: Date.now(),          // 墙上时间，只作记录（要判断"关了多久"用它，别用 performance.now）
    };
  }

  /**
   * 变没变的判据（uistate 的去抖靠它）。
   * ⚠ value 每帧都在动，**不能**算进签名 —— 否则每帧都"变了"，等于不停地写盘。
   */
  get sig() {
    return [this.state, this.face || '', this.source, this.noteKey, this.noteText, this.intensity].join('\u0001');
  }

  /**
   * 从快照恢复。规矩：
   *   ① state 必须是合法枚举 —— 不合法整条丢弃（宁可回待机，也不要停在不存在状态上）
   *   ② **原样还原，一个 state 都不折** —— 包括 'stream'。
   *      曾经这里把 'stream' 折成 idle，理由是"关掉时那轮输出早结束了，还原成它会让界面
   *      一直停在输出中"。那是有"静默兜底 / 声明过期回落"两条自动路径能收拾局面的年代；
   *      2026-10-17 那两条删掉之后，**折它等于程序替 agent 改心情**，正好违反"心情完全由
   *      agent 控制"。用户 2026-10-18 报的就是这个：「退出时是生气的 mood，重新开 HUD 后
   *      变成待机了」—— 存档里明明写着 stream（提示词里"被夸 / 来劲"就是它），却被折掉。
   *   ③ 「本地兜底让位窗口」（holdUntil）从**开机这一刻**重新计。原来的 holdUntil 是
   *      performance.now() 的刻度，重启后就归零了；按墙上时间算的话，关掉超过 5 分钟再开，
   *      本地兜底立刻就能顶掉 agent 的声明 —— 用户要的恰恰是"和退出前一样"（2026-10-15 报的）。
   *      注意这跟"心情有效期"无关：心情不会因为到期而改变，这里只是"多久之内别来抢"。
   *   ④ **manual 不还原**（调试旁路，只该活在这一趟运行里）：老档里若留着它（折叠前的版本写的），
   *      或留着它那句调试说明，一律降级成 auto 并清干净。不这样做，每次开机都会重新锁死一颗
   *      调试心情 —— 正是用户 2026-10-17 看到的「手动 · 生气」。
   */
  restore(s) {
    if (!s || typeof s !== 'object') return false;
    if (!MOOD_STATES[s.state]) return false;
    const now = performance.now();
    this.state = s.state;                        // 原样还（规矩 ②：连 stream 也不折）
    this.face = s.face ? String(s.face) : null;
    const base = MOOD_STATES[this.state].base / 100;
    this.intensity = (typeof s.intensity === 'number' && isFinite(s.intensity))
      ? Math.max(0, Math.min(1, s.intensity)) : base;
    // note：agent 自己那句话（noteText）优先，其次才是那条语言包 key —— 原样还回来
    this.noteText = String(s.noteText || '');
    this.noteKey = String(s.noteKey || '');
    // manual 不还原（规矩 ④）：盘上那份（无论新写的折过、还是老的没折）一律当 auto 看。
    this.source = s.source === 'agent' ? 'agent' : 'auto';
    if (this.noteKey === 'ui.mood.manualOverride') this.noteKey = '';   // 调试说明也不许还魂
    this._forced = null;                            // 锁一定从"没锁"开始：agent 才是权威
    if (this.source === 'agent') {
      this.lastAgent = now;                         // 从现在起重新计时
      this.holdUntil = now + DEFAULT_HOLD;
    } else {
      this.holdUntil = now + 6000;
    }
    if (typeof s.value === 'number' && isFinite(s.value)) {
      this.value = Math.max(2, Math.min(100, s.value));
    } else {
      this.value = Math.max(2, Math.min(100, MOOD_STATES[this.state].base));
    }
    return true;
  }

  /**
   * 每帧只做一件事：把心情条的高度平滑地挪向当前 state 的目标值（配色不跳变）。
   *
   * ⚠ 这里**不许改 state / source / note** —— 曾经有过两条：静默两分钟进瞌睡、agent 声明
   *   过期回待机。它们让"没人说话"变成一次情绪事件（用户 2026-10-17 问的"它会自动变成无聊"），
   *   而且被当成 agent 自己的心情喂给模型。心情现在只有 agent 能改。
   */
  tick(dt) {
    const st = MOOD_STATES[this.state] || MOOD_STATES.idle;
    const tgt = Math.max(2, Math.min(100, st.base + (this.intensity - 0.45) * 40));
    this.value += (tgt - this.value) * Math.min(1, dt * 1.6);
  }
}

/**
 * 「屏幕上的心情」—— 一层**跟随当前对话**的视图。
 *
 * 为什么要有它：心情现在每个对话一份（见类里那段注释），但**屏幕只有一块**。画配色、
 * 画面板、落快照、`?mood=` 调试那些地方都只需要"现在这个对话的心情"，它们不该各自
 * 去问一遍"当前是哪个对话"。所以 main.js 只造一个视图，全项目照旧 `mood.xxx` 地用 ——
 * 读和写都实时落到**当前活动对话**的那份 Mood 上，切标签就自动换人，不需要任何同步代码
 * （这正是"监听 selectTab 再搬运状态"那种写法最容易漏帧的地方）。
 *
 * 用法：`const mood = moodView(() => panels.agent.activeMood() || fallback)`
 *
 * ⚠ 拿到的是**代理**，不是 `Mood` 实例：`mood instanceof Mood` 为假、`Object.keys(mood)` 为空。
 *   项目里没有这种用法（只有 `mood.state/.key/.snapshot()/...` 这类正常读写），别新加。
 * @param {() => Mood} getActive 取当前该显示的那份心情（必须每次现取，不能缓存）
 */
export function moodView(getActive) {
  return new Proxy({}, {
    get(_, p) {
      const m = getActive();
      const v = m ? m[p] : undefined;
      // 方法要绑到那份实例上，否则 this 会指向代理，写进去的字段就丢了
      return typeof v === 'function' ? v.bind(m) : v;
    },
    set(_, p, v) {
      const m = getActive();
      if (m) m[p] = v;
      return true;
    },
    has(_, p) { const m = getActive(); return !!m && (p in m); },
  });
}
