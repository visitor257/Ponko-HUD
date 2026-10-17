// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 素材包取帧的缩放规则（2026-10-15 用户反馈"立绘太糊"时定）：
//   缩小 -> **面积平均**；放大 -> 最近邻。
// 起因：素材按 48 列生成，角色面板只给 40 列，平均每次都要缩 48→40。
// 最近邻在这种非整数比下会按 48/40 丢掉每第 6 列，竖直边缘全是锯齿、五官被挤歪。
//
// 用法：node tools/test_charpack.mjs
import { CharPack } from '../app/src/charpack.js';

let pass = 0, fail = 0;
const chk = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   → ' + got}`);
  ok ? pass++ : fail++;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 造一个 cols x rows 的假帧：上像素 = [col*40,0,0]，下像素 = [0,0,col*40] */
function fakeCells(cols, rows, emptyCols = []) {
  const cells = [];
  for (let y = 0; y < rows; y++) {
    const row = [];
    for (let x = 0; x < cols; x++) {
      row.push(emptyCols.includes(x) ? [null, null] : [[x * 40, 0, 0], [0, 0, x * 40]]);
    }
    cells.push(row);
  }
  return cells;
}

function stubFetch(cells) {
  const json = { cols: cells[0].length, rows: cells.length, cells, fps: 0 };
  globalThis.fetch = async () => ({ ok: true, json: async () => json });
}

const mkPack = () => new CharPack({
  id: 'fake', base: '/fake/', grid: { cols: 6, rows: 6, charset: 'block' },
  moods: { idle: { frames: ['idle.ans'], fps: 0, loop: false } },
});

const main = async () => {
  // ── 缩小 6 → 4：必须是"面积平均"，不是"最近邻跳列" ──
  stubFetch(fakeCells(6, 6));
  const down = await mkPack().frame('idle', 4);

  chk('缩小后行数按比例（6 行 → 4 行）', down.rows === 4, String(down.rows));
  chk('缩小后列数 = 目标列数', down.cols === 4 && down.cells[0].length === 4, String(down.cells[0].length));

  // k = 4/6；x=0 覆盖源列 0..1 -> 上像素 r 平均 = (0+40)/2 = 20
  chk('第 0 列上像素 = 源 0,1 列的平均（20,0,0）', eq(down.cells[0][0][0], [20, 0, 0]),
    JSON.stringify(down.cells[0][0][0]));
  chk('第 0 列下像素 = 源 0,1 列的平均（0,0,20）', eq(down.cells[0][0][1], [0, 0, 20]),
    JSON.stringify(down.cells[0][0][1]));
  chk('第 1 列 = 源 1,2 列的平均（60,0,0）', eq(down.cells[0][1][0], [60, 0, 0]),
    JSON.stringify(down.cells[0][1][0]));
  chk('第 3 列 = 源 4,5 列的平均（180,0,0）', eq(down.cells[0][3][0], [180, 0, 0]),
    JSON.stringify(down.cells[0][3][0]));
  chk('没退回最近邻（最近邻第 0 列会是纯 (0,0,0)）', !eq(down.cells[0][0][0], [0, 0, 0]),
    JSON.stringify(down.cells[0][0][0]));

  // ── 全空的源格缩完还得是空（不能被平均成半透明的灰） ──
  stubFetch(fakeCells(6, 6, [4, 5]));
  const holes = await mkPack().frame('idle', 4);
  chk('全是空的源格 -> 缩完仍是空', eq(holes.cells[0][3], [null, null]),
    JSON.stringify(holes.cells[0][3]));
  chk('同一次缩放里，有内容的列不受影响', eq(holes.cells[0][0][0], [20, 0, 0]),
    JSON.stringify(holes.cells[0][0][0]));

  // ── 放大 6 → 12：必须保持最近邻（方块复制），不能插值糊掉 ──
  stubFetch(fakeCells(6, 6));
  const up = await mkPack().frame('idle', 12);
  chk('放大后列/行数', up.cols === 12 && up.rows === 12, `${up.cols}x${up.rows}`);
  chk('放大 = 方块复制（相邻两格同色）',
    eq(up.cells[0][0], up.cells[0][1]) && eq(up.cells[0][0], up.cells[0][0]),
    JSON.stringify([up.cells[0][0], up.cells[0][1]]));
  chk('放大后第 0 格仍是源的纯色 (0,0,0)/(0,0,0)',
    eq(up.cells[0][0][0], [0, 0, 0]), JSON.stringify(up.cells[0][0][0]));
  chk('放大不会插出中间色（第 2 格 = 源第 1 列纯色 [40,0,0]）',
    eq(up.cells[0][2][0], [40, 0, 0]), JSON.stringify(up.cells[0][2][0]));

  // ── 列宽正好相等时不该动它 ──
  const same = await mkPack().frame('idle', 6);
  chk('目标列宽 == 源列宽时原样返回', same.rows === 6 && eq(same.cells[0][0][0], [0, 0, 0]),
    `${same.rows}`);

  // ───────────────────────────────────────────────────────────────────────────
  // 心情的**名字**：归素材包所有，不归语言包（2026-10-17 用户要求）
  //   "心情标签的翻译……写在角色形象的配置文件里。必填英文，其他语言选填。
  //    如果使用的那个语言没翻译，则显示英文。"
  // 回退链：当前语言 → 英文（必填）→ 标签本身。
  const labelled = new CharPack({
    id: 'x', base: '/x/', grid: { cols: 6, rows: 6, charset: 'block' },
    moods: {
      idle:     { frames: ['idle.ans'], label: { en: 'idle', 'zh-cn': '待机' } },   // 中英都有
      thinking: { frames: ['thinking.ans'], label: { en: 'thinking' } },            // 只有英文（必填那份）
      angry:    { frames: ['angry.ans'], label: { 'zh-cn': '生气' } },              // 漏了英文
      sleepy:   { frames: ['sleepy.ans'] },                                         // 连 label 都没有
    },
  });

  chk('有当前语言就用它', labelled.labelOf('idle', 'zh-cn') === '待机', labelled.labelOf('idle', 'zh-cn'));
  chk('当前语言没翻 → 落英文（必填的那份）',
    labelled.labelOf('thinking', 'zh-cn') === 'thinking', labelled.labelOf('thinking', 'zh-cn'));
  chk('漏写英文 + 该语言也没翻 → 落标签本身（不拿别的语言顶上）',
    labelled.labelOf('angry', 'ja') === 'angry', labelled.labelOf('angry', 'ja'));
  chk('但它翻了的那个语言照常生效', labelled.labelOf('angry', 'zh-cn') === '生气', labelled.labelOf('angry', 'zh-cn'));
  chk('整条 label 都没有 → 落标签本身', labelled.labelOf('sleepy', 'ja') === 'sleepy', labelled.labelOf('sleepy', 'ja'));
  chk('英文界面照样取到英文', labelled.labelOf('idle', 'en') === 'idle', labelled.labelOf('idle', 'en'));
  chk('语言 id 大小写不敏感', labelled.labelOf('idle', 'ZH-CN') === '待机', labelled.labelOf('idle', 'ZH-CN'));
  chk('不认识的标签也不炸', labelled.labelOf('nope', 'zh-cn') === 'nope', labelled.labelOf('nope', 'zh-cn'));

  // stateTag：包里**真的有**这个表情才返回它。
  // 与 tagFor 的差别在"没有"这一档 —— 画立绘可以兜底到待机脸，取名字不行
  // （否则一个没有生气表情的包会让"生气"顶着"待机"的名字，面板上像有两个待机）。
  chk('stateTag 命中 state 本身', labelled.stateTag('idle') === 'idle', String(labelled.stateTag('idle')));
  chk('stateTag 命中别名（think → thinking）',
    labelled.stateTag('think') === 'thinking', String(labelled.stateTag('think')));
  chk('包里没这个表情 → stateTag 返回 null（不兜底）',
    labelled.stateTag('error') === null, String(labelled.stateTag('error')));
  chk('而 tagFor 照旧兜底到 idle（画的时候宁可显示待机脸）',
    labelled.tagFor('error') === 'idle', String(labelled.tagFor('error')));
  chk('空包：两个都返回 null，不炸',
    new CharPack({ id: 'e', moods: {} }).stateTag('idle') === null
    && new CharPack({ id: 'e', moods: {} }).tagFor('idle') === null, '');

  console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}  （${pass}/${pass + fail}）`);
  process.exitCode = fail ? 1 : 0;
};

main().catch((e) => { console.log('FAIL 脚本异常：' + String((e && e.stack) || e)); process.exitCode = 1; });
