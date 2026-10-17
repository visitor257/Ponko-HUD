// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 回归：点阵化立绘的采样算法（2026-10-15 加）
//
// 只测 sampleDots —— 它是**纯函数**（吃一个 RGBA 缓冲、吐一串方点），不碰 DOM，
// 所以能在 Node 里直接跑。画布那一层（dotsCanvas）靠真实浏览器验：tools/_verify_charpack.mjs 会
// 去 canvas 上数像素。
//
// 必须验住的四件事：
//   ① cov（平均不透明度）只决定**点多大**，别拿去当亮度 —— 对照稿第一版就是这么做出一坨纯色剪影的；
//   ② 颜色 = **按 alpha 加权**的平均色（透明像素不该把颜色拉向黑）；
//   ③ 点必须**居中在它自己那一格**里，否则整幅会错位；
//   ④ 全透明 / 太淡的块要丢掉，不能拖出一层灰雾。
import { sampleDots, dotsCanvas, clearDotsCache } from '../app/src/dots.js';

let fail = 0;
const chk = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   → ' + JSON.stringify(got)}`);
  if (!ok) fail++;
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** 造一块 RGBA 缓冲；fill(x,y) 返回 [r,g,b,a]，缺省全透明 */
function mk(W, H, fill) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = fill ? fill(x, y) : null;
      if (!v) continue;
      const i = (y * W + x) * 4;
      d[i] = v[0]; d[i + 1] = v[1]; d[i + 2] = v[2]; d[i + 3] = v[3];
    }
  }
  return d;
}
const RED = [255, 0, 0, 255];

console.log('── ① 分块、居中、点距 ──');
{
  const pts = sampleDots(mk(8, 8, () => RED), 8, 8, { pitch: 2 });
  chk('8x8 全实心 / pitch 2 → 16 个点', pts.length === 16, pts.length);
  chk('覆盖率 1 的块：点铺满整格（s = pitch）', pts.every((p) => near(p.s, 2)), pts.map((p) => p.s));
  chk('点按行优先排列（第一格在左上角）',
    pts[0].x === 0 && pts[0].y === 0 && pts[1].x === 2 && pts[1].y === 0 && pts[4].y === 2,
    pts.slice(0, 5).map((p) => [p.x, p.y]));
  chk('每个点都居中在自己那一格里',
    pts.every((p) => near(p.x + p.s / 2, Math.floor(p.x / 2) * 2 + 1)
                   && near(p.y + p.s / 2, Math.floor(p.y / 2) * 2 + 1)),
    pts.slice(0, 4).map((p) => [p.x + p.s / 2, p.y + p.s / 2]));
  chk('颜色就是那一块的原色', pts.every((p) => p.c.join() === '255,0,0'), pts[0].c);
}

console.log('\n── ② 覆盖率只决定点的大小（不是亮度）──');
{
  // 2x2 一格，两个像素不透明、两个全透明 → cov = 0.5
  const d = mk(2, 2, (x, y) => (x === 0 ? RED : null));
  const [p] = sampleDots(d, 2, 2, { pitch: 2 });
  chk('cov = 0.5（两个不透明像素 / 4）', near(p.cov, 0.5, 1e-3), p.cov);
  chk('点边长 = pitch × (0.30 + 0.70 × cov)', near(p.s, 2 * (0.30 + 0.70 * 0.5), 1e-3), p.s);
  chk('点仍然居中', near(p.x + p.s / 2, 1, 1e-6) && near(p.y + p.s / 2, 1, 1e-6), [p.x, p.y]);

  // 半透明：alpha 128/255 → cov ≈ 0.502
  const d2 = mk(2, 2, () => [255, 0, 0, 128]);
  const [q] = sampleDots(d2, 2, 2, { pitch: 2 });
  chk('半透明整格：cov = 128/255', near(q.cov, 128 / 255, 1e-3), q.cov);
  chk('颜色不被 alpha 拉暗（仍是 255,0,0）', q.c.join() === '255,0,0', q.c);

  // 点永远不会超过点距、也不会小到看不见
  const many = [];
  for (let a = 1; a <= 255; a += 17) many.push(...sampleDots(mk(2, 2, () => [255, 0, 0, a]), 2, 2, { pitch: 2 }));
  chk('点边长始终落在 [0.30×pitch, pitch]',
    many.every((p) => p.s >= 0.30 * 2 - 1e-6 && p.s <= 2 + 1e-6),
    [Math.min(...many.map((p) => p.s)), Math.max(...many.map((p) => p.s))]);
}

console.log('\n── ③ 颜色 = 按 alpha 加权平均（透明像素不能把颜色拉向黑）──');
{
  // 一格两像素：不透明白 + 半透明黑。加权 → 255/1.502 ≈ 170；若按面积平均会是 128
  const d = mk(2, 1, (x) => (x === 0 ? [255, 255, 255, 255] : [0, 0, 0, 128]));
  const [p] = sampleDots(d, 2, 1, { pitch: 2 });
  chk('加权平均（≈170）而不是按面积平均（128）', p.c[0] === 170, p.c);
  chk('cov = (1 + 0.502) / 2', near(p.cov, (1 + 128 / 255) / 2, 1e-3), p.cov);

  // 红 + 蓝，各半 → 128,0,128
  const d2 = mk(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  chk('两色各半 → 取平均色', sampleDots(d2, 2, 1, { pitch: 2 })[0].c.join() === '128,0,128',
    sampleDots(d2, 2, 1, { pitch: 2 })[0].c);
}

console.log('\n── ④ 该丢的块要丢（全透明 / 太淡）──');
{
  chk('全透明 → 一个点都不出', sampleDots(mk(8, 8), 8, 8, { pitch: 2 }).length === 0, '');
  const faint = sampleDots(mk(2, 2, () => [255, 255, 255, 5]), 2, 2, { pitch: 2 });
  chk('alpha 5/255 ≈ 0.02 < 0.04 阈值 → 丢掉', faint.length === 0, faint.length);
  const edge = sampleDots(mk(2, 2, () => [255, 255, 255, 20]), 2, 2, { pitch: 2 });
  chk('alpha 20/255 ≈ 0.078 > 阈值 → 保留', edge.length === 1, edge.length);
  chk('阈值可调：alphaCut 0.9 时连半透明块也丢',
    sampleDots(mk(2, 2, () => [255, 0, 0, 128]), 2, 2, { pitch: 2, alphaCut: 0.9 }).length === 0, '');
  // 一块实心、旁边一块全透明
  const half = sampleDots(mk(4, 2, (x) => (x < 2 ? RED : null)), 4, 2, { pitch: 2 });
  chk('实心旁边挨着透明：只出实心那一个', half.length === 1 && half[0].x === 0, half.map((p) => p.x));
}

console.log('\n── ⑤ 边上不满一格的收尾块 ──');
{
  const pts = sampleDots(mk(5, 3, () => RED), 5, 3, { pitch: 2 });
  // x: 0,2,4（最后一列只有 1px）  y: 0,2（最后一行只有 1px） → 3×2
  chk('宽高不整除时，收尾块照样出（3×2 = 6）', pts.length === 6, pts.length);
  chk('收尾块也是满覆盖（点铺满它那 1px 格）',
    pts.filter((p) => p.x >= 4).every((p) => near(p.s, 2)), pts.map((p) => [p.x, p.s]));
  // 收尾块（1px 宽）的点仍按整格尺寸画，会溢出到画布外 —— 画布自己裁掉，视觉上就是一条细边。
  // 溢出的方向只可能是右边/下边（收尾块只出现在那里），所以不会压到邻居的点上。
  chk('点的起点都落在缓冲里', pts.every((p) => p.x >= 0 && p.y >= 0 && p.x < 5 && p.y < 3),
    pts.map((p) => [p.x, p.y]));
  chk('溢出只发生在右/下边缘，幅度不超过一个点距',
    pts.every((p) => p.x + p.s <= 5 + 2 && p.y + p.s <= 3 + 2), pts.map((p) => [p.x + p.s, p.y + p.s]));
}

console.log('\n── ⑥ 参数兜底 ──');
{
  // 必须保证 pitch ≥ 1：外层是按 pitch 步进的 for，0 会死循环
  chk('pitch 0 → 收敛成默认值 2', sampleDots(mk(4, 4, () => RED), 4, 4, { pitch: 0 }).length === 4, '');
  chk('pitch 负数 → 同样收敛（不死循环）', sampleDots(mk(4, 4, () => RED), 4, 4, { pitch: -3 }).length === 4, '');
  chk('pitch NaN → 同样收敛', sampleDots(mk(4, 4, () => RED), 4, 4, { pitch: NaN }).length === 4, '');
  chk('不给 pitch 也有默认值（2）', sampleDots(mk(4, 4, () => RED), 4, 4).length === 4,
    sampleDots(mk(4, 4, () => RED), 4, 4).length);
  chk('小数 pitch 取整', sampleDots(mk(4, 4, () => RED), 4, 4, { pitch: 2.4 }).length === 4, '');
  const big = sampleDots(mk(4, 4, () => RED), 4, 4, { pitch: 99 });
  chk('pitch 比图还大 → 只出一块', big.length === 1 && near(big[0].s, 99), big.length);
}

console.log('\n── ⑦ 画布层（无 DOM 时不能炸）──');
{
  chk('dotsCanvas 没有图 → null（调用方据此回退直接贴图）', dotsCanvas(null, 10, 10) === null, '');
  chk('dotsCanvas 尺寸为 0 → null', dotsCanvas({ width: 4, height: 4 }, 0, 10) === null, '');
  chk('clearDotsCache 存在且可调用', typeof clearDotsCache === 'function', typeof clearDotsCache);
  clearDotsCache();
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
