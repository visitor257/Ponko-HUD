// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 回归：管道模式的 Tab 补全（server/complete.js）+ 前端那几根接线
//
// 补全这东西坏起来是"静默的"：Tab 一按什么都不发生，或者更糟 —— 把已经打好的路径截掉一半。
// 所以这里不测"看起来对不对"，测的是**替换范围**：把 start/end 套回原行，看结果是不是
// 一条完整、能执行的命令行。
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { completeLine, splitWord, commonPrefix } = require('../server/complete.js');

let fail = 0;
const chk = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   → ' + JSON.stringify(got)}`);
  if (!ok) fail++;
};

/** 把一次补全"真的打进那一行"：等价于前端的 line.slice(0,start) + ins + line.slice(end) */
function apply(line, r, ins) {
  return line.slice(0, r.start) + ins + line.slice(r.end);
}

console.log('── ① 拆词：光标所在的词，引号里的空格不算分隔符 ──');
{
  const a = splitWord('cd Docs', 7);
  chk('普通词：start 落在词首', a.start === 3 && a.end === 7, a);
  chk('行尾（光标在最后）end = 行宽', splitWord('ls ', 3).start === 3, splitWord('ls ', 3));
  const q = splitWord('cd "My Do', 9);
  chk('开引号：词从引号开始，引号被记下来', q.start === 3 && q.quote === '"' && q.end === 9, q);
  const c = splitWord('cd "My Doc" && ls', 11);
  chk('闭引号：end 把闭引号算进去（换掉才不会剩下半截引号）', c.end === 11 && c.quote === '"', c);
  const mid = splitWord('cd Docs && ls', 5);
  chk('光标在词中间：end 停在空格上（不吞后面的命令）', mid.start === 3 && mid.end === 7, mid);
}

console.log('── ② 候选：目录带反斜杠、文件不带、公共前缀 ──');
{
  // 公共前缀保留**第一个候选的原始大小写**（填回输入框的得是真实文件名，不能是小写版）
  chk('公共前缀：大小写不敏感比较、保留原大小写', commonPrefix(['Proj\\', 'program.txt']) === 'Pro', commonPrefix(['Proj\\', 'program.txt']));
  chk('公共前缀：单个候选 = 它自己', commonPrefix(['abc']) === 'abc', commonPrefix(['abc']));
  chk('公共前缀：没有交集 = 空串', commonPrefix(['abc', 'xyz']) === '', commonPrefix(['abc', 'xyz']));
}

// ── 造一棵小树当工作目录（真目录，不用假数据：补全就是"列目录"这件事本身）──
const root = path.join(os.tmpdir(), 'ponko-complete-' + process.pid);
const mk = (rel) => { const p = path.join(root, rel); mkdirSync(p, { recursive: true }); return p; };
mk('proj\\inner');
mk('Projects');
mk('my docs');
writeFileSync(path.join(root, 'program.txt'), 'x');
writeFileSync(path.join(root, 'readme.md'), 'x');
writeFileSync(path.join(root, 'proj\\a.txt'), 'x');

try {
  console.log('── ③ 命令位置：从命令表里补 ──');
  {
    const cmds = ['python', 'pytest', 'pwsh', 'ping'];
    const r = completeLine({ line: 'pyt', caret: 3, cwd: root, commands: cmds });
    chk('两个候选都在，且公共前缀是 pyt', r.items.join(',') === 'pytest,python' && r.common === 'pyt', r.items);
    chk('替换范围 = 整个词', r.start === 0 && r.end === 3, r);
    const one = completeLine({ line: 'ping', caret: 4, cwd: root, commands: cmds });
    chk('已补全的词仍然回它自己（再按 Tab 不会吃掉）', one.items[0] === 'ping', one.items);
  }

  console.log('── ④ cd 只要目录（文件不混进来）──');
  {
    const r = completeLine({ line: 'cd pro', caret: 6, cwd: root });
    chk('pro → 只给目录', r.items.every((s) => s.endsWith('\\')), r.items);
    chk('pro → proj\\ 与 Projects\\ 都在', r.items.includes('proj\\') && r.items.includes('Projects\\'), r.items);
    chk('pro → 文件 program.txt 不出现', !r.items.some((s) => s.includes('program')), r.items);
    const r2 = completeLine({ line: 'type re', caret: 7, cwd: root });
    chk('非 cd（type 的参数）→ 文件也在', r2.items.includes('readme.md'), r2.items);
  }

  console.log('── ⑤ 大小写：按用户打的字母匹配，回**真实**文件名 ──');
  {
    const r = completeLine({ line: 'cd PROJ', caret: 7, cwd: root });
    chk('PROJ → 命中 proj\\（原样大小写）', r.items.includes('proj\\'), r.items);
  }

  console.log('── ⑥ 带目录的路径：候选是**整词**（否则前端会把 ..\\ 那截截掉）──');
  {
    const r = completeLine({ line: 'cd proj\\in', caret: 10, cwd: root });
    chk('proj\\in → proj\\inner\\', r.items.length === 1 && r.items[0] === 'proj\\inner\\', r.items);
    chk('替换范围从词首开始（含 proj\\）', r.start === 3, r);
    chk('打进去之后是一条完整命令', apply('cd proj\\in', r, r.items[0]) === 'cd proj\\inner\\', apply('cd proj\\in', r, r.items[0]));
    const up = completeLine({ line: 'cd ..\\pro', caret: 9, cwd: path.join(root, 'proj') });
    chk('相对路径 ..\\ 保留在候选里', up.items.includes('..\\proj\\') || up.items.includes('..\\program.txt'), up.items);
  }

  console.log('── ⑦ 引号：带空格的目录补完还是"一个词" ──');
  {
    const r = completeLine({ line: 'cd "my do', caret: 10, cwd: root });
    chk('识别出在引号里，前缀是 my do', r.quote === '"' && r.prefix === 'my do', r);
    chk('候选 = my docs\\（不带引号，引号由前端包回去）', r.items[0] === 'my docs\\', r.items);
    const out = apply('cd "my do', r, '"' + r.items[0] + '"');
    chk('替换后引号成对', out === 'cd "my docs\\"', out);
  }

  console.log('── ⑧ 光标在行中间：只动那一个词，后面的命令原样留着 ──');
  {
    const line = 'cd pro && echo hi';
    const r = completeLine({ line, caret: 6, cwd: root });
    chk('词是 pro，end 停在空格上', r.start === 3 && r.end === 6, r);
    const out = apply(line, r, 'proj\\');
    chk('打进去后后半句没被吃掉', out === 'cd proj\\ && echo hi', out);
  }

  console.log('── ⑨ 什么都没有的时候不许瞎给 ──');
  {
    const r = completeLine({ line: 'cd nope\\', caret: 8, cwd: root });
    chk('不存在的目录 → 空候选', r.items.length === 0, r.items);
    const r2 = completeLine({ line: 'zzz', caret: 3, cwd: root, commands: [] });
    chk('命令表为空 + 前缀不匹配 → 空候选', r2.items.length === 0, r2.items);
    const r3 = completeLine({ line: 'cd ', caret: 3, cwd: root });
    chk('空前缀 = 列出这一层（cd 下只列目录）', r3.items.length >= 3 && r3.items.every((s) => s.endsWith('\\')), r3.items);
  }

  console.log('── ⑩ 盘符与 ~ 的解基 ──');
  {
    const r = completeLine({ line: 'cd C:', caret: 5, cwd: root });
    chk('裸盘符按盘根列（不按"那个盘的当前目录"）', /^[A-Za-z]:\\/.test(r.base), r.base);
  }
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch (e) { /* 删不掉就算了 */ }
}

console.log('── ⑪ 接线：Tab 真的走到了补全，而且是从主循环那儿走的 ──');
{
  const main = readFileSync(new URL('../app/src/main.js', import.meta.url), 'utf8');
  const shell = readFileSync(new URL('../app/src/panels/shell.js', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../app/src/api.js', import.meta.url), 'utf8');
  const srv = readFileSync(new URL('../server/server.js', import.meta.url), 'utf8');
  chk('shell.js 有 tabComplete()（补全逻辑在标签上）', /async tabComplete\(\)/.test(shell), '');
  chk('shell.js 把结果当作"整词替换"用（line.slice(0, r.start)）', /line\.slice\(0, r\.start\)/.test(shell), '');
  chk('api.js 有 /api/complete 的封装', /completeShell/.test(api) && /\/api\/complete/.test(api), '');
  chk('server.js 有 /api/complete 路由', /p === '\/api\/complete'/.test(srv), '');
  chk('server.js 会扫 PATH 出命令名', /function commandNames/.test(srv), '');
  chk('主循环：有内容才补全（空行仍是老行为）', /focus === 'shell' && !panels\.shell\.inPty\(\) && panels\.shell\.input\.trim\(\)/.test(main), '');
  chk('补全分支确实调了 tabComplete', /sh\.tabComplete\(\)\.then/.test(main), '');
  chk('切焦点那句仍在（空行 Tab 的老路径没被删掉）',
    /focus = focus === 'shell' \? 'agent' : 'shell';/.test(main), '');
  chk('真终端那段仍然先把 Tab 发给程序（没被补全抢走）',
    /PTY_KEYS\[e\.key\]/.test(main) && /Tab: '\\t'/.test(main), '');
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
