// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 启动记录回归：/api/bootlog 里的每一行都必须**真** —— 能对着现场复算出来。
// 不测"格式好看"，测的是"有没有编造"：
//   ① 行按真实时间单调递增、时间戳落在真实时间窗内
//   ② 报的 node 版本 / 端口 / 素材包数 / 表情数 / 对话存档数，全部由测试自己现场数一遍对比
//   ③ LLM 那行与 server/llm-config.json 是否真的存在保持一致
//   ④ 文件（run/boot.log）真的落了盘，且宿主写的行也能被读回来
//   ⑤ 上一次启动的残留会被剔除（PONKO_BOOT_LOG 预写一行旧时间的，必须不算数）
//   ⑥ 每一行的**事件 id 都在两个语言包里**（文案改了不该红，key 改了必须红）
//
// 启动日志存的是「事件 id + 参数」，句子由页面按当前语言渲染 —— 所以这里先渲染成英文
// 再核对内容（见 app/src/i18n/index.js 第 3 条、server/bootlog.js 顶部格式说明）。
// 跑法：node tools/test_boot.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { t, useLang } from '../app/src/i18n/index.js';
import en from '../app/src/i18n/en.js';
import zhCn from '../app/src/i18n/zh-cn.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 8907;
const BOOT_FILE = path.join(tmpdir(), `ponko-boot-test-${process.pid}.log`);
const results = [];
let failed = 0;
const chk = (name, ok, detail) => {
  results.push(name);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   → ' + detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

useLang('en');                                   // 断言的句子用英文渲染（简中在最后单独核一遍）
const render = (l) => (l.key ? t(String(l.key), l.args || {}) : String(l.text || ''));

// ── 预写"上一次启动"的残留（真实时间戳，但比本次启动早一天）→ 必须被剔除
const oldStamp = (() => {
  const d = new Date(Date.now() - 86400000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000`;
})();
fs.writeFileSync(BOOT_FILE, `${oldStamp}  host   上一次启动留下的行，不该出现在本次记录里\n`, 'utf8');

// ── 现场自己数一遍：素材包 / 表情 / 帧文件 / 对话存档
function realAssets() {
  const CHARS = path.join(ROOT, 'characters');
  let packs = 0, frames = 0, bytes = 0;
  const moods = new Set();
  for (const d of fs.readdirSync(CHARS)) {
    const pj = path.join(CHARS, d, 'frames', 'pack.json');
    if (!fs.existsSync(pj)) continue;
    packs++;
    const pack = JSON.parse(fs.readFileSync(pj, 'utf8'));
    for (const t of Object.keys(pack.moods || {})) moods.add(t);
    for (const n of fs.readdirSync(path.join(CHARS, d, 'frames'))) {
      if (n === 'preview.html') continue;
      bytes += fs.statSync(path.join(CHARS, d, 'frames', n)).size;
      frames++;
    }
  }
  return { packs, moods: moods.size, frames, bytes };
}
function realConvs() {
  const dir = path.join(ROOT, 'run', 'conversations');
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
}

const backend = spawn(process.execPath, ['server/server.js'], {
  cwd: ROOT,
  env: { ...process.env, PONKO_PORT: String(PORT), PONKO_BOOT_LOG: BOOT_FILE },
  stdio: 'ignore',
});

let boot = null;
for (let i = 0; i < 80; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/api/bootlog`); if (r.ok) { boot = await r.json(); break; } } catch (e) { /* 还没起来 */ }
  await sleep(150);
}
if (!boot) { console.log('后端没起来，测试中止'); backend.kill(); process.exit(3); }
// python -V 那行是真的起了一次解释器（本机实测 ~600ms），等它落进日志再核对，
// 否则测的是"还没探完"而不是"探得对不对"
await sleep(1500);
boot = await (await fetch(`http://127.0.0.1:${PORT}/api/bootlog`)).json();

// 渲染成英文句子后再核对内容（语言包换文案不影响这些断言）
let L = boot.lines.map((l) => ({ ...l, text: render(l) }));
const byKey = (k) => L.find((l) => l.key === k);

console.log('── 1. 结构 ──');
const TAGS = new Set(['host', 'node', 'llm', 'pack', 'pty', 'conv', 'sys', 'net']);
chk('有足够多的行', boot.lines.length >= 6, String(boot.lines.length));
chk('每行都有 ts/tag，且带事件 id（+参数）或原样文本',
  boot.lines.every((l) => l.ts > 0 && TAGS.has(l.tag)
    && (l.key ? typeof l.args === 'object' : String(l.text || '').length > 0)),
  JSON.stringify(boot.lines.filter((l) => !l.key && !l.text).slice(0, 2)));
chk('按真实时间单调不减', boot.lines.every((l, i) => i === 0 || l.ts >= boot.lines[i - 1].ts), '');
chk('时间戳落在真实时间窗内（启动前后 5 分钟内）',
  boot.lines.every((l) => Math.abs(Date.now() - l.ts) < 300000), '');
chk('elapsedMs 是真实的后端自检耗时', boot.elapsedMs > 0 && boot.elapsedMs < 60000, String(boot.elapsedMs));
chk('selfMs = 到开始监听为止的真实耗时（0 < selfMs ≤ elapsedMs）',
  boot.selfMs > 0 && boot.selfMs <= boot.elapsedMs, `${boot.selfMs} vs ${boot.elapsedMs}`);
chk('带上了真实的 pid / node 版本 / 端口',
  boot.pid > 0 && /^v\d+\./.test(boot.node) && boot.port === PORT,
  `${boot.pid} ${boot.node} ${boot.port}`);

console.log('\n── 2. 每一行都能对着现场复算 ──');
const A = realAssets();
const nodeLine = byKey('boot.node.runtime');
chk('node 行报的版本 = process 里真实的 node 版本',
  !!nodeLine && nodeLine.args.ver === boot.node, nodeLine && nodeLine.args.ver);
const listenLine = byKey('boot.node.listen');
chk('监听行报的端口是真的', !!listenLine && listenLine.args.port === PORT,
  listenLine && JSON.stringify(listenLine.args));
const packLine = byKey('boot.pack.count');
chk(`素材包数 = 现场数的 ${A.packs} 个`, !!packLine && packLine.args.packs === A.packs,
  packLine && JSON.stringify(packLine.args));
chk(`表情数 = 现场数的 ${A.moods} 个`, !!packLine && packLine.args.moods === A.moods,
  packLine && JSON.stringify(packLine.args));
chk(`帧文件数 = 现场数的 ${A.frames} 个`, !!packLine && packLine.args.frames === A.frames,
  packLine && JSON.stringify(packLine.args));
const rc = realConvs();
const convLine = byKey('boot.conv.count') || byKey('boot.conv.empty') || byKey('boot.conv.none');
chk(`对话存档数 = 现场数的 ${rc} 个`,
  !!convLine && (rc ? convLine.args.n === rc : convLine.key !== 'boot.conv.count'),
  convLine && JSON.stringify(convLine.args));
const sysLine = byKey('boot.sys.host');
chk('sys 行里是这台机器的真 CPU 型号',
  !!sysLine && String(sysLine.args.cpu).includes(os.cpus()[0].model.trim()),
  sysLine && JSON.stringify(sysLine.args));
const ptyLine = byKey('boot.pty.ok') || byKey('boot.pty.fail');
chk('pty 行是现场探到的解释器（成功报版本 / 失败就如实说失败）',
  !!ptyLine && (ptyLine.key === 'boot.pty.fail' || /Python \d/.test(ptyLine.args.out)),
  ptyLine && JSON.stringify(ptyLine.args));

console.log('\n── 3. LLM 行与磁盘状态一致 ──');
const hasCfg = fs.existsSync(path.join(ROOT, 'server', 'llm-config.json'));
const llmLine = L.find((l) => l.tag === 'llm');
chk(hasCfg ? 'llm-config.json 存在 → 行里说已接入' : 'llm-config.json 不存在 → 行里如实说未配置',
  !!llmLine && llmLine.key === (hasCfg ? 'boot.llm.on' : 'boot.llm.off'),
  llmLine && JSON.stringify(llmLine.args));
chk('llm 行绝不回显 key 明文',
  !!llmLine && !/gh[pousr]_|sk-[A-Za-z0-9]{8,}/.test(llmLine.text), llmLine && llmLine.text);

console.log('\n── 4. 真的落盘了（宿主与后端共用一份） ──');
chk('boot.log 真的写出来了', fs.existsSync(BOOT_FILE) && fs.statSync(BOOT_FILE).size > 0, BOOT_FILE);
const fileText = fs.readFileSync(BOOT_FILE, 'utf8');
chk('文件里存的是事件 id + 行尾紧凑 JSON（不是成品句子）',
  /^\d{4}-\d{2}-\d{2} .*  node   boot\.node\.\S+ \{.*\}$/m.test(fileText)
  && !/\bNode v\d/.test(fileText),          // 成品句子不该再出现在文件里
  fileText.split('\n').slice(-3).join(' | '));
chk('文件行数 ≥ 接口返回的行数（文件是唯一真源）',
  fileText.trim().split('\n').length >= boot.lines.length, `${fileText.trim().split('\n').length} vs ${boot.lines.length}`);

console.log('\n── 5. 上一次启动的残留不算数 ──');
chk('预写的老格式旧行被剔除了（老格式也仍能解析，只是不算数）',
  !L.some((l) => /上一次启动留下的行/.test(l.text)), '');
chk('剔除了多少行也如实报出来', boot.staleDropped === 1, String(boot.staleDropped));

console.log('\n── 6. 没有占位符 / 假数据 ──');
const SUSPECT = /lorem|ipsum|TODO|FIXME|xxx|XXX|\bfoo\b|bar baz|示例文本|假数据|mock|placeholder|待填/;
chk('整份日志里不含占位符或假数据标记',
  !L.some((l) => SUSPECT.test(l.text)),
  JSON.stringify(L.filter((l) => SUSPECT.test(l.text)).map((l) => l.text)));
chk('每行都带真实测量痕迹（数字或路径），不是空话',
  L.every((l) => /[\d\\/：:·]/.test(l.text)), JSON.stringify(L.filter((l) => !/[\d\\/：:·]/.test(l.text)).map((l) => l.text)));
chk('渲染后没有剩下没被替换的 {占位符}（参数齐不齐一眼看出）',
  L.every((l) => !/\{\w+\}/.test(l.text)),
  JSON.stringify(L.filter((l) => /\{\w+\}/.test(l.text)).map((l) => `${l.key} → ${l.text}`).slice(0, 3)));

console.log('\n── 7. 事件 id 在两个语言包里都有（文案可以改，key 不能飘） ──');
const missing = [];
for (const l of boot.lines) {
  if (!l.key) continue;                                  // 老格式/手写行不参与
  if (en[l.key] === undefined) missing.push(`en 缺 ${l.key}`);
  if (zhCn[l.key] === undefined) missing.push(`zh-cn 缺 ${l.key}`);
  for (const v of Object.values(l.args || {})) {         // 参数里的 @key 片段也要有译文
    if (typeof v === 'string' && v.startsWith('@')) {
      const k = v.slice(1);
      if (en[k] === undefined) missing.push(`en 缺 ${k}`);
      if (zhCn[k] === undefined) missing.push(`zh-cn 缺 ${k}`);
    }
  }
}
chk('每一行的 key（含参数里的 @片段）都能在两个语言包里查到译文',
  missing.length === 0, JSON.stringify([...new Set(missing)].slice(0, 6)));

console.log('\n── 8. 语言包决定句子：简中下就是中文 ──');
useLang('zh-cn');
const zhListen = t('boot.node.listen', { port: 8787, ms: 350 });
chk('切到简中后同一行渲染成中文', /监听/.test(zhListen) && zhListen.includes('8787'), zhListen);
const zhHost = t('boot.host.win', { mode: '@boot.host.mode.full', w: 1920, h: 1080, how: '@boot.host.how.splash', url: 'u' });
chk('嵌套 @片段 也跟着语言走（不是漏成英文）',
  /全屏无边框/.test(zhHost) && !/fullscreen/.test(zhHost), zhHost);
useLang('en');

console.log('\n── 9. 追加式：过一会儿再看只会更多 ──');
await sleep(2500);        // 等地理查询（异步）落进日志
const boot2 = await (await fetch(`http://127.0.0.1:${PORT}/api/bootlog`)).json();
chk('行数只增不减', boot2.lines.length >= boot.lines.length, `${boot.lines.length} → ${boot2.lines.length}`);
chk('前一次的行还都在（不会被重写掉）',
  boot.lines.every((l) => boot2.lines.some((m) => m.ts === l.ts && (m.key || m.text) === (l.key || l.text))), '');

backend.kill();
try { fs.unlinkSync(BOOT_FILE); } catch (e) { /* 清不掉就算了 */ }
console.log(`\n${results.length - failed}/${results.length} PASS`);
await sleep(200);            // 等子进程句柄收干净再退，否则 Windows 上 libuv 会打一句断言噪音
process.exit(failed ? 1 : 0);
