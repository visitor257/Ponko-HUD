// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 多标签的色板：SHELL（终端标签）与 AGENT（对话标签）共用同一份
//
// 标签识别不用数字编号，用颜色：每个标签拿到一个当前没人占用的色，画成标签栏的色标
// 与面板顶线上的小方块。同一时刻最多 8 个标签，颜色刚好够分。
// 色相均匀铺开、彼此一眼能分；默认派到蓝色（先别撞主题青），青色排在后面备用。
import { rgb } from './grid.js';

export const TAB_COLORS = [
  rgb(96, 168, 255),    // 蓝
  rgb(248, 196, 96),    // 金
  rgb(126, 224, 152),   // 薄荷
  rgb(248, 146, 200),   // 粉
  rgb(198, 140, 252),   // 紫
  rgb(78, 214, 208),    // 青（跟主题色最近，排后面）
  rgb(248, 148, 96),    // 橙
  rgb(190, 226, 104),   // 黄绿
];

/** 色板容量 = 单面板标签上限（两个面板各自用满也不会串色） */
export const TAB_COLOR_COUNT = TAB_COLORS.length;
