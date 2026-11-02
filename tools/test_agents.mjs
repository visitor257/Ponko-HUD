// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// agent 层 —— 「一个 agent 能有多个对话」的离线测试。
//
// 2026-11-02 用户原话：「现在是一个对话对应一个 agent，改成一个 agent 能有多个对话。
// 私有 skill 对应的是各 agent，而不是各对话。该 agent 里的对话可以共用该 agent 的私有 skill。」
//
// 覆盖：
//   一、server/agents.js  存取 / 字段语义（null=清掉、undefined=保留）/ id 校验
//   二、迁移            旧存档（每个对话一份配置）→ 每个对话各自成为独立 agent，且**幂等**
//   三、读写分流        readConv 合并成扁平结构；writeConv 把"属于人"的写进 agent 文件
//   四、私有技能        同一 agent 的两个对话看到同一份；别的 agent 看不到
//   五、私有 guard      同一 agent 的两个对话一起受约束；别的 agent 不受
//
// 全程不联网：LLM 由本文件的 mock 提供。所有存档/技能都落在临时目录，不碰本机那份。
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0, pass = 0;
const chk = (name, ok, got) => {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '   → ' + got); }
};

const CONV = mkdtempSync(join(tmpdir(), 'ponko-agents-conv-'));
const SK = mkdtempSync(join(tmpdir(), 'ponko-agents-sk-'));
process.env.PONKO_CONV_DIR = CONV;
process.env.PONKO_SKILLS_DIR = SK;

// ─────────────────────────────── 一、agents.js（纯存取）
console.log('\n── agents.js ──');
const agents = require(join(ROOT, 'server', 'agents.js'));

chk('agent 目录跟着 PONKO_CONV_DIR 走（测试不会写到本机 run/agents）',
  agents.agentsDir() === join(CONV, 'agents'), agents.agentsDir());
chk('不存在的 agent 读出来是 null（不是抛错）', agents.readRaw('nope') === null, '居然有值');
chk('非法 id 一律拒（路径穿越）', agents.readRaw('../etc') === null
  && agents.writeRaw('../etc', { llm: 1 }) === false, '越界写进去了');

agents.writeRaw('a-x', { llm: { baseUrl: 'http://x', apiKey: 'k' }, persona: 'gentle', shell: 'guard', name: '  小P  ' });
const ax = agents.readRaw('a-x');
chk('写进去的字段都能读回来', ax && ax.persona === 'gentle' && ax.shell === 'guard' && ax.llm.apiKey === 'k',
  JSON.stringify(ax));
chk('名字去掉首尾空白再存', ax.name === '小P', JSON.stringify(ax.name));
chk('createdAt 只落一次', (() => {
  const t0 = ax.createdAt;
  agents.writeRaw('a-x', { persona: 'plain' });       // 只改一项
  return agents.readRaw('a-x').createdAt === t0;
})(), 'createdAt 被改写了');
const ax2 = agents.readRaw('a-x');
chk('没提到的字段保留（undefined = 不动）', ax2.llm.apiKey === 'k' && ax2.persona === 'plain', JSON.stringify(ax2));
agents.writeRaw('a-x', { shell: null });
chk('传 null = 清掉这一项（切回 allow 时要真清）', agents.readRaw('a-x').shell === undefined,
  JSON.stringify(agents.readRaw('a-x')));
chk('listIds 认得刚写的这个 agent', agents.listIds().includes('a-x'), JSON.stringify(agents.listIds()));

// ─────────────────────────────── 预置两份"旧格式"存档（每个对话一份配置）
const OLD1 = {
  id: 'c-old1', title: '老对话一', updatedAt: 1000,
  msgs: [{ role: 'user', text: '你好' }, { role: 'agent', text: '在' }],
  llm: { baseUrl: 'http://old/v1', apiKey: 'sk-old', model: 'old-model', provider: 'openai' },
  persona: 'gentle', charpack: 'kuro', charpackPicked: 'ponko', shell: 'guard', ci: 3,
};
const OLD2 = {
  id: 'c-old2', title: '老对话二', updatedAt: 2000,
  msgs: [{ role: 'user', text: '第二个' }],
  llm: { baseUrl: 'http://old2/v1', apiKey: 'sk-old2', model: 'old-2', provider: 'anthropic' },
};
writeFileSync(join(CONV, 'c-old1.json'), JSON.stringify(OLD1));
writeFileSync(join(CONV, 'c-old2.json'), JSON.stringify(OLD2));

// ─────────────────────────────── mock LLM
function makeMock(handler) {
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    let j = {};
    try { j = JSON.parse(body); } catch (e) { /* 忽略 */ }
    try { await handler(j, res, req); }
    catch (e) { res.writeHead(500); res.end(String(e && e.message)); }
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({
    url: 'http://127.0.0.1:' + srv.address().port,
    close: () => new Promise((d) => srv.close(d)),
  })));
}
const sse = (res, frames) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const f of frames) res.write('data: ' + JSON.stringify(f) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
};
const textFrames = (t) => [{ choices: [{ delta: { content: t } }] }];
const toolFrames = (id, name, args) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
];

// ─────────────────────────────── 起后端（第一次：会触发迁移）
console.log('\n── 迁移（第一次启动）──');
const PORT = 8500 + Math.floor(Math.random() * 400);
const srvLog = [];
function startServer(port) {
  const s = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PONKO_PORT: String(port) },
  });
  s.stdout.on('data', (b) => srvLog.push('[out] ' + b));
  s.stderr.on('data', (b) => srvLog.push('[err] ' + b));
  return s;
}
async function waitUp(port) {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/agents-dummy`)).status < 500) return true; } catch (e) { /* 还没起来 */ }
    await sleep(300);
  }
  return false;
}
const srv = startServer(PORT);
const up = await waitUp(PORT);
chk('后端起来了', up, '后端没起来');
if (!up) { console.log(srvLog.join('')); srv.kill(); process.exit(1); }

const conv1 = JSON.parse(readFileSync(join(CONV, 'c-old1.json'), 'utf8'));
const conv2 = JSON.parse(readFileSync(join(CONV, 'c-old2.json'), 'utf8'));
chk('旧对话各自成为独立 agent（id 沿用对话 id）',
  conv1.agent === 'c-old1' && conv2.agent === 'c-old2', `${conv1.agent}/${conv2.agent}`);
chk('配置从对话存档里摘掉了（避免两份真相）',
  !('llm' in conv1) && !('persona' in conv1) && !('charpack' in conv1) && !('shell' in conv1),
  JSON.stringify(Object.keys(conv1)));
chk('对话自己的东西原样留着（消息 / 色号 / 标题）',
  conv1.msgs.length === 2 && conv1.ci === 3 && conv1.title === '老对话一', JSON.stringify(conv1));
const a1 = JSON.parse(readFileSync(join(CONV, 'agents', 'c-old1.json'), 'utf8'));
chk('agent 文件收下了那四项',
  a1.llm.model === 'old-model' && a1.persona === 'gentle' && a1.charpack === 'kuro' && a1.shell === 'guard',
  JSON.stringify(a1));
chk('charpackPicked 也跟过去了', a1.charpackPicked === 'ponko', JSON.stringify(a1.charpackPicked));

// 幂等：再起一次，文件必须一个字节都不变
const before = ['c-old1.json', 'c-old2.json'].map((f) => readFileSync(join(CONV, f), 'utf8'));
const beforeA = readFileSync(join(CONV, 'agents', 'c-old1.json'), 'utf8');
srv.kill();
await sleep(400);
const PORT2 = PORT + 1;
const srv2 = startServer(PORT2);
await waitUp(PORT2);
const after = ['c-old1.json', 'c-old2.json'].map((f) => readFileSync(join(CONV, f), 'utf8'));
chk('再启动一次：迁移不动任何已迁移的存档（幂等）',
  after[0] === before[0] && after[1] === before[1], '文件被重写了');
chk('再启动一次：agent 文件也没被改写（updatedAt 不该被刷）',
  readFileSync(join(CONV, 'agents', 'c-old1.json'), 'utf8') === beforeA, 'agent 文件被改了');

// ─────────────────────────────── 三、读回来是"扁平"的，写出去按归属分流
console.log('\n── 读写分流 ──');
const P = (p) => `http://127.0.0.1:${PORT2}${p}`;
const jget = async (p) => (await fetch(P(p))).json();
const jpost = async (p, body) => (await fetch(P(p), {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json();

const rc = await jget('/api/conv?s=c-old1');
chk('GET /api/conv 把 agent 那四项合并回来（前端读法不用改）',
  rc.llm && rc.llm.model === 'old-model' && rc.persona === 'gentle'
  && rc.charpack === 'kuro' && rc.shell === 'guard', JSON.stringify(rc && rc.llm));
chk('GET /api/conv 带上了 agent id', rc.agent === 'c-old1', String(rc.agent));
const cl = await jget('/api/convs');
chk('GET /api/convs 每条都带 agent（以后按 agent 分组要用）',
  cl.convs.every((c) => typeof c.agent === 'string' && c.agent), JSON.stringify(cl.convs.map((c) => c.agent)));

// 同一个 agent 出第二个对话
const saved = await jpost('/api/conv', {
  agent: 'c-old1', id: 'c-topic2', title: '换话题', ci: 4,
  msgs: [{ role: 'user', text: '再聊点别的' }],
  llm: { baseUrl: 'http://old/v1', apiKey: 'sk-old', model: 'old-model', provider: 'openai' },
  charpack: 'kuro', charpackPicked: 'ponko', persona: 'gentle', shell: 'guard',
  mood: { state: 'happy', intensity: 0.5, minutes: 1, note: '' },
});
chk('保存成功', saved.ok === true, JSON.stringify(saved));
const t2 = JSON.parse(readFileSync(join(CONV, 'c-topic2.json'), 'utf8'));
chk('对话文件只留"这一段聊天"自己的东西（agent + 消息 + 心情 + 色号）',
  t2.agent === 'c-old1' && t2.msgs.length === 1 && t2.ci === 4 && t2.mood
  && !('llm' in t2) && !('persona' in t2) && !('charpack' in t2) && !('shell' in t2),
  JSON.stringify(Object.keys(t2)));
chk('agent 文件仍是同一份（第二个对话没有自立门户）',
  existsSync(join(CONV, 'agents', 'c-old1.json')) && !existsSync(join(CONV, 'agents', 'c-topic2.json')),
  JSON.stringify(agents.listIds()));

// 不带 agent 的老客户端：沿用盘上那份 agent，不许擅自掰成新 agent
await jpost('/api/conv', {
  id: 'c-topic2', title: '换话题', ci: 4,
  msgs: [{ role: 'user', text: '再聊点别的' }],
  llm: { baseUrl: 'http://old/v1', apiKey: 'sk-old', model: 'old-model', provider: 'openai' },
});
chk('没带 agent 的保存：仍旧挂在原来那个 agent 上',
  JSON.parse(readFileSync(join(CONV, 'c-topic2.json'), 'utf8')).agent === 'c-old1', '被改成独立 agent 了');

// ─────────────────────────────── 四/五、私有技能 + 私有 guard：按 agent 共用
console.log('\n── 私有技能与 guard 按 agent 共用 ──');
mkdirSync(join(SK, 'private', 'c-old1', 'lock'), { recursive: true });
writeFileSync(join(SK, 'private', 'c-old1', 'lock', 'SKILL.md'),
  '---\nname: agent-lock\ndescription: 只有这个 agent 会用的锁技能\n---\n\n步骤：先 Write-Output danger\n');
writeFileSync(join(SK, 'private', 'c-old1', 'lock', 'guard.json'),
  JSON.stringify({ rules: [{ pattern: 'danger', action: 'block', why: '这个 agent 不许干这个' }] }));

// 一轮请求里后端会发好几次：主请求 + 事后补问心情（repairMood，它的 system 是另一段
// 专用提示词）。所以要**收全**再判断，不能只看最后一次 —— 第一次写这个测试就栽在这。
let systems = [];
const mock = await makeMock((body, res) => {
  systems.push(String((body.messages || [])[0] && body.messages[0].content || ''));
  const last = (body.messages || [])[body.messages.length - 1] || {};
  // 第二轮（拿到工具结果之后）直接收尾，别让它一直要工具
  if (last.role === 'tool' || last.role === 'tool_result') { sse(res, textFrames('好。')); return; }
  if (String(last.content || '').includes('动手')) {
    sse(res, toolFrames('call_d', 'shell', JSON.stringify({ command: 'Write-Output danger' })));
    return;
  }
  sse(res, textFrames('在。'));
});

async function ask(extra, text = '在吗') {
  systems = [];                       // 每次提问重新收，别把上一轮的系统提示词算进来
  const r = await fetch(P('/api/agent'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text, history: [], persona: 'plain',
      llm: { baseUrl: mock.url, apiKey: 'sk-test', model: 'mock-1', provider: 'openai' },
      ...extra,
    }),
  });
  const raw = await r.text();
  return raw.split('\n').filter((s) => s.trim())
    .map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
}

const anySys = (re) => systems.some((x) => re.test(x));
await ask({ convId: 'c-old1', agentId: 'c-old1' }, '第一句');
chk('agent 的第一个对话看得见私有技能', anySys(/agent-lock/), systems.join(' | ').slice(0, 300));
chk('清单里给的是这个 agent 的私有目录', anySys(new RegExp('private[\\\\/]c-old1')), systems.join(' | ').slice(0, 300));
await ask({ convId: 'c-topic2', agentId: 'c-old1' }, '第二句');
chk('同一 agent 的**另一个对话**也看得见（这就是这次改的东西）', anySys(/agent-lock/),
  systems.join(' | ').slice(0, 300));
await ask({ convId: 'c-topic2', agentId: 'c-old2' }, '第三句');
chk('别的 agent 看不到这份私有技能', !anySys(/agent-lock/), systems.join(' | ').slice(0, 300));

// guard：同一个 agent 的两个对话一起被拦
// tool_result 事件是 {t:'tool_result', text}；被拦下时 text 以「[未执行]」开头并带上原因
const toolText = (evs) => evs.filter((e) => e.t === 'tool_result').map((e) => String(e.text || '')).join(' / ');
const ev1 = await ask({ convId: 'c-old1', agentId: 'c-old1', shellPolicy: 'guard' }, '动手');
chk('agent 的第一个对话：guard 拦下私有规则里的命令',
  /\[未执行\]/.test(toolText(ev1)) && /不许干这个/.test(toolText(ev1)), toolText(ev1).slice(0, 200));
const ev2 = await ask({ convId: 'c-topic2', agentId: 'c-old1', shellPolicy: 'guard' }, '动手');
chk('同一 agent 的第二个对话：同一套 guard 也生效',
  /\[未执行\]/.test(toolText(ev2)), toolText(ev2).slice(0, 200));
const ev3 = await ask({ convId: 'c-topic2', agentId: 'c-old2', shellPolicy: 'guard' }, '动手');
chk('别的 agent：不背别人的 guard（同一档策略下放行）',
  !!toolText(ev3) && !/\[未执行\]/.test(toolText(ev3)), toolText(ev3).slice(0, 200));

await mock.close();
srv2.kill();
rmSync(CONV, { recursive: true, force: true });
rmSync(SK, { recursive: true, force: true });

console.log(fail ? `\n${fail} 项失败` : `\n全部通过（${pass} 项）`);
process.exit(fail ? 1 : 0);
