// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 回归：回滚区里的提示符必须是**那一刻**的 cwd / shell 样式，不能被"当前"覆盖。
// 起因（2026-10-26 用户报）：在 PS 里敲 cmd 进去后，历史里 `PS C:\Users\Administrator>` 这一行
// 显示成了 `C:\Users\Administrator\Desktop>`（`PS ` 丢了、目录换成了最后的目录）。
// 根因：body() 每帧用 `this.prompt`（由当前 cwd/kind 现算）给所有历史命令行加前缀。
import { ShellPanel } from '../app/src/panels/shell.js';

let fail = 0;
const chk = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   → ' + got}`);
  if (!ok) fail++;
};

const CH_W = { '█': 1 };
function mkGrid() {
  const rows = new Map();
  const g = {
    cols: 200, rows,                     // rows 是 Map（和 test_caret_sel 的替身一致）
    chWidth: (c) => CH_W[c] ?? (c && c.charCodeAt(0) > 0x2e80 ? 2 : 1),
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
const TH = { text: 1, panel: 0, accent: 2, line: 3, dim: 4, darker: 5, err: 6, warn: 7, ok: 8, bg: 9 };
const C = { theme: TH, t: 0, tokRate: 0 };

/** 画一帧，把每行读成字符串（行尾空格去掉），按 y 排序 */
function render(s) {
  const g = mkGrid();
  s.draw(g, C);
  return [...g.rows.keys()].sort((a, b) => a - b)
    .map((y) => {
      const r = g.rows.get(y) || {};
      let out = '';
      // 从第 1 列开始读：第 0 列是外框
      for (let x = 1; x < 200; x++) out += (r[x] === undefined ? ' ' : r[x] === '~' ? '' : r[x]);
      return out.replace(/\s+$/, '');
    })
    .filter((l) => l.trim().length > 0);
}

const A = 'C:\\Users\\Administrator';
const D = 'C:\\Users\\Administrator\\Desktop';

console.log('── 1. PS 里进 cmd：历史提示符不能被改写 ──');
{
  const s = new ShellPanel({});
  s.layout({ x: 0, y: 0, w: 60, h: 14 });

  // 按用户那份记录的顺序打：四条命令、两次 cwd 变化、一次 shell 种类变化
  const tab = s.tab;
  tab.kind = 'pwsh'; tab.cwd = A;
  tab.push('cmd', 'cmd');                    // 在 PS 里敲 cmd
  tab.kind = 'cmd'; tab.cwd = A;             // 后端回：进的是 cmd，目录没变
  tab.push('cmd', 'cd');
  tab.push('out', A);
  // 注意顺序：cwd 事件是命令**跑完**才回来的，所以先 push 命令、再改 cwd
  tab.push('cmd', 'cd Desktop\\');
  tab.cwd = D;                               // 后端回：目录变成 Desktop
  tab.push('out', D);

  const lines = render(s);
  const find = (pred) => lines.find(pred) || '';
  const psLine = find((l) => l.includes('cmd') && l.trim().startsWith('PS '));
  const cdLine = find((l) => /[>*]\s*cd$/.test(l));
  const cdDesktop = find((l) => l.includes('cd Desktop\\'));

  chk('历史里的 PS 行保留 `PS ` 和**当时**的目录',
    psLine === `PS ${A}> cmd`, JSON.stringify(psLine));
  chk('第一条 cd 的提示符是执行它的那个目录（不是后来变的）',
    cdLine === `${A}>cd`, JSON.stringify(cdLine));
  chk('cd Desktop\\ 的提示符仍是切换前的目录',
    cdDesktop === `${A}>cd Desktop\\`, JSON.stringify(cdDesktop));
  chk('历史里没有一行 PS 提示符被刷成 Desktop',
    !lines.some((l) => l.startsWith('PS ') && l.includes('Desktop')), JSON.stringify(lines));
  chk('输出行不带提示符（仍是两个空格缩进）',
    lines.some((l) => l === `  ${A}`), JSON.stringify(lines));
  chk('最底下的输入行用的是**当前**目录',
    lines.some((l) => l === `${D}>`), JSON.stringify(lines));
  chk('命令行都带着入栈时定格的提示符',
    tab.lines.filter((l) => l.kind === 'cmd').every((l) => typeof l.p === 'string' && l.p.length > 0),
    JSON.stringify(tab.lines.map((l) => [l.kind, l.p])));
  chk('输出行不存提示符', tab.lines.filter((l) => l.kind === 'out').every((l) => l.p === undefined), '');
}

console.log('\n── 2. 反方向：cmd 里 exit 回 PS ──');
{
  const s = new ShellPanel({});
  s.layout({ x: 0, y: 0, w: 60, h: 14 });
  const tab = s.tab;
  tab.kind = 'cmd'; tab.cwd = 'C:\\';
  tab.push('cmd', 'exit');
  tab.kind = 'pwsh'; tab.cwd = A;            // 回到 PowerShell
  tab.push('cmd', 'dir');

  const lines = render(s);
  chk('cmd 那行的提示符没有被补上 `PS `',
    lines.includes('C:\\>exit'), JSON.stringify(lines));
  chk('回到 PS 后的新命令行是 PS 样式',
    lines.includes(`PS ${A}> dir`), JSON.stringify(lines));
}

console.log('\n── 3. 同一目录下连着敲：每条都定格，互不影响 ──');
{
  const s = new ShellPanel({});
  s.layout({ x: 0, y: 0, w: 60, h: 14 });
  const tab = s.tab;
  tab.kind = 'pwsh';
  for (const [cwd, cmd] of [['C:\\', 'cd'], [A, 'cd Desktop'], [D, 'echo hi']]) {
    tab.cwd = cwd;
    tab.push('cmd', cmd);
  }
  const lines = render(s);
  chk('三条命令各自的提示符都对应它们执行时的目录',
    lines.includes('PS C:\\> cd') && lines.includes(`PS ${A}> cd Desktop`)
      && lines.includes(`PS ${D}> echo hi`), JSON.stringify(lines));
}

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}`);
process.exitCode = fail ? 1 : 0;
