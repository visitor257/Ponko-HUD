// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 右上角「✕ 退出」按钮的排版（纯函数，便于回归）
//
// 三态共用**同一个宽度**：待确认（armed）/ 退出中（quitting）/ 平常（idle）。
// 之前「 ✕ 退出 」和「 ✕ 再点一次 」字面宽度不同，按钮的左边界会随状态往回缩 ——
// 看着就是"点一下按钮突然变长了"；而如果只按短的那个固定，长的那句又会被裁掉。
// 所以宽度取三态里最宽的那个，短的那句居中补空格（补出来的是按钮底色，不是空白缝隙）。
//
// 单独成模块的原因：这类 bug 只在"点一下"的那几秒才出现，肉眼容易漏；
// 放在这里就能在回归里直接断言三态等宽、且文字不被截断。

import { t } from './i18n/index.js';

export const EXIT_STATES = ['idle', 'armed', 'quitting'];

/**
 * 三态文案**每次现取**（`t()`），不是模块级常量 —— 常量在 import 那一刻就定死了，
 * 之后换语言它不会跟着变（模块加载早于 initLang()）。文案进字典后，切语言立刻生效。
 */
export function exitLabelText(state) {
  return t('ui.exit.' + (EXIT_STATES.includes(state) ? state : 'idle'));
}

/** 三态里最宽的标签宽度 —— 按钮的固定宽度就用它（按当前字体度量，换字号也会跟着变） */
export function exitWidth(g) {
  let w = 0;
  for (const k of EXIT_STATES) w = Math.max(w, g.strWidth(exitLabelText(k)));
  return w;
}

/** 某个状态的标签文本，左右补空格居中到固定宽度 */
export function exitLabel(g, state, width) {
  const s = exitLabelText(state);
  const w = width === undefined ? exitWidth(g) : width;
  const pad = Math.max(0, w - g.strWidth(s));
  const l = Math.floor(pad / 2);
  return ' '.repeat(l) + s + ' '.repeat(pad - l);
}

/** 按钮在 chrome 行（row 0）上的落位：绘制与命中判定共用这一套坐标 */
export function exitButtonRect(g, state) {
  const w = exitWidth(g);
  const x0 = Math.max(0, g.cols - w);
  return { x0, x1: g.cols - 1, y: 0, w, label: exitLabel(g, state, w) };
}
