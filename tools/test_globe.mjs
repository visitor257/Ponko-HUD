// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// GLOBE 球的几何回归（离线，不用开浏览器）：球在任何框里都必须是**完整的正圆**。
//
// 起因：球体以前只按 cols（宽度）定尺，u/v 都除以 cols。分栏态碰巧差不多，一旦
// 放大到整个内容区（150 列 × 30 行），"30 行折合多少列"只有 65 列却仍按 150 列定尺 ——
// 球被画得比可用高度大两倍多，南北极落在框外，只剩中间一条横带（用户看到的"地球显示不全"）。
// 现在球取 min(宽, 高折合列)，本文件锁住这条，顺带锁住"节点/弧线用同一把尺子"。
// 跑法：node tools/test_globe.mjs
import { readFileSync } from 'node:fs';
import { GlobePanel, project } from '../app/src/panels/globe.js';
import { themeFor } from '../app/src/theme.js';

let failed = 0;
const chk = (name, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   → ' + detail}`);
};

// 假网格：只记 g.set（球体每格一次 ▀），box/text 一律不求真 —— 量的是几何不是排版
const CELL_W = 8.25, CELL_H = 18;               // 与真机一致（字符宽高比 ≈ 2.18）
function mkGrid(cols, rows) {
  const sets = [];
  return {
    cols, rows, cellW: CELL_W, cellH: CELL_H, sets,
    px: (c) => c * CELL_W,
    py: (r) => r * CELL_H,
    gx: (px) => Math.floor(px / CELL_W),
    gy: (py) => Math.floor(py / CELL_H),
    strWidth: (s) => { let w = 0; for (const c of String(s)) w += c.charCodeAt(0) > 0x1100 ? 2 : 1; return w; },
    chWidth: (c) => (String(c).charCodeAt(0) > 0x1100 ? 2 : 1),
    box() {}, fill() {}, text() {},
    set(x, y, ch, fg, bg) { sets.push({ x, y, ch, fg, bg }); },
  };
}

/** 在某个框里画一帧，回报几何量与实测外接盒 */
function draw(rect) {
  const g = mkGrid(152, 37);
  const p = new GlobePanel();
  p.layout(rect);
  p.draw(g, { theme: themeFor('idle'), dt: 0, t: 0 });
  const cells = g.sets.filter((s) => s.ch === '▀');
  if (!cells.length) return { geom: p._geom, px: null };
  let minC = 1e9, maxC = -1, minR = 1e9, maxR = -1;
  for (const c of cells) {
    if (c.x < minC) minC = c.x;
    if (c.x > maxC) maxC = c.x;
    if (c.y < minR) minR = c.y;
    if (c.y > maxR) maxR = c.y;
  }
  const wCols = maxC - minC + 1, hRows = maxR - minR + 1;
  return {
    geom: p._geom,
    px: {
      n: cells.length,
      wPx: wCols * CELL_W, hPx: hRows * CELL_H,
      minC, maxC, minR, maxR, x0: p._geom.x0, y0: p._geom.y0,
    },
  };
}

const A = CELL_H / CELL_W;                      // 字符宽高比
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log('── 1. 分栏态（左上 34×16 的小框）──');
{
  const { geom: G, px: P } = draw({ x: 0, y: 2, w: 34, h: 16 });
  console.log(`  框内 ${G.cols}列×${G.rows}行 · 球区 ${G.grows}行 · 高折合 ${G.vertCols.toFixed(1)}列`
    + ` → 球直径 ${G.span.toFixed(1)}列 (${(G.span * CELL_W).toFixed(0)}px)`);
  chk('球画出来了', !!P, '0 格');
  chk('span 取 min(宽, 高折合列)', near(G.span, Math.min(G.cols, G.vertCols), 0.01),
    `${G.span} vs ${Math.min(G.cols, G.vertCols)}`);
  chk('球直径不超过可用高度 → 南北极在框内',
    G.span * CELL_W <= G.grows * CELL_H + 0.5,
    `${(G.span * CELL_W).toFixed(0)}px > ${(G.grows * CELL_H).toFixed(0)}px`);
  chk('球直径不超过可用宽度', G.span <= G.cols + 0.01, `${G.span} > ${G.cols}`);
  chk('外接盒是正方形（正圆，不是被裁的横带）', near(P.wPx, P.hPx, P.hPx * 0.2),
    `${P.wPx.toFixed(0)}×${P.hPx.toFixed(0)}`);
  const want = Math.PI * G.rad * G.rad / A;     // 圆面积（格）：π·rad² 列² ÷ 每格 aspect 列²
  chk('格数 ≈ 圆面积（没多画、也没少画）', near(P.n, want, want * 0.15),
    `实测 ${P.n} vs 期望 ${want.toFixed(0)}`);
}

console.log('\n── 2. 放大态（撑满整个内容区 152×33）──');
{
  const { geom: G, px: P } = draw({ x: 0, y: 2, w: 152, h: 33 });
  console.log(`  框内 ${G.cols}列×${G.rows}行 · 球区 ${G.grows}行 · 高折合 ${G.vertCols.toFixed(1)}列`
    + ` → 球直径 ${G.span.toFixed(1)}列 (${(G.span * CELL_W).toFixed(0)}px)`);
  chk('球画出来了', !!P, '0 格');
  chk('★ 放大态是**高度**受限（球的尺子不能再只认 cols）', G.vertCols < G.cols,
    `${G.vertCols.toFixed(1)} vs ${G.cols}`);
  chk('span 取的是高折合列（球不会被画得比框高）', near(G.span, G.vertCols, 0.01),
    `${G.span} vs ${G.vertCols}`);
  chk('球直径 = 可用高度（正好撑满，两极贴边但不越界）',
    near(G.span * CELL_W, G.grows * CELL_H, 1),
    `${(G.span * CELL_W).toFixed(0)}px vs ${(G.grows * CELL_H).toFixed(0)}px`);
  chk('外接盒是正方形', near(P.wPx, P.hPx, P.hPx * 0.2), `${P.wPx.toFixed(0)}×${P.hPx.toFixed(0)}`);
  const want = Math.PI * G.rad * G.rad / A;
  chk('格数 ≈ 圆面积（没有点飘到球外、也没有被裁）', near(P.n, want, want * 0.15),
    `实测 ${P.n} vs 期望 ${want.toFixed(0)}`);
  // 宽屏放大时球只占中间一条，左右必然留白 —— 这是圆的物理约束，不是 bug
  const sideGap = (G.cols - G.span) / 2;
  chk('球水平居中（左右留白相等）', sideGap > 1 && near(P.minC, P.x0 + Math.floor(sideGap) - 1, 2),
    `左边 ${P.minC - P.x0} 列，右边 ${P.x0 + G.cols - 1 - P.maxC} 列`);
}

console.log('\n── 3. 又高又窄的框（宽受限）：球按宽度定尺、垂直居中 ──');
{
  const { geom: G, px: P } = draw({ x: 0, y: 2, w: 20, h: 40 });
  console.log(`  框内 ${G.cols}列×${G.rows}行 · 球区 ${G.grows}行 · 高折合 ${G.vertCols.toFixed(1)}列`
    + ` → 球直径 ${G.span.toFixed(1)}列`);
  chk('球画出来了', !!P, '0 格');
  chk('这次是**宽度**受限', G.cols < G.vertCols, `${G.cols} vs ${G.vertCols.toFixed(1)}`);
  chk('span 取的是宽度', near(G.span, G.cols, 0.01), `${G.span} vs ${G.cols}`);
  chk('外接盒仍是正方形', near(P.wPx, P.hPx, P.hPx * 0.25), `${P.wPx.toFixed(0)}×${P.hPx.toFixed(0)}`);
  chk('球上下都留白（没顶到框边，说明没被纵向拉伸）',
    P.minR > P.y0 && P.maxR < P.y0 + G.grows - 1, `${P.minR}..${P.maxR} in ${P.y0}..${P.y0 + G.grows - 1}`);
}

console.log('\n── 4. 源码守卫：尺子只有一把 ──');
{
  const src = readFileSync(new URL('../app/src/panels/globe.js', import.meta.url), 'utf8');
  chk('球体用 rad 定尺（不是除以 cols）',
    /const span = Math\.min\(cols, vertCols\)/.test(src) && /const rad = span \/ 2/.test(src), '');
  chk('节点/弧线用同一把尺子的反函数（放大态不会跟陆地错位）',
    /const cx = p\[0\] \* rad \+ cols \/ 2 - 0\.5/.test(src)
      && /const j = grows - 0\.5 - p\[1\] \* rad \* 2 \/ aspect/.test(src), '');
  chk('不再出现旧的「v 只除以 cols」写法', !/const v = aspect \* \(grows - j - 0\.5\) \/ cols/.test(src), '');
  chk('几何量留给了端到端验证（_geom）', /this\._geom = \{ cols, rows, grows, aspect, vertCols, span, rad/.test(src), '');
}

console.log('\n── 5. 拖拽与自转的方向（必须"跟手"，不能反）──');
{
  const g = mkGrid(152, 37);
  const ctx = (dt) => ({ theme: themeFor('idle'), dt, t: 0 });
  // 盯住一个具体的点：赤道上正对观察者的那一点（lon = 初始 yaw）。
  // project 返回 [u, v, z] —— **u 正 = 屏幕右，v 正 = 屏幕上**（见 draw 里 put 的反函数）。
  const at = (p) => project(0, 116, p.yaw, p.pitch);
  const centerLon = (yaw) => ((yaw + 180) % 360 + 360) % 360 - 180;

  const p = new GlobePanel(); p.yaw = 116; p.pitch = 18;
  const b = at(p);
  p.onDown(20, 20);
  p.onMove(25, 20);                                   // 往右拖 5 列
  const a = at(p);
  console.log(`  向右拖 5 列：中心经度 ${centerLon(116)}° → ${centerLon(p.yaw)}° · 该点 u ${b[0].toFixed(3)} → ${a[0].toFixed(3)}`);
  chk('★ 向右拖 → 球面上的点跟着往右走（跟手，不是反的）', a[0] > b[0] + 0.02,
    `u ${b[0].toFixed(3)} → ${a[0].toFixed(3)}`);
  chk('向右拖 → 中心经度西移（东边转出去、西边转进来）', centerLon(p.yaw) < 116, `yaw ${p.yaw}`);
  chk('拖完 yaw 归一化在 [0,360)（底部"中心 X°"不会跳字）', p.yaw >= 0 && p.yaw < 360, String(p.yaw));

  const q = new GlobePanel(); q.yaw = 116; q.pitch = 18;
  const b2 = at(q);
  q.onDown(20, 20);
  q.onMove(20, 23);                                   // 往下拖 3 行
  const a2 = at(q);
  console.log(`  向下拖 3 行：pitch 18 → ${q.pitch} · 该点 v ${b2[1].toFixed(3)} → ${a2[1].toFixed(3)}`);
  chk('向下拖 → 球面跟着往下走（v 正 = 上，所以 y 应变小）', a2[1] < b2[1] - 0.02,
    `v ${b2[1].toFixed(3)} → ${a2[1].toFixed(3)}`);
  chk('向下拖 → 俯视增强（pitch 变大，露出更多北极）', q.pitch > 18, String(q.pitch));
  chk('左右拖不串到 pitch、上下拖不串到 yaw', near(p.pitch, 18, 1e-9) && near(q.yaw, 116, 1e-9),
    `pitch ${p.pitch} / yaw ${q.yaw}`);

  // 自转：给 1 秒的 dt（speed = 360/45 = 8°/s），看球往哪边转
  const s = new GlobePanel(); s.yaw = 116; s.pitch = 18;
  s.layout({ x: 0, y: 2, w: 152, h: 33 });
  const b3 = at(s);
  s.draw(g, ctx(1.0));
  const a3 = at(s);
  console.log(`  自转 1s：中心经度 ${centerLon(116)}° → ${centerLon(s.yaw)}° · 该点 u ${b3[0].toFixed(3)} → ${a3[0].toFixed(3)}`);
  chk('★ 自转是自西向东（中心经度递减，不是递增）', centerLon(s.yaw) < 116, `yaw ${s.yaw}`);
  chk('自转时球面点也往右走 → 与"向右拖"同向（松手不回飘）', a3[0] > b3[0],
    `u ${b3[0].toFixed(3)} → ${a3[0].toFixed(3)}`);

  const src = readFileSync(new URL('../app/src/panels/globe.js', import.meta.url), 'utf8');
  chk('onMove 里 yaw 用减号（拖右 = 球往右）',
    /this\.yaw = \(\(this\.dragging\.yaw - \(cellX - this\.dragging\.x\) \* 4\)/.test(src), '');
  chk('自转那行也是减号（自西向东）',
    /this\.yaw = \(this\.yaw - C\.dt \* this\.speed \+ 360\) % 360/.test(src), '');
}

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exitCode = failed ? 1 : 0;
