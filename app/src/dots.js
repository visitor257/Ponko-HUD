// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 点阵化立绘：把高清立绘重新采样成"方块点阵"再贴到画布上。
//
// 为什么要这个（2026-10-15 用户："把形象粒子化，看看会不会更符合终端风格"）：
//   立绘直接 drawImage 出来是一张**照片** —— 精细，但和字符网格是两个世界的东西。
//   采样成点阵之后画面由一个个方块构成，点距和网格同量级，才像从终端里长出来的。
//   八种风格的并排实拍在 mockup/particles.html，用户选定的是「原色 · pitch 2」。
//
// 开销：采样 + 画点只做**一次**（见 rasterize 的性能注释：冷的一次约 30ms，
//   其中一半是 getImageData 的读回），结果缓存成一张离屏画布；
//   之后每帧只是 drawImage 那张现成的图 —— 和原来的贴图同价，不拖渲染。
//   （反面做法：每帧现画上万个 fillRect，那才是会掉帧的路。）
//   那 30ms 的"冷"也不让用户等：换形象时会先在帧外把它算好，见 panels/char.js 的 sync()。
//
// 单元测试：tools/test_dots.mjs —— 只测 sampleDots（纯函数，不碰 DOM）。

/** 分块平均不透明度低于这个值就整块丢掉：原画边缘有一圈极淡的像素，留着会拖出一层灰雾 */
const ALPHA_CUT = 0.04;
/**
 * 点边长 = 点距 × (DOT_MIN + (1 - DOT_MIN) × 覆盖率)。
 * 覆盖率 = 1 的块（人物内部）铺满整格，覆盖率低的块（轮廓边缘）缩成小方点 ——
 * 就是印刷半调那套：靠"点的大小"而不是"点的颜色"做出边缘过渡。
 * 不能让边长直接跟覆盖率线性到 0，否则边缘会碎成点不亮的星尘。
 */
const DOT_MIN = 0.30;
/** 离屏画布缓存条数：正常只会命中 1~2 条（一个包、一种窗口尺寸）；拖动窗口时尺寸一直在变，要有个上限 */
const CACHE_MAX = 12;

/**
 * 按 pitch × pitch 分块采样 RGBA 缓冲，输出一串待画的方点。
 *
 * **纯函数**：只吃一个 Uint8ClampedArray，不碰 DOM —— 所以能在 Node 里单测。
 *
 * ⚠️ 两个量别混用（对照稿第一版就栽在这，做出来一坨纯色剪影）：
 *   cov = 分块的平均不透明度 —— 只反映**轮廓边缘**，色块内部恒为 1。
 *         拿它当亮度用，人物内部就没有层次了。它只该决定"点画多大"。
 *   颜色 = 按 alpha 加权的平均色 —— 内部块就是那块的真实颜色。它才决定"多亮"。
 *
 * @param {Uint8ClampedArray|Array} data  RGBA 平铺（长度 W×H×4，未预乘）
 * @param {number} W,H                    缓冲尺寸（设备像素）
 * @param {object} [o]                    { pitch: 采样块边长(设备像素), alphaCut }
 * @returns {Array<{x:number,y:number,s:number,c:number[],cov:number}>} x/y/s 均为设备像素
 */
export function sampleDots(data, W, H, o = {}) {
  // 非法点距（0 / NaN / 负数）收敛成默认值 2。**必须保证 ≥ 1**：外层是按 pitch 步进的 for，
  // 0 或负数会直接死循环。
  const raw = Math.round(o.pitch || 0);
  const pitch = raw > 0 ? raw : 2;
  const cut = o.alphaCut == null ? ALPHA_CUT : o.alphaCut;
  const span = 1 - DOT_MIN;
  const out = [];

  for (let by = 0; by < H; by += pitch) {
    const y1 = Math.min(by + pitch, H);
    for (let bx = 0; bx < W; bx += pitch) {
      const x1 = Math.min(bx + pitch, W);
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = by; y < y1; y++) {
        let i = (y * W + bx) * 4;
        for (let x = bx; x < x1; x++, i += 4) {
          const al = data[i + 3] / 255;
          if (al <= 0) continue;
          r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al;
          a += al;
        }
      }
      if (!a) continue;                                  // 整块全透明
      const cov = a / ((x1 - bx) * (y1 - by));
      if (cov < cut) continue;                           // 太淡：丢掉，别拖灰雾
      const k = Math.min(1, cov);
      const s = pitch * (DOT_MIN + span * k);
      out.push({
        x: bx + (pitch - s) / 2,                         // 点居中在它那一格里
        y: by + (pitch - s) / 2,
        s,
        c: [Math.round(r / a), Math.round(g / a), Math.round(b / a)],
        cov: k,
      });
    }
  }
  return out;
}

const cache = new Map();

/**
 * 点阵画布的缓存 key。**预热与实画必须算出同一条** —— 否则预热白做（实画时另算一遍，
 * 又回到"切换那一帧卡一下"）。所以这里单独抽出来给两边共用（grid.artKey / warmImg）。
 *
 * 尺寸一律按**设备像素**入 key：同一块地方在 dpr=1 和 dpr=2 下点阵是不同的两张图。
 */
export function dotsKey(image, w, h, o = {}) {
  if (!image) return '';
  const dpr = o.dpr || 1;
  const DW = Math.max(1, Math.round(w * dpr));
  const DH = Math.max(1, Math.round(h * dpr));
  // 点距按 **CSS 像素** 给（跟对照稿里看到的一致），设备像素下乘 dpr ——
  // 这样 dpr=1 和 dpr=2 的机器上颗粒的**观感大小**是一样的，不会高分屏上突然变细。
  const pitch = Math.max(1, Math.round((o.pitch || 2) * dpr));
  const sat = o.sat == null ? 1 : o.sat;
  return `${image.currentSrc || image.src}|${DW}x${DH}|${pitch}|${sat}`;
}

/** 这条 key 的点阵已经算好了？（预热流程据此判断"还差多少"，命中就不用再等一帧） */
export function dotsCached(key) { return !!key && cache.has(key); }

/**
 * 把一张已加载的图变成"点阵画布"（结果缓存）。返回的 canvas 尺寸是**设备像素**
 * （w×dpr, h×dpr），调用方用 CSS 尺寸 drawImage 上去，正好 1:1 —— 在 dpr=2 下也是清的。
 *
 * @param {HTMLImageElement} image 必须与页面同源，否则 getImageData 会抛 SecurityError → 返回 null
 * @param {number} w,h             目标**CSS**像素尺寸（= 立绘区像素）
 * @param {object} [o]             { pitch: CSS 像素点距(默认 2), sat, dpr }
 * @returns {HTMLCanvasElement|null} null = 这次画不了，调用方回退到直接贴原图
 */
export function dotsCanvas(image, w, h, o = {}) {
  if (!image || !image.width || !image.height || !(w > 0) || !(h > 0)) return null;
  const dpr = o.dpr || 1;
  const k = dotsKey(image, w, h, o);
  const hit = cache.get(k);
  if (hit) return hit;

  const DW = Math.max(1, Math.round(w * dpr));
  const DH = Math.max(1, Math.round(h * dpr));
  const pitch = Math.max(1, Math.round((o.pitch || 2) * dpr));
  const sat = o.sat == null ? 1 : o.sat;

  const off = document.createElement('canvas');
  off.width = DW; off.height = DH;
  const c = off.getContext('2d', { willReadFrequently: true });
  c.imageSmoothingQuality = 'high';
  // 降饱和交给 canvas 滤镜做，采到的就是降过的色 —— 与旧的直接贴图观感一致
  if (sat !== 1) c.filter = `saturate(${sat})`;
  // contain 适配，和 grid._drawImages 是同一套算法（两处必须一致，否则点阵位置会偏）
  const s = Math.min(DW / image.width, DH / image.height);
  const dw = image.width * s, dh = image.height * s;
  c.drawImage(image, (DW - dw) / 2, (DH - dh) / 2, dw, dh);

  let data;
  try {
    data = c.getImageData(0, 0, DW, DH).data;
  } catch (e) {
    return null;                       // 跨源污染 → 让调用方走老路
  }
  c.filter = 'none';
  // ⚠️ 不要 clearRect + 逐点 fillRect —— 一份 ImageData 写像素快一个数量级，见 rasterize 的注释。
  // 光栅只是中间产物：putImageData 会整块盖掉它，点以外的地方重新变成透明。
  rasterize(c, sampleDots(data, DW, DH, { pitch }), DW, DH);

  cache.set(k, off);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return off;
}

/**
 * 把采样出来的点**写进一块 ImageData** 再 putImageData。
 *
 * 为什么不用 fillStyle + fillRect（2026-10-15 在真页面上量的，231x342 立绘 / 约 1 万个点）：
 *   逐点 fillRect 26~52ms，写像素 2~8ms。差在 fillRect 每次都要过一遍画布状态机
 *   —— 解析 `fillStyle` 字符串、光栅化器取状态、按矩形裁剪；上万次就是几十毫秒。
 *   写像素是纯内存操作，没有状态可切。
 *
 * 点是**轴对齐的方块、互不重叠**（边长 ≤ 点距、居中在自己那一格里），所以逐点写
 * 和 canvas 逐次 fillRect 的结果一致；边缘按"覆盖了该像素多少"给 alpha，
 * 也就是 canvas 抗锯齿本来会算出来的那个数。
 */
function rasterize(ctx, pts, DW, DH) {
  const img = new ImageData(DW, DH);          // 全 0 = 全透明：点以外就该看穿到面板底色
  const b = img.data;
  for (const p of pts) {
    const R = p.c[0], G = p.c[1], B = p.c[2];
    const fx0 = p.x, fx1 = p.x + p.s, fy0 = p.y, fy1 = p.y + p.s;
    const x0 = Math.max(0, Math.floor(fx0)), x1 = Math.min(DW, Math.ceil(fx1));
    const y0 = Math.max(0, Math.floor(fy0)), y1 = Math.min(DH, Math.ceil(fy1));
    for (let y = y0; y < y1; y++) {
      const cy = Math.min(y + 1, fy1) - Math.max(y, fy0);   // 这一行被方块盖住的比例
      if (cy <= 0) continue;
      let i = (y * DW + x0) * 4;
      for (let x = x0; x < x1; x++, i += 4) {
        const a = (Math.min(x + 1, fx1) - Math.max(x, fx0)) * cy;
        if (a <= 0.003) continue;                            // 淡到看不见，跳过（也省得写出 0 alpha 的脏像素）
        b[i] = R; b[i + 1] = G; b[i + 2] = B;
        b[i + 3] = a >= 0.997 ? 255 : (a * 255 + 0.5) | 0;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}


/** 清空离屏缓存（换主题/换素材包时可选调用；正常靠 key 里的尺寸+源自动区分） */
export function clearDotsCache() { cache.clear(); }
