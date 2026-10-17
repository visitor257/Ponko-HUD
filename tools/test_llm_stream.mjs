// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 对话流回归：验证 OpenAI 兼容与 Anthropic 两套 SSE 都能被正确解析成 token 事件
// 配置验证（tools/test_llm.mjs）只证明"连得上"，这里证明"真能聊"——两套协议的
// SSE 报文格式完全不同（choices[0].delta.content vs content_block_delta.text_delta），
// 任一边解析写错，用户在界面上就只看到空白回答。
//   用法：node tools/test_llm_stream.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 注意：不能用 new URL().pathname —— 中文路径会被百分号编码，导致 spawn cwd ENOENT
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = 8793;
const BACKEND_PORT = 8794;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
const BACK = `http://127.0.0.1:${BACKEND_PORT}`;
const KEY = 'sk-stream-test';
const UI_TMP = path.join(os.tmpdir(), 'ponko-stream-test-ui.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
// 上游实际收到的 system 提示词（每轮 mock 都会覆盖）。
// 用它做**真·端到端**核对：性格 / 此刻心情是否一路走到了模型眼前，
// 而不只是"传进了后端"。比在源码里 grep 字符串可信得多。
let lastSys = '';
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   → ' + detail : ''}`);
}

// 模型写得不规矩时的输出：全角冒号 + 中文逗号 + 单侧括号 + 自创 state。
// 这些标记必须一个都不出现在对话里（老版本会因为认不出来而原样吐给用户）。
const WEIRD = ['[[心情：专注，face:thinking]]', '好的，我', '看一下。', '[mood:idle|face:idle|note:收工]'];

// ── mock：同一端口按路径分流，各按自己的协议吐 SSE ──────────────────
const mock = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let asked = '';
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const last = (body.messages || []).filter((m) => m.role === 'user').pop();
    asked = String((last && last.content) || body.text || '');
    // Anthropic 把 system 放顶层 body.system；OpenAI 兼容放进 messages[0]（role=system）
    const first = (body.messages || [])[0] || {};
    lastSys = String(body.system || (first.role === 'system' ? first.content : '') || '');
  } catch (e) { /* 读不到就当普通提问 */ }

  if (u.pathname === '/v1/messages') {
    // Anthropic：事件行 + data 行，文本在 delta.text 里
    if ((req.headers['x-api-key'] || '') !== KEY) { res.writeHead(401); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // 第一个片段故意是 "\n\n"：模型惯用 [[mood:...]] + 两个换行开头，
    // 标记剥掉后这俩换行就变成回复开头的空行，后端必须裁掉
    const parts = asked.includes('畸形') ? WEIRD
      : ['\n\n', 'HELLO', '-ANTH', 'ROPIC', '[[mood:idle|face:smile|note:收工]]'];
    for (const t of parts) {
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })}\n\n`);
    }
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end();
    return;
  }
  if (u.pathname === '/v1/chat/completions') {
    if ((req.headers.authorization || '') !== 'Bearer ' + KEY) { res.writeHead(401); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const parts = asked.includes('畸形') ? WEIRD
      : ['\n\n', 'HELLO', '-OPEN', 'AI', '[[mood:idle|face:smile|note:收工]]'];
    for (const t of parts) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.writeHead(404); res.end('nope');
});

// 打 /api/agent（NDJSON 流），把 token 拼回来
async function chat(ask = 'hi', llm, extra) {
  const r = await fetch(BACK + '/api/agent', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // llm = **这个对话自己的**配置（每个对话一份，随请求带过来）。
    // 不传 → 后端无从判断这个对话接的哪家，退回演示用的假 agent（本测试第 0 项就盯这个）。
    // extra = 额外请求字段（persona / mood），用来验证它们是否真被送进上游 system。
    body: JSON.stringify({ text: ask, history: [], ...(llm ? { llm } : {}), ...(extra || {}) }),
  });
  const body = await r.text();
  let text = '', done = false, err = '';
  const moods = [];
  let doneEv = null;
  for (const line of body.split('\n')) {
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
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  // 配置不再落任何全局文件（server/llm-config.json 那套已经删掉），所以这里**没有**
  // "测试前后要还原的现场"：每轮对话自带配置，跑完什么都不留 —— 这本身就是新机制的好处。
  const OPENAI = { baseUrl: MOCK_URL, apiKey: KEY, model: 'gpt-x', provider: 'openai', resolved: 'openai' };
  const ANTH = { baseUrl: MOCK_URL, apiKey: KEY, model: 'claude-x', provider: 'anthropic', resolved: 'anthropic' };

  const backend = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    // PONKO_UI_PATH 指向一个不存在的临时文件：本机若正好留着一份带心情的 run/ui-state.json，
    // 后端在"请求没带 mood"时会退回去读它 —— 那会让第 5 段"不带就不注入"的断言假红。
    // 隔离掉，测试结果只取决于它自己发的东西。
    env: { ...process.env, PONKO_PORT: String(BACKEND_PORT), PONKO_UI_PATH: UI_TMP },
    stdio: 'ignore',
  });
  let up = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BACK + '/index.html'); if (r.status === 200) { up = true; break; } } catch (e) {}
    await sleep(200);
  }
  if (!up) { console.log('backend 没起来，测试中止'); mock.close(); backend.kill(); process.exit(3); }

  // 0) 不带配置 → 退回演示用的假 agent：**不报错、也不去连真模型**
  let r = await chat('hi');
  record('没带 llm 配置 → 走演示假 agent，不报错', r.done && !r.err, JSON.stringify(r).slice(0, 110));

  // 1) OpenAI 兼容流
  r = await chat('hi', OPENAI);
  record('OpenAI 流解析正确', r.text === 'HELLO-OPENAI' && r.done && !r.err, JSON.stringify(r));
  record('OpenAI：回复开头的空两行被裁掉', !/^\s/.test(r.text) && r.text.startsWith('HELLO'), JSON.stringify(r.text.slice(0, 6)));
  record('OpenAI：done 带回收尾心情', !!r.doneEv && r.doneEv.mood && r.doneEv.mood.state === 'idle',
    JSON.stringify(r.doneEv && r.doneEv.mood));
  // 标记正文被剥掉了，但原文要随心情事件带回来 —— 界面显示的"心情语句"就是它
  record('心情事件带 raw 原文（可显示）',
    r.moods.length === 1 && r.moods[0].raw === '[[mood:idle|face:smile|note:收工]]',
    JSON.stringify(r.moods.map((m) => m.raw)));

  // 2) Anthropic 原生流
  r = await chat('hi', ANTH);
  record('Anthropic 流解析正确', r.text === 'HELLO-ANTHROPIC' && r.done && !r.err, JSON.stringify(r));
  record('Anthropic：回复开头的空两行被裁掉', !/^\s/.test(r.text) && r.text.startsWith('HELLO'), JSON.stringify(r.text.slice(0, 6)));
  record('Anthropic：done 带回收尾心情', !!r.doneEv && r.doneEv.mood && r.doneEv.mood.state === 'idle',
    JSON.stringify(r.doneEv && r.doneEv.mood));

  // 3) 协议写错时应当报错，而不是静默给空回答
  r = await chat('hi', { ...ANTH, apiKey: 'sk-wrong' });
  record('Anthropic 错 Key 有报错', !!r.err && /401/.test(r.err), r.err || JSON.stringify(r));

  // 4) 模型把标记写歪了（全角冒号/中文逗号/单括号/自创 state）：
  //    控制符一个都不许出现在对话里，心情仍要尽量生效
  r = await chat('畸形标记', OPENAI);
  const leak = /\[\[|\[?mood\s*[:：=]|心情\s*[:：=]/.test(r.text);
  record('畸形标记：正文里没有控制符', !leak, JSON.stringify(r.text));
  record('畸形标记：正文完整', r.text === '好的，我看一下。', JSON.stringify(r.text));
  record('畸形标记：心情仍然生效', r.moods.length >= 1 && r.moods[0].state === 'think',
    JSON.stringify(r.moods.map((m) => m.state)));
  record('畸形标记：收尾心情回传', !!r.doneEv && !!r.doneEv.mood, JSON.stringify(r.doneEv && r.doneEv.mood));

  // 5) 性格 + "此刻心情" 要一路走到**模型眼前**（前端传 → 后端校验 → buildSystemPrompt
  //    → 上游收到的 body）。分两段核：先确认不带时**不注入**（不凭空编），再确认带了就真进去。
  await chat('hi', OPENAI);                 // 不带 persona/mood：起手那份 system
  const bare = lastSys;
  record('不带心情 → system 里没有"你此刻的心情"段', !bare.includes('【你此刻的心情】'), '');
  record('persona=默认 → system 里没有"你的性格"段', !bare.includes('**你的性格**'), '');

  await chat('我今天有点烦', OPENAI,
    { persona: 'tsundere', mood: { state: 'error', note: '算了，不想说了', minutes: 4 } });
  const rich = lastSys;
  record('persona 进了上游 system（读到人设段）', rich.includes('**你的性格**'), '');
  record('人设段就是选中的那个性格（傲娇）', rich.includes('傲娇'), '');
  record('"此刻心情"进了上游 system', rich.includes('【你此刻的心情】'), '');
  record('注入了当时那个 state 的中文名（出错）', rich.includes('出错'), '');
  record('注入了当时的心里话原话', rich.includes('算了，不想说了'), '');
  record('注入了"保持了多久"', rich.includes('4 分钟'), '');

  // 脏 mood 不该被猜成某个合法值塞进去（宁可这段不出现）
  await chat('hi', OPENAI, { persona: 'nope-persona', mood: { state: 'zzz-bad' } });
  record('脏 persona 回落 default（system 里没人设段）', !lastSys.includes('**你的性格**'), '');
  record('脏 mood 不注入（不硬编一段假的顶上）', !lastSys.includes('【你此刻的心情】'), '');

  backend.kill();
  mock.closeAllConnections?.();
  mock.closeIdleConnections?.();
  await new Promise((r2) => mock.close(r2));
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length ? 1 : 0;
})();
