// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 主题：一套心情 = 一套配色。心情变化时整个界面（含地球陆地、角色、光标）一起换色。
import { rgb } from './grid.js';

const BASE = {
  bg: rgb(8, 12, 16),
  panel: rgb(12, 18, 24),
  panelHi: rgb(16, 24, 32),
  line: rgb(34, 52, 62),
  lineHi: rgb(52, 78, 92),
  text: rgb(206, 226, 234),
  dim: rgb(104, 132, 146),
  darker: rgb(60, 82, 94),
  ok: rgb(88, 214, 141),
  warn: rgb(240, 190, 80),
  err: rgb(240, 88, 88),
  sea: rgb(18, 46, 68),
  seaLit: rgb(38, 88, 118),
  grid: rgb(30, 70, 92),
  arc: rgb(240, 222, 96),
  node: rgb(255, 108, 108),
};

// ⚠ 这里**不含心情的名字** —— 名字来自角色素材包（pack.json 的 moods.<标签>.label），
//   由 mood.js 的 moodLabel(pack, state) 解析。配色是应用层的事，名字是角色的事，别混。
const MOODS = {
  idle:   { accent: rgb(72, 214, 208), land: rgb(46, 176, 168), glow: 0.6 },
  think:  { accent: rgb(240, 186, 80), land: rgb(206, 156, 62), glow: 0.8 },
  stream: { accent: rgb(96, 232, 128), land: rgb(78, 206, 110), glow: 1.0 },
  sleepy: { accent: rgb(158, 130, 240), land: rgb(134, 108, 214), glow: 0.35 },
  // angry 与 error 同属"坏心情"，靠**色温**分开：error 是偏粉的冷红（蔫下去），
  // angry 是饱和的火橙红（烧起来）—— 2026-10-17 加第 6 个 state 时定的。
  // ⚠ 这里漏加一个 state 不会报错，只会**静默**回落到 idle 配色（themeFor 的兜底），
  //   所以 tools/test_mood_strip.mjs 里有一条"前端配色表必须覆盖全部 state"的守卫钉着。
  angry:  { accent: rgb(255, 130, 44), land: rgb(214, 98, 34),  glow: 0.95 },
  error:  { accent: rgb(240, 92, 92),  land: rgb(206, 78, 78),  glow: 0.7 },
};

export const MOOD_KEYS = Object.keys(MOODS);

export function themeFor(mood) {
  const m = MOODS[mood] || MOODS.idle;
  return {
    ...BASE,
    accent: m.accent,
    accentDim: (
      (Math.round(((m.accent >> 16) & 255) * 0.45) << 16) |
      (Math.round(((m.accent >> 8) & 255) * 0.45) << 8) |
      Math.round((m.accent & 255) * 0.45)
    ),
    land: m.land,
    landDim: (
      (Math.round(((m.land >> 16) & 255) * 0.45) << 16) |
      (Math.round(((m.land >> 8) & 255) * 0.45) << 8) |
      Math.round((m.land & 255) * 0.45)
    ),
    glow: m.glow,
    key: mood in MOODS ? mood : 'idle',
  };
}

export { MOODS };
