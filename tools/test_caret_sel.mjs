// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 回归：输入行光标位置 / 配置框光标与 ←→ / 鼠标拖选（都不需要真 GUI）
import { readFileSync } from 'node:fs';
import { AgentPanel } from '../app/src/panels/agent.js';
import { ShellPanel } from '../app/src/panels/shell.js';
import { availableLangs, langOf, useLang } from '../app/src/i18n/index.js';
import zhCn from '../app/src/i18n/zh-cn.js';
import en from '../app/src/i18n/en.js';
import ja from '../app/src/i18n/ja.js';
import { Selection } from '../app/src/selection.js';
import { TAB_COLORS } from '../app/src/tabcolors.js';
import { exitWidth, exitLabel, exitButtonRect } from '../app/src/exitbutton.js';
import { zoomBtnRect, zoomWidth, fullRect } from '../app/src/zoombtn.js';
import {
  ZOOM_DUR, ZOOM_W, ZOOM_INK, ZOOM_INK_IN, ZOOM_OTHER_W,
  zoomPhase, zoomEase, zoomAnimRect, zoomBorderMix,
  zoomSelfFade, zoomOtherFade, zoomStagger, zoomOtherOrder, zoomSmooth,
} from '../app/src/zoomanim.js';

let fail = 0;
const chk = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   → ' + got}`);
  if (!ok) fail++;
};

// 真实字体（15px 等宽 + 中文 fallback）实测格宽：⛶/〼 是 2 格，□/■ 是 1 格
const CH_W = { '⛶': 2, '〼': 2, '□': 1, '■': 1 };
// LLM 配置是**每个对话一份**的：给对话装一份假的，界面才会画消息（没配的话只弹配置框）
const FAKE_LLM = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-test', model: 'm', provider: 'auto', resolved: '' };

// ── 极简网格替身：只实现面板画字时用到的几个原语，并记录每次 set 的坐标
function mkGrid() {
  const rows = new Map();
  const sets = [];
  const fgs = new Map();                 // 「y:x」→ 前景色（查色标颜色用）
  const g = {
    cols: 200, rows: 80,
    rows, sets, fgs,
    fgAt: (x, y) => fgs.get(`${y}:${x}`),
    // 真实字体下实测的格宽（tools/_measure_sym.mjs）：几何符号区里不少字符是全角，
    // 光靠码点范围会算错（⛶ U+26F6 实测 2 格，按范围会判 1 格）→ 这里按实测值覆盖。
    chWidth: (c) => CH_W[c] ?? (c && c.charCodeAt(0) > 0x2e80 ? 2 : 1),
    strWidth(s) { let n = 0; for (const ch of s) n += g.chWidth(ch); return n; },
    text(x, y, s, fg) {
      let col = x; const r = rows.get(y) || {};
      for (const ch of String(s)) {
        r[col] = ch;
        if (fg !== undefined) fgs.set(`${y}:${col}`, fg);
        for (let k = 1; k < g.chWidth(ch); k++) r[col + k] = '~';
        col += g.chWidth(ch);
      }
      rows.set(y, r);
      return col;
    },
    set(x, y, ch, fg) {
      const r = rows.get(y) || {}; r[x] = ch; rows.set(y, r); sets.push({ x, y, ch });
      if (fg !== undefined) fgs.set(`${y}:${x}`, fg);
    },
    box() {}, fill() {}, inBounds: () => true, idx: (x, y) => y * 200 + x,
  };
  return g;
}
const TH = { text: 1, panel: 0, accent: 2, line: 3, dim: 4, darker: 5, err: 6, warn: 7, ok: 8, bg: 9 };
const C = { theme: TH, t: 0, tokRate: 0 };      // t=0 → 光标处于"亮"相位

console.log('── 1. SHELL 输入行：光标应跟着 caret 走 ──');
{
  const g = mkGrid();
  const s = new ShellPanel({});
  s.layout({ x: 0, y: 0, w: 40, h: 12 });
  s.focus = true;
  s.input = 'hello world';

  const caretCol = (caret) => {
    s.caret = caret; g.sets.length = 0; s.draw(g, C);
    // 只看输入行那一行的 █：顶线右端也有标签色块（同字符）
    const hit = g.sets.find((v) => v.ch === '█' && v.y === s.rect.y + s.rect.h - 2);
    return hit ? hit.x : -1;
  };
  const base = caretCol(0);
  chk('caret=0 时光标紧贴提示符之后', base > 0, base);
  chk('caret=5 → 前进 5 列', caretCol(5) === base + 5, caretCol(5));
  chk('caret=11（末尾）→ 前进 11 列', caretCol(11) === base + 11, caretCol(11));
  chk('caret=2 与末尾不同列（不再是恒定画在末尾）', caretCol(2) !== caretCol(11), `${caretCol(2)} vs ${caretCol(11)}`);

  // 超长命令：窗口应滑动，光标留在可视区内且不越过面板边界
  s.input = 'x'.repeat(300);
  const col = caretCol(300);
  chk('超长输入：光标仍在面板内', col > 0 && col <= 40 - 2, col);
  chk('超长输入：光标贴在可视区右端', col === 37, col);
}

console.log('\n── 2. AGENT 输入行：同样按 caret 定位 ──');
{
  const g = mkGrid();
  const a = new AgentPanel({});
  a.layout({ x: 0, y: 0, w: 60, h: 20 });
  a.focus = true;
  a.tab.llm = { ...FAKE_LLM };     // 配好的对话才是聊天界面；没配的那个停在配置界面（见第 15 节）
  a.configClose();                 // 配好了就把表单收起来（configSave 验证通过后也是这么收的）
  a.input = '你好 hello';
  const caretCol = (caret) => {
    a.caret = caret; g.sets.length = 0; a.draw(g, C);
    // 只看输入框那一行的 █：面板顶线右端也有标签色块（同一个字符）
    const hit = g.sets.find((v) => v.ch === '█' && v.y > a.rect.y);
    return hit ? hit.x : -1;
  };
  const base = caretCol(0);
  chk('caret=0 有光标', base > 0, base);
  chk('caret=1 跳过宽字符（中文占 2 列）', caretCol(1) === base + 2, caretCol(1));
  chk('caret=3 → 2+3 列', caretCol(3) === base + 5, caretCol(3));

  a.input = 'y'.repeat(300);
  const col = caretCol(300);
  chk('超长输入不越界', col > 0 && col <= 60 - 2, col);
}

console.log('\n── 3. 配置框：光标位置 + ←→ 归属 ──');
{
  const g = mkGrid();
  const a = new AgentPanel({});
  a.layout({ x: 0, y: 0, w: 60, h: 30 });
  a.configOpen();
  a.form.fields[0].value = 'https://api.openai.com/v1';

  const fieldLine = () => {
    const y = Object.keys(a._cfgHits ? {} : {});
    return null;
  };
  const drawOnce = (idx, caret) => {
    a.form.idx = idx; a.form.caret = caret; g.sets.length = 0; a.drawConfig(g, C);
    return g.sets;
  };
  // 文本字段：set 只有光标一处（按钮未选中时走 text）
  const s0 = drawOnce(0, 0);
  chk('文本字段光标存在', s0.length === 1, JSON.stringify(s0));
  const x0 = s0[0].x;
  const s5 = drawOnce(0, 5);
  chk('caret=5 → 光标前进 5 列', s5[0].x === x0 + 5, `${x0} -> ${s5[0].x}`);
  chk('caret=5 光标压在该字符上（不再是追加 █）', s5[0].ch === 'https://api.openai.com/v1'[5], s5[0].ch);
  const sEnd = drawOnce(0, 'https://api.openai.com/v1'.length);
  chk('caret=末尾 → 光标是空格块', sEnd[0].ch === ' ', JSON.stringify(sEnd[0]));

  // ←→ 归属：只有"协议"这种循环字段才吃方向键
  chk('文本字段不吃 ←→', a.cfgCycleField() === false, a.cfgCycleField());
  a.form.idx = 3;
  chk('协议字段吃 ←→', a.cfgCycleField() === true, a.cfgCycleField());

  // 点击某列 → caret 应落到点到那个字符
  const hits = a._cfgHits.fields.find((f) => f.key === 'baseUrl');
  a.configMouse({ y: hits.y, x: hits.txtStart + 7 });
  chk('点击第 8 列 → caret=7', a.form.caret === 7, a.form.caret);

  // caret 同步要被 clamp，不能越到值外面
  a.form.idx = 0; a.syncFormCaret(999);
  chk('syncFormCaret 夹紧到值长', a.form.caret === 'https://api.openai.com/v1'.length, a.form.caret);
  a.syncFormCaret(-5);
  chk('负位置夹到 0', a.form.caret === 0, a.form.caret);

  // 切字段时光标到末尾
  a.form.idx = 2; a.formCaretToEnd();
  chk('切字段光标到末尾', a.form.caret === a.form.fields[2].value.length, a.form.caret);
}

console.log('\n── 4. 鼠标拖选 ──');
{
  const sel = new Selection();
  const r = { x: 0, y: 0, w: 40, h: 12 };

  chk('点在边框上不算起选', sel.begin({ x: 0, y: 0 }, r) === false, '');
  chk('点在正文区起选', sel.begin({ x: 5, y: 3 }, r) === true, '');
  sel.to({ x: 12, y: 3 });
  let n = sel.norm();
  chk('向右拖 → x0=5,x1=12', n.x0 === 5 && n.x1 === 12, JSON.stringify(n));

  // 反向拖（终点在锚点左上）也要归一化
  sel.begin({ x: 12, y: 5 }, r);
  sel.to({ x: 4, y: 2 });
  n = sel.norm();
  chk('反向拖自动归一化', n.x0 === 4 && n.x1 === 12 && n.y0 === 2 && n.y1 === 5, JSON.stringify(n));

  // 拖到面板外要被夹住
  sel.to({ x: 999, y: 999 });
  n = sel.norm();
  chk('拖出面板被夹在内容区内', n.x1 === r.w - 2 && n.y1 === r.h - 2, JSON.stringify(n));

  // 只点一下、没拖 → 不成立选区
  sel.begin({ x: 6, y: 6 }, r);
  sel.done();
  chk('单击不成选区', sel.active === false, '');

  // paint + text：拿一个真网格替身（带数组缓冲）
  const W = 10, H = 5;
  const gridish = {
    cols: W, rows: H,
    chs: [], fgs: new Array(W * H).fill(1), bgs: new Array(W * H).fill(2), attrs: new Uint8Array(W * H),
    idx: (x, y) => y * W + x,
    inBounds: (x, y) => x >= 0 && y >= 0 && x < W && y < H,
  };
  const alpha = 'abcdefghij';
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) gridish.chs[y * W + x] = alpha[x];

  // 线性（文档式）选区：首行从锚点到行尾、末行从行首到光标。
  // 内容区 b = 列 1..8、行 1..3；网格每行是 'abcdefghij'。
  sel.begin({ x: 2, y: 1 }, { x: 0, y: 0, w: W, h: H });
  sel.to({ x: 5, y: 2 });
  chk('线性选区：首行锚点→行尾 + 末行行首→光标',
    sel.text(gridish) === 'cdefghi\nbcdef', JSON.stringify(sel.text(gridish)));

  const i = sel.norm();
  const before = { f: gridish.fgs[gridish.idx(i.x0, i.y0)], b: gridish.bgs[gridish.idx(i.x0, i.y0)] };
  sel.paint(gridish);
  const after = { f: gridish.fgs[gridish.idx(i.x0, i.y0)], b: gridish.bgs[gridish.idx(i.x0, i.y0)] };
  chk('paint 交换前后景', after.f === before.b && after.b === before.f, JSON.stringify(after));

  // ── 线性选区的几个关键点（不是矩形块选）────────────────────────────
  sel.begin({ x: 5, y: 2 }, { x: 0, y: 0, w: W, h: H });
  sel.to({ x: 2, y: 1 });
  chk('反向拖也是线性、按文档顺序取', sel.text(gridish) === 'cdefghi\nbcdef',
    JSON.stringify(sel.text(gridish)));

  sel.begin({ x: 3, y: 1 }, { x: 0, y: 0, w: W, h: H });
  sel.to({ x: 5, y: 1 });
  chk('单行选择精确到列', sel.text(gridish) === 'def', JSON.stringify(sel.text(gridish)));

  // 三行：首行只取"锚点→行尾"，中间行取整行（行首→行尾），末行只取"行首→光标"
  const sp = (() => {
    sel.begin({ x: 2, y: 1 }, { x: 0, y: 0, w: W, h: H });
    sel.to({ x: 3, y: 3 });
    return sel.spans(gridish).map((r) => `${r.y}:${r.xa}-${r.xb}`);
  })();
  chk('三行片段：首行→行尾 / 中间整行 / 末行→光标',
    sp[0] === '1:2-8' && sp[1] === '2:1-8' && sp[2] === '3:1-3', JSON.stringify(sp));

  // 行尾取"最后一个非空格"，不是面板右边界：把末行右侧留白，尾随空格要裁掉
  for (let x = 3; x < W; x++) gridish.chs[2 * W + x] = ' ';
  sel.begin({ x: 2, y: 1 }, { x: 0, y: 0, w: W, h: H });
  sel.to({ x: 6, y: 2 });
  chk('末行尾随空格被裁掉', sel.text(gridish) === 'cdefghi\nbc', JSON.stringify(sel.text(gridish)));

  // 宽字符：续格不能被当成内容重复读一遍
  for (let x = 0; x < W; x++) gridish.chs[3 * W + x] = ' ';
  gridish.chs[3 * W + 1] = '中'; gridish.chs[3 * W + 2] = ''; gridish.chs[3 * W + 3] = '文'; gridish.chs[3 * W + 4] = '';
  sel.begin({ x: 1, y: 3 }, { x: 0, y: 0, w: W, h: H });
  sel.to({ x: 4, y: 3 });
  chk('宽字符续格跳过', sel.text(gridish) === '中文', JSON.stringify(sel.text(gridish)));

  // 空选区不应产生文本
  sel.clear();
  chk('清空后无文本', sel.text(gridish) === '', sel.text(gridish));
}

// 5. 单击 vs 拖选的判定（main.js 靠 end() 的返回值决定要不要切焦点 / 挪光标）
console.log('\n── 5. 按下→松手：单击还是拖选 ──');
{
  const sel = new Selection();
  const r = { x: 0, y: 0, w: 40, h: 12 };

  sel.begin({ x: 8, y: 9 }, r, 'shell');
  const click = sel.end();
  chk('没拖动 → end() 报"单击"', click === true, click);
  chk('单击不成选区', sel.active === false, sel.active);
  chk('单击仍能读到按下的面板', sel.tag === 'shell', sel.tag);
  chk('单击仍能读到按下坐标', sel.at.x === 8 && sel.at.y === 9, JSON.stringify(sel.at));

  sel.begin({ x: 8, y: 9 }, r, 'agent');
  sel.to({ x: 20, y: 9 });
  const drag = sel.end();
  chk('拖过 → end() 报"拖选"', drag === false, drag);
  chk('拖过保留选区', sel.active === true, sel.active);
  chk('tag 更新为后一次按下的面板', sel.tag === 'agent', sel.tag);

  // 同一个格子按下又松手（没跨格）也该算单击
  sel.begin({ x: 9, y: 9 }, r, 'shell');
  sel.to({ x: 9, y: 9 });
  chk('原地拖动一圈仍算拖选（已 moved）', sel.end() === false, sel.active);

  // 起在面板外（比如点的是边框/分割条）时 tag 不该残留上一次的
  const fresh = new Selection();
  chk('新实例 tag 为空', fresh.tag === null && fresh.at === null, `${fresh.tag} ${JSON.stringify(fresh.at)}`);
}

// 6. AGENT 多行输入：Enter 换行 → 输入框长高，光标到第 2 行；Ctrl+Enter 才发送
console.log('\n── 6. AGENT 输入框多行 ──');
{
  const g = mkGrid();
  const a = new AgentPanel({});
  a.layout({ x: 0, y: 0, w: 60, h: 20 });
  a.focus = true;
  a.tab.llm = { ...FAKE_LLM };     // 同上：要画输入框就得是一个配好了的对话
  a.configClose();

  chk('空输入占 1 行', a.inputRows(g) === 1, a.inputRows(g));
  chk('单行文本仍占 1 行', (a.input = 'hello', a.inputRows(g)) === 1, a.inputRows(g));

  // 一次 Enter：input 尾部插入 '\n'（真实浏览器由 textarea 完成，这里手工作等价输入）
  a.input = '第一行\n'; a.caret = 4;
  chk('末尾一个换行 → 2 行', a.inputRows(g) === 2, a.inputRows(g));
  chk('caret 在换行后 → 光标落第 2 行', a.inputWindow(g).cRow === 1, a.inputWindow(g).cRow);

  const caretDraw = () => { g.sets.length = 0; a.draw(g, C); return g.sets.find((v) => v.ch === '█' && v.y > a.rect.y); };
  a.input = '第一行\n'; a.caret = 4;                        // 换行之后 → 光标在第 2 行
  const yTail = caretDraw().y;
  a.input = '第一行\n第二行'; a.caret = 3;                   // 紧挨 '\n' 之前 → 仍属第 1 行
  const yFirst = caretDraw().y;
  a.caret = 4;                                             // '\n' 之后 → 跳到第 2 行
  const ySecond = caretDraw().y;
  chk('第 1 行行尾与第 2 行的光标不在同一行', yFirst !== ySecond, `${yFirst} vs ${ySecond}`);
  chk('跳到下一行只是下移一格', ySecond === yFirst + 1, `${yFirst} -> ${ySecond}`);
  chk('末行光标与旧写法位置一致', yTail === ySecond, `${yTail} vs ${ySecond}`);

  // 输入框高 2 行时，它的顶边比单行时高一格（不能盖住对话区最后一行之上无谓的空间）
  const w2 = a.inputWindow(g);
  chk('2 行时输入框顶边 = 面板底 - 4', w2.iyTop === 20 - 4, w2.iyTop);
  chk('消息区行数相应减少', w2.iyTop - 1 === 20 - 5, w2.iyTop - 1);

  // 超宽单行要软换行，而不是撑爆面板
  a.input = 'z'.repeat(300); a.caret = 300;
  const wl = a.inputWindow(g);
  chk('超宽行被软换行且不超过行数上限', wl.lines.length > 1 && wl.rows <= 6, `${wl.lines.length}/${wl.rows}`);
  chk('末行在可视窗口内（滚动跟随光标）', wl.top <= wl.cRow && wl.cRow - wl.top < wl.rows, `${wl.top}/${wl.cRow}`);
  chk('每行宽度不超可用宽度', wl.lines.every((L) => g.strWidth(L.text) <= wl.avail), JSON.stringify(wl.avail));

  // 点击定位：多行下点第 2 行第 3 个字符
  a.input = 'abcd\nwxyz'; a.caret = 0;
  const win6 = a.inputWindow(g);
  const clicked = a.caretFromPoint(g, win6.tx0 + 3, win6.iyTop + 1);
  chk('点第 2 行第 4 列 → caret=8', clicked === 8, clicked);
  chk('点输入框外返回 null', a.caretFromPoint(g, win6.tx0, win6.iyTop - 1) === null, '');
  chk('点第 1 行开头 → caret=0', a.caretFromPoint(g, win6.tx0, win6.iyTop) === 0, a.caretFromPoint(g, win6.tx0, win6.iyTop));

  // 宽字符行 Columns 换算
  a.input = '中文\n第二'; a.caret = 2;
  const w6 = a.inputWindow(g);
  const cMid = a.caretFromPoint(g, w6.tx0 + 3, w6.iyTop);     // 点在第 2 个字后半格
  chk('点宽字符后半格 → 落在该字之后', cMid === 2, cMid);
  chk('caret=2 的行内列 = 4（两个宽字符）', w6.cRow === 0 && g.strWidth(a.input.slice(0, 2)) === 4, w6.cRow);

  // 行数上限：面板很矮时不能把对话区吃光
  a.layout({ x: 0, y: 0, w: 60, h: 8 });
  a.input = 'a\nb\nc\nd\ne\nf\ng\nh'; a.caret = 15;
  chk('矮面板：行数被限制，消息区至少留 3 行', a.inputRows(g) === 2, a.inputRows(g));
  chk('且 top 窗口让光标可见', a.inputWindow(g).cRow - a.inputWindow(g).top < a.inputWindow(g).rows, '');
}

// 7. 对话流里的换行必须真的分行（不能被当成 1 列宽字符画进网格）
console.log('\n── 7. 消息正文的多行 ──');
{
  const g = mkGrid();
  const a = new AgentPanel({});
  a.layout({ x: 0, y: 0, w: 40, h: 20 });
  a.tab.llm = { ...FAKE_LLM };
  a.configClose();                 // 要画消息正文就得是聊天形态（未配置的对话停在配置界面）
  a.focus = true;
  a.input = '';
  const rowText = (y) => {
    const r = g.rows.get(y) || {};
    let s = '';
    for (let x = 0; x < 60; x++) {
      const ch = r[x];
      if (ch === undefined) s += ' ';
      else if (ch === '~') continue;                 // 宽字符续格
      else s += ch;
    }
    return s.replace(/\s+$/, '');
  };
  const drawMsgs = (role, text) => { a.msgs = []; a.push(role, text); g.rows.clear(); a.draw(g, C); };

  drawMsgs('user', '1\n2');
  chk('用户消息：第 1 行', rowText(1) === ' › 1', JSON.stringify(rowText(1)));
  chk('用户消息：第 2 行独立成一行且缩进对齐', rowText(2) === '   2', JSON.stringify(rowText(2)));
  chk('没有把 "\\n" 当字符塞进同一行', rowText(1) !== ' › 1 2', JSON.stringify(rowText(1)));

  drawMsgs('agent', '第一行\n第二行');
  chk('agent 回复换行也分行', rowText(1) === ' ▌ 第一行' && rowText(2) === '   第二行',
    `${JSON.stringify(rowText(1))} / ${JSON.stringify(rowText(2))}`);

  // 多行里再叠加自动换行：硬行优先，软换行不越界
  const long = 'x'.repeat(100);
  drawMsgs('user', long + '\n短');
  const rowsDrawn = [1, 2, 3, 4].map(rowText).filter((s) => s.trim() !== '');
  chk('长行被软换行且不越界', rowsDrawn.every((s) => s.length <= 40), JSON.stringify(rowsDrawn.map((s) => s.length)));
  chk('硬换行第二段独立且缩进对齐', rowsDrawn[rowsDrawn.length - 1] === '   短', JSON.stringify(rowsDrawn[rowsDrawn.length - 1]));
  chk('硬换行没和软换行混在一行', !rowsDrawn.slice(0, -1).some((s) => s.includes('短')), JSON.stringify(rowsDrawn));
}

// 8. 心情控制语句：agent 给自己下的 [[mood:...]] 指令要能显示在对话里（并可以关掉）
console.log('\n── 8. 心情语句的显示与开关 ──');
{
  const g = mkGrid();
  const a = new AgentPanel({});
  a.layout({ x: 0, y: 0, w: 40, h: 20 });
  a.tab.llm = { ...FAKE_LLM };
  a.configClose();                 // 要画消息正文就得是聊天形态（未配置的对话停在配置界面）
  a.focus = true;
  a.input = '';
  const rowText = (y) => {
    const r = g.rows.get(y) || {};
    let s = '';
    for (let x = 0; x < 60; x++) {
      const ch = r[x];
      if (ch === undefined) s += ' ';
      else if (ch === '~') continue;
      else s += ch;
    }
    return s.replace(/\s+$/, '');
  };

  // 心情控制语句**一律不进对话流**（2026-10-15 用户要求：那个"显示/隐藏"开关本来就是
  // 开发时想看一眼用的，删掉了）。协议本身照常生效 —— 这里能验的是"界面上不留痕"。
  chk('已经不存在"心情语句"那条开关（noteMood / showMoodTags 都删了）',
    a.noteMood === undefined && a.tab.showMoodTags === undefined,
    `${String(a.noteMood)} / ${String(a.tab.showMoodTags)}`);

  // 关键：旧存档里可能还留着 role='mood' 的行 → 读回来必须**整行不生成**，
  // 不能只把字抹掉留一条空行（正文A 下面直接就是 正文B）
  a.msgs = [];
  a.push('agent', '正文A');
  a.push('mood', '[[mood:think|note:想想]]');
  a.push('agent', '正文B');
  g.rows.clear(); a.draw(g, C);
  chk('历史里的心情行整行不渲染（正文A 下面直接是 正文B）',
    rowText(1) === ' ▌ 正文A' && rowText(2) === ' ▌ 正文B',
    `${JSON.stringify(rowText(1))} / ${JSON.stringify(rowText(2))}`);
  const drawn = [1, 2, 3].map(rowText).filter((s) => s.trim() !== '');
  chk('不出现 ♥ 行也不出现空行', drawn.length === 2 && !drawn.some((s) => s.includes('♥')),
    JSON.stringify(drawn));

  // 历史上下文不能把心情语句回灌给模型：send() 只取 user/agent
  a.msgs = [
    { role: 'user', text: '问一句' },
    { role: 'mood', text: '[[mood:think]]' },
    { role: 'agent', text: '答一句' },
  ];
  const picked = a.msgs.filter((m) => (m.role === 'user' || m.role === 'agent') && m.text.trim());
  chk('心情语句不进上下文', picked.length === 2 && picked.every((m) => m.role !== 'mood'),
    JSON.stringify(picked.map((m) => m.role)));

  // 配置框：字段变多后按钮不能压到字段上（按钮行 = 最后一个字段的下一行）
  a.configOpen();                       // inConfig 现在是 getter（看当前对话有没有摊开的表单）
  g.rows.clear(); a.draw(g, C);
  // 网格里宽字符占两格（第二格是续位 ~），拼接前要先滤掉
  const textOf = (r) => Object.keys(r).sort((a, b) => a - b)
    .map((k) => (r[k] === '~' ? '' : r[k])).join('');
  const anyRow = (sub) => [...g.rows.values()].some((r) => textOf(r).includes(sub));
  chk('配置框含「形象」字段（原「心情语句」那一栏已删）', anyRow('形象'), '');
  chk('配置框里没有「心情语句」了', !anyRow('心情语句'), '');
  chk('配置框仍有 保存 / 取消 按钮', anyRow('保存') && anyRow('取消'), '');
}

// 9. 多标签终端：一个标签一份状态（输入/cwd/历史），彼此不串；标签栏可点；id 必须能当后端会话 id
console.log('\n── 9. 多标签终端 ──');
{
  const g = mkGrid();
  const s = new ShellPanel({});
  s.layout({ x: 3, y: 2, w: 50, h: 14 });

  chk('默认只有一个标签', s.tabs.length === 1 && s.active === 0, `${s.tabs.length}/${s.active}`);
  chk('标签 id 可直接当后端会话 id', /^[A-Za-z0-9_-]{1,24}$/.test(s.tab.id), s.tab.id);

  const t0 = s.tab;
  t0.input = 'aaa'; t0.caret = 3;
  s.newTab();
  chk('新建后两个标签且光标切到新的', s.tabs.length === 2 && s.active === 1, `${s.tabs.length}/${s.active}`);
  chk('新标签有独立的会话 id', s.tab.id !== t0.id, `${s.tab.id} vs ${t0.id}`);
  chk('新标签输入框是空的（没串到旧标签）', s.input === '' && s.caret === 0, JSON.stringify(s.input));

  s.input = 'bbb';
  s.selectTab(0);
  chk('切回标签 1 看到它自己的输入与光标', s.input === 'aaa' && s.caret === 3, `${s.input}/${s.caret}`);
  chk('标签 2 的输入没被改掉', s.tabs[1].input === 'bbb', s.tabs[1].input);

  s.selectTab(1);
  s.nextTab(1);
  chk('nextTab(1) 到下个标签', s.active === 0, s.active);
  s.nextTab(-1);
  chk('nextTab(-1) 回上一个', s.active === 1, s.active);

  // cwd / shell 种类也按标签各算各的
  t0.cwd = 'C:\\Windows'; t0.kind = 'cmd';
  s.tabs[1].cwd = 'D:\\work';
  s.selectTab(0);
  chk('标签 1 的 cwd/shell 是自己的', s.cwd === 'C:\\Windows' && s.kind === 'cmd', `${s.cwd}/${s.kind}`);
  s.selectTab(1);
  chk('切过来就是标签 2 的 cwd', s.cwd === 'D:\\work', s.cwd);

  // 标签栏绘制 + 命中区（标签栏已移到 SHELL 框**外**：框顶线上面那一行）
  s.selectTab(0);
  g.rows.clear(); g.sets.length = 0;
  s.draw(g, C);
  s.drawTabBar(g, C);                 // 框内画完后再画框外的标签栏（同 main.js 的调用顺序）
  const barRow = s.tabBarRow();
  const bar = (() => {
    const r = g.rows.get(barRow) || {};
    return Object.keys(r).sort((a, b) => a - b).map((k) => (r[k] === '~' ? '' : r[k])).join('');
  })();
  chk('标签栏有新建按钮 +', bar.includes('+'), JSON.stringify(bar));
  chk('标签栏在框顶线之上（框外）', barRow === s.rect.y - 1 && barRow === 1, barRow);
  chk('tabAt 命中标签 2', s.tabAt(s._tabHits[1].x0, barRow) === 1,
    JSON.stringify(s._tabHits[1]));
  chk('tabAt 命中“+”返回 -1', s.tabAt(s._tabHits[2].x0, barRow) === -1,
    JSON.stringify(s._tabHits[2]));
  const textAt = (y) => {
    const r = g.rows.get(y) || {};
    return Object.keys(r).sort((a, b) => a - b).map((k) => (r[k] === '~' ? '' : r[k])).join('');
  };
  chk('输入行仍在面板最后一行（标签栏没顶掉它）',
    textAt(s.rect.y + s.rect.h - 2).includes('>'), JSON.stringify(textAt(s.rect.y + s.rect.h - 2)));

  // 认标签靠颜色而不是数字编号
  const barMap = g.rows.get(barRow) || {};
  chk('标签栏不再出现数字编号', !/[0-9]/.test(bar), JSON.stringify(bar));
  chk('标签栏画出两个标签的名字', (bar.match(/pwsh|cmd/g) || []).length === 2, JSON.stringify(bar));
  const mk = (i) => barMap[s._tabHits[i].x0];
  chk('当前标签实心色块、其它半块', mk(0) === '█' && mk(1) === '▄', `${mk(0)}/${mk(1)}`);
  const col0 = g.fgAt(s._tabHits[0].x0, barRow), col1 = g.fgAt(s._tabHits[1].x0, barRow);
  chk('两个标签的色标不是一个颜色',
    Number.isFinite(col0) && Number.isFinite(col1) && col0 !== col1, `${col0}/${col1}`);
  chk('两个标签的颜色也真的不同', s.tabs[0].ci !== s.tabs[1].ci, `${s.tabs[0].ci}/${s.tabs[1].ci}`);

  // 框顶线右端：一小排标签色块取代原来的 "1/2"
  const topRow = g.rows.get(s.rect.y) || {};
  const topTxt = Object.keys(topRow).sort((a, b) => a - b).map((k) => topRow[k]).join('');
  chk('顶线右端是色标而不是数字', !/[0-9]/.test(topTxt), JSON.stringify(topTxt));
  chk('顶线色标个数 = 标签个数', (topTxt.match(/[█▄]/g) || []).length === 2, JSON.stringify(topTxt));
  const mkX0 = (s.rect.x + s.rect.w - 1) - 3;      // 两个标签 → need=3，色块落在 x0、x0+2
  chk('顶线色块顺序 = 标签顺序，当前那个实心',
    topRow[mkX0] === '█' && topRow[mkX0 + 2] === '▄', `${topRow[mkX0]}/${topRow[mkX0 + 2]}`);
  chk('顶线色块用的是各自标签的颜色',
    g.fgAt(mkX0, s.rect.y) === col0 && g.fgAt(mkX0 + 2, s.rect.y) === col1,
    `${g.fgAt(mkX0, s.rect.y)}/${g.fgAt(mkX0 + 2, s.rect.y)}`);

  // 关掉中间那个，剩下的颜色不能跟着重排（否则"颜色 = 那个标签"就串了）
  const s4 = new ShellPanel({});
  const tFirst = s4.tabs[0];
  const ta = s4.newTab(), tb = s4.newTab(), tc = s4.newTab();
  chk('四个标签颜色互不相同',
    new Set([tFirst.ci, ta.ci, tb.ci, tc.ci]).size === 4, `${tFirst.ci}/${ta.ci}/${tb.ci}/${tc.ci}`);
  s4.closeTab(s4.tabs.indexOf(tb));
  chk('关掉中间那个，剩下的颜色不变（不看位置）',
    s4.tabs.map((t) => t.ci).join(',') === [tFirst.ci, ta.ci, tc.ci].join(','),
    s4.tabs.map((t) => t.ci).join(','));
  // 取色是"按轮子往下走"而不是马上回填刚释放的那个：否则新标签用上一个刚关掉的颜色，
  // 看着就像那个标签又回来了 —— 而这恰恰是颜色代替编号后最容易产生的错觉
  const tNew = s4.newTab();
  chk('新标签不套用刚释放的颜色（免得看成那个标签回来了）', tNew.ci !== tb.ci, `${tNew.ci} vs ${tb.ci}`);
  chk('颜色在标签之间始终不重复', new Set(s4.tabs.map((t) => t.ci)).size === s4.tabs.length,
    s4.tabs.map((t) => t.ci).join(','));

  // focus / onLine 要覆盖所有标签（含之后新建的）
  const s2 = new ShellPanel({});
  s2.focus = true;
  chk('focus 落在活动标签', s2.tab.focus === true, '');
  s2.newTab();
  chk('新建标签后焦点跟着走，旧标签不再有焦点',
    s2.tab.focus === true && s2.tabs[0].focus === false, '');

  const seen = [];
  const s3 = new ShellPanel({});
  s3.onLine = (l) => seen.push(l);
  s3.push('out', 'hello');
  s3.newTab();
  s3.push('out', 'world');
  chk('onLine 对新建的标签同样生效',
    seen.includes('hello') && seen.includes('world'), JSON.stringify(seen));

  // 关闭：最后一个不给关
  const first = s.tabs[0].id;
  chk('关掉标签 1 成功', s.closeTab(0) === true, '');
  chk('关完只剩一个且 id 是另一个', s.tabs.length === 1 && s.tabs[0].id !== first, s.tabs[0].id);
  chk('只剩一个时拒绝再关', s.closeTab() === false, '');
}

console.log('\n── 10. 右上角退出按钮：三态等宽 + 文字不被裁 ──');
{
  const g = mkGrid();
  g.cols = 120;                                   // 真实窗口下这个值远大于按钮宽度

  const W = exitWidth(g);
  const rect = (st) => exitButtonRect(g, st);
  const lbl = (st) => exitLabel(g, st);

  // 三态盒宽完全相同（这就是"按钮忽长忽短"的直接回归）
  const w0 = g.strWidth(lbl('idle'));
  const w1 = g.strWidth(lbl('armed'));
  const w2 = g.strWidth(lbl('quitting'));
  chk('三态标签宽度一致', w0 === w1 && w1 === w2 && w0 === W, `idle=${w0} armed=${w1} quitting=${w2} W=${W}`);

  // 落位一致：左边界不动、右边界贴屏幕最右
  const r0 = rect('idle'), r1 = rect('armed'), r2 = rect('quitting');
  chk('三态左边界相同', r0.x0 === r1.x0 && r1.x0 === r2.x0, `${r0.x0}/${r1.x0}/${r2.x0}`);
  chk('右边界贴住最右列', r0.x1 === g.cols - 1 && r1.x1 === g.cols - 1, `${r0.x1}/${r1.x1}`);
  chk('命中区宽度 = 绘制宽度（三态都不错位）',
    [r0, r1, r2].every((r) => r.x1 - r.x0 + 1 === W), `${r0.x1 - r0.x0 + 1}/${W}`);

  // 文字完整：补的是空格，不是把字吃掉
  chk('待确认态完整包含「再点一次」', lbl('armed').includes('✕ 再点一次'), JSON.stringify(lbl('armed')));
  chk('退出中态完整包含「退出中」', lbl('quitting').includes('✕ 退出中'), JSON.stringify(lbl('quitting')));
  chk('平常态完整包含「退出」', lbl('idle').includes('✕ 退出'), JSON.stringify(lbl('idle')));
  chk('三态都带 ✕ 图标', ['idle', 'armed', 'quitting'].every((s) => lbl(s).includes('✕')), '');

  // 回归守卫：如果哪个标签天生比其它长，就必须靠补齐 ——
  // 断言"未补齐的原始标签确实不等宽"，否则上面那条会失去意义（说明文字被换短了）
  const raw = { idle: ' ✕ 退出 ', armed: ' ✕ 再点一次 ', quitting: ' ✕ 退出中… ' };
  const rw = (s) => g.strWidth(raw[s]);
  chk('原始标签本身不等宽（所以才需要补齐）', rw('armed') !== rw('idle'), `${rw('armed')} vs ${rw('idle')}`);
  chk('补齐后不会越界（右端正好落在最后一列）', r0.x0 + W === g.cols, `${r0.x0}+${W} vs ${g.cols}`);

  // 补的是空格：去掉两侧空格后与原始标签一致
  chk('补齐只加空格、不删字', ['idle', 'armed', 'quitting'].every((s) => lbl(s).trim() === raw[s].trim()), '');
}

console.log('\n── 11. 各框右下角的 ⛶ / 〼 放大按钮 ──');
{
  const g = mkGrid();
  g.cols = 120; g.rows = 40;

  const r = { x: 0, y: 2, w: 34, h: 12 };            // 典型的 GLOBE 框
  const off = zoomBtnRect(g, r, false);
  const on = zoomBtnRect(g, r, true);

  chk('按钮落在框的底边线上', off.y === r.y + r.h - 1, off.y);
  chk('按钮在框内且不吃掉右下角', off.x1 === r.x + r.w - 2 && off.x0 >= r.x + 1, JSON.stringify(off));
  chk('放大/还原两态等宽', g.strWidth(off.label) === g.strWidth(on.label)
    && g.strWidth(off.label) === zoomWidth(g), `${g.strWidth(off.label)} vs ${g.strWidth(on.label)}`);
  chk('用符号不写字：平常 ⛶、放大态 〼',
    on.label.includes('〼') && off.label.includes('⛶')
    && !off.label.includes('〼') && !on.label.includes('⛶'),
    `${JSON.stringify(off.label)} / ${JSON.stringify(on.label)}`);
  chk('两个符号都没被截掉（补齐后仍完整包含）',
    off.label.trim() === '⛶' && on.label.trim() === '〼',
    `${JSON.stringify(off.label)} / ${JSON.stringify(on.label)}`);
  chk('按钮至少 4 列宽（符号只有 2 格，太窄点不中）', zoomWidth(g) >= 4, zoomWidth(g));
  // 两个符号都是 2 格宽 → 只要按钮宽度是偶数，两边的补白就能平分，符号落在正中间
  const pads = (lbl, sym) => {
    const i = lbl.indexOf(sym);
    return { l: i, r: lbl.length - i - sym.length };
  };
  const pOff = pads(off.label, '⛶');
  chk('⛶ 在按钮正中间（左右补白相等）', pOff.l === pOff.r,
    `${JSON.stringify(off.label)} 左${pOff.l} 右${pOff.r}`);
  const pOn = pads(on.label, '〼');
  chk('〼 也在按钮正中间（左右补白相等）', pOn.l === pOn.r,
    `${JSON.stringify(on.label)} 左${pOn.l} 右${pOn.r}`);
  chk('两态左边界不动', off.x0 === on.x0, `${off.x0} vs ${on.x0}`);

  // 放大后的目标矩形：占满整个内容区，上下 chrome 行留着（退出按钮/快捷键还够得着）
  const full = fullRect(g, 2, 2);
  chk('放大后占满整宽', full.x === 0 && full.w === g.cols, JSON.stringify(full));
  chk('放大后上下各留 2 行 chrome', full.y === 2 && full.h === g.rows - 4, JSON.stringify(full));
  const big = zoomBtnRect(g, full, true);
  chk('放大后按钮仍在右下角', big.y === full.y + full.h - 1 && big.x1 === g.cols - 2, JSON.stringify(big));
}

console.log('\n── 12. 放大 / 还原的过场动画（不再一帧到位）──');
{
  const from = { x: 34, y: 2, w: 60, h: 18 };      // SHELL 在分栏里的位置
  const to = { x: 0, y: 2, w: 120, h: 36 };        // 放大后的整块内容区
  const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

  // easing：起点终点必须精确、全程单调、且是 easeOut（前半程走得比线性快）
  chk('easing 端点精确（0→0、1→1）', zoomEase(0) === 0 && Math.abs(zoomEase(1) - 1) < 1e-9,
    `${zoomEase(0)} / ${zoomEase(1)}`);
  chk('easeOut：中点进度 > 线性的一半（冲出去再收住）', zoomEase(0.5) > 0.5, zoomEase(0.5));
  let mono = true, prevE = -1;
  for (let i = 0; i <= 20; i++) { const e = zoomEase(i / 20); if (e < prevE - 1e-12) mono = false; prevE = e; }
  chk('easing 全程单调不回头', mono, '');

  // 矩形插值：两条边一起走，所以 x 只减、宽只增，中间不能抖
  chk('进度 0 就是原框', sameRect(zoomAnimRect(from, to, 0), from), JSON.stringify(zoomAnimRect(from, to, 0)));
  chk('进度 1 就是全屏框', sameRect(zoomAnimRect(from, to, 1), to), JSON.stringify(zoomAnimRect(from, to, 1)));

  const path = [];
  for (let i = 0; i <= 20; i++) path.push(zoomAnimRect(from, to, zoomEase(i / 20)));
  chk('左边界单调向右扩展（不来回抖）',
    path.every((r, i) => i === 0 || r.x <= path[i - 1].x), JSON.stringify(path.map((r) => r.x)));
  chk('宽度单调增长（不缩回去）',
    path.every((r, i) => i === 0 || r.w >= path[i - 1].w), JSON.stringify(path.map((r) => r.w)));
  chk('中间态始终夹在起点与终点之间（没越界）',
    path.every((r) => r.x >= to.x && r.x <= from.x && r.w >= from.w && r.w <= to.w
      && r.y >= to.y && r.h >= from.h && r.h <= to.h), '');
  // 这条是关键：真在走就必须出现既不等于起点也不等于终点的框，且数量要够（帧数太少就是假动画）
  const mids = new Set(path.map((r) => `${r.x},${r.y},${r.w},${r.h}`));
  chk('确实走到了中间态（不是一步跳到终点）', mids.size >= 8, `${mids.size} 个不同形状`);
  chk('最小的中间框也够画一圈边框（w,h ≥ 2）', path.every((r) => r.w >= 2 && r.h >= 2), '');
  // 格子必须取整：半个格子会让 box-drawing 的竖线错位
  chk('宽高都是整格（box-drawing 不会画歪）',
    path.every((r) => Number.isInteger(r.x) && Number.isInteger(r.y)
      && Number.isInteger(r.w) && Number.isInteger(r.h)), '');

  // 反向（还原）：起止互换即可
  chk('还原方向：起点是全屏、终点回到原来的分栏',
    sameRect(zoomAnimRect(to, from, 0), to) && sameRect(zoomAnimRect(to, from, 1), from), '');

  // 描边色：两头都留渐变 —— 进位移段时框还是正常线色（上一段刚淡完内容），
  // 出位移段要接回面板自己的线色，任何一头硬切都会看见"啪"地换色
  chk('进位移段：由正常线色升到 accent', zoomBorderMix(0) === 1 && zoomBorderMix(ZOOM_INK_IN) === 0,
    `${zoomBorderMix(0)} / ${zoomBorderMix(ZOOM_INK_IN)}`);
  chk('位移中段保持 accent', zoomBorderMix((ZOOM_INK_IN + ZOOM_INK) / 2) === 0, '');
  chk('出位移段收回正常线色', Math.abs(zoomBorderMix(1) - 1) < 1e-9, zoomBorderMix(1));

  // ── 三段依次：淡出 → 位移 → 淡入（不是一锅端）
  const segs = [];
  for (let i = 0; i <= 100; i++) segs.push(zoomPhase(1, i / 100).seg);
  const order = ['out', 'move', 'in'];
  let seqOk = true, seen = -1;
  for (const s of segs) {
    const k = order.indexOf(s);
    if (k < seen) seqOk = false;          // 回头了 = 段之间有重叠/乱序
    seen = Math.max(seen, k);
  }
  chk('三段严格依次（out→move→in，不回头）', seqOk, '');
  chk('三段都真的排上了（不是某段长度为 0）',
    new Set(segs).size === 3, [...new Set(segs)].join(','));
  chk('进度 0 落在淡出段起点、进度 1 落在淡入段终点',
    zoomPhase(1, 0).seg === 'out' && zoomPhase(1, 0).p === 0
    && zoomPhase(1, 1).seg === 'in' && Math.abs(zoomPhase(1, 1).p - 1) < 1e-9, '');
  chk('两个方向的切段一致（还原只是内容换了顺序，节奏相同）',
    zoomPhase(-1, 0.5).seg === zoomPhase(1, 0.5).seg, '');

  // ── 主角框的内容：先退干净 → 位移时空着 → 到位再浮现
  chk('淡出段内容 1→0', zoomSelfFade('out', 0) === 1 && zoomSelfFade('out', 1) === 0, '');
  chk('位移段一律没有内容（带着妆走）', zoomSelfFade('move', 0) === 0 && zoomSelfFade('move', 1) === 0, '');
  chk('淡入段内容 0→1', zoomSelfFade('in', 0) === 0 && zoomSelfFade('in', 1) === 1, '');
  let smono = true, ps = 2;
  for (let i = 0; i <= 20; i++) { const f = zoomSelfFade('out', i / 20); if (f > ps + 1e-12) smono = false; ps = f; }
  chk('内容淡出单调（不会闪回来）', smono, '');
  chk('淡入用的是 smoothstep（两头都不硬）', zoomSmooth(0.5) === 0.5 && zoomSmooth(0) === 0 && zoomSmooth(1) === 1, '');

  // ── 其它框：错开（这条是"不要同时"的正面证据）
  const N = 4;
  // 某个框"开始动"的时刻（放大=开始变淡，还原=开始变亮）
  const startAt = (dir, seg, idx) => {
    for (let i = 0; i <= 400; i++) {
      const p = i / 400;
      const f = zoomOtherFade(dir, seg, p, idx, N);
      if (dir > 0 ? f < 0.999 : f > 0.001) return p;
    }
    return 1;
  };
  const sOut = [0, 1, 2, 3].map((i) => startAt(1, 'out', i));
  chk('放大：其它框依次开始淡出（不是一起淡）',
    sOut.every((v, i) => i === 0 || v > sOut[i - 1] + 1e-9), sOut.map((v) => v.toFixed(3)).join(' < '));
  const sIn = [0, 1, 2, 3].map((i) => startAt(-1, 'in', i));
  chk('还原：其它框依次开始淡入（不是一起现）',
    sIn.every((v, i) => i === 0 || v < sIn[i - 1] - 1e-9), sIn.map((v) => v.toFixed(3)).join(' > '));
  chk('还原是放大的倒放（最远的先回来，紧贴主角的最后回）',
    sIn[0] > sIn[N - 1], `${sIn[0].toFixed(3)} vs ${sIn[N - 1].toFixed(3)}`);
  // 错开间隔得看得出来：小于 2 帧跟"同时"没区别
  const gapSec = (sOut[1] - sOut[0]) * ZOOM_W.out * ZOOM_DUR;
  chk('相邻两框的错开间隔 ≥ 2 帧（肉眼能分出先后）', gapSec >= 0.033, `${(gapSec * 1000).toFixed(0)}ms`);
  // 同一时刻拿四个框的可见度，必须各不相同（都相等就说明没错开）
  const snap = [0, 1, 2, 3].map((i) => zoomOtherFade(1, 'out', 0.45, i, N));
  chk('同一帧里四个框的可见度互不相同', new Set(snap.map((v) => v.toFixed(4))).size === N,
    snap.map((v) => v.toFixed(2)).join(' / '));
  // 段末要收干净 / 段初都还在，不能有谁被窗口截断
  chk('放大：淡出段末其它框全部退干净',
    [0, 1, 2, 3].every((i) => zoomOtherFade(1, 'out', 1, i, N) === 0), '');
  chk('还原：淡入段末其它框全部回来',
    [0, 1, 2, 3].every((i) => zoomOtherFade(-1, 'in', 1, i, N) === 1), '');
  chk('错开窗口不截断任何一个框（最后一个正好撑到段末）',
    Math.abs(zoomStagger(1, N - 1, N) - 1) < 1e-9 && zoomStagger(0, 0, N) === 0, '');
  // 不在自己那一段时必须彻底缺席
  chk('放大：位移段与淡入段其它框不在场',
    [0, 1, 2, 3].every((i) => zoomOtherFade(1, 'move', 0.5, i, N) === 0
      && zoomOtherFade(1, 'in', 0.5, i, N) === 0), '');
  chk('还原：淡出段与位移段其它框还没回来',
    [0, 1, 2, 3].every((i) => zoomOtherFade(-1, 'out', 0.5, i, N) === 0
      && zoomOtherFade(-1, 'move', 0.5, i, N) === 0), '');
  let fmono = true, pf = 2;
  for (let i = 0; i <= 40; i++) {
    const f = zoomOtherFade(1, 'out', i / 40, 0, N); if (f > pf + 1e-12) fmono = false; pf = f;
  }
  chk('单个框自身的淡出单调递减（不会闪回来）', fmono, '');

  // ── 出场顺序按几何距离：由近及远，这样退场连成一片扩散出去的波
  const rects = {
    shell: { x: 0, y: 20, w: 60, h: 16 },    // 主角
    globe: { x: 0, y: 2, w: 60, h: 16 },     // 正上方，最近
    sys: { x: 0, y: 38, w: 120, h: 8 },
    agent: { x: 62, y: 20, w: 58, h: 16 },   // 右邻
    char: { x: 62, y: 2, w: 58, h: 16 },     // 右上对角，最远
  };
  const seq = zoomOtherOrder('shell', ['globe', 'shell', 'agent', 'char', 'sys'], rects);
  chk('出场顺序由近及远', seq[0] === 'globe' && seq[seq.length - 1] === 'char', seq.join(' → '));
  chk('顺序里不含主角自己', !seq.includes('shell'), seq.join(','));
  chk('顺序覆盖其余所有框', seq.length === 4, seq.length);

  // 时长：三段加起来是"看得清但不碍事"的量级
  chk('过场总时长在 0.5~1.0s（分了三段，短了看不出层次）',
    ZOOM_DUR >= 0.5 && ZOOM_DUR <= 1.0, ZOOM_DUR);
  chk('三段权重加起来为 1',
    Math.abs(ZOOM_W.out + ZOOM_W.move + ZOOM_W.in - 1) < 1e-9, ZOOM_W.out + ZOOM_W.move + ZOOM_W.in);
  chk('位移段最长（它是主角）',
    ZOOM_W.move > ZOOM_W.out && ZOOM_W.move > ZOOM_W.in, JSON.stringify(ZOOM_W));
  chk('单个框自身淡完的时长 ≤ 所在段（否则会被段末截断）',
    ZOOM_OTHER_W <= 1 && ZOOM_OTHER_W > 0.2, ZOOM_OTHER_W);
}

// ── 13. shell 内置命令不得遮蔽原生命令 ──────────────────────────────────
// 面板的非 PTY 模式下，内置命令是**先于后端执行**拦截的（exec 里在 runShell 之前 return）。
// 所以任何跟 PowerShell / CMD 同名的内置命令都会让原生那条永远执行不到——`help` 就是典型：
// PowerShell 里 help 是 Get-Help（查文档），CMD 里是 help.exe，语义跟我们的面板说明完全不同。
// 内置命令一律加 `ponko-` 前缀；`clear`/`cls` 例外——它们与原生 Clear-Host / cls 语义一致（都是清屏）。
{
  const src = readFileSync(new URL('../app/src/panels/shell.js', import.meta.url), 'utf8');

  // 逐行取命令拦截点：形如 if (c === 'xxx')
  const builtins = [...src.matchAll(/if\s*\(\s*c\s*===\s*'([^']+)'/g)].map((m) => m[1]);

  chk('help 不再被内置拦截（否则盖掉 PowerShell Get-Help / CMD help.exe）',
    !builtins.includes('help'), builtins.join(', '));
  chk('改成了 ponko-help', builtins.includes('ponko-help'), builtins.join(', '));

  // 其它内置命令要么带 ponko- 前缀，要么与原生语义一致（clear/cls 都是清屏）。
  // lang 是用户点名要的（`lang <lang_id>` 切语言）：它不是 PowerShell/CMD 的内置命令，
  // 也不是 Windows 上常见的可执行文件（不像 help 那样真有一条原生命令会被盖掉），
  // 而且只截"整条恰好是 lang 或 lang <一个词>"，`lang a b` 照常发给 shell。
  const ALLOW = new Set(['clear', 'cls', 'lang']);
  const bad = builtins.filter((b) => !b.startsWith('ponko-') && !ALLOW.has(b));
  chk('不存在其它会遮蔽原生命令的内置命令', bad.length === 0, bad.join(', ') || '（无）');

  // 用户是看欢迎语才知道有这个命令的，提示里的名字必须跟着改。
  // 界面文案已进语言包（2026-10-13）：源码里只剩 key，所以断言改成"key + 两个包的值"。
  chk('欢迎语走语言包 ui.shell.welcome（源码里不再有成品句子）',
    /pushT\('info',\s*'ui\.shell\.welcome'\)/.test(src), '');
  chk('欢迎语提示的是 ponko-help',
    typeof zhCn['ui.shell.welcome'] === 'string' && zhCn['ui.shell.welcome'].includes('ponko-help')
    && typeof en['ui.shell.welcome'] === 'string' && en['ui.shell.welcome'].includes('ponko-help'),
    zhCn['ui.shell.welcome'] + ' / ' + en['ui.shell.welcome']);
  chk('欢迎语不再指向裸 help', !/输入\s+help\b/.test(zhCn['ui.shell.welcome'] || ''),
    zhCn['ui.shell.welcome']);
}

// ── 14. shell 会话退出 → 关掉该标签 ────────────────────────────────────
// 一个标签 = 一个后端会话。用户在 shell 里 exit，后端收掉会话并回 dead 事件，
// 前端据此关标签；最后一個退完要自动补新的（面板不能空着没法用）。
// 注意与 closeTab 的区别：那是 UI 上"关掉标签"，保护最后一个；这里是"会话结束了"。
{
  const mood = { touch() {}, fromLocal() {}, localSignals: false };
  const p = new ShellPanel(mood);
  const t0 = p.tab;
  chk('初始有一个标签', p.tabs.length === 1 && t0 === p.tab, '');

  // 最后一个标签 exit：关掉后自动补一个新的
  t0.onDead(t0);
  chk('最后一个 exit 后仍有一个可用标签（自动补新的）', p.tabs.length === 1, String(p.tabs.length));
  chk('补的是新标签而不是原来那个', p.tab !== t0, '');

  // 多标签：关掉当前，焦点应回退到前一个
  const t1 = p.tab;
  p.newTab();
  const t2 = p.tab;
  chk('新建后有两个标签且焦点在新标签', p.tabs.length === 2 && p.tab === t2, '');
  t2.onDead(t2);
  chk('非最后一个 exit 后标签数减一', p.tabs.length === 1, String(p.tabs.length));
  chk('焦点回退到剩下的那个', p.tab === t1, '');
  chk('被关的标签已 dispose（流断掉、pty 清空）', t2.pty === null, '');

  // 两种语义不能混：UI 关闭仍然保护最后一个
  chk('closeTab 仍保护最后一个（与 exit 语义不同）',
    p.closeTab() === false && p.tabs.length === 1, '');
}

// ── 15. 多标签对话：一个标签一份对话，彼此不串；标签栏可点；标签名来自第一条提问 ──
console.log('\n── 15. 多标签对话 ──');
{
  const g = mkGrid();
  const a = new AgentPanel({});
  a.layout({ x: 3, y: 4, w: 60, h: 16 });

  chk('默认只有一个对话', a.tabs.length === 1 && a.active === 0, `${a.tabs.length}/${a.active}`);
  chk('对话 id 能直接当存档文件名', /^[A-Za-z0-9_-]{1,40}$/.test(a.tab.id), a.tab.id);
  chk('没说过话的对话标签名是「新对话」', a.tab.title() === '新对话', a.tab.title());

  a.push('user', '帮我看下构建为什么失败');
  chk('说过话之后标签名取第一条提问', a.tab.title() === '帮我看下构建…', a.tab.title());

  const c0 = a.tab;
  a.input = 'aaa'; a.caret = 3;
  const c1 = a.newTab();
  chk('新建后两个对话且焦点切到新的', a.tabs.length === 2 && a.active === 1, `${a.tabs.length}/${a.active}`);
  chk('新对话是空的（没串到旧对话）',
    a.msgs.length === 0 && a.input === '' && a.caret === 0,
    `${a.msgs.length}/${JSON.stringify(a.input)}/${a.caret}`);
  chk('两个对话色标不同', c0.ci !== c1.ci, `${c0.ci}/${c1.ci}`);

  a.input = 'bbb';
  a.selectTab(0);
  chk('切回对话 1 看到它自己的输入与光标', a.input === 'aaa' && a.caret === 3, `${a.input}/${a.caret}`);
  chk('对话 2 的输入没被改掉', a.tabs[1].input === 'bbb', a.tabs[1].input);
  chk('对话 1 的提问还在，对话 2 的一条没有',
    a.msgs.filter((m) => m.role === 'user').length === 1 && a.tabs[1].msgs.length === 0,
    `${a.msgs.length}/${a.tabs[1].msgs.length}`);

  a.selectTab(1);
  a.nextTab(1);
  chk('nextTab(1) 到下个对话', a.active === 0, a.active);
  a.nextTab(-1);
  chk('nextTab(-1) 回上一个', a.active === 1, a.active);

  // 形象（charpack）是**每个对话一份**的：切标签换人，互相不串
  const a6 = new AgentPanel({});
  a6.newTab();                                    // 先建（那会儿包清单还没到）
  a6.getPacks = () => [{ id: 'ponko', name: 'ponko' }, { id: 'kuro', name: 'kuro' }];
  a6.refreshArtOpts();                            // 包加载完，主装配通知一次 → 候选项补齐
  a6.tabs[0].charpack = 'ponko';
  a6.tabs[1].charpack = 'auto';
  chk('形象跟着对话走（各自的 charpack 互不影响）',
    a6.tabs[0].charpack === 'ponko' && a6.tabs[1].charpack === 'auto',
    `${a6.tabs[0].charpack}/${a6.tabs[1].charpack}`);
  a6.selectTab(1);
  chk('artId()：自动但还没挑 → 空（交给主装配回退默认包）', a6.artId() === '', JSON.stringify(a6.artId()));
  a6.tabs[1].charpackPicked = 'kuro';
  chk('artId()：自动 + 已挑 → 用挑出来的那个', a6.artId() === 'kuro', a6.artId());
  a6.selectTab(0);
  chk('artId()：直接选了包 → 就用那个（不受兄弟对话"挑了什么"影响）', a6.artId() === 'ponko', a6.artId());
  const aopts = a6.form.fields.find((x) => x.key === 'charpack').opts.map((o) => o[0]);
  chk('形象候选项 = 自动 + 所有已保存的包',
    JSON.stringify(aopts) === JSON.stringify(['auto', 'ponko', 'kuro']), JSON.stringify(aopts));

  // 标签栏绘制 + 命中区（在 AGENT 框**外**：框顶线上面那一行）
  a.selectTab(0);
  g.rows.clear(); g.sets.length = 0;
  a.draw(g, C);
  a.drawTabBar(g, C);
  const barRow = a.tabBarRow();
  const rowOf = (grid, y) => {
    const r = grid.rows.get(y) || {};
    return Object.keys(r).sort((x, z) => x - z).map((k) => (r[k] === '~' ? '' : r[k])).join('');
  };
  const bar = rowOf(g, barRow);
  chk('标签栏在框顶线之上（框外）', barRow === a.rect.y - 1 && barRow === 3, barRow);
  chk('标签栏不出现数字编号', !/[0-9]/.test(bar), JSON.stringify(bar));
  chk('标签栏有新建按钮 +', bar.includes('+'), JSON.stringify(bar));
  chk('标签栏画出了两个对话的名字（含第一条提问）', bar.includes('帮我看下构建') && bar.includes('新对话'), JSON.stringify(bar));
  chk('tabAt 命中对话 2', a.tabAt(a._tabHits[1].x0, barRow) === 1, JSON.stringify(a._tabHits[1]));
  chk('tabAt 命中“+”返回 -1', a.tabAt(a._tabHits[2].x0, barRow) === -1, JSON.stringify(a._tabHits[2]));
  const barMap = g.rows.get(barRow) || {};
  chk('当前对话实心色块、其它半块',
    barMap[a._tabHits[0].x0] === '█' && barMap[a._tabHits[1].x0] === '▄',
    `${barMap[a._tabHits[0].x0]}/${barMap[a._tabHits[1].x0]}`);
  const k0 = g.fgAt(a._tabHits[0].x0, barRow), k1 = g.fgAt(a._tabHits[1].x0, barRow);
  chk('两个对话的色标不是一个颜色',
    Number.isFinite(k0) && Number.isFinite(k1) && k0 !== k1, `${k0}/${k1}`);

  // 框顶线右端：一小排对话色块（要往左让出右上角那截状态字，并跟它空开一列以上）
  const topTxt = rowOf(g, a.rect.y);
  const hdrW = g.strWidth(a._hdr);
  const need = 2 * 2 - 1;
  const mx = a._marksX0;
  chk('顶线右端是色标而不是数字', !/[0-9]/.test(topTxt), JSON.stringify(topTxt));
  chk('顶线色标个数 = 对话个数', (topTxt.match(/[█▄]/g) || []).length === 2, JSON.stringify(topTxt));
  const topRow = g.rows.get(a.rect.y) || {};
  chk('顶线色块顺序 = 对话顺序，当前那个实心',
    topRow[mx] === '█' && topRow[mx + 2] === '▄', `${topRow[mx]}/${topRow[mx + 2]}`);
  chk('顶线色块用的是各自对话的颜色',
    g.fgAt(mx, a.rect.y) === k0 && g.fgAt(mx + 2, a.rect.y) === k1,
    `${g.fgAt(mx, a.rect.y)}/${g.fgAt(mx + 2, a.rect.y)}`);
  const hdrStart = a.rect.x + a.rect.w - 2 - hdrW;      // box() 里 right 就画在这一列
  chk('顶线色标与右上角状态字之间空开 2 列（贴着会看成一坨）',
    hdrStart - (mx + need) === 2, `gap=${hdrStart - (mx + need)}`);
  chk('顶线色标也没压到标题 AGENT',
    mx > a.rect.x + 2 + g.strWidth('AGENT'), `${mx} vs ${a.rect.x + 2 + g.strWidth('AGENT')}`);

  // 颜色跟着对话走，不跟着位置走
  const a4 = new AgentPanel({});
  const tA = a4.tabs[0];
  const tB = a4.newTab(), tC = a4.newTab();
  chk('三个对话颜色互不相同', new Set([tA.ci, tB.ci, tC.ci]).size === 3, `${tA.ci}/${tB.ci}/${tC.ci}`);
  a4.closeTab(a4.tabs.indexOf(tB));
  chk('关掉中间那个，剩下的颜色不变（不看位置）',
    a4.tabs.map((t) => t.ci).join(',') === [tA.ci, tC.ci].join(','),
    a4.tabs.map((t) => t.ci).join(','));
  const tD = a4.newTab();
  chk('新对话不套用刚释放的颜色（免得看成那个对话回来了）', tD.ci !== tB.ci, `${tD.ci} vs ${tB.ci}`);

  // 关闭：最后一个不给关（丢的是整个对话，所以前端还要先弹一行确认才走到这儿）
  const a5 = new AgentPanel({});
  chk('只剩一个对话时拒绝关闭', a5.closeTab() === false && a5.tabs.length === 1, '');
  a5.newTab();
  chk('两个时可以关，关完剩一个', a5.closeTab() === true && a5.tabs.length === 1, '');

  // 上限 = 色板容量，超了要明确拒绝
  const a7 = new AgentPanel({});
  for (let i = 0; i < 12; i++) a7.newTab();
  chk('对话数有上限（色板给每个对话一个独有色）',
    a7.tabs.length === 8 && a7.newTab() === null, String(a7.tabs.length));
  chk('上限内颜色不重复', new Set(a7.tabs.map((t) => t.ci)).size === a7.tabs.length,
    a7.tabs.map((t) => t.ci).join(','));

  // ── 配置框是**挂在对话身上**的：切走是"看不见"，不是"丢弃" ──────────────
  // （2026-10-14 用户报的两轮：① 点 + 之后不填、直接切到别对话，人还被困在配置界面里；
  //   ② 改成"切走就删标签"之后用户又指出：不该删，应该还留在配置中。）
  //   所以定下来的形状是：panel.form 由 tab.cfg 派生，切走只换引用，不动数据。
  const a8 = new AgentPanel({});
  a8.tabs[0].llm = { ...FAKE_LLM };                 // 先让第一个对话有份配置可以继承
  a8.configClose();                                 // 配好就收起（configSave 验证通过后也是这么收的）
  const n0 = a8.tabs.length;
  a8.newTab(true);
  const pending = a8.tab;
  chk('点「+」建好就弹配置框', a8.inConfig && a8._cfgNew, `${a8.inConfig}/${a8._cfgNew}`);
  chk('表单里预填着"按 + 时所在的那个对话"那份配置',
    (a8.form.fields.find((f) => f.key === 'model') || {}).value === 'm', '');
  chk('没保存之前新对话不算配好（种子不会先落到它身上）', a8.tab.llm === null, String(a8.tab.llm));
  // 先改一个字段，待会儿靠它认"是不是原来那份表单"
  a8.form.fields.find((f) => f.key === 'model').value = 'my-model';
  a8.form.idx = 2;

  a8.selectTab(0);                                  // 不配，直接点回第一个对话
  chk('切走后落在这个对话上，且**不再**是配置界面', a8.tab === a8.tabs[0] && !a8.inConfig,
    `${a8.active}/${a8.inConfig}`);
  chk('那个对话还在（切走不等于丢弃）', a8.tabs.includes(pending) && a8.tabs.length === n0 + 1,
    String(a8.tabs.length));
  chk('表单跟着对话留着（切走时什么都不擦）',
    pending.cfg && pending.cfg.fields.find((f) => f.key === 'model').value === 'my-model', '');
  a8.selectTab(a8.tabs.indexOf(pending));           // 切回来
  chk('切回来还在配置中（不是回到空输入框）', a8.inConfig === true, String(a8.inConfig));
  chk('切回来填的东西还在',
    a8.form.fields.find((f) => f.key === 'model').value === 'my-model', '');
  chk('连焦点停在第几行都还是原来那样', a8.form.idx === 2, String(a8.form.idx));
  chk('新建标记也还在（这时取消仍然 = 撤销新建）', a8._cfgNew === true, String(a8._cfgNew));

  // ^Tab（nextTab）那条路一样
  a8.nextTab(1);
  chk('^Tab 切走同样是"看不见"而不是删除', !a8.inConfig && a8.tabs.includes(pending), String(a8.inConfig));
  a8.nextTab(1);
  chk('^Tab 切回来也还在配置中', a8.inConfig && a8.tab === pending, String(a8.inConfig));

  // 两个对话同时处在"配置中"：各读各的，互不覆盖
  // 内部新建（/del chat 之后补的那种）：同样没配 LLM → 一样停在配置界面
  const other = a8.newTab(false);
  chk('内部新建的对话也没配 → 同样停在配置界面', a8.inConfig && other.cfg !== null, String(a8.inConfig));
  chk('它是"自己摊开的"那份（不是人手点出来的新建态）',
    other.cfg.auto === true && other.cfg.isNew === false, `${other.cfg.auto}/${other.cfg.isNew}`);
  a8.configOpen();                                  // 编辑当前这个已有对话 → 自己的表单
  a8.form.fields.find((f) => f.key === 'model').value = 'second';
  a8.selectTab(a8.tabs.indexOf(pending));
  chk('切到另一个"配置中"的对话：看到的是它自己那份表单',
    a8.form.fields.find((f) => f.key === 'model').value === 'my-model', '');
  a8.selectTab(a8.tabs.indexOf(other));
  chk('切回去看到的是另一个那份（两边各存各的）',
    a8.form.fields.find((f) => f.key === 'model').value === 'second', '');
  chk('同时两个对话都在配置中也不冲突', !!(pending.cfg && other.cfg), '');

  // 取消：只有它自己被收起，别的那份不动
  a8.selectTab(a8.tabs.indexOf(pending));
  a8.configCancel();
  chk('取消一个：只有它被撤销', !a8.tabs.includes(pending) && a8.tabs.includes(other), '');
  chk('别的那个仍在配置中（表单没跟着一起没）', other.cfg !== null, String(other.cfg));

  // ── 未配置的对话一律停在配置界面（含冷启动那个）────────────────────────
  // （2026-10-14 用户报：只有一个未配置的标签页，关掉 HUD 再开，看到的却是对话界面。
  //   未配置的对话早就被卡住 —— 一句话发出去也会被弹回配置框（见 AgentConv.send）,
  //   所以摆一个能打字的空聊天框是在骗人；让它停在配置界面才是真的形状。
  //   注意"重启"这件事本身不会留下什么：没说过话又没配置过的对话根本不落盘，
  //   下次起来的是一个全新的空对话 —— 靠这条规则它仍然落在配置界面上。）
  const a9 = new AgentPanel({});
  chk('冷启动：那个对话没配 LLM → 面板就是配置界面', a9.inConfig === true, String(a9.inConfig));
  chk('这份表单是"自己摊开"的，不是人手点 + 建出来的',
    a9.form.auto === true && a9.form.isNew === false, `${a9.form.auto}/${a9.form.isNew}`);
  // 循环字段（协议 / 形象 / 性格）本来就有值，判"空白"时按各自的默认档算，
  // 别的一律要求空串 —— 这样"偷偷继承了别人的性格"也会被抓到。
  const CYCLE_DEFAULT_9 = { provider: 'auto', charpack: 'auto', persona: 'default' };
  chk('起手那份是空表单（当前这个对话没配过，就没得继承）',
    a9.form.fields.every((f) => (f.key in CYCLE_DEFAULT_9)
      ? f.value === CYCLE_DEFAULT_9[f.key] : f.value === ''),
    JSON.stringify(a9.form.fields.map((f) => f.value)));
  chk('冷启动不会偷偷替它配好（种子不落到 tab.llm 上）', a9.tab.llm === null, String(a9.tab.llm));

  const only = a9.tab;
  a9.configCancel();
  chk('只剩它一个时取消 = 收起表单（面板没有"零个对话"状态）',
    a9.tabs.length === 1 && a9.tab === only && only.cfg === null, String(a9.tabs.length));
  chk('收起时留一句说明：它还不能用、怎么回来',
    only.msgs.some((m) => m.k === 'ui.agent.form.hintSkip'), JSON.stringify(only.msgs.map((m) => m.k)));
  chk('这句说明不会把空对话写进存档（里面没有用户消息）',
    only.msgs.some((m) => m.role === 'user') === false, '');
  chk('收起后它仍然是发不出消息的（普通文本被弹回配置框）',
    (a9.send('你好'), a9.inConfig === true && a9.msgs.some((m) => m.role === 'user') === false), '');

  a9.configClose();
  a9.send('/llm');
  chk('/llm 能把配置框叫回来', a9.inConfig === true && a9.form.idx === 0, String(a9.form.idx));
  a9.form.fields.find((f) => f.key === 'model').value = 'half-typed';
  a9.configClose(); a9.send('/llm');
  chk('收起 = 明确"这次不用了"，所以叫回来的是一份新表单（区分于切走那种"还在配"）',
    a9.form.fields.find((f) => f.key === 'model').value === '',
    JSON.stringify(a9.form.fields.find((f) => f.key === 'model').value));
  chk('/llm 不是新建态（取消不会把它删掉）', a9.form.isNew === false, String(a9.form.isNew));
}

// ── 16. 对话存档不能被推上 GitHub ────────────────────────────────────────
// 对话内容写在 run/conversations/ 下；推送脚本与 git 都按 .gitignore 排除 run/。
// 这条是"防呆"回归：哪天有人顺手把 run/ 从 .gitignore 里删了，对话就会跟着进仓库。
console.log('\n── 16. 对话存档不进仓库 ──');
{
  const gi = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  chk('.gitignore 排除了 run/（对话存档就在那儿）', /^\s*run\/?\s*$/m.test(gi), gi.split('\n').filter((l) => l.includes('run')).join('|'));
  const src = readFileSync(new URL('../server/server.js', import.meta.url), 'utf8');
  chk('服务端把存档写在 run/conversations/ 下',
    /path\.join\(ROOT,\s*'run',\s*'conversations'\)/.test(src),
    (src.match(/CONV_DIR\s*=.*/) || [''])[0]);
}

// ── 17. /del chat：在对话输入框里打命令删当前对话（不靠快捷键）──────────────────
// 打字表达的是"想删哪一个"，**不是**"现在立刻删"：命中之后面板只把请求交出去（onDelAsk），
// 由 main.js 弹那道红条，在红条上回车才真删（ESC / 开始打别的字 / 6 秒过期都作废）。
// 所以这里分两段测：① 命令只请求、不碰存档；② 确认之后的执行器 delChat 才真关。
// 严进：只认整条输入恰好是 /del chat，别的 /xxx 一律当正文交给模型。
console.log('\n── 17. /del chat 关对话（打字 → 确认 → 回车）──');
{
  // ① 命令本身只"请求确认"：一条都不许删
  const a = new AgentPanel({});
  a.newTab();
  a.tabs[0].msgs = [{ role: 'user', text: '旧对话' }];
  a.selectTab(1);
  const idsBefore = a.tabs.map((t) => t.id).join();
  let asked = 0, closed = 0;
  a.onDelAsk = () => { asked++; };
  a.onConvClosed = () => { closed++; };

  chk('send 认出 /del chat 并返回"已处理"', a.send('/del chat') === true, '');
  chk('只是请求确认：标签一个都没少', a.tabs.map((t) => t.id).join() === idsBefore, a.tabs.map((t) => t.id).join());
  chk('请求确实交出去了（onDelAsk 被调一次）', asked === 1, String(asked));
  chk('没确认之前绝不删存档（onConvClosed 没被叫）', closed === 0, String(closed));
  chk('面板自己不再直接删（delChat 是确认后的执行器，独立存在）', typeof a.delChat === 'function', '');
  // 命令本身绝不进对话流（既不显示、也不进下一轮的上下文）
  chk('命令没被当成用户消息塞进对话',
    a.tabs.every((t) => !t.msgs.some((m) => String(m.text).includes('/del chat'))),
    JSON.stringify(a.msgs));

  // ② 没有装配钩子（理论上不会）时什么都不做 —— 删存档不能有"静默兜底"
  const bare = new AgentPanel({});
  bare.newTab();
  const bareIds = bare.tabs.map((t) => t.id).join();
  chk('没有确认钩子时命令被吃掉但什么也不做（宁可没反应，也不能不确认就删）',
    bare.send('/del chat') === true && bare.tabs.map((t) => t.id).join() === bareIds, bareIds);

  // ③ 确认之后的执行器：关掉一个 —— 标签没了、切到剩下的那个、给主装配回执、旧对话被 dispose
  const b = new AgentPanel({});
  b.newTab();
  b.tabs[0].msgs = [{ role: 'user', text: '旧对话' }];
  b.selectTab(1);
  const dying = b.tab;
  dying.busy = true;
  let cancelled = 0;
  dying._cancel = () => { cancelled++; };
  b._dirty.add(dying);
  const callbacks = [];
  b.onConvClosed = (label, kind) => callbacks.push([label, kind]);

  chk('确认后执行 delChat 才真关', b.delChat() === true, '');
  chk('标签从 2 个变成 1 个', b.tabs.length === 1, String(b.tabs.length));
  chk('关掉的是正在说话的那个', b.tabs[0].id !== dying.id, `${b.tabs[0].id} vs ${dying.id}`);
  chk('关掉的对话中止了在飞的请求', cancelled === 1 && dying.busy === false, `${cancelled}/${dying.busy}`);
  chk('关掉的对话被 dispose（钩子摘掉，不会再往上写）',
    dying.onDirty === null && dying.onToken === null, `${dying.onDirty}/${dying.onToken}`);
  chk('关掉的对话不会再被落盘（脏集合里已摘掉）', b._dirty.has(dying) === false, String(b._dirty.size));
  chk('回执：closed + 关之前那个标题', callbacks.length === 1 && callbacks[0][1] === 'closed',
    JSON.stringify(callbacks));

  // ④ 没接 LLM 也认得：这条命令跟模型无关，不该被"先弹配置框"挡住
  const n = new AgentPanel({});
  n.newTab();
  let askedOk = 0;
  n.onDelAsk = () => { askedOk++; };
  n.send('/del chat');
  chk('没接 LLM 也认这条命令（不会被拦截）', askedOk === 1, String(askedOk));

  // ⑤ 严进：不认识的 /xxx、带别的话、正文里的斜杠，一律当普通正文，也绝不请求确认
  const d = new AgentPanel({});
  d.newTab();
  const before = d.tabs.length;
  let askedBad = 0;
  d.onDelAsk = () => { askedBad++; };
  for (const s of ['/foo', '/del', '/del chat 吧', '/delchat', '删掉 /del chat', '帮我看下构建为什么失败',
    'del chat', '/', '  ', '', '/del\tchat  extra']) {
    chk(`「${s}」不当命令`, d.command(s) === false, String(d.command(s)));
  }
  chk('这些都没动标签、也没请求过确认', d.tabs.length === before && askedBad === 0,
    `${before} → ${d.tabs.length}, asked=${askedBad}`);
  chk('/del chat 前后的空白无所谓', d.command('  /del chat\n') === true && askedBad === 1,
    `asked=${askedBad}`);
  chk('大小写不敏感', d.command('/DEL CHAT') === true && askedBad === 2, `asked=${askedBad}`);

  // ⑥ 普通文本要走原路（不能被吞掉）：没接 LLM 时应当弹出配置框
  const e = new AgentPanel({});
  e.send('你好');
  chk('普通文本照旧交给对话（未接 LLM → 弹配置框）',
    e.inConfig === true && e.msgs.some((m) => m.role === 'user') === false,
    `${e.inConfig}/${JSON.stringify(e.msgs.map((m) => m.role))}`);

  // ⑦ 没接 LLM 时面板一开就被配置表单盖住，键盘其实落在表单字段上 ——
  // 那条路也得认这条命令，否则"打 /del chat 就能删"在没配 LLM 的状态下就不成立
  const f = new AgentPanel({});
  f.newTab();
  f.configOpen();                                          // 模拟启动时自动弹出的配置框
  f.form.fields[0].value = '/del chat';
  f.form.caret = 9;
  const fIdBefore = f.tab.id;
  const fCountBefore = f.tabs.length;
  let askedForm = 0;
  f.onDelAsk = () => { askedForm++; };
  f.configEnter();
  chk('配置表单字段里打 /del chat 也认（同样只是请求确认）',
    askedForm === 1 && f.tabs.length === fCountBefore && f.tab.id === fIdBefore,
    `${askedForm}/${fCountBefore}→${f.tabs.length}/${f.tab.id} vs ${fIdBefore}`);
  chk('字段里那行命令被擦掉（那是 API 地址的位置）', f.form.fields[0].value === '',
    JSON.stringify(f.form.fields[0].value));
  chk('表单没有因为这条命令跳到别的字段', f.form.idx === 0, String(f.form.idx));
  f.form.fields[0].value = 'https://api.openai.com/v1';
  f.configEnter();
  chk('不是命令时表单照常跳到下一个字段', f.form.idx === 1, String(f.form.idx));

  // ⑧ 只剩一个对话：确认后是"清空并换成新的空对话"（也是毁数据，红条会照实说）
  const c = new AgentPanel({});
  const oldId = c.tab.id;
  c.push('user', '要清掉的那段');
  let cbs = [];
  c.onConvClosed = (label, kind) => cbs.push([label, kind]);
  chk('只剩一个时执行 delChat 仍返回 true（换新而不是拒绝）', c.delChat() === true, '');
  chk('仍是 1 个对话（面板没有"零个对话"状态）', c.tabs.length === 1, String(c.tabs.length));
  chk('换成了新的对话（旧的连存档一起没了）', c.tab.id !== oldId, `${c.tab.id} vs ${oldId}`);
  chk('旧对话的内容不会跟过来',
    !c.msgs.some((m) => String(m.text).includes('要清掉的那段')), JSON.stringify(c.msgs));
  chk('换掉时回执说的是 replaced', cbs.length === 1 && cbs[0][1] === 'replaced', JSON.stringify(cbs));
  chk('留下一条说明（顺带告诉用户这条命令存在）',
    c.msgs.some((m) => String(m.text).includes('/del chat')), JSON.stringify(c.msgs.map((m) => m.role)));
  chk('说明里说了"回车确认后才删"（别让人以为打完就删）',
    c.msgs.some((m) => String(m.text).includes('回车确认')), JSON.stringify(c.msgs.map((m) => m.text)));
  chk('空的说明对话不会被落盘（没有用户消息）',
    c.msgs.some((m) => m.role === 'user') === false, JSON.stringify(c.msgs.map((m) => m.role)));

  // ⑨ 主装配守卫：打字入口必须在 main.js 合流到那道确认
  const mjs = readFileSync(new URL('../app/src/main.js', import.meta.url), 'utf8');
  chk('main.js 把 onDelAsk 接到红条上（打字入口只是"请求"）',
    /panels\.agent\.onDelAsk\s*=\s*\(\)\s*=>\s*armConvClose\(\)/.test(mjs), '');
  chk('^⇧W 已删干净（键位分派里没有 W 分支、也没有 armConvClose(\'key\') 这种老路径）',
    !/k === 'W'/.test(mjs) && !/armConvClose\('key'\)/.test(mjs), '');
  chk('红条上回车才是执行点，且走的是 delChat（不是 closeTab 的老路）',
    /function confirmConvClose\(\)[\s\S]{0,400}?a\.delChat\(\)/.test(mjs), '');
  chk('只剩最后一个时红条换文案（说清会换成新的空对话）',
    /convClose\.last[\s\S]{0,160}?'ui\.convdel\.last'[\s\S]{0,80}?'ui\.convdel\.one'/.test(mjs)
    && /清空对话/.test(zhCn['ui.convdel.last'] || '') && /删除对话/.test(zhCn['ui.convdel.one'] || ''),
    zhCn['ui.convdel.last']);
  chk('开始打别的字会作废确认（打了半句再发送不会把对话删掉）',
    /hidden\.addEventListener\('input'[\s\S]{0,600}?convClose = null/.test(mjs), '');
  chk('main.js 注入了 onConvClosed', /panels\.agent\.onConvClosed\s*=\s*afterConvClosed/.test(mjs), '');
  chk('onConvClosed 里会作废确认条并把隐藏输入框接到当前对话',
    /function afterConvClosed[\s\S]{0,400}?convClose = null;[\s\S]{0,400}?syncHidden\(\);/.test(mjs), '');

  // ⑩ 左下角那条提示**只报看不见的东西** —— 界面自己已经在说的事不许再打一行字。
  // 这条约定是用户明确定的（"不需要在左下角弹状态变化的信息"），锁在这儿防止以后被加回来。
  const fnBody = (name) => {
    const i = mjs.indexOf(`function ${name}(`);
    if (i < 0) return '';
    let d = 0;
    for (let k = mjs.indexOf('{', i); k < mjs.length; k++) {
      if (mjs[k] === '{') d++;
      else if (mjs[k] === '}' && --d === 0) return mjs.slice(i, k + 1);
    }
    return '';
  };
  chk('删完对话不弹"已删除"（标签栏少一个就是回执）',
    fnBody('afterConvClosed') !== '' && !/selToast/.test(fnBody('afterConvClosed')), fnBody('afterConvClosed'));
  chk('放大/还原不弹"已放大/已还原"（框撑满、按钮变 〼 就是回执）',
    fnBody('toggleZoom') !== '' && !/selToast/.test(fnBody('toggleZoom')), fnBody('toggleZoom').slice(0, 120));
  chk('切标签不播报"终端 · xxx · 共 N 个"（标签栏自己亮了）',
    fnBody('afterTabChange') !== '' && !/selToast/.test(fnBody('afterTabChange'))
      && fnBody('afterConvChange') !== '' && !/selToast/.test(fnBody('afterConvChange')), '');
  chk('取消删除不弹"已取消删除"（红条消失就是回执）', !/已取消删除/.test(mjs), '');
  // 反过来：按了却没发生的、屏幕外发生的操作结果、要你再动一下的，这些**必须**还在
  chk('按了但没发生的仍说明原因（最后一个对话不能关）',
    /toast\('ui\.toast\.lastConv'/.test(mjs) && !!zhCn['ui.toast.lastConv'], '');
  chk('到上限仍说明原因（对话数/标签数已达上限）',
    /toast\('ui\.toast\.maxConv'/.test(mjs) && /toast\('ui\.toast\.maxTab'/.test(mjs)
    && !!zhCn['ui.toast.maxConv'] && !!zhCn['ui.toast.maxTab'], '');
  chk('屏幕外的操作结果仍提示（已复制 N 字符）',
    /toast\('ui\.toast\.copied',\s*\{\s*n:/.test(mjs) && /\{n\}/.test(zhCn['ui.toast.copied'] || ''),
    zhCn['ui.toast.copied']);
  chk('要你再动一下的仍提示（退出两步确认）',
    /toast\('ui\.toast\.exitArm'/.test(mjs) && /再点一次/.test(zhCn['ui.toast.exitArm'] || ''), '');
}

// ── 18. 框顶右上角：显示真在用的模型 id（不再写死 "llm"），且与左边的色标空开 ────
console.log('\n── 18. 右上角状态 = 连接的模型 id ──');
{
  const g = mkGrid();
  const a = new AgentPanel({});
  a.layout({ x: 3, y: 4, w: 34, h: 13 });        // 分栏态 AGENT 的真实宽度
  a.newTab();                                    // 两个对话 → 色标占 3 列

  a.draw(g, C);
  chk('没接 LLM 时说「未接LLM」', a._hdr === '未接LLM', JSON.stringify(a._hdr));

  // 每个对话一份配置：装进去之后，右上角显示的就是这份里的模型 id
  a.tab.llm = { ...FAKE_LLM, model: 'gpt-4o-mini' };
  a.draw(g, C);
  chk('接上之后右上角就是模型 id', a._hdr === 'gpt-4o-mini', JSON.stringify(a._hdr));
  chk('不再是写死的 llm / streaming', !/^(llm|streaming)$/.test(a._hdr), JSON.stringify(a._hdr));

  // 流式输出中：底部状态行本来就在报「流式输出中 · N tok/s」，右上角那点地方留给"在跟谁说话"
  a.tab.busy = true;
  a.draw(g, C);
  chk('流式输出中显示的仍是模型 id', a._hdr === 'gpt-4o-mini', JSON.stringify(a._hdr));
  a.tab.busy = false;

  // 窄框 + 长模型名 → 截断，但要认得出、也不能把色标挤没
  a.tab.llm.model = 'claude-3-5-sonnet-20241022';   // llmModel 是 getter，改配置里的 model
  a.draw(g, C);
  chk('放不下就截断并以 … 结尾', a._hdr.endsWith('…') && a._hdr !== '…' && g.strWidth(a._hdr) <= 34 - 10 - 3 - 2,
    `${JSON.stringify(a._hdr)} w=${g.strWidth(a._hdr)}`);
  chk('截断了也还认得出是哪个模型', a._hdr.startsWith('claude'), JSON.stringify(a._hdr));
  chk('截断不会把色标挤没', a._marksX0 !== null, String(a._marksX0));

  // 放大态（整个内容区）不该截断
  a.layout({ x: 0, y: 2, w: 150, h: 30 });
  a.draw(g, C);
  chk('放大态完整显示模型 id（不截断）', a._hdr === 'claude-3-5-sonnet-20241022', JSON.stringify(a._hdr));

  // 对话拉满（色标占 15 列）时：状态字被压到最短，但色标仍画得出来
  a.layout({ x: 3, y: 4, w: 34, h: 13 });
  while (a.tabs.length < 8) a.newTab();
  a.draw(g, C);
  chk('对话拉满时状态字仍不小于 6 列', g.strWidth(a._hdr) >= 6, `${JSON.stringify(a._hdr)} w=${g.strWidth(a._hdr)}`);
  chk('对话拉满时色标照样画得出来（不会为了让字而消失）', a._marksX0 !== null, String(a._marksX0));

  // 几何：色标与状态字之间必须空开 2 列，且色标不能压到标题 AGENT
  a.layout({ x: 3, y: 4, w: 60, h: 16 });
  // 上一步新建了一堆标签，当前这个没有配置 → 整个装一份（不能再只改 model 字段）
  a.tab.llm = { ...FAKE_LLM, model: 'gpt-4o-mini' };
  a.draw(g, C);
  const need = a.tabs.length * 2 - 1;
  const hdrStart = a.rect.x + a.rect.w - 2 - g.strWidth(a._hdr);
  chk('色标与右上角状态字之间空开 2 列（贴着会看成一坨）',
    hdrStart - (a._marksX0 + need) === 2, `gap=${hdrStart - (a._marksX0 + need)}`);
  chk('色标也没压到标题 AGENT',
    a._marksX0 > a.rect.x + 2 + g.strWidth('AGENT'), `${a._marksX0} vs ${a.rect.x + 2 + g.strWidth('AGENT')}`);

  // 源码守卫：模型 id 必须是**读回来的**，不是写死的
  const src = readFileSync(new URL('../app/src/panels/agent.js', import.meta.url), 'utf8');
  // 配置是**每个对话一份**的：模型 id 得从当前对话那份里现取，不再是面板级的一个字段
  chk('模型 id 从当前对话的配置里现取（getter，不是面板级字段）',
    /get llmModel\(\)[\s\S]{0,160}?this\.tab\.llm[\s\S]{0,80}?\.model/.test(src), '');
  chk('对话恢复时把各自的配置带回来（每个对话一份）',
    /if \(c\.llm\)\s*\{\s*t\.llm\s*=\s*\{\s*\.\.\.c\.llm\s*\}/.test(src), '');
  chk('新建对话拿"按 + 那一刻正看着的那个对话"预填表单',
    /newTab\(fromUser\)[\s\S]{0,900}?configOpen\(\{\s*isNew:\s*true,\s*seed/.test(src), '');
  chk('预填来源只有这一条：_llmOfTab(当前对话)，没有"最近配好的那份"当兜底',
    /const src = this\.tab;[\s\S]{0,200}?const seed = this\._llmOfTab\(src\)/.test(src) && !/_lastLlm/.test(src), '');
  chk('预填只是**拷一份**（改新对话不该动到老对话那份）',
    /return \(tab && tab\.llm\) \? \{ \.\.\.tab\.llm \} : null;/.test(src), '');
  chk('种子不落进新对话（没保存就不算配好，也就不会被写盘）',
    !/fromUser && seed\)\s*t\.llm\s*=/.test(src), '');
  chk('新建流程点取消 = 删掉刚建的那个标签',
    /configCancel\(\)[\s\S]{0,600}?closeTab\(this\.tabs\.indexOf\(victim\)\)/.test(src), '');
  chk('配置表单挂在**对话**上（tab.cfg），不再是一整个面板共一份',
    /get form\(\)\s*\{\s*return \(this\.tab && this\.tab\.cfg\) \|\| null;/.test(src)
    && /this\.cfg = null;/.test(src), '');
  chk('inConfig 由"当前对话有没有摊开的表单"派生（不允许再有人直接赋值）',
    /get inConfig\(\)\s*\{\s*return !!this\.form;/.test(src)
    && !/this\.inConfig\s*=/.test(src), '');
  chk('切标签不许再动表单：selectTab / nextTab 里没有清 cfg 的动作',
    !/selectTab\(i\)[\s\S]{0,400}?tab\.cfg\s*=/.test(src)
    && !/nextTab\(dir\)[\s\S]{0,400}?tab\.cfg\s*=/.test(src), '');
  chk('撤销新建只剩一个入口：configCancel（它对别的对话那份表单没有副作用）',
    /configCancel\(\)[\s\S]{0,500}?this\.closeTab\(this\.tabs\.indexOf\(victim\)\)/.test(src), '');
  chk('没配 LLM 的对话都会停在配置界面：内部新建 / 恢复存档两条路都走同一个入口',
    /else this\._openFormIfUnset\(t,/.test(src)
    && /this\._openFormIfUnset\(t, prevLlm/.test(src), '');
  chk('取消不再把人困住（旧的"未配置不许取消"已经没了）',
    !/cantCancel/.test(src) && !/form\.cantCancel/.test(src), '');
  // /llm 这个命令名里的 'llm' 不是状态字 —— 挖掉它再扫，别让守卫空转也不要误伤
  const hd = src.replace(/name === 'llm'[^\n]*/g, '');
  chk('源码里不再有写死的 llm / streaming 状态字',
    !/'llm'/.test(hd) && !/busy \? 'streaming'/.test(hd), '');
  chk('间隔是常量而不是魔法数（改布局能一处改掉）', /const HDR_GAP\s*=\s*2/.test(src), '');

  // ── 标签数必须在"关掉 HUD 再开"之后对得上（2026-10-14 用户报）──────────
  chk('用户点「+」建的标签会记账（keepOpen）+ 立刻排落盘',
    /if \(fromUser\) \{ t\.keepOpen = true; this\._markDirty\(t\); \}/.test(src), '');
  chk('落盘时把 keep 一起报给后端（否则后端会把"空对话"直接丢掉）',
    /saveConv\(\{[^}]*keep: !!conv\.keepOpen[^}]*\}\)/.test(src), '');
  chk('恢复存档时空格对话也收（不再要求 msgs.length > 0）',
    /if \(c && Array\.isArray\(c\.msgs\)\) loaded\.push\(c\)/.test(src)
    && !/Array\.isArray\(c\.msgs\) && c\.msgs\.length/.test(src), '');
  chk('一个存档都没恢复出来时，起手那个标签也要记进存档（_keepBootTab）',
    /_keepBootTab\(\)\s*\{[\s\S]{0,420}?t\.keepOpen = true;[\s\S]{0,120}?this\._markDirty\(t\)/.test(src), '');
  chk('恢复出来的对话也标成 keep（以后落盘不会因为"空"被丢掉）',
    /t\.keepOpen = true;\s*\/\/[^\n]*\n/.test(src), '');
  chk('存档标题不存界面文案：saveTitle() 给空串，title() 才补「新对话」',
    /saveConv\(\{[^}]*title: conv\.saveTitle\(\)/.test(src)
    && /title\(\) \{ return this\.saveTitle\(\) \|\| t\('ui\.agent\.newConv'\); \}/.test(src), '');
}

console.log('\n── 19. SHELL 的 lang 命令（看 / 换语言）──');
{
  const shellSrc = readFileSync(new URL('../app/src/panels/shell.js', import.meta.url), 'utf8');
  // 截获条件必须是"整条恰好是 lang 或 lang <一个词>"：`lang a b` 得照常发给 shell，
  // 不能顺手把用户打的东西吞掉（和 /del chat 只认整条命中是同一条规矩）。
  const m = shellSrc.match(/c === 'lang' \|\| (\/\^lang\[[^\n]*?\$\/)\.test\(c\)/);
  chk('exec 里有 lang 的截获点（裸 `lang` 走等值判断、`lang <id>` 走这条正则）', !!m, '');
  if (m) {
    const re = new RegExp(m[1].slice(1, -1));
    chk('lang <id> 命中', re.test('lang en'), '');
    chk('lang a b 不命中（照常发给 shell，不吞用户打的东西）', !re.test('lang a b'), '');
    chk('language 不命中（不是前缀匹配）', !re.test('language'), '');
  }

  const s = new ShellPanel({});
  const out = () => s.lines.map((l) => l.text).join('\n');
  s.lines.length = 0;
  await s.exec('lang');
  const menu = s.lines.map((l) => l.text);
  chk('lang 报出当前 lang_id', /当前\s*lang_id\s*zh-cn/.test(out()), out());
  chk('lang 报出用法', /用法\s*lang <lang_id>/.test(out()), out());
  chk('可切换的 lang_id 逐行列出（一个 id 独占一行，清单来自 i18n、没有第二张表）',
    availableLangs().map((l) => l.id).every((id) => menu.includes(id)), JSON.stringify(menu));
  // 用户 2026-10-13：只列 id，不要"id=某种语言"的解释
  chk('只列 id，不解释 id 是哪种语言（不出现语言自称）',
    !/简体中文|English|日本語/.test(out()), out());

  s.lines.length = 0;
  await s.exec('lang en');
  chk('lang en 真切过去了', langOf() === 'en', langOf());
  // 回执是在**切换之后**渲染的，所以它用的是新语言（en）—— 这正是"界面文案现取现翻"的证据
  chk('切完有回执（切到哪 + 偏好已记住）',
    out().includes('en') && /switched|已切到/.test(out()) && /remembered|记住/.test(out()), out());

  // 大小写不敏感：lang EN / lang En 都该认
  s.lines.length = 0;
  await s.exec('lang ZH-CN');
  chk('lang_id 大小写不敏感', langOf() === 'zh-cn', langOf());

  s.lines.length = 0;
  await s.exec('lang zz');
  chk('认不出的 id 不切（语言保持原样）', langOf() === 'zh-cn', langOf());
  const zzLines = s.lines.map((l) => l.text);
  chk('认不出的 id 报错并把可切换的 id 再逐行列一遍',
    s.lines.some((l) => l.kind === 'err' && l.text.includes('没有这个语言包'))
    && availableLangs().map((l) => l.id).every((id) => zzLines.includes(id)), out());

  useLang('zh-cn');            // 复原，别把后面的测试带跑偏
  chk('复原成 zh-cn', langOf() === 'zh-cn', langOf());
}

console.log('\n── 20. 标签数在「关掉 HUD 再开」之后对得上（用户 2026-10-14 报）──');
{
  // 收掉待落盘的定时器：这里是纯逻辑验证，别让 flushSaves 去打一个不存在的后端
  const stop = (p) => { p._dirty.clear(); if (p._saveTimer) { clearTimeout(p._saveTimer); p._saveTimer = null; } };
  // 用户点「+」建出来的标签是"他真的要这个对话" → 立刻记账（keepOpen）+ 排一次落盘。
  // 不这样做的话，没配完就关掉 HUD，那个标签连存档都没有，再开就少一个。
  const a = new AgentPanel({});
  a.tabs[0].llm = { ...FAKE_LLM };
  const boot = a.tab;
  chk('起手那个标签默认没记账（内部新建的不算"用户开的"）', boot.keepOpen === false, String(boot.keepOpen));
  const made = a.newTab(true);
  chk('点「+」建的标签立刻记账', made.keepOpen === true, String(made.keepOpen));
  chk('并且排了落盘（不然"建完立刻关 HUD"就白建）', a._dirty.has(made), String(a._dirty.size));
  chk('内部新建（/del chat 补的那个）不记账', a.newTab(false).keepOpen === false, '');
  stop(a);
}

console.log('\n── 21. 空存档也能恢复成标签（stub 掉接口，纯逻辑验证）──');
{
  const realFetch = globalThis.fetch;
  // 造一个假后端：只回答对话列表与单个对话，两个都是"空对话"（没说过话、没配 LLM）
  const mkFetch = (ids) => async (url) => {
    const u = String(url);
    if (u.startsWith('/api/convs')) {
      return { json: async () => ({ convs: ids.map((id, i) => ({ id, title: '', updatedAt: i + 1, count: 0 })), max: 8 }) };
    }
    const m = /[?&]s=([^&]+)/.exec(u);
    return { json: async () => ({ id: m ? decodeURIComponent(m[1]) : '', title: '', msgs: [], llm: null }) };
  };
  const stop = (p) => { p._dirty.clear(); if (p._saveTimer) { clearTimeout(p._saveTimer); p._saveTimer = null; } };
  try {
    globalThis.fetch = mkFetch(['c-e1', 'c-e2']);
    const b = new AgentPanel({});
    b.tabs[0].llm = { ...FAKE_LLM };
    await b.restore();
    chk('两个空存档 → 恢复出两个标签（不再缩成一个）', b.tabs.length === 2, String(b.tabs.length));
    chk('空对话也各自带回自己的 id', b.tabs.map((t) => t.id).join(',') === 'c-e1,c-e2',
      b.tabs.map((t) => t.id).join(','));
    chk('恢复出来的都记了账（以后落盘仍带 keep，不会被判成空对话丢掉）',
      b.tabs.every((t) => t.keepOpen), String(b.tabs.map((t) => t.keepOpen)));
    chk('没配 LLM → 落在配置界面上，不是聊天界面', b.inConfig === true && b.tab.cfg !== null, String(b.inConfig));
    chk('落在最近更新的那个上（最后一个）', b.tab.id === 'c-e2', b.tab.id);
    stop(b);

    // 一个存档都没有（第一次开 / 存档被删光）：起手那个标签也得记进存档
    globalThis.fetch = mkFetch([]);
    const c = new AgentPanel({});
    const boot2 = c.tab;
    chk('恢复之前不记账（避免每次开都多写一个空存档）', boot2.keepOpen === false, String(boot2.keepOpen));
    await c.restore();
    chk('一个存档都没有时，起手那个标签被记账', boot2.keepOpen === true, String(boot2.keepOpen));
    chk('它同时排了落盘（下次开 HUD 就恢复出它，标签数不缩水）', c._dirty.has(boot2), String(c._dirty.size));
    chk('它仍停在配置界面', c.inConfig === true && boot2.cfg !== null, String(c.inConfig));
    chk('还是只有一个标签（不会因为记账就多生一个）', c.tabs.length === 1, String(c.tabs.length));
    stop(c);
  } finally { globalThis.fetch = realFetch; }
}

console.log('\n── 22. 点「+」预填的是"按 + 时所在的那个对话"，不是别处那份（用户 2026-10-14 指出）──');
{
  // 用户原话："这个上一个会话，是不是指按 + 时所在的会话，而不是最后创建的那个会话？
  //          应该是按 + 时所在的会话才对"。
  // 所以规矩钉死成一条：**谁在眼前就用谁那份**（配置框开着就以框里的为准），
  // 眼前这个没配过就留空 —— 不许拿"最近配好的那份"顶上（那会让人以为点错了对话）。
  const realFetch = globalThis.fetch;
  const A = { baseUrl: 'http://127.0.0.1:3/v1', apiKey: 'sk-AAA', model: 'model-a', provider: 'openai', resolved: 'openai' };
  const meta = [{ id: 'c-p1', llm: A }, { id: 'c-p2' }];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/convs')) {
      return { json: async () => ({ convs: meta.map((m, i) => ({ id: m.id, title: '', updatedAt: i + 1, count: 0 })), max: 8 }) };
    }
    const mm = /[?&]s=([^&]+)/.exec(u);
    const id = mm ? decodeURIComponent(mm[1]) : '';
    const rec = meta.find((x) => x.id === id) || {};
    return { json: async () => ({ id, title: '', msgs: [], llm: rec.llm || null }) };
  };
  const stop = (p) => { p._dirty.clear(); if (p._saveTimer) { clearTimeout(p._saveTimer); p._saveTimer = null; } };
  // 「空白表单」的判据：文本字段为空，**循环字段**停在各自的默认档
  // （provider=auto、charpack=auto、persona=default —— 这三栏本来就总有值，不算"预填了东西"）。
  // 用表而不是"key 命中就放行"：这样循环字段被预填成**非默认值**时也抓得住。
  const CYCLE_DEFAULTS = { provider: 'auto', charpack: 'auto', persona: 'default' };
  const blank = (f) => f.fields.every((x) => (x.key in CYCLE_DEFAULTS)
    ? x.value === CYCLE_DEFAULTS[x.key]
    : x.value === '');
  const val = (f, k) => (f.fields.find((x) => x.key === k) || {}).value;
  const valSet = (f, k, v) => { const x = f.fields.find((y) => y.key === k); if (x) x.value = v; };
  try {
    const p = new AgentPanel({});
    p.tabs[0].llm = { ...A };              // 起手那个标签先"配好"（restore 之后会被存档顶掉）
    await p.restore();
    const one = p.tabs.find((t) => t.id === 'c-p1');
    const two = p.tabs.find((t) => t.id === 'c-p2');
    chk('恢复：配过的那个带回自己的配置（不再弹表单）',
      !!one && one.llm && one.llm.model === 'model-a' && one.cfg === null, JSON.stringify(one && one.llm));
    chk('恢复：没配过的那个停在配置界面', !!two && two.cfg !== null, String(!!two && !!two.cfg));
    chk('恢复：它表单里预填的是**前面那个对话**那份（重启后看到的还是原来那样）',
      !!two && val(two.cfg, 'model') === 'model-a' && val(two.cfg, 'apiKey') === 'sk-AAA',
      JSON.stringify(two && two.cfg.fields.map((f) => f.value)));

    // ── 关键那条：站在"没配过、表单也收起来了"的对话上点「+」──
    p.selectTab(p.tabs.indexOf(two));
    p.configClose();                        // 收起来看历史（/llm 才能叫回来的那个状态）
    chk('站的地方确认是没配过的那个对话', p.tab === two && p.tab.llm === null, String(p.tab === two));
    const made1 = p.newTab(true);
    chk('这一下预填的是空的：眼前这个没配过，就不去抄别的对话那份',
      !!made1 && made1.cfg !== null && blank(made1.cfg), JSON.stringify(made1 && made1.cfg.fields.map((f) => f.value)));
    chk('别处明明有一份配好的（c-p1 就是）也照样不抄过来',
      !!(one.llm && one.llm.model === 'model-a'), '');

    // 站在**配好的**那个上点「+」：预填的就是它那份
    p.configCancel();                       // 撤销刚才那个新建
    p.selectTab(p.tabs.indexOf(one));
    one.persona = 'gentle';                 // 给"配好的那个"一个非默认性格，看它会不会跟着继承
    const made2 = p.newTab(true);
    chk('站在配好的对话上点「+」：地址/Key/模型/协议都预填它那份',
      !!made2 && val(made2.cfg, 'baseUrl') === A.baseUrl && val(made2.cfg, 'apiKey') === A.apiKey
        && val(made2.cfg, 'model') === 'model-a' && val(made2.cfg, 'provider') === 'openai',
      JSON.stringify(made2 && made2.cfg.fields.map((f) => f.value)));
    chk('预填是拷一份：两边不是同一份表单', made2.cfg !== one.cfg, '');
    // 性格跟形象一样，也是**每个对话一份**、也一起被继承（继承的是"按 + 时看着的那个"）
    chk('性格也预填了它那份（不是回到默认）', val(made2.cfg, 'persona') === 'gentle', val(made2.cfg, 'persona'));

    // 配置框正摊着的时候：以**框里现在的内容**为准（你看到什么就继承什么）
    valSet(made2.cfg, 'model', 'half-typed-live');
    const made3 = p.newTab(true);
    chk('眼前那个正摊着配置框：按框里现在的值预填（半改过的也算）',
      !!made3 && val(made3.cfg, 'model') === 'half-typed-live' && val(made3.cfg, 'baseUrl') === A.baseUrl,
      JSON.stringify(made3 && made3.cfg.fields.map((f) => f.value)));
    chk('上一份表单的内容没被新对话改动（各是各的）',
      val(made2.cfg, 'model') === 'half-typed-live' && made3.cfg !== made2.cfg, '');

    // 提示语里不许再出现"已按上一个对话预填"这类解释（用户明确不要）
    chk('提示语文字：只讲"改动只影响这一个对话"，不解释预填从哪来',
      !/预填/.test(zhCn['ui.agent.form.hintNew']) && !/pre-filled|previous/.test(en['ui.agent.form.hintNew'])
        && !/コピー済み|前の会話/.test(ja['ui.agent.form.hintNew']),
      `${zhCn['ui.agent.form.hintNew']} / ${en['ui.agent.form.hintNew']} / ${ja['ui.agent.form.hintNew']}`);
    stop(p);
  } finally { globalThis.fetch = realFetch; }
}

console.log('\n── 23. 标签色号跨重启保持（用户 2026-10-15 报："重开 HUD 颜色变了"）──');
{
  // 症状的根因：色号以前**不落盘**，恢复时按"第几个标签"重新派一遍。而恢复顺序是
  // updatedAt（最后动过的排最后），跟当初创建的顺序不一样 → 颜色就洗牌了。
  // 钉住三件事：① 存档里的色号原样还回来 ② 脏值/缺失/撞车时现派且不重复 ③ 落盘带上它。
  const realFetch = globalThis.fetch;
  const mkFetch = (recs) => async (url, opt) => {
    const u = String(url);
    if (u.startsWith('/api/convs')) {
      return { json: async () => ({ convs: recs.map((r, i) => ({ id: r.id, title: '', updatedAt: i + 1, count: 0 })), max: 8 }) };
    }
    if (u.startsWith('/api/conv?')) {
      const m = /[?&]s=([^&]+)/.exec(u);
      const id = m ? decodeURIComponent(m[1]) : '';
      const rec = recs.find((r) => r.id === id) || {};
      return { json: async () => ({ id, title: '', msgs: [], llm: null, ci: rec.ci }) };
    }
    globalThis.__savedConv = JSON.parse(opt.body);      // 记下落盘报文
    return { json: async () => ({ ok: true }) };
  };
  const stop = (p) => { p._dirty.clear(); if (p._saveTimer) { clearTimeout(p._saveTimer); p._saveTimer = null; } };
  const okCi = (t) => Number.isInteger(t.ci) && t.ci >= 0 && t.ci < 8;
  try {
    // ① 原样还回来（5 / 1 —— 按位置重派的话会是 0 / 1）
    globalThis.fetch = mkFetch([{ id: 'c-x1', ci: 5 }, { id: 'c-x2', ci: 1 }]);
    const p = new AgentPanel({});
    await p.restore();
    chk('恢复出两个标签', p.tabs.length === 2, String(p.tabs.length));
    chk('色号原样还回来（不按位置重派 —— 那正是颜色洗牌的原因）',
      p.tabs.map((t) => t.ci).join(',') === '5,1', p.tabs.map((t) => t.ci).join(','));
    chk('标签认的就是那个颜色（color() = 色板里那一格）',
      p.tabs[0].color() === TAB_COLORS[5] && p.tabs[1].color() === TAB_COLORS[1], '');
    chk('恢复之后新开的不撞上恢复回来的色号',
      (() => { const t3 = p.newTab(); return okCi(t3) && ![5, 1].includes(t3.ci); })(),
      p.tabs.map((t) => t.ci).join(','));
    stop(p);

    // ② 脏值 / 缺失 / 小数 → 一律不认，现派一个
    globalThis.fetch = mkFetch([{ id: 'c-y1', ci: 99 }, { id: 'c-y2', ci: -1 },
      { id: 'c-y3' }, { id: 'c-y4', ci: 2.5 }, { id: 'c-y5', ci: '3' }]);
    const q = new AgentPanel({});
    await q.restore();
    chk('越界 / 负数 / 缺失 / 小数 / 字符串 的色号都不认，改成现派',
      q.tabs.length === 5 && q.tabs.every(okCi), q.tabs.map((t) => t.ci).join(','));
    chk('现派出来的彼此不重复（5 个标签 5 个颜色）',
      new Set(q.tabs.map((t) => t.ci)).size === 5, q.tabs.map((t) => t.ci).join(','));
    stop(q);

    // ③ 两个存档撞同一个色号（老存档被手工改过 / 上限从 8 改小过）→ 后面的另派
    globalThis.fetch = mkFetch([{ id: 'c-z1', ci: 3 }, { id: 'c-z2', ci: 3 }, { id: 'c-z3', ci: 6 }]);
    const r = new AgentPanel({});
    await r.restore();
    chk('撞车时先到的保住，后面的换个颜色', r.tabs[0].ci === 3 && r.tabs[1].ci !== 3, r.tabs.map((t) => t.ci).join(','));
    chk('没撞的那个原样不动', r.tabs[2].ci === 6, r.tabs.map((t) => t.ci).join(','));
    chk('三个标签三个颜色', new Set(r.tabs.map((t) => t.ci)).size === 3, r.tabs.map((t) => t.ci).join(','));
    stop(r);

    // ④ 落盘要带上色号（不带的话下次开又得重派 = 又洗牌）
    globalThis.fetch = mkFetch([{ id: 'c-w1', ci: 6 }]);
    const w = new AgentPanel({});
    await w.restore();
    globalThis.__savedConv = null;
    w._dirty.add(w.tabs[0]);
    w.flushSaves();
    chk('落盘报文里带着色号', !!globalThis.__savedConv && globalThis.__savedConv.ci === 6,
      JSON.stringify(globalThis.__savedConv));
    // 新开的对话也得带上（不然它一落盘色号就丢了）
    globalThis.__savedConv = null;
    const fresh = w.newTab();
    w._dirty.add(fresh);
    w.flushSaves();
    chk('新开的对话落盘也带色号（且是它自己那个）',
      !!globalThis.__savedConv && globalThis.__savedConv.ci === fresh.ci,
      JSON.stringify(globalThis.__savedConv) + ' vs ' + fresh.ci);
    stop(w);

    // ⑤ 源码守卫：恢复那段必须真的去读存档里的 ci（而不是继续按位置派）
    const src = readFileSync(new URL('../app/src/panels/agent.js', import.meta.url), 'utf8');
    chk('restore 里读了存档的 ci', /const want = normCi\(c\.ci\)/.test(src), '');
    chk('ci 脏值走 normCi（不收敛成某个"看着合理"的值）', /function normCi\(v\)/.test(src) && /TAB_COLORS\.length/.test(src), '');
    chk('落盘带了 ci', /ci: conv\.ci/.test(src), '');
  } finally { globalThis.fetch = realFetch; }
}

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}`);
process.exitCode = fail ? 1 : 0;
