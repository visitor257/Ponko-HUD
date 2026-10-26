// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
//
// 技能库（skills）—— **磁盘就是注册表**
//
// 设计来自用户 2026-10-26 的原话：「一开始默认 agent 只有调用 shell 的功能，agent 可以用 shell
// 写入文件或者其他操作，来自己给自己加 skill」。
//
// 所以这里**没有注册接口、没有 install 动作、没有内存里的登记表**：
// 一个目录 + 一份 SKILL.md 就是一个技能，存在即生效。agent 用 shell 建出来，
// 下一轮请求重新扫一遍目录就能看见自己刚写的东西（见 listSkills 的"不缓存"说明）。
//
// 为什么技能不提供"新的执行能力"：唯一工具永远是 shell。技能里放的是**知识**（步骤、坑、
// 参数怎么给），不是权限。这样"自己给自己加技能"不会变成"自己给自己提权"——
// 技能再多，它能干的事还是 shell 能干的事。
//
// 目录（都在 run/ 下，该目录不入库，见推送脚本的排除项）：
//   run/skills/public/<dir>/SKILL.md          所有对话都能用
//   run/skills/private/<convId>/<dir>/SKILL.md 只有这个对话能用（同名时覆盖公有的）
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// PONKO_SKILLS_DIR 是**给验证脚本用的**：把技能库指到临时目录，跑测试时不碰用户本机那份。
// 与 PONKO_CONV_DIR 同一套路（见 server.js 文件头那节）。
const SKILLS_DIR = process.env.PONKO_SKILLS_DIR
  ? path.resolve(process.env.PONKO_SKILLS_DIR)
  : path.join(ROOT, 'run', 'skills');

const PUBLIC_DIR = path.join(SKILLS_DIR, 'public');
const PRIVATE_DIR = path.join(SKILLS_DIR, 'private');

// 目录名也是技能名（frontmatter 里的 name 只作显示）。
// 允许中文（agent 大概率会写中文名），但**必须以字母/数字/汉字开头** ——
// 这一条顺带把 `.` 和 `..` 挡在外面，路径穿越就没机会了。
const DIR_RE = /^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9_.\-\u4e00-\u9fa5]{0,39}$/;
const CONV_RE = /^[A-Za-z0-9_-]{1,40}$/;          // 与 server.js 的 CONV_ID_RE 一致

const MAX_SKILLS = 40;          // 再多清单就吃掉太多上下文了
const MAX_DESC = 140;           // 单条描述上限（清单里一行）
const MAX_BRIEF = 4000;         // 清单总长上限，超了截断并注明

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * 解析 SKILL.md：可选 frontmatter + 正文。
 *
 * 故意不引 yaml 库（本工程零依赖）：只认 `key: value` 单行形式，
 * 值里不做引号/多行折叠——技能说明书用不到那些，真需要就写进正文。
 * frontmatter 没闭合（少一条 ---）时整体当正文，宁可少解析也不要吞掉内容。
 */
function parseSkill(text, fallbackName) {
  const raw = stripBom(String(text || ''));
  const meta = {};
  let body = raw;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i <= 0) continue;
      const k = line.slice(0, i).trim().toLowerCase();
      const v = line.slice(i + 1).trim();
      if (k && v) meta[k] = v;
    }
  }
  // 没写 description 就退到正文第一个非空、非标题行 —— 至少让清单里有话说
  let desc = oneLine(meta.description);
  if (!desc) {
    const first = body.split(/\r?\n/).map((s) => oneLine(s.replace(/^#{1,6}\s*/, '')))
      .find((s) => s && !s.startsWith('```'));
    desc = first || '';
  }
  return {
    name: oneLine(meta.name) || fallbackName,
    description: desc.slice(0, MAX_DESC),
    when: oneLine(meta.when),
    body,
  };
}

/** 扫一个作用域目录：只认"子目录里有 SKILL.md"的，散落的文件一律忽略 */
function scanScope(dir, scope) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return out; }   // 目录还不存在是正常的
  for (const n of names) {
    if (!DIR_RE.test(n)) continue;
    const d = path.join(dir, n);
    const file = path.join(d, 'SKILL.md');
    let st = null;
    try { st = fs.statSync(d); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }  // 没 SKILL.md 不算技能
    const sk = parseSkill(text, n);
    out.push({ ...sk, dir: n, scope, path: file, dirPath: d });
  }
  return out;
}

/**
 * 这个对话现在能看见哪些技能。
 *
 * **不缓存**，每次请求现扫（一次请求只扫一次，见 server.js 的 streamAgent）。
 * 缓存会带来"agent 刚写完的 SKILL.md 要等重启才生效"，那正好毁掉自举这件事；
 * 而扫目录的代价是两次 readdir + 每个技能一次读文件，跟一次 LLM 请求比可以忽略。
 */
function listSkills(convId) {
  const pub = scanScope(PUBLIC_DIR, 'public');
  const priv = CONV_RE.test(String(convId || ''))
    ? scanScope(path.join(PRIVATE_DIR, convId), 'private')
    : [];
  // 私有覆盖公有：按**技能名**覆盖（不是目录名）——用户理解的是"同一个技能我有自己那份"
  const map = new Map();
  for (const s of pub) map.set(s.name, s);
  for (const s of priv) map.set(s.name, s);
  const all = [...map.values()];
  all.sort((a, b) => a.name.localeCompare(b.name));
  return all.slice(0, MAX_SKILLS);
}

/** 按名字或目录名找一个技能（给"读全文"和测试用） */
function readSkill(convId, key) {
  const k = oneLine(key);
  if (!k) return null;
  return listSkills(convId).find((s) => s.name === k || s.dir === k) || null;
}

/** 每个技能目录下可选的 guard.json —— shell 命令的拦截规则（见 toolrun.js） */
function guardRules(convId) {
  const out = [];
  for (const s of listSkills(convId)) {
    let j = null;
    try { j = JSON.parse(stripBom(fs.readFileSync(path.join(s.dirPath, 'guard.json'), 'utf8'))); } catch (e) { continue; }
    for (const r of (j && Array.isArray(j.rules) ? j.rules : [])) {
      const pattern = oneLine(r && r.pattern);
      if (!pattern) continue;
      out.push({
        pattern,
        action: r.action === 'block' ? 'block' : 'block',   // 第一版只有 block（confirm 档见 TODO）
        why: oneLine(r.why).slice(0, 120),
        from: s.name,
      });
    }
  }
  return out;
}

/**
 * 拼进 system prompt 的那一段。
 *
 * 三条信息缺一不可：
 *   ① 技能放在哪（**绝对路径**——运行时 serve 的是桌面副本，相对路径对不上，
 *      而且 shell 的 cwd 会跟着 `cd` 变，靠相对路径找技能必然翻车）
 *   ② 现在有哪些（名字 + 一句话，正文让模型自己 `Get-Content` 去读，省上下文）
 *   ③ 怎么新建一个（格式 + 一个能跑的例子）
 *
 * 即使清单是空的也要输出 ①②③ —— 空清单正是"它现在还没有技能"的那一天，
 * 而那一天它必须知道往哪写才能长出自己的第一个技能。
 */
function skillsBrief(convId) {
  const list = listSkills(convId);
  const privRoot = CONV_RE.test(String(convId || '')) ? path.join(PRIVATE_DIR, convId) : PRIVATE_DIR;
  const L = [];
  L.push('## 技能（skills）');
  L.push('技能就是磁盘上的一份说明书。它**不给你新的权限**——你唯一能调用的是 shell，'
    + '技能里存的是"遇到这类事该怎么做"：步骤、命令、坑。需要时读它，照着做。');
  L.push('');
  L.push('技能库路径（绝对路径，写文件时用这个，别用相对路径）：');
  L.push('- 公有（所有对话共用）：`' + PUBLIC_DIR + '`');
  L.push('- 私有（只有本对话可见）：`' + privRoot + '`');
  L.push('');
  if (list.length) {
    L.push('已有的技能（清单只有一行摘要，要用时先读全文）：');
    let used = 0;
    for (const s of list) {
      const line = '- `' + s.name + '`（' + s.scope + '）— ' + (s.description || '(没有描述)');
      if (used + line.length > MAX_BRIEF) { L.push('- …（还有更多，先 `Get-ChildItem` 看一眼）'); break; }
      used += line.length;
      L.push(line);
    }
  } else {
    L.push('已有的技能：**一个都还没有**。这是正常状态——需要什么就自己写一个（见下）。');
  }
  L.push('');
  L.push('要读某个技能的全文：`Get-Content -LiteralPath \'<上面清单里的路径>\' -Encoding UTF8`'
    + '（路径就是 `<库路径>\\<技能名>\\SKILL.md`）。');
  L.push('');
  L.push('新建一个技能（用 shell 自己写，建完立即生效，不用重启）：');
  L.push('```powershell');
  L.push('$d = \'' + PUBLIC_DIR.replace(/'/g, "''") + '\\<技能名>\'');
  L.push('New-Item -ItemType Directory -Force -Path $d | Out-Null');
  L.push('Set-Content -LiteralPath "$d\\SKILL.md" -Encoding UTF8 -Value @\'');
  L.push('---');
  L.push('name: <技能名>');
  L.push('description: <一句话：什么时候该用它>');
  L.push('---');
  L.push('');
  L.push('## 什么时候用');
  L.push('...');
  L.push('## 怎么做');
  L.push('1. ...（写清命令原文，别写"运行一下那个脚本"）');
  L.push('## 坑');
  L.push('...');
  L.push("'@");
  L.push('```');
  L.push('写私有技能就把上面的路径换成私有的那个。**先判断该放哪**：只跟当前这件事有关的放私有，'
    + '以后别的对话也用得上的放公有。');
  L.push('不确定能不能跑通，就先跑一遍再把**实际跑通的命令**写进技能——凭印象写的步骤下次一定翻车。');
  return L.join('\n');
}

module.exports = {
  SKILLS_DIR, PUBLIC_DIR, PRIVATE_DIR,
  MAX_SKILLS, DIR_RE, CONV_RE,
  parseSkill, listSkills, readSkill, guardRules, skillsBrief,
};
