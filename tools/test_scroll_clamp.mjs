// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 回归：滚到顶之后继续往上划，不能攒"欠账"。
// 用户 2026-10-26 报：llm 框里划到顶，再往上划 4 下，然后往下划**不动**，得划 4 下才重新下划。
// 根因：onWheel 的上限是写死的 400（跟内容多少无关），划过头就只是把 scroll 加到 400，
// 反向要先把这段多出来的量还完。修法：上限改成 body() 每帧算的真实可滚行数 _maxScroll。
import { AgentPanel } from '../app/src/panels/agent.js';
import { ShellPanel } from '../app/src/panels/shell.js';

let fail = 0;
const chk = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   → ' + got}`);
  if (!ok) fail++;
};

/**
 * 极简网格替身（与 test_caret_sel / test_shell_prompt 同款）。
 * ⚠ `rows` 必须是 Map：写 `rows: 80` 再写 `rows` 时后写的会覆盖前者，面板按 rect 定位、不用数值行数。
 */
function mkGrid() {
  const rows = new Map();
  const g = {
    cols: 200, rows,
    chWidth: (c) => (c && c.charCodeAt(0) > 0x2e80 ? 2 : 1),
    strWidth(s) { let n = 0; for (const ch of s) n += g.chWidth(ch); return n; },
    text(x, y, s) {
      let col = x; const r = rows.get(y) || {};
      for (const ch of String(s)) {
        r[col] = ch;
        for (let k = 1; k < g.chWidth(ch); k++) r[col + k] = '~';
        col += g.chWidth(ch);
      }
      rows.set(y, r);
      return col;
    },
    set(x, y, ch) { const r = rows.get(y) || {}; r[x] = ch; rows.set(y, r); },
    box() {}, fill() {}, inBounds: () => true, idx: (x, y) => y * 200 + x,
  };
  return g;
}
const TH = { text: 1, panel: 0, panelHi: 2, accent: 3, line: 4, dim: 5, darker: 6, err: 7, warn: 8, ok: 9, bg: 10 };
const C = { theme: TH, t: 0, tokRate: 0 };
const FAKE_LLM = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-test', model: 'm', provider: 'auto', resolved: '' };

/** 画一帧，把每行读成字符串（跳过第 0 列外框、去掉行尾空格） */
function render(panel) {
  const g = mkGrid();
  panel.draw(g, C);
  return [...g.rows.keys()].sort((a, b) => a - b).map((y) => {
    const r = g.rows.get(y) || {};
    let out = '';
    for (let x = 1; x < 200; x++) out += (r[x] === undefined ? ' ' : r[x] === '~' ? '' : r[x]);
    return out.replace(/\s+$/, '');
  });
}
// 滚轮方向：d > 0 是**往下**滚（浏览器 deltaY 为正）→ scroll 减 1；往上才是回看。
const up = (p, n) => { for (let i = 0; i < n; i++) p.onWheel(-1); };
const down = (p, n) => { for (let i = 0; i < n; i++) p.onWheel(1); };

console.log('── 1. llm 框：到顶后多划的那几下不该被记住 ──');
{
  const a = new AgentPanel({});
  a.layout({ x: 0, y: 0, w: 60, h: 20 });
  a.tab.llm = { ...FAKE_LLM };
  a.configClose();
  a.msgs = [];
  for (let i = 0; i < 40; i++) a.push('user', `history line ${i}`);

  render(a);                                  // 先画一帧，_maxScroll 才有值
  const max = a.tab._maxScroll;
  chk('内容够长 → 能回看', max > 0, max);

  up(a, max);                                 // 划到顶
  const topAtTop = render(a)[1];              // [0] 是面板边框行
  chk('划到顶时 scroll == 可滚上限', a.scroll === max, `${a.scroll} vs ${max}`);

  up(a, 4);                                   // 用户说的"再往上划 4 下"
  chk('到顶后多划 4 下，scroll 不涨（不攒欠账）', a.scroll === max, `${a.scroll} vs ${max}`);

  down(a, 1);                                 // 用户说"往下划不动"的那一下
  const topAfter1 = render(a)[1];
  chk('紧接着往下划 1 下就动', a.scroll === max - 1, `${a.scroll} vs ${max - 1}`);
  chk('画面确实往下走了（顶行变了）', topAfter1 !== topAtTop, `${JSON.stringify(topAtTop)} → ${JSON.stringify(topAfter1)}`);

  down(a, max + 10);
  chk('划到底 scroll 钳在 0，不会变负', a.scroll === 0, a.scroll);
}

console.log('\n── 2. llm 框：内容装得下时根本不该动 ──');
{
  const a = new AgentPanel({});
  a.layout({ x: 0, y: 0, w: 60, h: 24 });
  a.tab.llm = { ...FAKE_LLM };
  a.configClose();
  a.msgs = [];
  a.push('user', '就一行');
  render(a);
  chk('内容不满一屏 → 上限是 0', a.tab._maxScroll === 0, a.tab._maxScroll);
  up(a, 10);
  chk('往上划 10 下 scroll 仍是 0', a.scroll === 0, a.scroll);
  down(a, 5);
  chk('往下划也不会变负', a.scroll === 0, a.scroll);
}

console.log('\n── 3. 内容变短后旧的 scroll 要被夹回来 ──');
{
  const a = new AgentPanel({});
  a.layout({ x: 0, y: 0, w: 60, h: 20 });
  a.tab.llm = { ...FAKE_LLM };
  a.configClose();
  a.msgs = [];
  for (let i = 0; i < 40; i++) a.push('user', `line ${i}`);
  render(a);
  up(a, 999);
  chk('先划到顶', a.scroll === a.tab._maxScroll && a.scroll > 0, a.scroll);

  a.msgs = [{ role: 'user', text: '只剩一条' }];   // 换了个短对话
  render(a);
  chk('换成短对话后 scroll 被夹到 0（不会停在一片空白上）', a.scroll === 0, a.scroll);
}

console.log('\n── 4. shell 面板同一个毛病也修了 ──');
{
  const s = new ShellPanel({});
  s.layout({ x: 0, y: 0, w: 60, h: 16 });
  for (let i = 0; i < 40; i++) s.tab.push('out', `out ${i}`);
  render(s);
  const max = s.tab._maxScroll;
  chk('shell 也有可滚上限', max > 0, max);
  up(s, max + 5);
  // ShellPanel 没有 scroll 访问器，看标签自己的值
  chk('shell 到顶后多划不攒欠账', s.tab.scroll === max, `${s.tab.scroll} vs ${max}`);
  const before = render(s)[1];
  down(s, 1);
  const after = render(s)[1];
  chk('shell 往下划 1 下就动', s.tab.scroll === max - 1 && before !== after, `${s.tab.scroll} / ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
}

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}`);
process.exitCode = fail ? 1 : 0;
