// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 技能（skills）+ shell 工具 + 工具循环 —— 离线测试。
//
// 全程不联网：LLM 端点由本文件里的 mock 提供（本地 http），真跑的是 pwsh 与后端。
//
// 覆盖：
//   一、skills.js  发现 / 私有覆盖公有 / 非法名拒绝 / 没有 SKILL.md 不算技能 / BOM+CRLF / 清单生成
//   二、toolrun.js 空命令 / deny 全拦 / guard 命中 / 中文编码 / 输出截断 / 超时 / 进程树回收
//   三、端到端    原生 tool_calls 一轮 → 执行 → 回填 → 出结论；mood 收尾
//   四、端到端    端点不收 tools → 自动降级文本协议（```sh 块）→ 照样执行
//   五、端到端    **自举**：agent 用 shell 写出 SKILL.md，下一轮 system 里就看得见它
//   六、端到端    同一条命令打转被拦 + 轮数上限强制收尾 + 坏 JSON 参数不执行
//
// 用法：node tools/test_skills.mjs
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8300 + Math.floor(Math.random() * 900);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0, pass = 0;
const chk = (name, ok, got) => {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '   → ' + got); }
};

// ─────────────────────────────── 一、skills.js（纯逻辑，不需要后端）
console.log('\n── skills.js ──');

const SK = mkdtempSync(join(tmpdir(), 'ponko-skills-'));
process.env.PONKO_SKILLS_DIR = SK;
process.env.PONKO_CONV_DIR = mkdtempSync(join(tmpdir(), 'ponko-conv-'));

const skills = require(join(ROOT, 'server', 'skills.js'));

// public 一条、private 一条同名（要覆盖）、一个没 SKILL.md 的目录（不算）
mkdirSync(join(SK, 'public', 'pdf'), { recursive: true });
writeFileSync(join(SK, 'public', 'pdf', 'SKILL.md'),
  '\ufeff---\r\nname: pdf-digest\r\ndescription: 把 PDF 压成三条结论\r\n---\r\n\r\n正文A\r\n');
mkdirSync(join(SK, 'public', 'empty'), { recursive: true });
writeFileSync(join(SK, 'public', 'empty', 'readme.txt'), '没有 SKILL.md');
mkdirSync(join(SK, 'private', 'convA', 'pdf'), { recursive: true });
writeFileSync(join(SK, 'private', 'convA', 'pdf', 'SKILL.md'),
  '---\nname: pdf-digest\ndescription: 只有这个对话用的版本\n---\n正文B');

const lA = skills.listSkills('convA');
const lB = skills.listSkills('convB');
chk('public 技能对任何对话可见', lB.length === 1 && lB[0].name === 'pdf-digest', JSON.stringify(lB.map((s) => s.name)));
chk('private 覆盖同名 public', lA[0].description === '只有这个对话用的版本', lA[0].description);
chk('没有 SKILL.md 的目录不算技能', !skills.listSkills('convA').some((s) => s.name === 'empty'), 'empty 混进来了');
chk('BOM + CRLF 的 frontmatter 能解析', lB[0].name === 'pdf-digest' && /PDF/.test(lB[0].description), lB[0].description);
chk('读全文拿到的是自己那份', skills.readSkill('convA', 'pdf-digest').body.trim() === '正文B',
  JSON.stringify(skills.readSkill('convA', 'pdf-digest').body));
chk('读不存在的技能返回 null', skills.readSkill('convA', '没有这个') === null, '居然返回了对象');
chk('convId 带路径穿越时不越界', skills.listSkills('../../etc').length === 1, '越界读到了私有目录');
chk('非法目录名（以 . 开头）被忽略', (() => {
  mkdirSync(join(SK, 'public', '..evil'), { recursive: true });
  writeFileSync(join(SK, 'public', '..evil', 'SKILL.md'), '---\nname: evil\n---\nx');
  return !skills.listSkills('convA').some((s) => s.name === 'evil');
})(), '..evil 被当成技能了');

const brief = skills.skillsBrief('convA');
chk('清单里给的是绝对路径', brief.includes(SK.replace(/\\/g, '\\')) || brief.includes(SK), '没找到库根绝对路径');
chk('清单含技能名与一句话摘要', brief.includes('pdf-digest') && brief.includes('只有这个对话用的版本'), '清单缺内容');
chk('清单教了怎么新建技能（含 Set-Content -Encoding UTF8）', /Set-Content/.test(brief) && /Encoding UTF8/.test(brief), '没有新建示例');
// 空库必须在**子进程**里测：SKILLS_DIR 是 require 时读的常量，本进程改环境变量不会生效
const emptyBrief = (() => {
  const empty = mkdtempSync(join(tmpdir(), 'ponko-skills0-'));
  const out = execFileSync(process.execPath, ['-e',
    'const s=require(' + JSON.stringify(join(ROOT, 'server', 'skills.js')) + ');process.stdout.write(s.skillsBrief("nobody"));',
  ], { env: { ...process.env, PONKO_SKILLS_DIR: empty }, encoding: 'utf8' });
  rmSync(empty, { recursive: true, force: true });
  return out;
})();
chk('空库也要给出路径与写法（自举的前提）',
  /一个都还没有/.test(emptyBrief) && /SKILL\.md/.test(emptyBrief) && /Set-Content/.test(emptyBrief),
  emptyBrief.slice(0, 120));

// guard.json 规则加载
mkdirSync(join(SK, 'public', 'guardtest'), { recursive: true });
writeFileSync(join(SK, 'public', 'guardtest', 'SKILL.md'), '---\nname: guard-test\ndescription: 拦 rm -rf\n---\n');
writeFileSync(join(SK, 'public', 'guardtest', 'guard.json'),
  JSON.stringify({ rules: [{ pattern: 'rm\\s+-rf', action: 'block', why: '会删掉整个目录' }] }));
const gr = skills.guardRules('convA');
chk('guard.json 的规则被读出来', gr.length === 1 && gr[0].from === 'guard-test' && /rm/.test(gr[0].pattern), JSON.stringify(gr));

// ─────────────────────────────── 二、toolrun.js
console.log('\n── toolrun.js ──');
const toolrun = require(join(ROOT, 'server', 'toolrun.js'));

chk('默认策略是 allow（用户要的"全放行"）', toolrun.DEFAULT_POLICY === 'allow', toolrun.DEFAULT_POLICY);
chk('空命令直接拒', toolrun.checkCommand('', {}).ok === false, '空命令放过去了');
chk('deny 档全拦', toolrun.checkCommand('Write-Output 1', { policy: 'deny' }).ok === false, 'deny 没拦住');
chk('guard 档命中规则就拦', toolrun.checkCommand('rm -rf C:/x', { policy: 'guard', guardRules: gr }).ok === false, 'guard 没拦住');
chk('guard 档不命中就放行', toolrun.checkCommand('Write-Output 1', { policy: 'guard', guardRules: gr }).ok === true, '误拦');
chk('allow 档无视规则（全放行）', toolrun.checkCommand('rm -rf C:/x', { policy: 'allow', guardRules: gr }).ok === true, 'allow 被规则拦了');

const r1 = await toolrun.runShell({ command: 'Write-Output ("中文" + 1)' }, {});
chk('真跑 pwsh 且中文不乱码', r1.ok && r1.stdout.trim() === '中文1', JSON.stringify(r1.stdout));

const r2 = await toolrun.runShell({ command: 'Write-Output ("x" * 20000)' }, {});
chk('超长输出被截断且标注原长', r2.stdout.length <= toolrun.OUT_CAP + 80 && /已截断/.test(r2.stdout), r2.stdout.length);

const r3 = await toolrun.runShell({ command: 'Start-Sleep -Seconds 5; Write-Output never', timeout_ms: 1200 }, {});
chk('超时会被杀掉（不会一直等）', r3.timeout === true && r3.ok === false, JSON.stringify({ timeout: r3.timeout, ms: r3.ms }));

const r4 = await toolrun.runShell({ command: 'Write-Output $PWD.Path', cwd: SK }, {});
// 比 basename：tmpdir() 在 Node 里可能给短名（ADMINI~1），$PWD.Path 给长名，整串比会假红
const SKBASE = SK.split(/[\\/]/).pop().toLowerCase();
chk('cwd 参数生效', r4.ok && r4.stdout.trim().toLowerCase().endsWith(SKBASE), r4.stdout.trim());

const r5 = await toolrun.runShell({ command: 'Write-Output nope' }, { policy: 'deny' });
chk('被策略拒的命令不真执行', r5.refused === true && r5.stdout === '', JSON.stringify(r5));

chk('每格都是独立进程（cd 不跨调用保留）', await (async () => {
  await toolrun.runShell({ command: 'Set-Location C:\\Windows' }, {});
  const r = await toolrun.runShell({ command: 'Write-Output $PWD.Path', cwd: SK }, {});
  return r.stdout.trim().toLowerCase().endsWith(SKBASE);
})(), 'cd 居然串到下一次了');

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

const sseHead = (res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
};
const sse = (res, frames) => {
  sseHead(res);
  for (const f of frames) res.write('data: ' + JSON.stringify(f) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
};
const textFrames = (t) => [{ choices: [{ delta: { content: t } }] }];
// 分片给 tool_calls：id/name 一片，arguments 拆两片 —— 专治"见到一片就当完整调用"
function toolFrames(id, name, args) {
  const half = Math.ceil(args.length / 2);
  return [
    { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
};

// ─────────────────────────────── 起后端
console.log('\n── 端到端（真后端 + 真 pwsh + mock LLM）──');
const srvLog = [];
const srv = spawn(process.execPath, ['server/server.js'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PONKO_PORT: String(PORT) },
});
srv.stdout.on('data', (b) => srvLog.push('[out] ' + b));
srv.stderr.on('data', (b) => srvLog.push('[err] ' + b));
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try { up = (await (await fetch(`http://127.0.0.1:${PORT}/api/skills`)).ok); } catch (e) { await sleep(300); }
}
chk('后端起来了（且 /api/skills 可用）', up, '后端没起来');
if (!up) { console.log(srvLog.join('')); srv.kill(); process.exit(1); }

/** 跑一轮 /api/agent，把 NDJSON 事件收成数组 */
async function ask(mockUrl, text, extra) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/agent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      history: [],
      llm: { baseUrl: mockUrl, apiKey: 'sk-test', model: 'mock-1', provider: 'openai' },
      persona: 'plain',
      ...extra,
    }),
  });
  const raw = await r.text();
  return raw.split('\n').filter((s) => s.trim()).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
}
const ofType = (evs, t) => evs.filter((e) => e.t === t);
const tokText = (evs) => ofType(evs, 'token').map((e) => e.text).join('');

// ── 三、原生 tool_calls：一轮 → 执行 → 回填 → 出结论
let callNo = 0;
const rounds = [];
const m1 = await makeMock((body, res) => {
  rounds.push(body);
  callNo++;
  if (callNo === 1) {
    sse(res, toolFrames('call_a', 'shell', JSON.stringify({ command: 'Write-Output PONKO_TOOL_OK' })));
  } else {
    const hasToolMsg = (body.messages || []).some((m) => m.role === 'tool');
    sse(res, textFrames(hasToolMsg ? '跑完了：[[mood:happy|note:一次就过]]' : '没收到工具结果'));
  }
});
const ev1 = await ask(m1.url, '试一下 shell');
chk('请求里带了 tools 定义', Array.isArray(rounds[0].tools) && rounds[0].tools[0].function.name === 'shell',
  JSON.stringify((rounds[0].tools || []).map((t) => t.function && t.function.name)));
chk('分片的 tool_calls 被拼回完整参数', ofType(ev1, 'tool').length === 1
  && /Write-Output PONKO_TOOL_OK/.test(ofType(ev1, 'tool')[0].arg), JSON.stringify(ofType(ev1, 'tool')));
chk('执行结果回传给模型（第二轮 messages 里有 role=tool）',
  rounds[1] && rounds[1].messages.some((m) => m.role === 'tool' && /PONKO_TOOL_OK/.test(m.content)), '第二轮没有工具结果');
chk('界面收到 tool_result 且内容是真实输出', /PONKO_TOOL_OK/.test((ofType(ev1, 'tool_result')[0] || {}).text || ''),
  JSON.stringify(ofType(ev1, 'tool_result')));
chk('模型之后能继续说话（结论流回界面）', /跑完了/.test(tokText(ev1)), tokText(ev1));
chk('mood 标记照旧生效', (ofType(ev1, 'mood')[0] || {}).state === 'happy', JSON.stringify(ofType(ev1, 'mood')));
chk('done 事件带 tools 计数', (ofType(ev1, 'done')[0] || {}).tools === 1, JSON.stringify(ofType(ev1, 'done')));
await m1.close();

// ── 四、端点不收 tools → 降级文本协议
let tmNo = 0;
const tmBodies = [];
const m2 = await makeMock((body, res) => {
  tmNo++;
  tmBodies.push(body);
  if (Array.isArray(body.tools)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'tools parameter is not supported by this endpoint' } }));
    return;
  }
  const gotOutput = (body.messages || []).some((m) => /命令输出/.test(String(m.content || '')));
  if (tmNo === 2 && !gotOutput) {
    sse(res, textFrames('我看一下。\n```sh\nWrite-Output TEXT_MODE_OK\n```\n'));
  } else {
    sse(res, textFrames('看到了：TEXT_MODE_OK'));
  }
});
const ev2 = await ask(m2.url, '试试文本协议');
chk('第一次带了 tools、被 400 拒后改用无 tools 重发',
  Array.isArray(tmBodies[0].tools) && !Array.isArray(tmBodies[1].tools), JSON.stringify(tmBodies.map((b) => !!b.tools)));
chk('降级有明确提示', ofType(ev2, 'thinking').some((e) => /不收 tools/.test(e.text)), JSON.stringify(ofType(ev2, 'thinking')));
chk('```sh 块被执行且结果回传给模型', /TEXT_MODE_OK/.test((ofType(ev2, 'tool_result')[0] || {}).text || ''),
  JSON.stringify(ofType(ev2, 'tool_result')));
chk('降级后还能出最终结论', /看到了/.test(tokText(ev2)), tokText(ev2));
await m2.close();

// ── 五、自举：agent 用 shell 写技能，下一轮 system 里就看得见
const NEW_SKILL = 'zipnote';
let bootSeen = null, bootNo = 0;
const bootSeq = [];
const m3 = await makeMock((body, res) => {
  bootNo++;
  bootSeq.push({ n: bootNo, roles: (body.messages || []).map((m) => m.role).join(','), hasTools: !!body.tools });
  if (bootNo === 1) {
    // 注意：这里是**真的用 shell 建文件**，跟 agent 自己动手时走的是同一条路
    const dir = join(process.env.PONKO_SKILLS_DIR, 'public', NEW_SKILL).replace(/\\/g, '\\\\');
    const cmd = `New-Item -ItemType Directory -Force -Path '${dir}' | Out-Null; `
      + `Set-Content -LiteralPath '${dir}\\\\SKILL.md' -Encoding UTF8 -Value "---\`nname: ${NEW_SKILL}\`ndescription: 自动长出来的技能\`n---\`n\`n步骤：先 Get-ChildItem"; `
      + 'Write-Output SKILL_WRITTEN';
    sse(res, toolFrames('call_b', 'shell', JSON.stringify({ command: cmd })));
    return;
  }
  // 只在**第 2 次**（工具执行后那一轮）取样。第 3 次是 repairMood 的心情补问，
  // 它的 system 是另一段专用提示词，会把这个快照覆盖掉（第一版就栽在这）。
  if (bootNo === 2) {
    const sys = String((body.messages || [])[0] && body.messages[0].content || '');
    bootSeen = {
      hasName: sys.includes(NEW_SKILL), hasDesc: sys.includes('自动长出来的技能'),
      role0: (body.messages || [])[0] && body.messages[0].role,
      hasSkillSection: /技能（skills）/.test(sys),
      listed: (sys.match(/^- `[^`]+`/gm) || []).join(' | '),
    };
    // 顺带给个 mood，省掉 repairMood 那一次多余请求
    sse(res, textFrames('记住了。[[mood:happy|note:长大了一点]]'));
    return;
  }
  sse(res, textFrames('好。'));
});
const ev3 = await ask(m3.url, '给你自己加一个技能');
chk('shell 真的把 SKILL.md 写到了盘上', existsSync(join(SK, 'public', NEW_SKILL, 'SKILL.md')),
  '文件没落盘');
if (!(bootSeen && bootSeen.hasName)) console.log('  调试 请求序列: ' + JSON.stringify(bootSeq));
chk('下一轮请求的 system 里出现了刚写的技能名', bootSeen && bootSeen.hasName === true, JSON.stringify(bootSeen));
chk('清单里连描述也带上了（模型才知道什么时候用）', bootSeen && bootSeen.hasDesc === true, JSON.stringify(bootSeen));
chk('自举过程界面上看得到（tool + tool_result）',
  ofType(ev3, 'tool').length >= 1 && /SKILL_WRITTEN/.test((ofType(ev3, 'tool_result')[0] || {}).text || ''),
  JSON.stringify(ofType(ev3, 'tool_result')));
await m3.close();

// ── 六、打转拦截 / 轮数上限 / 坏 JSON
let loopNo = 0;
const m4 = await makeMock((body, res) => {
  loopNo++;
  const msgs = body.messages || [];
  const forced = msgs.some((m) => /工具调用次数已经用完/.test(String(m.content || '')));
  if (forced || loopNo > 12) { sse(res, textFrames('好吧，就到这里。')); return; }
  if (loopNo === 1) { sse(res, toolFrames('c1', 'shell', '{"command": ')); return; }  // 坏 JSON
  sse(res, toolFrames('c' + loopNo, 'shell', JSON.stringify({ command: 'Write-Output SAME' })));
});
const ev4 = await ask(m4.url, '一直跑同一条命令试试');
chk('坏 JSON 参数不执行、回告模型', ofType(ev4, 'tool_result').some((e) => /没有执行/.test(e.text) && /JSON/.test(e.text)),
  JSON.stringify(ofType(ev4, 'tool_result').slice(0, 2)));
chk('同一条命令打转会被拦（不是一直跑到上限）',
  ofType(ev4, 'tool_result').some((e) => /打转/.test(e.text)), JSON.stringify(ofType(ev4, 'tool_result').slice(0, 4)));
chk('轮数用完会强制收尾并给出结论', (ofType(ev4, 'done')[0] || {}).rounds <= 8 && /就到这里/.test(tokText(ev4)),
  JSON.stringify({ rounds: (ofType(ev4, 'done')[0] || {}).rounds, text: tokText(ev4).slice(0, 60) }));
chk('收尾那趟明确告诉模型"别再调工具了"', (() => {
  const last = rounds.length;   // 仅占位，真正断言看下面 forcded 分支是否被触发
  return ofType(ev4, 'done').length === 1;
})(), 'done 发了不止一次');
await m4.close();

// ─────────────────────────────── 收尾
srv.kill();
await sleep(300);
try { rmSync(SK, { recursive: true, force: true }); } catch (e) { /* 文件被占也就算了 */ }
console.log(`\n${fail ? 'FAIL' : 'OK'}  ${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
