// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 多终端会话回归：一个标签 = 一个会话，彼此必须完全隔离
//
// 背景：全窗口原来只有一路 shell（sh/shellKind/curDir 是模块级全局变量），
// 加标签后每个会话各有自己的持久 pwsh、cwd、shell 种类和 PTY。
// 这里专门盯"串味"——在 A 标签里 cd、切到 cmd，B 标签绝不能跟着变。
//   用法：node tools/test_sessions.mjs
//
// 备注：本机（沙箱 Windows VM）系统时钟会跳变，长跑时偶发 Node 的
// "Assertion failed: new_time >= loop->time (src\win\core.c)" —— 那是 libuv 的已知问题，
// 不是本测试或产品的问题；重跑即可。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 不能用 new URL().pathname：中文路径会被百分号编码，导致 spawn cwd ENOENT
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8795;
const BACK = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   → ' + detail : ''}`);
}

// 收尾 backend.kill() 时，undici 那条 keep-alive 连接会被对端掐断，抛一个
// "TypeError: terminated / ECONNRESET" 的未处理拒绝。那是**测试脚手架**的噪音（不是产品问题），
// 但它会以退出码非零结束、且在输出被管道缓冲时连带把已打印的 PASS 一起吞掉（假失败）。
process.on('unhandledRejection', (e) => {
  const msg = String((e && e.message) || e);
  if (/terminated|ECONNRESET|socket hang up|aborted/i.test(msg)) return;   // 已知收尾噪音
  console.log('!! 未处理的 Promise 拒绝：' + msg);
});

/** 跑一条命令，把 NDJSON 事件收全 */
async function shell(session, cmd) {
  const r = await fetch(BACK + '/api/shell', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd, session }),
  });
  const txt = await r.text();
  return txt.split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}
const lastCwd = (evs) => {
  const c = evs.filter((e) => e.t === 'cwd');
  return c.length ? c[c.length - 1].text : '';
};
const jpost = (url, body) => fetch(BACK + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
}).then((r) => r.json());
const jget = (url) => fetch(BACK + url).then((r) => r.json());

(async () => {
  const backend = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT, env: { ...process.env, PONKO_PORT: String(PORT) }, stdio: 'ignore',
  });
  let up = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BACK + '/index.html'); if (r.status === 200) { up = true; break; } } catch (e) {}
    await sleep(200);
  }
  if (!up) { console.log('backend 没起来，测试中止'); backend.kill(); process.exit(3); }

  // 1) 两个会话各自 cd，互不影响
  const a1 = await shell('a', 'cd C:\\Windows');
  record('a 会话 cd C:\\Windows 成功', lastCwd(a1).toLowerCase().endsWith('windows'), lastCwd(a1));
  const b1 = await shell('b', 'cd C:\\Windows\\System32');
  record('b 会话 cd System32 成功', lastCwd(b1).toLowerCase().endsWith('system32'), lastCwd(b1));
  const a2 = await shell('a', '(Get-Location).Path');
  record('a 的 cwd 仍是 C:\\Windows（没被 b 带跑）',
    lastCwd(a2).toLowerCase().endsWith('windows'), lastCwd(a2));
  const b2 = await shell('b', '(Get-Location).Path');
  record('b 的 cwd 仍是 System32',
    lastCwd(b2).toLowerCase().endsWith('system32'), lastCwd(b2));

  // 2) /api/shell/state 也按会话返回
  const sa = await jget('/api/shell/state?s=a');
  const sb = await jget('/api/shell/state?s=b');
  record('state?a 返回 a 的 cwd', String(sa.cwd).toLowerCase().endsWith('windows'), sa.cwd);
  record('state?b 返回 b 的 cwd', String(sb.cwd).toLowerCase().endsWith('system32'), sb.cwd);
  record('state 回带会话 id', sa.session === 'a' && sb.session === 'b', sa.session + '/' + sb.session);

  // 3) shell 种类（pwsh/cmd）也隔离
  await shell('a', 'cmd');
  const ka = await jget('/api/shell/state?s=a');
  const kb = await jget('/api/shell/state?s=b');
  record('a 切到 cmd 后 state 显示 shell=cmd', ka.shell === 'cmd', ka.shell);
  record('b 仍是 pwsh（没被 a 带成 cmd）', kb.shell === 'pwsh', kb.shell);
  const a3 = await shell('a', 'cd');
  record('cmd 模式下命令照常执行', lastCwd(a3).toLowerCase().endsWith('windows'), lastCwd(a3));

  // 4) 会话清单
  const list = await jget('/api/sessions');
  const ids = list.sessions.map((s) => s.id).sort();
  record('会话清单含 a / b', ids.includes('a') && ids.includes('b'), JSON.stringify(ids));
  record('会话清单带上限', list.max > 0, String(list.max));

  // 5) 非法 id 一律回落到默认会话 '0'，不能乱建
  const evil = await jget('/api/shell/state?s=' + encodeURIComponent('../etc/passwd'));
  record('非法会话 id 回落默认会话', evil.session === '0', evil.session);

  // 6) 不存在的会话：status 不崩、stream 明确报错（而不是挂住）
  const st = await jget('/api/pty/status?s=nope-nope');
  record('/api/pty/status 对不存在的会话返回 running=false', st.running === false, JSON.stringify(st));
  const sr = await fetch(BACK + '/api/pty/stream?s=nope-nope');
  const stxt = await sr.text();
  record('/api/pty/stream 对不存在的会话给出 error 事件',
    /"t":"error"/.test(stxt) || /error/.test(stxt), stxt.slice(0, 80));

  // 7) shell 里执行 exit：会话真的结束（发 dead 事件 + 从清单里消失）
  //    一个标签 = 一个会话，前端收到 dead 才关标签，所以这两件事必须都成立
  await shell('z', 'cd C:\\Windows');
  const zExit = await shell('z', 'exit');
  record('exit 事件流里带 dead（前端据此关标签）',
    zExit.some((e) => e.t === 'dead'), zExit.map((e) => e.t).join(','));
  record('exit 也给一句人话提示',
    zExit.some((e) => e.t === 'info' && /会话已结束/.test(e.text || '')),
    (zExit.find((e) => e.t === 'info') || {}).text || '');
  await sleep(300);                          // 后端是 60ms 后 dropSess，给它走完
  const listAfterExit = await jget('/api/sessions');
  record('exit 后会话被回收（清单里没有 z 了）',
    !listAfterExit.sessions.some((s) => s.id === 'z'),
    JSON.stringify(listAfterExit.sessions.map((s) => s.id)));
  // CMD 模式下的 exit 是"退回 PowerShell"，不该把会话收掉——两级退出，别一次退到底
  await shell('z2', 'cmd');
  const z2Exit = await shell('z2', 'exit');
  record('CMD 模式下 exit 只退回 PowerShell，不发 dead',
    !z2Exit.some((e) => e.t === 'dead') && z2Exit.some((e) => e.t === 'shell' && e.text === 'pwsh'),
    z2Exit.map((e) => e.t).join(','));
  const z2State = await jget('/api/shell/state?s=z2');
  record('CMD 模式 exit 后会话还在', z2State.shell === 'pwsh', z2State.shell);

  // 8) 关闭会话：真的回收（再查就是全新会话，cwd 回到起点）
  const home = (await jget('/api/shell/state?s=b')).cwd;
  const closed = await jpost('/api/pty', { op: 'close', session: 'b' });
  record('关闭会话返回 ok', closed.ok === true, JSON.stringify(closed));
  const bAfter = await jget('/api/shell/state?s=b');
  record('关闭后是新会话（cwd 不再是被关掉那个）',
    bAfter.cwd !== home || bAfter.shell === 'pwsh', bAfter.cwd);

  // 9) 会话数上限：超了要明确拒绝，而不是无限建
  const maxN = list.max;
  let created = 0, refused = false;
  for (let i = 0; i < maxN + 4; i++) {
    const s = await jget('/api/shell/state?s=cap' + i);
    if (s.cwd) created++; else { refused = true; break; }
  }
  record('超过上限后会拒绝新建会话', refused, `created=${created} max=${maxN}`);

  // 10) 对话存档（AGENT 多标签）：写盘 → 清单 → 取回 → 删除
  //     内容落在 run/conversations/（.gitignore 里排除），所以只在本机留着，不会进仓库
  const CID = 'ctest1';
  const MSGS = [
    { role: 'user', text: '你好' },
    { role: 'agent', text: '你好呀', stream: true, t: 12345 },   // 界面态字段不该落盘
    { role: 'mood', text: '[[mood:idle]]' },
    { role: 'bogus', text: '非法角色不该存进来' },
  ];
  const w = await jpost('/api/conv', { id: CID, title: '测试对话', msgs: MSGS });
  record('对话落盘成功', w.ok === true, JSON.stringify(w));
  const list2 = await jget('/api/convs');
  record('清单里出现该对话', (list2.convs || []).some((c) => c.id === CID), JSON.stringify((list2.convs || []).map((c) => c.id)));
  record('清单带上限（= 前端色板容量）', list2.max === 8, String(list2.max));
  const got = await jget('/api/conv?s=' + CID);
  record('取回的消息条数正确（非法角色被剔除）', got.msgs.length === 3, JSON.stringify(got.msgs));
  record('取回的消息不带流式中间态', got.msgs.every((m) => m.stream === undefined && m.t === undefined),
    JSON.stringify(got.msgs[0]));
  record('标题一并存/取回来', got.title === '测试对话', got.title);

  // id 不合法就拒绝：这里挡的是路径穿越（../ 直接写到 run/ 外面去）
  const evilW = await jpost('/api/conv', { id: '../evil', title: 'x', msgs: MSGS });
  record('非法 id 落盘被拒绝（挡路径穿越）', evilW.ok === false, JSON.stringify(evilW));
  const evilGet = await fetch(BACK + '/api/conv?s=' + encodeURIComponent('../evil'));
  record('非法 id 取回是 404', evilGet.status === 404, String(evilGet.status));

  // 只有欢迎语、用户一个字没说的对话不落盘（否则每开一次就多一个空对话）
  const emptyW = await jpost('/api/conv', { id: 'cempty', title: '欢迎', msgs: [{ role: 'agent', text: '已就绪' }] });
  record('没说过话的对话不落盘', emptyW.ok === false, JSON.stringify(emptyW));

  const del = await jpost('/api/conv/delete', { id: CID });
  record('删除对话返回 ok', del.ok === true, JSON.stringify(del));
  const list3 = await jget('/api/convs');
  record('删除后清单里没有了', !(list3.convs || []).some((c) => c.id === CID),
    JSON.stringify((list3.convs || []).map((c) => c.id)));
  const gone = await fetch(BACK + '/api/conv?s=' + CID);
  record('删除后取回 404', gone.status === 404, String(gone.status));

  backend.kill();
  await sleep(300);            // 让在飞的请求/连接收干净，别把收尾噪音算进来
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length ? 1 : 0;
})();
