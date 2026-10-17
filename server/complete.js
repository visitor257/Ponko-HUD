// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 管道模式的 Tab 补全 —— **纯逻辑，不碰网络**（server.js 只负责收请求、给 cwd/命令表）
//
// 为什么补全要放后端：管道模式的 shell 是后端那个持久 pwsh，**前端根本不知道 cwd 底下有什么**。
// 而"列出目录"这件事前端做不了（浏览器没有文件系统），所以只能问后端。好在这是本地 HTTP，
// 一个来回 1~3ms，比人手快，感觉不到。
//
// 为什么不用 `TabExpansion2`（PowerShell 自己的补全引擎）：它得在会话里再喂一条命令，
// 而这条命令会跟 runCommand 的哨兵行（PONKO_DONE_9f3c）抢同一根管道 —— 一次补全就能把
// "谁的回包是谁的"搞乱。宁可自己列目录：路径与命令名的补全覆盖了日常九成以上，
// 剩下的（参数名、别名）留给真终端（`pty pwsh`）—— 那里 Tab 是直接发给程序的，
// 由 PowerShell 自己做满血补全，这个模块根本不参与。
const fs = require('fs');
const path = require('path');

// 面板自己的命令 + 各家 shell 的常用别名。真正的命令名由 server.js 扫 PATH 补上，
// 这里只放"系统里没有可执行文件、但打了就该补出来"的那些。
const BUILTINS = [
  'clear', 'cls', 'lang', 'ponko-help', 'pty', 'exit',
  'cd', 'pwd', 'ls', 'dir', 'cat', 'type', 'echo', 'mkdir', 'rmdir', 'del', 'rm', 'copy', 'move',
];

// 这些命令只吃目录 → 补全只给目录（不给文件，少一半噪声）
const DIR_ONLY = new Set(['cd', 'chdir', 'pushd', 'popd']);

/**
 * 把一行拆成"光标所在的那个词"。
 *
 * 返回 { start, end, quote }：
 *   start  词的起点（**含**开头那个引号，如果能确定词是从引号开始的）
 *   end    词的终点（闭引号算在内）
 *   quote  这个词用的引号（'' / '"' / "'"）—— 补全结果要包回去，否则 `cd "My Doc"` 补完引号就丢了
 *
 * 引号必须当真处理：`cd "My Doc` 里那个空格**不是**分隔符，按空格硬切会把词切成 `DoC`，
 * 补出来就是错的。
 */
function splitWord(line, caret) {
  const n = line.length;
  const c = Math.max(0, Math.min(n, caret | 0));
  let open = '';          // 扫到光标处仍未闭合的引号
  let start = 0;
  for (let i = 0; i < c; i++) {
    const ch = line[i];
    if (open) { if (ch === open) open = ''; continue; }
    if (ch === '"' || ch === "'") { open = ch; continue; }
    if (ch === ' ' || ch === '\t') start = i + 1;
  }
  // 词尾：还在引号里就找闭合引号（光标在词中间时词可能还往后延伸），否则到下一个空白
  let end = c;
  if (open) {
    let j = c;
    while (j < n && line[j] !== open) j++;
    end = j < n ? j + 1 : n;
  } else {
    let j = c;
    while (j < n && line[j] !== ' ' && line[j] !== '\t') j++;
    end = j;
  }
  // 词是从引号开始的吗？（`cd a"b` 这种怪写法不管，只认"起点就是引号"）
  const q0 = line[start] === '"' || line[start] === "'" ? line[start] : '';
  return { start, end, quote: q0 };
}

/** 候选集的公共前缀（大小写不敏感比较、但保留第一个候选的大小写） */
function commonPrefix(items) {
  if (!items.length) return '';
  let p = items[0];
  for (let k = 1; k < items.length; k++) {
    const s = items[k];
    let i = 0;
    const n = Math.min(p.length, s.length);
    while (i < n && p[i].toLowerCase() === s[i].toLowerCase()) i++;
    p = p.slice(0, i);
    if (!p) break;
  }
  return p;
}

/** 把 dirPart（可能相对、可能是 C:、可能带 ~）解成绝对目录 */
function resolveBase(cwd, dirPart, home) {
  let d = String(dirPart || '');
  if (!d) return cwd;
  if (d === '~' || d.startsWith('~/') || d.startsWith('~\\')) d = (home || cwd) + d.slice(1);
  if (/^[A-Za-z]:$/.test(d)) d += '\\';           // 裸盘符是"那个盘的当前目录"，用户要的其实是盘根
  try { return path.isAbsolute(d) ? path.normalize(d) : path.resolve(cwd, d); } catch (e) { return cwd; }
}

/**
 * 主函数。
 *
 * opts = {
 *   line, caret,            // 光标所在行 + 光标位置（UTF-16 下标，跟 input.selectionStart 同刻度）
 *   cwd,                    // 这个标签的实际工作目录（后端会话里那份，不是前端猜的）
 *   kind,                   // 'pwsh' | 'cmd' —— 目前只影响命令表（两者共用 PATH）
 *   commands,              // PATH 里的可执行文件名（server.js 扫好并缓存的）
 *   home,                   // ~ 展开成什么
 * }
 *
 * 返回 { ok, start, end, quote, prefix, base, items, common }
 *   start/end  要替换的那一段在行里的范围（**含**开引号与闭引号 —— 引号也要一起换掉，
 *              不然会拼成 `""My Doc"`）
 *   items      候选，**整词替换**（已经带上用户打好的目录部分，如 `Docs\src\`），
 *              目录带结尾反斜杠、文件不带 —— 前端据此决定"补完要不要接空格"
 *   common     候选的公共前缀（同样含目录部分），前端只拿它往输入框里填
 */
function completeLine(opts) {
  const o = opts || {};
  const line = String(o.line || '');
  const caret = Number.isFinite(o.caret) ? o.caret : line.length;
  const cwd = String(o.cwd || process.env.USERPROFILE || 'C:\\');
  const home = String(o.home || process.env.USERPROFILE || '');
  const commands = Array.isArray(o.commands) && o.commands.length ? o.commands : BUILTINS;

  const w = splitWord(line, caret);
  const innerStart = w.quote ? w.start + 1 : w.start;
  // 闭引号不算前缀的一部分（`cd "My Doc"` 补全时前缀不该带那个 `"`）
  let innerEnd = w.end;
  if (w.quote && w.end - 1 >= innerStart && line[w.end - 1] === w.quote) innerEnd = w.end - 1;
  const cut = Math.max(innerStart, Math.min(caret, innerEnd));
  const prefix = line.slice(innerStart, cut);

  // 命令位置 = 行首，或紧跟在 | ; & && || ( { 之后（pwsh 的管道 / 语句分隔）
  const head = line.slice(0, w.start).replace(/\s+$/, '');
  const isCmdPos = head === '' || /[|;&{(]$/.test(head);
  const words = head.split(/\s+/).filter(Boolean);
  const prev = words.length ? words[words.length - 1].toLowerCase() : '';
  const dirsOnly = !isCmdPos && DIR_ONLY.has(prev);

  // 前缀里带路径成分（分隔符 / 盘符 / . / ~）→ 按路径补；否则先按命令名补
  const looksPath = /[\\/]/.test(prefix) || /^[A-Za-z]:/.test(prefix)
    || prefix.startsWith('.') || prefix.startsWith('~');

  let dirPart = '';
  let namePre = prefix;
  const iSep = Math.max(prefix.lastIndexOf('\\'), prefix.lastIndexOf('/'));
  if (iSep >= 0) { dirPart = prefix.slice(0, iSep + 1); namePre = prefix.slice(iSep + 1); }
  if (/^[A-Za-z]:$/.test(prefix)) { dirPart = prefix + '\\'; namePre = ''; }

  const items = [];
  const seen = new Set();
  const add = (s) => {
    if (!s) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k); items.push(s);
  };

  if (isCmdPos && !looksPath) {
    const lp = prefix.toLowerCase();
    const hit = commands.filter((c) => String(c).toLowerCase().startsWith(lp)).map(String);
    hit.sort((a, b) => a.localeCompare(b));
    for (const c of hit) add(c);
  }

  const base = resolveBase(cwd, dirPart, home);
  const lp = namePre.toLowerCase();
  const dirs = [];
  const files = [];
  let ents = [];
  try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { ents = []; }
  for (const e of ents) {
    if (!e.name.toLowerCase().startsWith(lp)) continue;
    // 候选是**整词**：用户已经打好的 `..\` / `C:\Win` 那一截要带回去，
    // 否则前端只能替换到名字那一段（算偏移，容易跟引号/相对路径打架）。
    if (e.isDirectory()) dirs.push(dirPart + e.name + '\\');
    else if (!dirsOnly) files.push(dirPart + e.name);
  }
  dirs.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.localeCompare(b));
  for (const d of dirs) add(d);
  for (const f of files) add(f);

  return {
    // start 用**词的起点**（含开引号）：前端把 `q + 候选 + q` 整段填回去，
    // 开引号必须在替换范围里，否则会拼出 `""My Doc"` 这种双引号。
    ok: true, start: w.start, end: w.end, quote: w.quote,
    prefix, base, items, common: commonPrefix(items),
  };
}

module.exports = { completeLine, splitWord, commonPrefix, resolveBase, BUILTINS, DIR_ONLY };
