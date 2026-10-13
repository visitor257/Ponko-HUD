// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 心情：agent 是唯一权威。前端不推断情绪，只做三件事——
//   1) 执行 agent 的声明（state / face / intensity / note）
//   2) 把数值平滑友（避免配色跳变）
//   3) agent 沉默时的兜底，且必须标注来源，agent 一开口立刻让位
//
// state  内部状态 → 决定全局配色（封闭枚举）
// face   表情标签 → 决定角色立绘（开放词汇，素材文件名）
// 二者正交：agent 可以"state=error 却配一副 thinking 的脸"（正为难地查问题）。

import { t } from './i18n/index.js';

export const MOOD_STATES = {
  idle:   { base: 62 },
  think:  { base: 70 },
  stream: { base: 88 },
  sleepy: { base: 30 },
  error:  { base: 24 },
};
export const MOOD_KEYS = Object.keys(MOOD_STATES);
/**
 * 状态名的语言包 key（'ui.mood.idle' …）。
 * 这里只给 key、不给成品文案：本模块在 import 那一刻就求值了，早于 initLang()，
 * 把 `t()` 写在模块级等于把语言定死在加载那一刻（换语言不变）。
 */
export function moodNameKey(k) { return 'ui.mood.' + (MOOD_STATES[k] ? k : 'idle'); }
const SILENCE_MS = 120000;      // 无 agent 活动这么久 → 本地兜底进入低功耗
// agent 没给 until 时的默认保持时长。
// 之前是 20s，结果"输出过程中声明的心情"一回复完就过期、界面立刻回落成待机(idle)，
// 用户体感是"心情只在输出时有效"。心情是 agent 的权威声明，没理由 20 秒就作废，
// 这里放宽到 5 分钟（agent 仍可用 until 自己指定，上限 10 分钟）。
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
    this.lastInput = performance.now();
    this.holdUntil = 0;
    this.autoFallback = true;    // 关掉后连 Sleepy 兜底也不做，完全交给 agent
    this.localSignals = false;   // shell 成败是否反向影响心情（默认否：那是 agent 的活）
    this.faces = [];             // 素材包可用标签，注入后用于提示 face 是否命中
    this._forced = null;
    this.history = new Array(64).fill(62);
  }

  /** 用户的活动：只记时间戳，不推情绪 */
  touch() { this.lastInput = performance.now(); }

  setFaces(list) { this.faces = Array.isArray(list) ? list : []; }

  /**
   * agent 权威写入。ev = {state, face, intensity, note, until}
   * @returns {boolean} 是否生效（state 非法则丢弃，绝不猜）
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
    if (ev.face !== undefined) this.face = ev.face ? String(ev.face) : null;
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

  /** 手动覆盖（?mood= / 点表情标签 / ^M）。有 lock 时不让位给兜底，但 agent 仍优先 */
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

  /** 面板上的来源标记：agent 自己声明的就写 AGENT（专有名词，不翻），其余走语言包 */
  get sourceTag() {
    if (this.source === 'agent') return 'AGENT';
    if (this.source === 'manual') return t('ui.mood.srcManual');
    if (this.source === 'auto') return t('ui.mood.srcLocal');
    return this.source;
  }

  /** 面板上那句说明：agent 给过原文就用原文，否则翻本地那条 key（现取，切语言立刻变） */
  get note() { return this.noteText || (this.noteKey ? t(this.noteKey) : ''); }

  get label() { return t(moodNameKey(this.state)); }
  get key() { return this.state; }        // 兼容 themeFor(mood.key)

  tick(dt) {
    const now = performance.now();
    if (this._forced) {
      // 手动覆盖期间不接受任何推断，但 agent 可以抢
    } else if (this.source === 'agent' && now > this.holdUntil) {
      this.source = 'auto';
      this.state = 'idle';
      this.intensity = 0.45;
      this.noteKey = 'ui.mood.staleAgent';
      this.noteText = '';
    } else if (this.autoFallback
      && this.source !== 'agent'
      && now - Math.max(this.lastAgent, this.lastInput) > SILENCE_MS
      && this.state !== 'sleepy') {
      this.state = 'sleepy';
      this.source = 'auto';
      this.intensity = 0.2;
      this.noteKey = 'ui.mood.quiet';
      this.noteText = '';
      this.holdUntil = now + SILENCE_MS;
    }

    const st = MOOD_STATES[this.state] || MOOD_STATES.idle;
    const tgt = Math.max(2, Math.min(100, st.base + (this.intensity - 0.45) * 40));
    this.value += (tgt - this.value) * Math.min(1, dt * 1.6);
    this.history.push(this.value);
    if (this.history.length > 64) this.history.shift();
  }
}
