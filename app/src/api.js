// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 后端接口封装（流式接口用 NDJSON 逐行解析）

export async function sysSnapshot() {
  const r = await fetch('/api/sys');
  if (!r.ok) throw new Error('sys ' + r.status);
  return r.json();
}

export async function netgeo() {
  const r = await fetch('/api/netgeo');
  if (!r.ok) throw new Error('netgeo ' + r.status);
  return r.json();
}

export async function geoLookup(ip) {
  const r = await fetch('/api/geo?ip=' + encodeURIComponent(ip));
  if (!r.ok) throw new Error('geo ' + r.status);
  return r.json();
}

/** 启动记录（宿主 + 后端的真实自检日志）：启动画面回放用 */
export async function bootLog() {
  const r = await fetch('/api/bootlog');
  if (!r.ok) throw new Error('bootlog ' + r.status);
  return r.json();
}

function stream(url, body, onEvent, onEnd) {
  const ctrl = new AbortController();
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).then(async (res) => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) {
          try { onEvent(JSON.parse(line)); } catch (e) { /* 坏行忽略 */ }
        }
      }
    }
    if (onEnd) onEnd();
  }).catch((e) => { if (e.name !== 'AbortError') onEvent({ t: 'error', text: String(e.message) }); });
  return () => ctrl.abort();
}

export const runShell = (cmd, onEvent, onEnd, session) => stream('/api/shell', { cmd, session }, onEvent, onEnd);
// llm = **这个对话自己的** API 配置（每个对话一份）。没配就传 null → 后端走演示用的假 agent。
// 不发配置过去 = 后端无从判断这个对话接的哪家，只能退回默认 —— 那正是以前的老毛病。
// opts 可选：
//   persona  这个对话的性格 id（喂进 system 提示词的人设，每个对话一份）
//   mood     "此刻心情"快照 {state, note, minutes} —— 模型的 mood 标记不进上下文（发历史时会被
//            剥掉），不给它这份快照，每轮都从白纸开始推情绪（见 server 的 moodBriefing）
export const askAgent = (text, onEvent, onEnd, history, llm, opts) => stream('/api/agent', {
  text, history: history || [], ...(llm ? { llm } : {}),
  ...(opts && opts.persona ? { persona: opts.persona } : {}),
  ...(opts && opts.mood ? { mood: opts.mood } : {}),
}, onEvent, onEnd);

// ── 对话存档（AGENT 多标签）：落在后端的 run/conversations/ —— 那个目录不入库，
//    所以对话内容永远不会被推到 GitHub。
export const listConvs = () => fetch('/api/convs')
  .then((r) => r.json()).catch(() => ({ convs: [] }));
export const getConv = (id) => fetch('/api/conv?s=' + encodeURIComponent(id))
  .then((r) => r.json()).catch(() => null);
export const saveConv = (c) => post('/api/conv', c);
export const deleteConv = (id) => post('/api/conv/delete', { id });

// ── 界面状态（重启后画面要跟关掉时一样）：心情快照 + 落在哪个对话。
//    两样都不是"内容"：心情的**权威**在对话存档里（每个对话一份），这里这份是"最后一帧"的缓存；
//    active 天生跨对话（它说的就是"这些对话里选哪个"），所以只能放这儿。
//    读不到（后端没起来 / 文件还没有）就返回 null，调用方按"没有快照"处理。
//    ⚠ 写是**逐字段**的：只带 mood 就只改 mood、只带 active 就只改 active，谁都不会抹掉对方。
export const getUiState = () => fetch('/api/ui-state')
  .then((r) => r.json()).catch(() => null);
export const saveUiState = (s) => post('/api/ui-state', s);

// ── LLM 接入配置（**每个对话一份**：配置存在对话存档里，没有全局那份了）
// 所以这里只留下一个连通性验证：真的打一次远端接口，返回 { ok, ms, model, via }
// 或 { ok:false, error }。**纯探测，不写任何文件** —— 存不存进那个对话由前端决定。
// 注意：这一层只管"把请求发出去、把回包解成对象"，**不负责措辞** ——
// 错误原文原样往上传（String(e.message)），要加"连接失败："这种前缀由调用方的语言包做
// （见 agent.js 的 ui.agent.form.testFail）。服务层不 import i18n，见 test_i18n.mjs 第 8 节。
export const testLlmConfig = (cfg) => fetch('/api/llm/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg || {}),
}).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e.message) }));
// 让**刚配好的这个模型**自己挑一个形象包（'自动' 那条路）。
// 传的就是那份 LLM 配置 + 候选清单 [{id,name}]；后端问一次模型、解析出它选的 id。
// 纯调用，不写任何文件 —— 挑出来的结果由前端存进那个对话（tab.charpackPicked）。
export const pickArt = (body) => fetch('/api/llm/pick-art', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
}).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e.message) }));
export const abortShell = (session) => fetch('/api/shell', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ abort: true, session }),
});

// ── PTY（真终端）：交互式程序专用。每个标签一个会话，session 就是标签 id
function post(url, body) {
  return fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  }).then((r) => r.json()).catch(() => ({ ok: false }));
}
const q = (session) => '?s=' + encodeURIComponent(session || '0');

export const ptyStart = (opts, session) => post('/api/pty', { op: 'start', session, ...(opts || {}) });
export const ptyWrite = (text, session) => post('/api/pty', { op: 'write', text, session });
export const ptyResize = (cols, rows, session) => post('/api/pty', { op: 'resize', cols, rows, session });
export const ptyStop = (session) => post('/api/pty', { op: 'stop', session });
/** 关标签时用：连会话带子进程一起回收 */
export const ptyClose = (session) => post('/api/pty', { op: 'close', session });
export const ptyStatus = (session) => fetch('/api/pty/status' + q(session))
  .then((r) => r.json()).catch(() => ({ running: false }));
export const shellState = (session) => fetch('/api/shell/state' + q(session))
  .then((r) => r.json()).catch(() => ({}));

/**
 * Tab 补全（管道模式）：把"这一行 + 光标位置"发给后端，回
 * `{ start, end, quote, prefix, base, items, common }` —— 候选 + 这个词在行里的替换范围。
 * 只读，不建会话、不落盘；后端没起来就返回 null（调用方当"没补出东西"处理）。
 */
export const completeShell = (session, line, caret) => fetch('/api/complete' + q(session)
  + '&line=' + encodeURIComponent(line == null ? '' : line)
  + '&caret=' + (Number.isFinite(caret) ? Math.max(0, caret | 0) : 0))
  .then((r) => r.json()).catch(() => null);

/** 订阅某个会话的终端输出流（NDJSON 长连接） */
export function ptyStream(session, onEvent, onEnd) {
  const ctrl = new AbortController();
  fetch('/api/pty/stream' + q(session), { signal: ctrl.signal }).then(async (res) => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) { try { onEvent(JSON.parse(line)); } catch (e) { /* 坏行忽略 */ } }
      }
    }
    if (onEnd) onEnd();
  }).catch((e) => { if (e.name !== 'AbortError' && onEnd) onEnd(); });
  return () => ctrl.abort();
}
