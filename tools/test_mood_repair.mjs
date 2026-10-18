// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 心情兜底的回归：**模型整轮没写 [[mood:...]] 时，后端要单独补问一次**。
//
// 2026-10-18 用户报「起码有两次心情设置有错误」。翻存档只能看到正文（标记早被剥掉了），
// 拿同一段历史复现才发现：那几轮模型根本没发标记 —— 三次里三次都没发。漏发不报错，
// 界面只是停在上一副表情上，用户看到的就是"设了没生效"。
//
// 这个脚本钉住四件事：
//   ① 整轮没标记 → 补问一次，补出来的心情照常发给界面（done 也带着）
//   ② 补问请求是**非流式、只问一行标记**，而且只发一次
//   ③ 有标记的正常回复 → **绝不额外补问**（别每次都多花一次钱）
//   ④ 补问失败（上游 500）→ 不报错、不硬塞心情，这一轮就当没声明
//
//   用法：node tools/test_mood_repair.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = 8795;
const BACKEND_PORT = 8796;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
const BACK = `http://127.0.0.1:${BACKEND_PORT}`;
const KEY = 'sk-repair-test';
const TMP = path.join(os.tmpdir(), 'ponko-mood-repair-' + process.pid);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function chk(name, ok, extra) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined && extra !== '' ? '   → ' + extra : ''}`);
}

// ── mock：一个端口两种问法 ────────────────────────────────────────
//   stream:true   → 正常流式正文；按 case 决定要不要带标记
//   stream:false  → 这是"补问"，返回一行标记（或按 case 返回 500）
let caseName = 'norepair';
let repairCalls = 0;
let repairSys = '';
let repairAsk = '';
let streamCalls = 0;
let sawStreamFlag = null;

const mock = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/v1/chat/completions') { res.writeHead(404); res.end('nope'); return; }
  let body = {};
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch (e) { /* 读不到就按默认 */ }

  if (!body.stream) {
    repairCalls++;
    sawStreamFlag = body.stream;
    repairSys = String((body.messages || [])[0] && (body.messages || [])[0].content || '');
    repairAsk = String(((body.messages || [])[1] || {}).content || '');
    if (caseName === 'repairfail') { res.writeHead(500); res.end('{"error":"boom"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: '[[mood:sleepy|face:sleepy|i:0.6|until:600000|note:懒得动]]' } }],
    }));
    return;
  }

  streamCalls++;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const parts = caseName === 'norepair'
    ? ['\n\n', '好，就定在 sleepy 上。', '这档懒得展开。', '[[mood:sleepy|face:sleepy|i:0.6|note:定好了]]']
    : ['\n\n', '行，就这样吧。', '不往下走了。'];      // ← 一句标记都没有
  for (const t of parts) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
});

async function chat() {
  const r = await fetch(BACK + '/api/agent', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: '设为第四个',
      history: [],
      llm: { baseUrl: MOCK_URL, apiKey: KEY, model: 'gpt-x', provider: 'openai', resolved: 'openai' },
    }),
  });
  const raw = await r.text();
  let text = '', done = false, err = '';
  const moods = [];
  let doneEv = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    if (o.t === 'token') text += o.text || '';
    else if (o.t === 'done') { done = true; doneEv = o; }
    else if (o.t === 'error') err = o.text || '';
    else if (o.t === 'mood') moods.push(o);
  }
  return { text, done, err, moods, doneEv };
}

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  const backend = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PONKO_PORT: String(BACKEND_PORT), PONKO_CONV_DIR: TMP },
    stdio: 'ignore',
  });
  let up = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BACK + '/index.html'); if (r.status === 200) { up = true; break; } } catch (e) {}
    await sleep(200);
  }
  if (!up) { console.log('backend 没起来，测试中止'); mock.close(); backend.kill(); process.exit(3); }

  // ① 整轮没标记 → 补问一次并落地
  caseName = 'miss';
  let r = await chat();
  chk('没标记的回复照样把正文给出来', r.done && r.text.includes('不往下走了'), JSON.stringify(r.text));
  chk('补问了一次（非流式，只问一行标记）', repairCalls === 1 && sawStreamFlag === false,
    `calls=${repairCalls} stream=${sawStreamFlag}`);
  chk('补问的 system 里有 STATE 枚举和格式', repairSys.includes('idle / think / working / sleepy / angry / error')
    && repairSys.includes('[[mood:STATE|face:标签'), JSON.stringify(repairSys.slice(0, 60)));
  chk('补问带上了它刚说的正文', repairAsk.includes('不往下走了'), JSON.stringify(repairAsk.slice(0, 40)));
  chk('补出来的心情发给了界面', r.moods.length === 1 && r.moods[0].state === 'sleepy',
    JSON.stringify(r.moods));
  chk('done 里也有收尾心情', !!r.doneEv && r.doneEv.mood && r.doneEv.mood.state === 'sleepy',
    JSON.stringify(r.doneEv && r.doneEv.mood));
  let log = '';
  try { log = fs.readFileSync(path.join(TMP, 'mood.log'), 'utf8'); } catch (e) { log = ''; }
  chk('mood.log 记了一行 repair', /	repair	/.test(log) && log.includes('sleepy'), JSON.stringify(log.trim().slice(0, 80)));

  // ② 正常回复自带标记 → 不许补问（别每次都多花一次钱）
  caseName = 'norepair';
  const before = repairCalls;
  r = await chat();
  chk('自带标记的回复不触发补问', repairCalls === before, `calls=${repairCalls}`);
  chk('自带标记时心情来自流里那一条',
    r.moods.length === 1 && r.moods[0].raw === '[[mood:sleepy|face:sleepy|i:0.6|note:定好了]]',
    JSON.stringify(r.moods));

  // ③ 补问失败 → 不报错、不硬塞心情
  caseName = 'repairfail';
  const calls0 = repairCalls;
  r = await chat();
  chk('补问问挂了也不报错（回复照常收尾）', r.done && !r.err, JSON.stringify({ done: r.done, err: r.err }));
  chk('补问失败时这一轮就没有心情事件（界面保持原样，绝不硬塞）',
    r.moods.length === 0 && !!r.doneEv && !r.doneEv.mood,
    JSON.stringify({ moods: r.moods.length, mood: r.doneEv && r.doneEv.mood }));
  chk('失败那次确实尝试过补问', repairCalls === calls0 + 1, `calls=${repairCalls}`);

  console.log(`\n${failed ? 'FAILED ' + failed : '全部通过'}`);
  // 收尾：fetch 用的是 keep-alive 连接，直接 exit 会在 Windows 上撞 libuv 断言
  // （UV_HANDLE_CLOSING），退出码变成 127 —— 于是"全绿"也会被当成失败。
  if (mock.closeAllConnections) mock.closeAllConnections();
  mock.close();
  backend.kill();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  await sleep(200);
  process.exit(failed ? 1 : 0);
})();
