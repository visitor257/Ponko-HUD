// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 素材包加载器：用户自定义表情的入口
//
// 约定（与 tools/charpack.py 对齐）：
//   characters/<pack>/src/*.png        用户放的图，文件名 = 表情标签，label_0/label_1 = 同标签逐帧
//   characters/<pack>/frames/pack.json 标签 → 帧文件映射
//   characters/<pack>/frames/<label>.json  帧数据：cells[row][col] = [上半RGB, 下半RGB] | [null,null]
//
// 立绘有两种画法（角色面板按素材包自动选）：
//   1. **高清贴图**（推荐）：包里有 src/<tag>.png 就直接 drawImage，绕开字符网格 ——
//      字符网格下那块地方只有「列数 x 行数」个色块，精细插画压进去必然糊。
//   2. **字符画**：包内没有 src 图时回退到 frames/*.json（也是 charpack.py 从 src 生成的）。
//
// 标签不预设枚举：proud / confused / 开心 都行，运行时查不到就回退 idle。
import { rgb } from './grid.js';

// 状态机键 → 素材包标签（素材是用户起的名，这里只做兜底别名）
// ⚠ 每个 state 都得有一条，否则包**没有**该标签的素材时，tagFor 找不到别名会直接落到 idle ——
//   表现是"切到生气，脸却变回待机"，且不报任何错。加 state 时别漏这里。
const ALIAS = {
  idle: ['idle', '待机', 'normal', 'default'],
  think: ['thinking', 'think', '思考'],
  // working 是 2026-10-18 从 stream 改的名；'stream' 留着让旧素材包 / 旧存档照样能对上表情。
  working: ['streaming', 'working', 'stream', '输出', 'talk'],
  // happy 是 2026-10-18 的第 7 个 state。包里若只有「高兴」这张中文名素材（或旧包根本没有
  // 这张脸），靠这条别名对上；都没有才会落到 idle。
  happy: ['happy', '高兴', '开心', 'joy'],
  sleepy: ['sleepy', '瞌睡', 'sleep'],
  angry: ['angry', '生气', '愤怒', 'mad'],
  error: ['error', '出错', 'sad'],
};

export class CharPack {
  constructor(meta) {
    Object.assign(this, meta);            // id, name, grid, moods, base, artBase, art
    this._frames = new Map();             // tag -> {cols, rows, cells}
    this._scaled = new Map();             // `${tag}@${cols}` -> cells
    this._art = new Map();                // tag -> Image（已加载）/ null（加载中）/ false（失败）
    this.loaded = false;
  }

  tags() { return Object.keys(this.moods || {}); }

  /** 包内是否声明了这个标签的高清立绘（服务端扫 src/ 得出） */
  hasArt(tag) {
    return !!(tag && this.artBase && this.art && this.art[tag]);
  }

  /** 高清立绘加载失败 —— 调用方据此回退字符画 */
  artFailed(tag) { return this._art.get(tag) === false; }

  /**
   * 取高清立绘。首次调用发起加载并返回 null，**下一帧再问就拿到了**
   * （本地文件几十毫秒，面板每帧都会重画，不需要回调）。
   */
  artImage(tag) {
    if (!this.hasArt(tag)) return null;
    const got = this._art.get(tag);
    if (got !== undefined) return got || null;
    const im = new Image();
    im.decoding = 'async';
    this._art.set(tag, null);             // 占位：加载中
    im.onload = () => this._art.set(tag, im);
    im.onerror = () => this._art.set(tag, false);
    im.src = this.artBase + this.art[tag];
    return null;
  }

  /**
   * 把包内**所有**高清立绘先摊开加载（只管发起，不等待）。
   *
   * 用户 2026-10-15："这些心情形象，第一次显示他都会卡一下" —— 卡的是首次 fetch + 解码。
   * 一个包就几张本地图，与其每换一次表情现打一次，不如切到这个包时一次性铺开；
   * 之后换表情时图早已在内存里。没有高清图的包（只有 frames/*.json）不会发起任何请求。
   */
  preloadArt() {
    for (const tag of this.tags()) if (this.hasArt(tag)) this.artImage(tag);
  }

  has(tag) {
    return this.tags().some((h) => String(h).toLowerCase() === String(tag).toLowerCase());
  }

  /**
   * 这个 state 在包里**真的有**对应表情吗 —— 有就返回那个标签，没有返回 null。
   *
   * 与 tagFor 的唯一区别：tagFor 最后会兜底到 idle（画立绘时这是对的 —— 宁可显示待机脸，
   * 也别空着）。但**取名字时不能兜底**：一个没有"生气"表情的包，会让"生气"这个标签
   * 顶着待机的名字，面板上看起来像有两个"待机"。
   */
  stateTag(state) {
    const have = this.tags();
    if (!have.length) return null;
    const want = String(state || '').toLowerCase();
    const direct = have.find((h) => String(h).toLowerCase() === want);
    if (direct) return direct;
    for (const w of (ALIAS[state] || [])) {
      const hit = have.find((h) => String(h).toLowerCase() === String(w).toLowerCase());
      if (hit) return hit;
    }
    return null;
  }

  /**
   * 标签的**显示名** —— 来自素材包自己的配置（`pack.json` 的 `moods.<标签>.label`），
   * **不来自语言包**（用户 2026-10-17）。名字属于这个角色，跟素材一起分发：
   * 换一个角色包就是另一套叫法，不用动任何语言文件。
   *
   * 回退链：当前语言 → 英文（包作者**必填**）→ 标签本身（连英文都没写，就把标签亮出来，
   * 比猜一个别的语言顶上要诚实）。中文/日文等选填，没翻就落英文。
   *
   * ⚠ `lang` 由调用方**传进来**，这里不读全局语言 —— 本模块是"识别层"，
   *   不许 import i18n（tools/test_i18n.mjs 的边界守卫盯着这条）。
   */
  labelOf(tag, lang) {
    const m = this.moods && this.moods[tag];
    const lab = m && m.label;
    if (!lab) return String(tag);
    const key = String(lang || '').toLowerCase();
    return lab[key] || lab.en || String(tag);
  }

  /**
   * 标签解析：input 可以是 agent 指定的任意 face（开放词汇），也可以是心情 state。
   * 命中素材就用素材；查不到才按 state 别名兜底，最后落到 idle。
   */
  tagFor(input) {
    const have = this.tags();
    if (!have.length) return null;
    const hit = this.stateTag(input);
    if (hit) return hit;
    return have.includes('idle') ? 'idle' : have[0];
  }

  async ensure(tag) {
    if (this._frames.has(tag)) return this._frames.get(tag);
    const entry = this.moods && this.moods[tag];
    if (!entry) return null;
    const files = Array.isArray(entry.frames) ? entry.frames : [entry.frames];
    const frames = [];
    for (const f of files) {
      const url = this.base + String(f).replace(/\.(ans|txt)$/i, '.json');
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const j = await r.json();
        frames.push({ cols: j.cols, rows: j.rows, cells: j.cells, fps: entry.fps || 0 });
      } catch (e) { /* 坏帧跳过 */ }
    }
    if (!frames.length) return null;
    this._frames.set(tag, frames);
    return frames;
  }

  /** 取某一心情的帧（按目标列宽缩放，结果缓存） */
  async frame(moodKey, cols, tSec = 0) {
    const tag = this.tagFor(moodKey);
    const frames = await this.ensure(tag);
    if (!frames || !frames.length) return null;
    const f = frames.length > 1 && frames[0].fps > 0
      ? frames[Math.floor(tSec * frames[0].fps) % frames.length]
      : frames[0];
    const key = `${tag}@${cols}@${frames.indexOf(f)}`;
    let s = this._scaled.get(key);
    if (!s) { s = scaleCells(f.cells, f.cols, cols); this._scaled.set(key, s); }
    return { cols, rows: s.length, cells: s };
  }
}

/**
 * 按目标列宽调整帧（结果按 `tag@cols` 缓存在 CharPack 里）。
 *
 * **缩小走面积平均，放大走最近邻。**（2026-10-15 用户反馈"立绘太糊"时改的）
 * 素材一般按 48 列生成，而角色面板只给 40 列 —— 平均每次都要缩 48→40。
 * 最近邻在这种**非整数比**下会按 48/40 丢掉每第 6 列，竖直边缘全是锯齿、
 * 五官还会被整列挤歪；改成把 k×k 个源格的非空颜色平均掉，边缘就顺了。
 * 放大则相反：插值只会把方块糊成一片，保持最近邻的方块感才对。
 */
function scaleCells(cells, srcCols, dstCols) {
  if (!cells || !cells.length || dstCols === srcCols) return cells;
  const srcRows = cells.length;
  const k = dstCols / srcCols;
  const dstRows = Math.max(1, Math.round(srcRows * k));
  const out = [];

  if (dstCols > srcCols) {                                  // 放大：最近邻（别插值）
    for (let y = 0; y < dstRows; y++) {
      const sy = Math.min(srcRows - 1, Math.floor(y / k));
      const row = [];
      for (let x = 0; x < dstCols; x++) {
        row.push(cells[sy][Math.min(srcCols - 1, Math.floor(x / k))]);
      }
      out.push(row);
    }
    return out;
  }

  for (let y = 0; y < dstRows; y++) {                        // 缩小：面积平均
    const sy0 = Math.max(0, Math.floor(y / k));
    const sy1 = Math.max(sy0 + 1, Math.round((y + 1) / k));
    const row = [];
    for (let x = 0; x < dstCols; x++) {
      const sx0 = Math.max(0, Math.floor(x / k));
      const sx1 = Math.max(sx0 + 1, Math.round((x + 1) / k));
      const half = [null, null];
      for (let h = 0; h < 2; h++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = sy0; yy < Math.min(sy1, srcRows); yy++) {
          for (let xx = sx0; xx < Math.min(sx1, srcCols); xx++) {
            const c = cells[yy][xx] && cells[yy][xx][h];
            if (c) { r += c[0]; g += c[1]; b += c[2]; n++; }
          }
        }
        half[h] = n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : null;
      }
      row.push(half);
    }
    out.push(row);
  }
  return out;
}

/** 把帧画进网格：每格一个 ▀，上半 fg 下半 bg */
export function blit(grid, x, y, frame, bgColor) {
  if (!frame) return;
  for (let r = 0; r < frame.rows; r++) {
    const row = frame.cells[r];
    for (let c = 0; c < frame.cols; c++) {
      const cell = row[c];
      if (!cell) continue;
      const top = cell[0], bot = cell[1];
      if (!top && !bot) continue;
      grid.set(x + c, y + r, '▀',
        top ? rgb(top[0], top[1], top[2]) : bgColor,
        bot ? rgb(bot[0], bot[1], bot[2]) : bgColor);
    }
  }
}

export async function loadPacks() {
  const r = await fetch('/api/charpacks');
  const list = await r.json();
  return list.map((m) => new CharPack(m));
}
