// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 克林贡文 pIqaD 的罗马化 ↔ 字形互转（CSUR 注册的私用区编码 U+F8D0–U+F8FF）。
//
// 为什么要这个工具：语言包 tlh.js 里存的是**字形**（不是罗马化 —— 用户 2026-10-17
// 明确要"克林贡文，不是罗马拼音"），但字形本身没法读、没法核对。这里给一对互逆函数：
//   toPiqad('tlhIngan Hol')  → ... （7 个字形）
//   fromPiqad(那个字符串)     → 'tlhIngan Hol'
// 于是 review 一份 pIqaD 文本只要 `node tools/piqad.mjs --roman <文件>`，改文案时从罗马化
// 转过去即可。转换是**确定性、可逆**的（每个字形 ↔ 一个罗马化记号，见下表），
// 测试里有一条往返断言盯着它别漂。
//
// 编码表出处：ConScript Unicode Registry 的 Klingon pIqaD 注册
//   http://www.evertype.com/standards/csur/klingon.html
//   字母 U+F8D0(a) … U+F8E8(y)、U+F8E9(')、数字 U+F8F0–U+F8F9(0–9)、
//   逗号 U+F8FD、句号 U+F8FE、帝国徽记 U+F8FF。
//   注意 'q' 和 'Q' 是两个不同的字母（注册表里前者叫 Q、后者叫 QH）。
//
// 字体：app/assets/fonts/pIqaD-qolqoS.ttf（SIL OFL，未改动）—— 系统里没有任何字体
// 能画这一段私用区，不自带就是豆腐块。
import { pathToFileURL } from 'node:url';

/** 罗马化记号 → 码点。多字母记号（tlh / ch / gh / ng）靠下面的 TOKENS 先匹配，顺序要紧 */
export const PUNCT = { ',': 0xF8FD, '.': 0xF8FE };
const SINGLE = {
  a: 0xF8D0, b: 0xF8D1, ch: 0xF8D2, D: 0xF8D3, e: 0xF8D4, gh: 0xF8D5, H: 0xF8D6, I: 0xF8D7,
  j: 0xF8D8, l: 0xF8D9, m: 0xF8DA, n: 0xF8DB, ng: 0xF8DC, o: 0xF8DD, p: 0xF8DE, q: 0xF8DF,
  Q: 0xF8E0, r: 0xF8E1, S: 0xF8E2, t: 0xF8E3, tlh: 0xF8E4, u: 0xF8E5, v: 0xF8E6, w: 0xF8E7,
  y: 0xF8E8, "'": 0xF8E9,
};

/** 罗马化 → 码点（数字用 U+F8F0 起的克林贡数字，逗号句号走 PUNCT） */
export function codeOf(token) {
  if (Object.prototype.hasOwnProperty.call(SINGLE, token)) return SINGLE[token];
  if (/^[0-9]$/.test(token)) return 0xF8F0 + Number(token);
  if (Object.prototype.hasOwnProperty.call(PUNCT, token)) return PUNCT[token];
  return null;
}

/** 码点 → 罗马化记号（codeOf 的逆；表外返回 null） */
export function tokenOf(cp) {
  for (const [k, v] of Object.entries(SINGLE)) if (v === cp) return k;
  if (cp >= 0xF8F0 && cp <= 0xF8F9) return String(cp - 0xF8F0);
  for (const [k, v] of Object.entries(PUNCT)) if (v === cp) return k;
  return null;
}

// 长的先匹配：tlh / ch / gh / ng 是两个三个字母一个字形，抢在单字母前面
const TOKENS = Object.keys(SINGLE).sort((a, b) => b.length - a.length);

const isUpper = (c) => c && c !== c.toLowerCase() && c === c.toUpperCase();

/**
 * 罗马化 → pIqaD。**只转克林贡字母**，其余字符（空格、标点、数字以外的技术记号、
 * 中文、西里尔文…）原样留在原地 —— 粘一段中英混排过来不会炸，方便逐条改文案。
 * 大小写敏感：Klingon 的 D / H / I / Q / S 是大写字母（跟小写 d / h / i / q / s 不是一回事）。
 * 不在字母表里的拉丁字母（如 g、f、c 单用）会**原样保留**，转出来一眼就能看出哪里拼错了。
 */
export function toPiqad(text) {
  const s = String(text);
  const out = [];
  for (let i = 0; i < s.length;) {
    let hit = null;
    for (const tk of TOKENS) {
      if (s.startsWith(tk, i)) { hit = tk; break; }
    }
    if (hit) { out.push(String.fromCharCode(codeOf(hit))); i += hit.length; continue; }
    const c = s[i];
    if (/^[0-9]$/.test(c)) { out.push(String.fromCharCode(codeOf(c))); i++; continue; }
    out.push(c); i++;                        // 空格 / 标点 / 表外字符原样带过
  }
  return out.join('');
}

/** pIqaD → 罗马化（可逆：toPiqad(fromPiqad(x)) === x 对纯字形串恒成立） */
export function fromPiqad(text) {
  const out = [];
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    const tk = tokenOf(cp);
    out.push(tk === null ? ch : tk);
  }
  return out.join('');
}

/** 这个码点是不是 pIqaD 字形（含数字与标点，不含帝国徽记） */
export const isPiqadCode = (cp) => (cp >= 0xF8D0 && cp <= 0xF8E9) || (cp >= 0xF8F0 && cp <= 0xF8F9)
  || cp === 0xF8FD || cp === 0xF8FE;

export function hasPiqad(s) {
  for (const ch of String(s)) if (isPiqadCode(ch.codePointAt(0))) return true;
  return false;
}

/** 所有不是 pIqaD 的码点（诊断用：哪些字没转过去） */
export function nonPiqad(s) {
  const bad = new Set();
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (!isPiqadCode(cp)) bad.add(ch);
  }
  return [...bad];
}

/** 字形数量（不是字符数：emoji 之类按码点算，这里只数 pIqaD 字形） */
export function glyphCount(s) {
  let n = 0;
  for (const ch of String(s)) if (isPiqadCode(ch.codePointAt(0))) n++;
  return n;
}

// ── CLI ────────────────────────────────────────────────────────────────────
// node tools/piqad.mjs --roman <文件|文本>   把文件/文本里的 pIqaD 读成罗马化
// node tools/piqad.mjs --piqad <文本>        把罗马化写成 pIqaD
// node tools/piqad.mjs --check <文件>        报出每一行里"没转成 pIqaD 的字母"
// ⚠ 判"是不是被直接运行"要用 pathToFileURL：Windows 上 import.meta.url 是 file:///C:/…，
//   手拼 `file://${argv[1]}` 会少一个斜杠，永远不相等 → 脚本静默什么都不做。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...rest] = process.argv.slice(2);
  const arg = rest.join(' ');
  if (!mode || !arg) {
    console.log('用法：node tools/piqad.mjs --roman|--piqad|--check <文件或文本>');
    process.exit(1);
  }
  let text = arg;
  if (!mode.startsWith('--') || rest.length === 1) {
    try { text = (await import('node:fs')).readFileSync(arg, 'utf8'); } catch (e) { /* 不是文件，按文本处理 */ }
  }
  if (mode === '--roman') console.log(fromPiqad(text));
  else if (mode === '--piqad') console.log(toPiqad(text));
  else if (mode === '--check') {
    // 两类分开报，**别混成一个"未转"数字**（第一版就是这样，129 行全红 → 看着像整份没转）：
    //   ① 硬错误：还剩中文 / 西里尔 / 假名 —— 那一定是没转，或者是从别的语言包抄来的
    //   ② 提示：还剩拉丁字母 —— 多半是**故意保留的技术标识**（shell / LLM / pid / server.js…），
    //      按 i18n 第 3 条它们就该留 ASCII；只报条数，不改退出码
    let hard = 0, soft = 0;
    for (const [i, line] of text.split('\n').entries()) {
      const m = line.match(/^(\s*'[^']+':\s*(?:'([^']*)'|"([^"]*)").*)$/);
      if (!m) continue;
      const val = m[2] !== undefined ? m[2] : m[3];
      const letters = nonPiqad(val).filter((c) => /[\p{L}]/u.test(c));
      const foreign = letters.filter((c) => /[\u0400-\u04ff\u3040-\u30ff\u4e00-\u9fff]/.test(c));
      if (foreign.length) {
        hard++;
        console.log(`第 ${i + 1} 行  ${m[1].slice(0, 46)}…\n          非拉丁残留：${foreign.join('')}  →  ${fromPiqad(val)}`);
      } else if (letters.length) {
        soft++;
      }
    }
    if (hard) { console.log(`\n${hard} 行里混进了非克林贡文字（中文/西里尔/假名）—— 这是真错误`); process.exitCode = 1; }
    console.log(`\n拉丁字母保留在 ${soft} 行里（技术标识，按 i18n 第 3 条就该留 ASCII）；` +
      `硬错误 ${hard} 行。要看某行说的是什么：--roman`);
  } else { console.log('未知模式：' + mode); process.exit(1); }
}
