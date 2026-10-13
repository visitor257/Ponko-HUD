// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
'use strict';

// 启动记录：**只记真实发生过的事** —— 谁、在什么时刻、做了什么、花了多久。
//
// 宿主 native_host.py 与后端 server.js 都往同一个文件里追加；前端 GET /api/bootlog
// 取回去在启动画面上逐行回放。所以启动画面上的每一行背后都有一个真实动作，
// 时间戳也是真的（回放时只压缩"行与行之间"的间隔，时间戳原样显示）。
//
// 文件格式（人可读，同时也是唯一的真源）——**事件 id + 参数**，不是成品句子：
//   2026-10-11 22:41:03.104  host   boot.host.mutex {"id":"Ponko-HUD.Desktop"}
//
// 为什么是 id 而不是句子：启动画面上的语言要跟着语言包走，而这些行在页面拿到语言包
// **之前**就落盘了 —— 只有把"发生了什么"和"参数是什么"存下来，页面才能用当前语言
// 重新渲染（见 app/src/i18n/*.js 与 boot.js 的 replay()）。`{...}` 一定是行尾那段
// 紧凑 JSON，所以按"前三个空白分隔字段 + 剩下的当 JSON"解析，正文里带空格也不会错。
// 老格式（第三个字段直接是句子）仍能解析，会落成 {ts, tag, text} 原样显示。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// 测试用 PONKO_BOOT_LOG 指到临时文件，免得污染真机的 run/boot.log
const FILE = process.env.PONKO_BOOT_LOG || path.join(ROOT, 'run', 'boot.log');
const T0 = Date.now();

// 自检里的"多久"都以本模块加载为原点 —— 后端进程一切从这里开始算
const STALE_MS = 30000;      // 早于本次启动 30s 的文件行：上一次启动留下的残留，不算数

const p2 = (n, w = 2) => String(n).padStart(w, '0');
function stamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} `
    + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p2(d.getMilliseconds(), 3)}`;
}

const TS_PAT = String.raw`(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})`;
// 新格式：时间戳 · tag · key · 行尾紧凑 JSON 参数
const STRUCT_RE = new RegExp(`^${TS_PAT}\\s+(\\S+)\\s+(\\S+)\\s+(\\{.*\\})$`);
// 老格式 / 手写行：时间戳 · tag · 任意文本（原样显示，不翻译）
const LEGACY_RE = new RegExp(`^${TS_PAT}\\s+(\\S+)\\s+(.+)$`);

function parse(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const s = raw.trim();
    if (!s) continue;
    const m = STRUCT_RE.exec(s);
    if (m) {
      const ts = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime();
      if (!Number.isFinite(ts)) continue;
      let args = {};
      try { args = JSON.parse(m[10]) || {}; } catch (e) { args = {}; }   // 参数坏了也别丢这一行
      out.push({ ts, tag: m[8], key: m[9], args });
      continue;
    }
    const l = LEGACY_RE.exec(s);
    if (!l) continue;
    const ts = new Date(+l[1], +l[2] - 1, +l[3], +l[4], +l[5], +l[6], +l[7]).getTime();
    if (!Number.isFinite(ts)) continue;
    out.push({ ts, tag: l[8], text: l[9] });
  }
  return out;
}

// 本次进程自己写的行（文件写不进去时的兜底，也用于和文件内容对账）
const mem = [];
let fileOk = true;
let selfMs = 0;              // 后端自己走完自检（能开始监听）用了多久 —— 由 server.js 落定

/** 后端自检完成（listen 起来那一刻）由 server.js 调一次，记下真实耗时 */
function settle() {
  selfMs = Date.now() - T0;
  return selfMs;
}

/** 记一条真实启动日志：事件 id + 参数。tag：host / node / llm / pack / pty / conv / sys / net */
function emit(tag, key, args) {
  const ts = Date.now();
  const a = args || {};
  const line = { ts, tag: String(tag), key: String(key), args: a };
  mem.push(line);
  if (fileOk) {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      const payload = JSON.stringify(a);            // 紧凑、无空格 → 行尾那段就是它
      fs.appendFileSync(FILE, `${stamp(ts)}  ${String(tag).padEnd(6)} ${line.key} ${payload}\n`);
    } catch (e) { fileOk = false; }
  }
  return line;
}

// 文件里那些"上一次启动"的行：本进程一加载就点一次数，好让第一行如实说出忽略了什么
const stale = (() => {
  try { return parse(fs.readFileSync(FILE, 'utf8')).filter((l) => l.ts < T0 - STALE_MS).length; }
  catch (e) { return 0; }
})();

/** 合并后的完整启动记录：宿主写进文件的 + 本进程的，按真实时间排序去重 */
function lines() {
  let fromFile = [];
  try {
    fromFile = parse(fs.readFileSync(FILE, 'utf8')).filter((l) => l.ts >= T0 - STALE_MS);
  } catch (e) { fromFile = []; }
  const seen = new Set();
  const merged = [];
  const push = (l) => {
    const k = `${l.ts}|${l.tag}|${l.key || l.text}`;
    if (seen.has(k)) return;
    seen.add(k);
    merged.push(l);
  };
  fromFile.forEach(push);
  mem.forEach(push);
  merged.sort((a, b) => a.ts - b.ts);
  return merged;
}

function snapshot(extra) {
  const now = Date.now();
  return Object.assign({
    node: process.version,
    pid: process.pid,
    ppid: process.ppid,
    t0: T0,
    now,
    elapsedMs: now - T0,      // 请求这一刻，后端进程已经活了多久
    selfMs,                   // 后端自检本身花了多久（到开始监听为止）
    file: path.relative(ROOT, FILE).split(path.sep).join('/'),
    staleDropped: stale,
    lines: lines(),
  }, extra || {});
}

module.exports = { emit, lines, snapshot, settle, FILE, T0, staleDropped: stale };
