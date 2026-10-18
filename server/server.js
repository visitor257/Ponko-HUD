// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// Ponko-HUD 本地后端：纯 Node 标准库，零第三方依赖
//   GET  /api/sys            系统快照
//   POST /api/shell          执行 shell 命令（NDJSON 流：out/err/exit）
//   GET  /api/shell/state?s=id  这个标签的 shell 种类 + 真实工作目录
//   GET  /api/complete?s=id&line=…&caret=…  Tab 补全（管道模式：候选 + 这个词在行里的范围）
//   POST /api/agent          agent 对话（NDJSON 流：mood/thinking/token/tool/done）
//                            ★ mood 事件完全由 agent 的正文标记产出，后端不推断情绪
//   GET  /api/mood/protocol  心情协议：状态枚举 + 可用表情 + 给 LLM 的 system 提示词
//   GET  /api/charpacks      列出素材包（用户自定义表情）
//   GET  /api/bootlog        启动记录（宿主 + 后端的真实自检日志，启动画面回放用）
//   GET  /api/convs          对话存档清单（AGENT 多标签）
//   GET  /api/conv?s=id      取一个对话全文 / POST 落盘 / POST /api/conv/delete 删除
//                            ★ 存在 run/conversations/，该目录不入库 → 对话不会被推上 GitHub
//   GET  /api/ui-state       界面状态（心情快照 + 落在哪个对话）/ POST 存下"这一刻长什么样"
//                            ★ 存在 run/ui-state.json：关掉再开，配色、立绘、停在哪个对话都跟退出前一致
//   /*                       静态文件（app/ 目录）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const bootlog = require('./bootlog');
const sysinfo = require('./sysinfo');
const netgeo = require('./netgeo');
const moodp = require('./moodprotocol');
const complete = require('./complete');
const { PtySession, getSession: getPtySession, dropSession: dropPtySession,
  listSessions: listPtySessions, normSession } = require('./pty');

// ─────────────────────────────── LLM 接入配置（**每个对话一份**，跟着对话存档走）
//
// 以前这里是一份进程级全局配置（server/llm-config.json），所有对话共用同一个地址与 Key，
// 想换个模型就得改全局、改完全部对话跟着变。现在改成**每个对话一份**：配置存在对话自己的
// 存档里（run/conversations/<id>.json），发消息时随请求一起带上来，后端拿请求里那份去调模型
// —— 不再有任何跨对话共享的可变状态。于是不同对话可以接不同的中转站 / 模型
// （一个省钱跑批、一个要强的写代码），互不干扰，也不用"切之前先改配置"。
// 用户在前端填 API 地址 / API Key / 模型；填好并验证通过才写进那个对话。
// provider  = 用户的选择：auto（自动识别）/ openai（OpenAI 兼容）/ anthropic（Claude 原生）
// resolved  = 自动识别后实际用到的协议，存下来之后对话就不用再猜
// rawProvider：只认两个真协议，其它（含空串）一律 ''（= 还没识别/不适用）
// normProvider：在 rawProvider 之上把空值补成 auto，用于"用户意图"字段
function rawProvider(p) {
  const s = String(p || '').trim().toLowerCase();
  return (s === 'openai' || s === 'anthropic') ? s : '';
}
function normProvider(p) {
  return rawProvider(p) || 'auto';
}
/**
 * 把外面传进来的配置洗成后端内部用的形状。**地址与 Key 缺任一个就返回 null**
 * （= 这个对话还没配），调用方据此决定走真模型还是演示用的假 agent。
 * 洗这一道有两个用处：① 存档 / 请求里的怪值（null、数字、超长串）统一收敛成干净形状；
 * ② "配没配"这件事只有这一个判断入口，不会散落到各处各判一遍。
 */
function llmOf(cfg) {
  const baseUrl = String((cfg && cfg.baseUrl) || '').trim();
  const apiKey = String((cfg && cfg.apiKey) || '').trim();
  if (!baseUrl || !apiKey) return null;
  return {
    baseUrl,
    apiKey,
    // model **不在这里兜底**：OpenAI 与 Anthropic 的默认模型不是一回事，
    // 统一填 gpt-3.5-turbo 会让 Anthropic 那条路拿到一个 OpenAI 的模型名。
    model: String((cfg && cfg.model) || '').trim(),
    provider: normProvider(cfg && cfg.provider),
    resolved: rawProvider(cfg && cfg.resolved),
  };
}
/** 对话时真正用的协议：探测结果优先，其次用户显式选择，都没有就按 OpenAI 兼容走 */
function activeProvider(cfg) {
  return rawProvider(cfg && cfg.resolved) || rawProvider(cfg && cfg.provider) || 'openai';
}

// 形象（角色素材包）id：要么是 'auto'，要么是一个干净的目录名。
// 只认这一种形状 —— 前端传上来的、存档里躺着的一律过这里收敛，
// 免得脏值被拼进 /characters/... 的路径里。
const ART_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
function normArtOf(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return (s === 'auto' || ART_ID_RE.test(s)) ? s : 'auto';
}

// ─────────────────────────── LLM 连通性验证（保存前必须真的打一次接口）
// 之前 /api/llm/config 只做「非空→写盘」，于是乱填地址/Key 也能"配置成功"，
// 直到第一次对话才炸。现在保存前先探一次，并且顺便认出对面是什么协议：
//   OpenAI 兼容：GET {base}/v1/models（顺带校模型名）→ 不行再 POST /v1/chat/completions 探针
//   Anthropic  ：POST {base}/v1/messages（x-api-key + anthropic-version）
// 两者报文完全不通，所以「自动识别」就是按顺序各试一次，谁通用谁。
function llmV1(base) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  return b.replace(/\/v1$/, '') + '/v1';          // 兼容带或不带 /v1 的地址
}
const ANTHROPIC_VERSION = '2023-06-01';

async function probeOpenAI(base, apiKey, model, t0) {
  const v1 = llmV1(base);
  const hdr = { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' };
  let netErr = '';

  // ① 模型列表
  try {
    const r = await fetch(v1 + '/models', { headers: hdr, signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      const ids = j && Array.isArray(j.data)
        ? j.data.map((x) => x.id || x.name).filter(Boolean)
        : [];
      if (ids.length && !ids.includes(model)) {
        const tip = ids.slice(0, 6).join(' / ') + (ids.length > 6 ? ' …' : '');
        return { ok: false, ms: Date.now() - t0, provider: 'openai', models: ids, error: `Key 有效，但没找到模型「${model}」。可用：${tip}` };
      }
      return { ok: true, ms: Date.now() - t0, provider: 'openai', model, via: 'models', models: ids };
    }
    if (r.status === 401 || r.status === 403) {
      const d = await r.text().catch(() => '');
      return { ok: false, ms: Date.now() - t0, provider: 'openai', error: `鉴权失败（HTTP ${r.status}）：Key 不对或没有权限 ${d.slice(0, 120)}` };
    }
    // 其他状态码：落到 ② 再试一次
  } catch (e) {
    netErr = e.name === 'TimeoutError' ? '请求 /models 超时' : ('连不上：' + e.message);
  }

  // ② 极小对话探针
  try {
    const r = await fetch(v1 + '/chat/completions', {
      method: 'POST',
      headers: { ...hdr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) return { ok: true, ms: Date.now() - t0, provider: 'openai', model, via: 'chat' };
    let d = '';
    try { d = (await r.text()).slice(0, 160); } catch (e) {}
    if (r.status === 401 || r.status === 403) return { ok: false, ms: Date.now() - t0, provider: 'openai', error: `鉴权失败（HTTP ${r.status}）：Key 不对 ${d}` };
    if (r.status === 404) return { ok: false, ms: Date.now() - t0, provider: 'openai', error: `没有 ${v1}/chat/completions（HTTP 404）：地址填错了吗？` };
    return { ok: false, ms: Date.now() - t0, provider: 'openai', error: `LLM 返回 HTTP ${r.status}：${d}` };
  } catch (e) {
    const m = e.name === 'TimeoutError' ? '对话请求超时' : ('连不上：' + e.message);
    return { ok: false, ms: Date.now() - t0, provider: 'openai', error: netErr || m };
  }
}

async function probeAnthropic(base, apiKey, model, t0) {
  const url = llmV1(base) + '/messages';
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) {
      let j = null; try { j = await r.json(); } catch (e) {}
      return { ok: true, ms: Date.now() - t0, provider: 'anthropic', model: (j && j.model) || model, via: 'messages' };
    }
    let d = '';
    try { d = (await r.text()).slice(0, 160); } catch (e) {}
    if (r.status === 401 || r.status === 403) return { ok: false, ms: Date.now() - t0, provider: 'anthropic', error: `鉴权失败（HTTP ${r.status}）：x-api-key 不对或没权限 ${d}` };
    if (r.status === 404) return { ok: false, ms: Date.now() - t0, provider: 'anthropic', error: `没有 ${url}（HTTP 404）：这不是 Anthropic 接口吧？` };
    return { ok: false, ms: Date.now() - t0, provider: 'anthropic', error: `Anthropic 返回 HTTP ${r.status}：${d}` };
  } catch (e) {
    const m = e.name === 'TimeoutError' ? 'Anthropic 请求超时' : ('连不上：' + e.message);
    return { ok: false, ms: Date.now() - t0, provider: 'anthropic', error: m };
  }
}

async function testLlm(cfg) {
  // 探测是**纯只读**的：只拿传进来的这份配置去试，不写任何文件、不碰任何对话。
  // 以前这里会回退到全局 llmCfg，于是前端字段空着也能"探测通过"——那等于什么都没验。
  const base = String((cfg && cfg.baseUrl) || '').trim();
  const apiKey = String((cfg && cfg.apiKey) || '').trim();
  const model = String((cfg && cfg.model) || '').trim() || 'gpt-3.5-turbo';
  if (!base) return { ok: false, error: '缺少 API 地址' };
  if (!apiKey) return { ok: false, error: '缺少 API Key' };

  let u;
  try { u = new URL(base); } catch (e) { return { ok: false, error: `API 地址不是合法 URL：${base}` }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'API 地址必须以 http:// 或 https:// 开头' };
  }

  const t0 = Date.now();
  const want = normProvider(cfg && cfg.provider);
  if (want === 'anthropic') return probeAnthropic(base, apiKey, model, t0);
  if (want === 'openai') return probeOpenAI(base, apiKey, model, t0);

  // auto：OpenAI 兼容先试（中转站绝大多数是它），不行再试 Anthropic 原生
  const a = await probeOpenAI(base, apiKey, model, t0);
  if (a.ok) return a;
  const b = await probeAnthropic(base, apiKey, model, t0);
  if (b.ok) return b;
  // 两个都不通：优先展示"真连上了但被拒"的那条（鉴权类比 404/连不上更能说明问题）
  const pick = [a, b].find((x) => /鉴权失败/.test(x.error || '')) || a;
  return { ok: false, ms: Date.now() - t0, error: pick.error, models: pick.models, tried: ['openai', 'anthropic'] };
}

// ── 一次**非流式**问答（给"让模型自己挑形象"这种内部小任务用）──────────────
// 跟对话那条流式路完全分开：这里只要一个完整回包、不要 SSE、不进任何存档。
// 两种协议各写一遍报文（跟 callRealLLM / callAnthropic 那两份是同源约定，别各改各的）。
async function chatOnce(cfg, sys, user, maxTokens) {
  const base = String((cfg && cfg.baseUrl) || '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, error: '缺少 API 地址' };
  const prov = activeProvider(cfg);
  const model = String((cfg && cfg.model) || '').trim();
  let url, headers, body;
  if (prov === 'anthropic') {
    url = base.replace(/\/v1$/, '') + '/v1/messages';
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
    body = { model: model || 'claude-3-5-sonnet-latest', max_tokens: maxTokens, system: sys, messages: [{ role: 'user', content: user }] };
  } else {
    url = llmV1(base) + '/chat/completions';
    headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey };
    body = { model: model || 'gpt-3.5-turbo', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], temperature: 0, stream: false };
    if (maxTokens) body.max_tokens = maxTokens;
  }
  let resp;
  try { resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }); }
  catch (e) { return { ok: false, error: '连不上 LLM：' + e.message }; }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 200); } catch (e) { /* 读不出来就算了 */ }
    return { ok: false, error: `LLM 返回 ${resp.status}：${detail}` };
  }
  let j = null;
  try { j = await resp.json(); } catch (e) { return { ok: false, error: '回包不是 JSON' }; }
  const text = prov === 'anthropic'
    ? (Array.isArray(j && j.content) ? j.content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('') : '')
    : String((j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
  if (!text.trim()) return { ok: false, error: '模型没给出内容' };
  return { ok: true, text: text.trim() };
}

/**
 * 「自动」形象：把候选清单交给**这个对话配好的模型**，让它自己选一个。
 *
 * 解析故意写得宽容：模型经常回 "ponko"、"我选 ponko"、"`ponko`"、甚至带解释的一段话 ——
 * 只要回包里**出现了某个候选 id**(按词边界匹配)，就算它选了那个。
 * 一个都没匹配上就如实报错（宁可不换，也不猜一个装成"它就想要这个"）。
 */
async function pickArt(cfg, packs) {
  const cands = (Array.isArray(packs) ? packs : [])
    .map((p) => ({ id: String((p && p.id) || '').trim(), name: String((p && p.name) || '').trim() }))
    .filter((p) => ART_ID_RE.test(p.id));
  if (!cands.length) return { ok: false, error: '没有可选的素材包' };
  if (cands.length === 1) return { ok: true, id: cands[0].id, only: true, ms: 0 };

  const sys = '你在为一个本地桌面助手挑一个"形象"（角色立绘素材包）。'
    + '只回你选中的那个 id，不要解释、不要标点、不要别的字。';
  const user = '可选形象：\n'
    + cands.map((p) => `- ${p.id}${p.name && p.name !== p.id ? `（${p.name}）` : ''}`).join('\n')
    + '\n\n挑一个最适合你的，只回 id。';
  const t0 = Date.now();
  const r = await chatOnce(cfg, sys, user, 24);
  if (!r.ok) return { ok: false, error: r.error, ms: Date.now() - t0 };
  // 优先整条就是一个 id（最常见的合规回答）；否则退一步找"出现过的候选"。
  const raw = r.text.trim().replace(/^[`"'\s]+|[`"'\s.。！!]+$/g, '');
  let hit = cands.find((p) => p.id.toLowerCase() === raw.toLowerCase());
  if (!hit) {
    const lower = r.text.toLowerCase();
    hit = cands.find((p) => new RegExp(`(^|[^a-z0-9_-])${p.id.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_-])`).test(lower));
  }
  if (!hit) return { ok: false, error: `它回的不是候选里的形象：${r.text.slice(0, 60)}`, ms: Date.now() - t0 };
  return { ok: true, id: hit.id, said: r.text.slice(0, 120), ms: Date.now() - t0 };
}

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app');
const CHARS = path.join(ROOT, 'characters');
const PORT = Number(process.env.PONKO_PORT || 8787);

// ─────────────────────────────── 对话存档（AGENT 多标签 = 多个对话）
//
// 存到 run/conversations/<id>.json。**run/ 已经写在 .gitignore 与推送脚本的排除项里**，
// 所以对话内容只在本机留着，绝不会跟着代码推上 GitHub —— 这正是放这里的理由。
// 为什么不用 localStorage：① WebView2 里它未必可用（隐私模式 / 异常状态）；
// ② 服务端写盘与前端渲染解耦，重启后一次 GET 就能把标签栏全量恢复；
// ③ 前端崩了 / 刷新了，内容也已经在盘上。
//
// ⚠ 这一段必须**早于下面的启动自检**：自检会立即扫这个目录说"有几个对话存档"。
// 之前它写在文件后半段，而 const 不提升 —— 启动时访问 CONV_DIR 抛 ReferenceError，
// 又被 listConvs 里那句 try/catch 当成"目录读不了"给吞了，于是启动画面那行
// 「对话存档」永远显示"没有对话"，哪怕盘上明明存着好几个。提到最前面就对了。
// PONKO_CONV_DIR 是**给验证脚本用的**：把存档指到一个临时目录，验证时就碰不到
// 用户本机那份真实对话（那些文件里有明文 Key，误删误改是不可逆的）。
// 正常启动不设这个变量 → 还是 run/conversations。
const CONV_DIR = process.env.PONKO_CONV_DIR
  ? path.resolve(process.env.PONKO_CONV_DIR)
  : path.join(ROOT, 'run', 'conversations');
const CONV_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;          // 同时挡住 ../ 之类的路径穿越
const CONV_MAX = 8;                                  // 最多几个对话标签（= 前端色板容量）
const CONV_MAX_MSGS = 300;
const CONV_MAX_TEXT = 20000;                         // 单条消息上限，别让一个文件无限长
const CONV_ROLES = new Set(['user', 'agent', 'think', 'tool', 'mood', 'info']);

// ─────────────────────────────── 界面状态（重启后画面要跟关掉时一样）
//
// 存两样东西，都是"这一刻屏幕长什么样"，不是"内容"：
//   ① **心情快照**（state/face/note/intensity/来源）—— 2026-10-15 用户报的
//      "mood 也变回 idle 了，应该和退出前一样才对"。
//   ② **落在哪个对话上**（active = 对话 id）—— 2026-10-17 用户报的"切到第一个对话，
//      关掉再开却落在第二个"。它不是某个对话的内容（内容在对话存档里），是"屏幕停在哪"。
//      ⚠ 只记 **id**、不记下标：标签顺序每次重开都可能变（restore 按 updatedAt 排），
//      记位置下次就指到别人身上了。
//
// 为什么**不放进对话存档**：① 心情虽然每对话一份（2026-10-17 改的，见 mood.js），
// 但这份是"最后一帧"的缓存，写进对话存档等于让"看过的最后一帧"冒充"这个对话的状态"；
// ② active 天生跨对话（它描述的正是"这些对话里选哪个"），塞进任何单个对话都不讲道理。
//
// 位置有个讲究：验证脚本会把 PONKO_CONV_DIR 指到一个临时目录（为的是不碰用户本机那份
// 真存档）。这里跟着它走 —— 落到那个临时目录里、名字带前导点（`.ui-state.json`），
// 于是 ① 验证跑完连文件一起删掉，② 那些"扫存档目录"的地方（listConvs / 启动自检）
// 靠 CONV_ID_RE 认不出 `.ui-state` 这个名字，不会把它当成一个对话。
// 不这样做的话，每跑一次验证都会拿一个 idle 快照盖掉用户本机那份（正好是用户要的效果的反面）。
const UI_PATH = process.env.PONKO_UI_PATH
  ? path.resolve(process.env.PONKO_UI_PATH)
  : (process.env.PONKO_CONV_DIR
    ? path.join(CONV_DIR, '.ui-state.json')
    : path.join(ROOT, 'run', 'ui-state.json'));

// 心情日志：一轮一条，记下**模型实际声明了什么**（state / face / i / note），
// 以及是不是"正文里漏了、事后补问出来的"。用户报"心情设置错了"时，这是唯一能回看的证据 ——
// 正文里的标记早被剥掉了，光看对话存档只能看到"它嘴上说了什么"。
// 位置跟 UI_PATH 同一个目录：验证脚本把存档指到临时目录时，这份日志也跟着进去，不脏本机。
const MOOD_LOG = path.join(path.dirname(UI_PATH), 'mood.log');
const UI_DIR = path.dirname(UI_PATH);
const UI_MOOD_STATES = new Set(moodp.STATE_KEYS);    // 封闭枚举，跟 /api/mood/protocol 同源
const UI_MOOD_SOURCES = new Set(['agent', 'auto', 'manual']);

// ─────────────────────────────── 启动自检（真实记录 → 前端启动画面回放）
//
// eDEX-UI 开机那套刷屏，这里不要"形式上的假日志"：下面每一行都是这一步真的做了什么、
// 真的花了多久。数字全部来自现场测量（process.version / 端口 / 文件系统 / 真起一次
// python -V），没有任何写死的内容 —— 没配 LLM 就说没配，扫不到素材包就说扫不到。
function hostOf(u) { try { return new URL(u).host || String(u); } catch (e) { return String(u || '?'); } }
const gb = (n) => (n / 1073741824).toFixed(1);
const mb = (n) => (n / 1048576).toFixed(2) + 'MB';
const firstLine = (s) => String(s || '').split('\n')[0].slice(0, 90);

// 素材包：现场扫 characters/，数出来多少就是多少
function assetStat() {
  const packs = listCharpacks();
  let frames = 0, bytes = 0;
  const moods = new Set();
  for (const p of packs) {
    for (const t of Object.keys(p.moods || {})) moods.add(t);
    const dir = path.join(CHARS, p.id, 'frames');
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { names = []; }
    for (const n of names) {
      if (n === 'preview.html') continue;               // 生成产物，不算帧
      try { bytes += fs.statSync(path.join(dir, n)).size; frames++; } catch (e) { /* 读不到就跳过 */ }
    }
  }
  return { packs: packs.length, moods: moods.size, frames, bytes };
}

// 启动日志只记「事件 id + 参数」——渲染成哪种语言由页面按当前语言包决定
// （见 server/bootlog.js 顶部格式说明、app/src/i18n/*.js）
bootlog.emit('node', 'boot.node.runtime', {
  ver: process.version, platform: process.platform, arch: process.arch,
  pid: process.pid, ppid: process.ppid,
});
bootlog.emit('node', 'boot.node.root', { root: ROOT });
if (bootlog.staleDropped) {
  bootlog.emit('node', 'boot.node.stale', { n: bootlog.staleDropped });
}

/**
 * 扫一遍对话存档：一共几个对话、其中**最近更新且配了 LLM** 的是哪个。
 * 启动画面那行"接没接 LLM / 接的什么"只能这样回答 —— 配置现在散在各个对话里，
 * 没有一份全局的可以一眼看穿了。只用来打日志：主机 / 模型 / 协议，Key 一个字都不往外带。
 */
function probeLlmCounts() {
  let names = [];
  try { names = fs.readdirSync(CONV_DIR); } catch (e) { return { total: 0, first: null }; }
  const hits = [];
  let total = 0;
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -5);
    if (!CONV_ID_RE.test(id)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(convPath(id), 'utf8'));
      total++;
      const llm = llmOf(j.llm);
      if (llm) hits.push({ updatedAt: Number(j.updatedAt) || 0, llm });
    } catch (e) { /* 坏存档跳过，别让一个坏文件把启动画面搞挂 */ }
  }
  if (!hits.length) return { total, first: null };
  hits.sort((a, b) => b.updatedAt - a.updatedAt);      // 新 → 旧：说最近在用的那个
  return { total, first: hits[0] };
}

// LLM 接入：配置是**每个对话一份**，所以这里扫存档说"有没有对话接了 / 连哪 / 什么协议"。
// 只说这三样，**永不回显 Key**；一个都没配时，报"扫过几个存档都没配" —— 那也是实测出来的数，
// 不是一句"未配置"的空话（启动画面的规矩：每行都得带真实测量痕迹，见 test_boot 第 6 节）。
(function probeLlm() {
  const { total, first } = probeLlmCounts();
  bootlog.emit('llm', first ? 'boot.llm.on' : 'boot.llm.off', first
    ? { host: hostOf(first.llm.baseUrl), model: first.llm.model || 'gpt-3.5-turbo', proto: activeProvider(first.llm) }
    : { n: total });
})();

const ASSETS = assetStat();
bootlog.emit('pack', ASSETS.packs ? 'boot.pack.count' : 'boot.pack.none', ASSETS.packs
  ? { packs: ASSETS.packs, moods: ASSETS.moods, frames: ASSETS.frames, size: mb(ASSETS.bytes) }
  : {});

// 真终端：真起一次 python -V —— 探到的就是之后 ConPTY 桥要用的那个解释器。
// 用 setImmediate 推到 listen 之后：Windows 上创建进程（uv_spawn）有时要几百毫秒甚至
// 更久，同步跑会把"开始监听"一起拖慢，而启动画面正等着这一下。诊断行不值得拖慢开机。
const PYBIN = process.env.PONKO_PY || 'python';
function probePython() {
  const t0 = Date.now();
  execFile(PYBIN, ['-V'], { windowsHide: true, timeout: 5000 }, (err, out, errOut) => {
    const ms = Date.now() - t0;
    if (err) {
      bootlog.emit('pty', 'boot.pty.fail', { bin: PYBIN, err: firstLine(err.message) });
      return;
    }
    bootlog.emit('pty', 'boot.pty.ok', {
      out: String(out || errOut || '').trim() || PYBIN + ' (no version output)',
      bin: PYBIN, ms,
    });
  });
}

// 系统快照：CPU / 内存 / 系统盘 / GPU 都是现场读的
(function probeSys() {
  const s = sysinfo.snapshot();
  // disk / gpu 是"片段"：交给语言包拼（值以 @key 形式带出去，见 i18n/index.js 第 3 条）
  const disk = s.disk ? { key: 'boot.sys.diskUsed', args: {
    used: gb(s.disk.used), total: gb(s.disk.total), pct: s.disk.pct.toFixed(0),
  } } : '';
  const gpu = s.gpu ? { key: 'boot.sys.gpuMem', args: {
    util: s.gpu.util, used: s.gpu.memUsed, total: s.gpu.memTotal,
  } } : '';
  bootlog.emit('sys', 'boot.sys.host', {
    platform: s.platform, arch: s.arch, host: s.host, user: s.user,
    cpu: s.cpu.model, cores: s.cpu.cores, mem: gb(s.mem.total), disk, gpu,
  });
})();

// 对话存档：真的存了几个 —— 这个数就是启动后标签栏会恢复出几个对话
(function probeConvs() {
  const cs = listConvs();
  bootlog.emit('conv', cs.length ? 'boot.conv.count' : 'boot.conv.empty', cs.length
    ? { n: cs.length, title: String(cs[cs.length - 1].title || 'untitled').slice(0, 24) }
    : {});
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  // 克林贡文 pIqaD 字体（app/assets/fonts/）。没有这一条会按 octet-stream 发，
  // Chrome 对字体 MIME 卡得严，@font-face 直接不生效。
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, obj, code = 200) {
  const b = Buffer.from(JSON.stringify(obj));
  // 接口一律禁缓存，而且要用 no-store（不是 no-cache）：
  //   这些响应都是**当前磁盘状态**的镜像（素材包清单、会话清单、系统信息…），
  //   没有一个带 Last-Modified / ETag。少了这个头，Chromium 会把它们当启发式可缓存对象
  //   落到 WebView2 的磁盘缓存里（实测 `run/webview-profile/**/Cache/Cache_Data` 里
  //   就存着一条旧的 `/api/charpacks`（里面还是早就换掉的旧素材包），
  //   换掉素材包之后重启可能读到旧清单 → 去取已经删掉的帧 → 角色面板一直 "loading…"。
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': b.length,
    'Cache-Control': 'no-store',
  });
  res.end(b);
}

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  const b = Buffer.from(body);
  // 本地应用禁缓存：否则 WebView2 会把旧 JS 模块缓存住，改了前端代码"不生效"
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': b.length, 'Cache-Control': 'no-cache' });
  res.end(b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > 4 << 20) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ─────────────────────────────── shell（pwsh 持久会话 / cmd 一次性执行）
//
// 为什么 cmd 不能也用持久会话：cmd.exe 的 stdin 管道在 chcp 65001 下会吞掉多字节命令
// （实测卡死在 "More?"），而默认 936 又把中文命令解烂。所以 CMD 模式改一次性 `cmd /c`：
// 命令作为 argv 传入 → Windows 走 UTF-16，中文无损；输出侧用 chcp 65001 强制 UTF-8。
//
// 另一个坑：裸跑 cmd / python / ssh 这类交互式程序会**抢占父 shell 的 stdin**，
// 之后所有命令都被喂给它（"is not recognized as an internal or external command"），
// 而且哨兵行被吞导致退出码永远是 0 —— 整个会话废掉。故必须拦截。
const SENTINEL = 'PONKO_DONE_9f3c';

// ── 终端会话：一个标签 = 一个 ShellSession ──────────────────────────────
// 以前 sh/shellKind/curDir 等都是模块级全局变量，全窗口只有一路 shell。
// 现在收进会话对象：每个标签有自己的持久 pwsh、自己的 cwd/shell 种类、自己的 PTY，
// 切标签互不干扰。默认会话 id '0'，不带 session 参数的老请求都落到它身上。
class ShellSession {
  constructor(id) {
    this.id = id;
    this.kind = 'pwsh';                                   // pwsh | cmd（原 shellKind）
    this.cwd = process.env.USERPROFILE || 'C:\\';         // 原 curDir
    this.sh = null;                                       // 管道模式的持久 pwsh 进程
    this.shBuf = '';                                      // 原 shBuf
    this.shState = 'idle';                                // idle | busy
    this.activeProc = null;                               // CMD 模式下的一次性进程
    this.pty = new PtySession(id);                        // 真终端会话
  }
}

const MAX_SESSIONS = 12;
const sessionStore = new Map();

/** 取会话；create=false 时只查不建 */
function getSess(id, create = true) {
  const k = normSession(id);
  let s = sessionStore.get(k);
  if (!s && create) {
    if (sessionStore.size >= MAX_SESSIONS) return null;
    s = new ShellSession(k);
    sessionStore.set(k, s);
  }
  return s || null;
}

/** 关掉一个会话：连它的 pwsh 子进程、跑着的命令、PTY 一起收掉 */
function dropSess(id) {
  const k = normSession(id);
  const s = sessionStore.get(k);
  if (!s) return false;
  try { if (s.sh) s.sh.kill(); } catch (e) { /* 已退出 */ }
  try { if (s.activeProc) s.activeProc.kill(); } catch (e) { /* 已退出 */ }
  try { dropPtySession(k); } catch (e) { /* 桥可能已经走了 */ }
  sessionStore.delete(k);
  return true;
}

function listSess() {
  return [...sessionStore.values()].map((s) => ({
    id: s.id, cwd: s.cwd, shell: s.kind, state: s.shState,
    running: !!(s.sh && s.shState === 'busy') || !!(s.activeProc),
  }));
}

// 裸跑（不带参数）会抢 stdin 的交互式程序
const REPL_BLOCK = new Set(['python', 'python3', 'py', 'node', 'ipython', 'ssh', 'ftp', 'sftp', 'telnet',
  'nslookup', 'mysql', 'psql', 'sqlite3', 'diskpart', 'regedit', 'wsl', 'bash', 'sh', 'zsh',
  'more', 'less', 'vim', 'nvim', 'nano', 'emacs', 'top', 'htop', 'tmux', 'ranger', 'notepad']);

function spawnShell(sess) {
  if (sess.sh) { try { sess.sh.kill(); } catch (e) {} sess.sh = null; }
  sess.sh = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
    cwd: sess.cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sh = sess.sh;
  sess.shBuf = '';
  sh.stdout.setEncoding('utf8');
  sh.stderr.setEncoding('utf8');
  sh.on('exit', () => { if (sess.sh === sh) sess.sh = null; });

  // ── 中文编码：Windows PowerShell 5.1 的管道是 ANSI(936)，两头都会坏
  //   · 输出侧：强制 UTF-8，否则文件名 / 错误消息等"系统产生的中文"会变成 GBK 字节
  //   · 输入侧：[Console]::InputEncoding 设置了也不生效（实测），
  //     所以命令走 base64（纯 ASCII）进去，由 PowerShell 自己解成 UTF-8 字符串
  sh.ready = false;
  sh.stdin.write('try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch { }\n');
  sh.stdin.write('$OutputEncoding=[System.Text.Encoding]::UTF8\n');
  sh.stdin.write('$ProgressPreference="SilentlyContinue"; $ErrorActionPreference="Continue"\n');
  // 就绪前吃掉初始化期的所有输出
  const swallow = (c) => { if (!sh.ready) { sess.shBuf = ''; return; } };
  sh.stdout.on('data', swallow);
  setTimeout(() => {
    if (sess.sh === sh) { sh.stdout.off('data', swallow); sh.ready = true; sess.shBuf = ''; }
  }, 400);
  return sh;
}
spawnShell(getSess('0'));

// cmd 输出用的是系统 ANSI 代码页（chcp 对管道无效，实测），所以在 Node 侧按该代码页解码。
// 中文命令则走 argv（UTF-16），不受影响 —— 两边分开治。
const CP_MAP = { 936: 'gbk', 950: 'big5', 932: 'shift_jis', 949: 'euc-kr', 65001: 'utf-8', 1252: 'windows-1252' };
let cmdEnc = 'gbk';
try {
  const cp = Number((require('child_process').execSync('chcp', { windowsHide: true }).toString() || '').match(/(\d+)/) || [0, 936])[1];
  if (CP_MAP[cp]) cmdEnc = CP_MAP[cp];
} catch (e) { /* 保持 gbk */ }

// CMD 模式：一次性 cmd /c（cwd 用 spawn 的 cwd 选项，命令里不再拼路径）
function runCmdOnce(sess, cmd, onLine, onExit) {
  // 三处 cmd 特性必须同时满足，缺一个就坏：
  //  · /s + 外层引号 + windowsVerbatimArguments —— 否则 Node 把 " 转义成 \"（cmd 不认反斜杠转义）
  //  · /V:ON + !VAR! —— cmd /c 立即模式下 & 链里的 %VAR% 在**执行前**就全展开完，
  //    导致 %CD% 是旧目录、%ERRORLEVEL% 拿不到（实测 %EC% 直接输出字面量）
  //  · 先 set 捕获 ERRORLEVEL，因为后面的 echo 会把它重置成 0
  const full = `${cmd} & set "EC=!ERRORLEVEL!" & echo PONKO_CWD:!CD! & echo PONKO_DONE:!EC!`;
  const p = spawn('cmd.exe', ['/V:ON', '/s', '/c', `"${full}"`], {
    cwd: sess.cwd, windowsHide: true, windowsVerbatimArguments: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  sess.activeProc = p;
  sess.shState = 'busy';
  let buf = '', done = false, code = 0;
  const dec = new TextDecoder(cmdEnc);
  const timer = setTimeout(() => {
    if (!done) { done = true; try { p.kill(); } catch (e) {} onExit(-1, 'timeout'); }
  }, 60000);

  const feed = (s) => {
    buf += s;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      const mc = line.match(/^PONKO_CWD:(.*)$/);
      if (mc) { if (mc[1]) sess.cwd = mc[1].trim(); onLine(sess.cwd, 'cwd'); continue; }
      const md = line.match(/PONKO_DONE:(-?\d+)/);
      if (md) { code = Number(md[1]); return; }
      onLine(line, 'out');
    }
  };
  const flush = () => { if (buf.trim()) feed('\n'); };

  const onData = (c) => feed(dec.decode(c, { stream: true }));
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  p.on('exit', () => {
    if (done) return;
    done = true; clearTimeout(timer); flush();
    if (sess.activeProc === p) sess.activeProc = null;
    sess.shState = 'idle';
    onExit(code, null);
  });
  p.on('error', (e) => {
    if (done) return;
    done = true; clearTimeout(timer);
    if (sess.activeProc === p) sess.activeProc = null;
    sess.shState = 'idle';
    onExit(-1, String(e && e.message || e));
  });
}

// 往持久会话写命令：必须走 base64（stdin 是 ANSI 编码，直接写中文会被解烂）
function pwshSend(sess, psCmd) {
  if (!sess.sh || !sess.sh.stdin.writable) return;
  const b64 = Buffer.from(psCmd, 'utf8').toString('base64');
  sess.sh.stdin.write(`Invoke-Expression ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${b64}")))\n`);
}

function pwshCd(sess, dir) {
  pwshSend(sess, `Set-Location -LiteralPath "${String(dir).replace(/"/g, '`"')}" -ErrorAction SilentlyContinue`);
}

// 把一行命令拆成 argv（处理双/单引号），供 pty.startProgram 直接跑程序
function splitArgs(s) {
  const out = []; let cur = ''; let q = null;
  for (const ch of String(s)) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (ch === ' ' || ch === '\t') { if (cur) { out.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// 命令分发：先处理 shell 切换 / 交互式拦截，再交给对应执行器
function runCommand(sess, cmd, onLine, onExit) {
  const raw = String(cmd || '').trim();
  const tok0 = (raw.split(/\s+/)[0] || '').toLowerCase().replace(/^["']|["']$/g, '');
  const bare = tok0.replace(/\.(exe|com|bat|cmd)$/, '');
  const noArgs = raw.slice(tok0.length).trim() === '' || raw === tok0;

  // ── 切换 shell（裸 cmd / powershell）
  if (noArgs && (bare === 'cmd' || bare === 'powershell' || bare === 'pwsh')) {
    const want = bare === 'cmd' ? 'cmd' : 'pwsh';
    if (sess.kind === want) {
      onLine(want === 'cmd' ? '已经在 CMD 模式了。输入 powershell 切回 PowerShell。'
        : '已经在 PowerShell 模式了。输入 cmd 切到 CMD。', 'info');
      return onExit(0, null);
    }
    sess.kind = want;
    sess.cwd = sess.cwd || 'C:\\';
    if (want === 'pwsh') pwshCd(sess, sess.cwd);   // 把 CMD 期间改变的目录同步回持久会话
    onLine(sess.kind, 'shell');
    onLine(want === 'cmd'
      ? '已切到 CMD 模式：cd 保持，但 set 的环境变量不跨命令保留。输入 powershell 或 exit 切回。'
      : '已切回 PowerShell 模式（持久会话，cd 和变量都保留）。', 'info');
    return onExit(0, null);
  }

  // ── exit / quit：结束这个标签的 shell 会话
  // 一个标签 = 一个会话，所以会话没了标签也该关——前端收到 dead 后负责收标签。
  // CMD 模式只是本会话的一层壳（不是独立进程），所以那里 exit 仍是"退回 PowerShell"，
  // 再输一次才真的收掉；两级退出，跟 cmd 里套 pwsh 的直觉一致。
  if (noArgs && (bare === 'exit' || bare === 'quit')) {
    if (sess.kind === 'cmd') {
      sess.kind = 'pwsh';
      pwshCd(sess, sess.cwd);
      onLine(sess.kind, 'shell');
      onLine('已退回 PowerShell 模式。再输一次 exit 会关掉这个标签的 shell。', 'info');
      return onExit(0, null);
    }
    onLine('shell 会话已结束，标签随之关闭。要退出整个程序：点右上角「✕ 退出」或按 ^⇧Q（或运行 stop.bat）。', 'info');
    onLine('__dead__', 'dead');          // 前端据此关标签（并补一个新的）
    // 让这条响应流先收尾再 kill 子进程，否则流会被掐断、前端收不到 dead
    setTimeout(() => dropSess(sess.id), 60);
    return onExit(0, null);
  }

  // ── 显式进入真终端：pty <cmd>
  if (bare === 'pty' || bare === '!pty') {
    const inner = raw.slice(tok0.length).trim() || 'powershell';
    const parts = splitArgs(inner);
    const first = (parts[0] || '').toLowerCase().replace(/^["']|["']$/g, '').replace(/\.(exe|com|bat|cmd)$/, '');
    const ptyOpts = { cwd: sess.cwd,
      cols: Number(process.env.PONKO_PTY_COLS || 100), rows: Number(process.env.PONKO_PTY_ROWS || 30) };
    // 想要一个真终端（开 shell）→ 直接起 shell（不再在里面重复跑一遍同名 shell）；
    // 想把某个程序放真终端跑 → 直接跑，退出即回本 shell
    const isShell = first === 'pwsh' || first === 'powershell' || first === 'cmd';
    const p = isShell
      ? sess.pty.start({ ...ptyOpts, shell: first === 'cmd' ? 'cmd' : 'pwsh' })
      : sess.pty.startProgram(parts, ptyOpts);
    p.then((r) => { if (!r.ok) onLine('PTY 启动失败：' + (r.msg || '未知原因'), 'err'); });
    onLine('__pty__', 'pty');            // 通知前端：切到终端渲染模式
    return onExit(0, null);
  }

  // ── 交互式程序不再拦截，改开真终端（ConPTY）直接跑它 —— 这是"卡死"的正解
  // 直接在 PTY 里跑程序本身（不是先起一层 shell）：程序退出即 PTY 结束，自动回到当前 shell，
  // 不会让用户"莫名其妙掉进第二个 cmd/pwsh，还得再 exit 一次"。
  if (noArgs && REPL_BLOCK.has(bare)) {
    sess.pty.startProgram([bare], { cwd: sess.cwd,
      cols: Number(process.env.PONKO_PTY_COLS || 100), rows: Number(process.env.PONKO_PTY_ROWS || 30) })
      .then((r) => {
        if (!r.ok) {
          onLine('PTY 启动失败：' + (r.msg || '未知原因'), 'err');
          onLine(`带参数执行仍可用管道：${bare} script.py / ${bare} -c "..."`, 'info');
        }
      });
    onLine('__pty__', 'pty');
    return onExit(0, null);
  }
  // CMD 模式下裸 powershell 同理（不带参数就是进 REPL）
  if (sess.kind === 'cmd' && noArgs && bare === 'powershell') { /* 上面已处理 */ }

  if (sess.kind === 'cmd') return runCmdOnce(sess, raw, onLine, onExit);
  return runPwsh(sess, raw, onLine, onExit);
}

function runPwsh(sess, cmd, onLine, onExit) {
  if (!sess.sh) spawnShell(sess);
  if (!sess.sh.ready) { setTimeout(() => runPwsh(sess, cmd, onLine, onExit), 120); return; }
  const sh = sess.sh;
  sess.shState = 'busy';
  let done = false;
  const timer = setTimeout(() => {
    if (!done) {
      done = true; cleanup();
      // 超时多半是命令抢占了 stdin（会话已不可信），必须重建
      try { sh.kill(); } catch (e) {}
      if (sess.sh === sh) sess.sh = null;
      spawnShell(sess);
      onExit(-1, 'timeout');
    }
  }, 60000);

  function onData(chunk) {
    sess.shBuf += chunk;
    let idx;
    while ((idx = sess.shBuf.indexOf('\n')) >= 0) {
      const line = sess.shBuf.slice(0, idx).replace(/\r$/, '');
      sess.shBuf = sess.shBuf.slice(idx + 1);
      if (line.includes(SENTINEL)) {
        const m = line.match(/PONKO_DONE_9f3c:(-?\d+)/);
        if (!done) { done = true; cleanup(); onExit(m ? Number(m[1]) : 0, null); }
        return;
      }
      const cwd = line.match(/^PONKO_CWD:(.*)$/);
      if (cwd) { if (cwd[1]) sess.cwd = cwd[1]; if (!done) onLine(sess.cwd, 'cwd'); return; }
      if (!done) onLine(line, 'out');
    }
  }
  function onErr(chunk) {
    sess.shBuf += chunk; // stderr 与 stdout 交错，统一按行处理
    onData('');
  }
  function cleanup() {
    clearTimeout(timer);
    sh.stdout.off('data', onData);
    sh.stderr.off('data', onErr);
    sess.shState = 'idle';
  }

  sh.stdout.on('data', onData);
  sh.stderr.on('data', onErr);
  // 命令经 base64 传入（绕开 stdin 的 ANSI 编码），PowerShell 侧解码后执行
  pwshSend(sess, cmd);
  // 顺带回传当前目录，前端提示符才能跟着 cd 变
  sh.stdin.write('Write-Output "PONKO_CWD:$((Get-Location).Path)"\n');   // 纯 ASCII，可直接写
  sh.stdin.write(`Write-Output "${SENTINEL}:$LASTEXITCODE"\n`);
}

function killCommand(sess) {
  if (sess.kind === 'cmd') {
    if (sess.activeProc) {
      try { sess.activeProc.kill(); } catch (e) {}
      sess.activeProc = null; sess.shState = 'idle'; return true;
    }
    return false;
  }
  if (sess.sh && sess.shState === 'busy') {
    try { sess.sh.kill(); } catch (e) {}
    sess.sh = null;
    spawnShell(sess);
    sess.shState = 'idle';
    return true;
  }
  return false;
}

// ─────────────────────────────── 假 agent（后续替换成真 LLM 调用）
//
// 关键约定：**心情由 agent 自己在正文里声明**，格式 [[mood:STATE|face:标签|i:强度|note:自述]]。
// 所以这里模拟的是"一个会自我标注情绪的 LLM 输出"——整段正文交给 streamAgent 原样切片，
// 标记由 moodp.parseInline 剥离。换真 LLM 时，只要把 fakeAgentBody 换成模型输出即可，
// 前端/主题/角色链路一行都不用改。

const DEFAULT_STATE_INTENSITY = { idle: 0.45, think: 0.6, stream: 0.8, sleepy: 0.2, error: 0.7 };

function fakeAgentBody(text) {
  const lower = String(text || '').toLowerCase();
  const wantsShell = /失败|报错|error|构建|build|为什么|查|看|跑|运行|错/.test(lower);

  if (wantsShell) {
    return [
      '[[mood:think|face:thinking|i:0.55|note:先别急着下结论，看现场]]\n',
      '判断需要先看真实输出，而不是凭印象猜。\n',
      '[[mood:error|face:error|i:0.7|note:这个报错有点难缠]]\n',
      '日志里确实有异常，我盯一会儿。\n',
      '[[mood:stream|face:thinking|i:0.8|note:有线索了，先说结论]]\n',
      '问题不在你的代码里。\n\n',
      'AGP 的 path check 在解析中文路径时会直接抛错，这是已知的 AGP 行为。\n\n',
      '两条路：\n',
      '1. 把工程复制到纯 ASCII 目录（比如 C:\\NetGateBuild）再构建，最干净；\n',
      '2. 在 gradle.properties 加 android.overridePathCheck=true，绕过检查。\n\n',
      '[[mood:idle|face:idle|i:0.5|note:我建议方案 1，方案 2 迟早失效]]\n',
      '我推荐方案 1 ——方案 2 是 experimental 开关，将来可能失效。',
    ].join('');
  }

  return [
    '[[mood:think|face:thinking|i:0.55|note:这话里有两层意思]]\n',
    '[[mood:stream|face:streaming|i:0.75|note:捋一下再说]]\n',
    '我理解你要的是两件事：\n\n',
    '一是界面自己画字符网格，而不是套一个真终端；\n',
    '二是我这边的内部状态要能直接决定角色表情，而不是前端替我猜。\n\n',
    '第二点现在已经成立了——心情是我自己在输出里声明的，前端只是执行器。\n',
    '[[mood:idle|face:idle|i:0.45|note:剩下的就是把真 LLM 接进来]]\n',
    '剩下要做的，只是把这里换成真的模型调用。',
  ].join('');
}

/** 把整段正文切成 2-4 字的流式片段（真 LLM 的 token 也会切碎行内标记，故下游需缓冲还原） */
function toChunks(body) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    const n = 2 + Math.floor(Math.random() * 3);
    out.push(body.slice(i, i + n));
    i += n;
  }
  return out;
}

/**
 * /api/agent 里那两个"情绪相关"的可选参数 —— 都从请求体里来，都要挡脏值：
 *   persona  性格 id（白名单见 moodp.PERSONAS）→ 非法一律回落 'default'
 *   mood     "此刻心情"快照 {state, note, minutes} → 这里再校一遍，脏的当没给
 *
 * ⚠ **没带 mood 就是没有**，不许拿盘上那份兜底（2026-10-17 改）。
 * 原来这里会退回 `readUiState().mood`：那是"整个屏幕最后一帧"的缓存，不是这个对话的心情。
 * 心情改成每对话一份之后，那份缓存随时可能正写着**隔壁那个对话**的 anger ——
 * 前端一旦少带一次（旧页面 / 手动 curl / 请求体拼漏了），模型就会被塞进别的对话的火气，
 * 表现出来就是用户说的"记忆串通"。宁可这一轮不提心情，也不能提错人的心情。
 */
function agentMoodOpts(body) {
  const persona = moodp.normPersona(body && body.persona);
  const raw = (body && body.mood && typeof body.mood === 'object') ? body.mood : null;
  let mood = null;
  if (raw && moodp.STATES[raw.state]) {
    const mins = Number(raw.minutes);
    mood = {
      state: raw.state,
      // 只认 "agent 自己写过的那句" —— noteKey 那种是本地兜底 / 界面文案，
      // 拿去当"你心里想的是…"等于凭空给模型塞一句它没说过的话（同前端 _moodBrief）
      note: String(raw.note || raw.noteText || '').slice(0, 40),
      minutes: (isFinite(mins) && mins >= 0) ? mins : 0,
    };
  }
  return { persona, mood };
}

async function streamAgent(res, text, history, llm, opts) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Transfer-Encoding': 'chunked',
    'X-Accel-Buffering': 'no',
  });
  const emit = (obj) => res.write(JSON.stringify(obj) + '\n');

  // 走真模型还是演示用的假 agent，**只看这个对话自己带没带配置**（地址+Key 都有）：
  // 不再看任何进程级状态 —— 同一个后端进程里，A 对话可以接真模型、B 对话还在演示模式。
  const cfg = llmOf(llm);
  if (cfg) { await callRealLLM(res, emit, text, history, cfg, opts); res.end(); return; }

  // 真 LLM 的 token 会随意切开 [[mood:...]]，交给解析器跨片段还原
  const parser = new moodp.MoodStreamParser(facesFromPacks());
  const trimLead = makeLeadTrimmer();

  const chunks = toChunks(fakeAgentBody(text));
  let tokens = 0, lastMood = null;
  for (const raw of chunks) {
    const taken = parser.feed(raw);
    for (const m of taken.moods) { lastMood = m; emit({ t: 'mood', ...m, src: 'agent' }); }
    const s = trimLead(taken.text);
    if (s) { emit({ t: 'token', text: s }); tokens++; }
    await new Promise((r) => setTimeout(r, 18 + Math.floor(Math.random() * 30)));
  }
  const tail = parser.flush();                  // 收尾：冲刷缓冲里的半截标记
  for (const m of tail.moods) { lastMood = m; emit({ t: 'mood', ...m, src: 'agent' }); }
  const ts = trimLead(tail.text);
  if (ts) { emit({ t: 'token', text: ts }); tokens++; }
  emit({ t: 'done', tokens: Math.max(1, Math.ceil(tokens / 1.6)), mood: lastMood || undefined });
  res.end();
}

/**
 * 流式正文的开头空白裁剪器。
 * 模型惯用的写法是先在正文前甩一个 [[mood:...]]、再换行两次才开始说正事：
 *     [[mood:think|note:想想]]\n\n正文……
 * 标记被解析器剥掉之后，那两个换行就原封不动地留在了回复最前面 ——
 * 用户看到的就是"每次回答开头都空两行"。这里把正文真正开始之前的空白全部吃掉，
 * 只在开头生效一次，正文中间的换行/缩进原样保留。
 */
function makeLeadTrimmer() {
  let started = false;
  return (s) => {
    if (!s) return '';
    if (started) return s;
    const t = s.replace(/^[\s\u3000]+/, '');
    if (!t) return '';            // 还没真正开始说话，这段空白整个丢掉
    started = true;
    return t;
  };
}

// 把前端送来的近期对话整理成 LLM 的消息数组（不含 system、不含本次提问）。
// 三个坑：
//   ① 角色名要映射：前端的 'agent' → assistant；system 走单独字段不入列；
//      未知角色一律当 user，免得部分服务对着非法 role 直接 400。
//   ② 历史末尾若已经躺着一条和本次提问一模一样的 user（前端没排干净 / 重发），要剔掉，
//      否则同一次提问被发两遍。
//   ③ 窗口要够宽：10 条只有 5 轮，聊几轮前面的就忘了。
const MAX_HISTORY_MSGS = 20;                  // 约 10 轮
function buildHistory(history, text) {
  const out = [];
  const cur = String(text || '').trim();
  const src = Array.isArray(history) ? history.slice(-MAX_HISTORY_MSGS) : [];
  for (const m of src) {
    if (!m || !m.content) continue;
    const content = String(m.content).trim();
    if (!content) continue;
    let role = m.role === 'agent' ? 'assistant' : m.role;
    if (role === 'system') continue;
    if (role !== 'user' && role !== 'assistant') role = 'user';
    out.push({ role, content });
  }
  while (out.length && out[out.length - 1].role === 'user' && out[out.length - 1].content === cur) out.pop();
  return out;
}

// ─────────────────────────────── 心情兜底（模型整轮不发标记时）
//
// 2026-10-18 用户报"起码有两次心情设置有错误"：翻存档发现那几轮模型**根本没写
// [[mood:...]]** —— 同一段历史复现，三次里三次都没写。漏了不会报错，界面只是停在
// 上一副表情上，用户看到的就是"设了没生效 / 设错了"。
//
// 所以流结束后如果一条声明都没收到，就拿它**刚说完的这段正文**再问一次，只让它输出
// 一行标记。心情仍然由模型判断（换了个更专注的问法），不是本地猜、也没有任何默认值：
// 补问失败（超时 / 返回看不懂）就当它这轮没说话，界面保持原样，绝不硬塞一个 state。
// 12s 上限。max_tokens 要留够：deepseek-flash 这类**带推理**的模型会先吐一大段
// reasoning_content，80 个 token 全被它吃掉，正文是空的（finish_reason=length）——
// 实测 200 还不够，400 才稳定收在 STOP。时间也相应放宽，宁可慢一两秒也别补不出来。
const MOOD_REPAIR_MS = 12000;

function moodLogLine(src, m, text) {
  try {
    const line = [
      new Date().toISOString(),
      src,
      m.state || '?',
      'face=' + (m.face || '-'),
      'i=' + (m.intensity === undefined ? '-' : m.intensity),
      'until=' + (m.until === undefined ? '-' : m.until),
      'note=' + JSON.stringify(m.note || ''),
      'text=' + JSON.stringify(String(text || '').replace(/\s+/g, ' ').trim().slice(0, 40)),
    ].join('\t') + '\n';
    fs.appendFileSync(MOOD_LOG, line);
  } catch (e) { /* 日志写不进去不能影响回复 */ }
}

async function repairMood(cfg, faces, text) {
  const body = String(text || '').trim();
  if (!body) return null;
  console.log('[mood] 本轮没收到标记，补问一次');
  const sys = [
    '你把一段角色台词归到一种心情上。只输出一行标记，别的什么都不写。',
    '- STATE 只能是：' + moodp.STATE_KEYS.join(' / '),
    (faces && faces.length) ? '- face 必须从这些标签里选：' + faces.join(' / ') : '',
    '格式：[[mood:STATE|face:标签|i:0.6|until:600000|note:二十字以内的第一人称心里话]]',
  ].filter(Boolean).join('\n');
  const q = '台词：\n' + body.slice(0, 4000);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), MOOD_REPAIR_MS);
  try {
    let out = '';
    if (activeProvider(cfg) === 'anthropic') {
      const url = (cfg.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1/messages';
      const r = await fetch(url, {
        method: 'POST', signal: ctl.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: cfg.model || 'claude-3-5-sonnet-latest',
          max_tokens: 400,
          system: sys,
          messages: [{ role: 'user', content: q }],
        }),
      });
      if (!r.ok) { console.log('[mood] 补问失败 HTTP ' + r.status); return null; }
      const j = await r.json();
      out = (j.content || []).map((x) => x.text || '').join('');
    } else {
      const url = (cfg.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1/chat/completions';
      const r = await fetch(url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify({
          model: cfg.model || 'gpt-3.5-turbo',
          max_tokens: 400, temperature: 0.2, stream: false,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: q }],
        }),
      });
      if (!r.ok) { console.log('[mood] 补问失败 HTTP ' + r.status); return null; }
      const j = await r.json();
      out = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    }
    return new moodp.MoodStreamParser(faces).feed(out).moods[0] || null;
  } catch (e) {
    console.log('[mood] 补问异常：' + (e && e.message));   // 超时 / 网络错：这一轮就当没声明
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 真 LLM（SSE 流式）。两套协议：OpenAI 兼容 /chat/completions 与 Anthropic 原生 /messages。
// 心情标记 [[mood:...]] 仍由原解析器处理，所以真模型只要按协议在正文里声明情绪，
// 前端/角色链路一行都不用改。
async function callRealLLM(res, emit, text, history, cfg, opts) {
  if (activeProvider(cfg) === 'anthropic') { await callAnthropic(res, emit, text, history, cfg, opts); return; }
  const base = (cfg.baseUrl || '').replace(/\/+$/, '');
  if (!base) { emit({ t: 'error', text: 'LLM 未配置：缺少 API 地址' }); return; }
  const url = base.replace(/\/v1$/, '') + '/v1/chat/completions';   // 兼容带或不带 /v1 的地址
  // opts = { persona, mood }：性格 + "此刻心情"。心情那一段是**情绪记忆**的关键，
  // 见 moodprotocol.js 的 moodBriefing。
  const sys = moodp.buildSystemPrompt(facesFromPacks(), opts);
  const messages = [{ role: 'system', content: sys }, ...buildHistory(history, text)];
  messages.push({ role: 'user', content: text });

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ model: cfg.model || 'gpt-3.5-turbo', stream: true, messages, temperature: 0.7 }),
    });
  } catch (e) { emit({ t: 'error', text: '连不上 LLM：' + e.message }); return; }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 240); } catch (e) {}
    emit({ t: 'error', text: `LLM 返回 ${resp.status}：${detail}` });
    return;
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', tokens = 0, lastMood = null, full = '';
  const parser = new moodp.MoodStreamParser(facesFromPacks());
  const trimLead = makeLeadTrimmer();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch (e) { continue; }
        const delta = j.choices && j.choices[0] && j.choices[0].delta ? (j.choices[0].delta.content || '') : '';
        if (!delta) continue;
        const taken = parser.feed(delta);
        for (const m of taken.moods) { lastMood = m; emit({ t: 'mood', ...m, src: 'agent' }); moodLogLine('stream', m, full); }
        const s = trimLead(taken.text);
        if (s) { emit({ t: 'token', text: s }); tokens++; full += s; }
      }
    }
  } catch (e) { emit({ t: 'error', text: '读取 LLM 流失败：' + e.message }); }
  const tail = parser.flush();
  for (const m of tail.moods) { lastMood = m; emit({ t: 'mood', ...m, src: 'agent' }); moodLogLine('stream', m, full); }
  const ts = trimLead(tail.text);
  if (ts) { emit({ t: 'token', text: ts }); tokens++; full += ts; }
  // 整轮一条标记都没有 —— 模型把协议忘了。拿它刚说的正文单独补问一次（见 repairMood）。
  if (!lastMood && full.trim()) {
    const m = await repairMood(cfg, facesFromPacks(), full);
    if (m) { lastMood = m; emit({ t: 'mood', ...m, src: 'agent' }); moodLogLine('repair', m, full); }
  }
  emit({ t: 'done', tokens: Math.max(1, tokens), mood: lastMood || undefined });
}

// Anthropic 原生（Claude）：POST /v1/messages，x-api-key 头，SSE 事件是
// content_block_delta{ delta:{ type:'text_delta', text } }，跟 OpenAI 的 choices[0].delta 不是一回事。
// 两个 Anthropic 特有的坑：system 必须单独字段（不能塞进 messages）；
// user/assistant 必须严格交替（连续同角色要合并），否则 400。
async function callAnthropic(res, emit, text, history, cfg, opts) {
  const base = (cfg.baseUrl || '').replace(/\/+$/, '');
  if (!base) { emit({ t: 'error', text: 'LLM 未配置：缺少 API 地址' }); return; }
  const url = base.replace(/\/v1$/, '') + '/v1/messages';
  const sys = moodp.buildSystemPrompt(facesFromPacks(), opts);

  const raw = [...buildHistory(history, text), { role: 'user', content: text }];
  // 合并连续同角色 + 保证首条是 user（Anthropic 要求严格交替，否则 400）
  const messages = [];
  for (const m of raw) {
    const prev = messages[messages.length - 1];
    if (prev && prev.role === m.role) prev.content += '\n' + m.content;
    else messages.push({ role: m.role, content: m.content });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length) messages.push({ role: 'user', content: text });

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'x-api-key': cfg.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: cfg.model || 'claude-3-5-sonnet-latest',
        max_tokens: 1024,
        system: sys,
        messages,
        stream: true,
      }),
    });
  } catch (e) { emit({ t: 'error', text: '连不上 LLM：' + e.message }); return; }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 240); } catch (e) {}
    emit({ t: 'error', text: `LLM 返回 ${resp.status}：${detail}` });
    return;
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', tokens = 0, lastMood = null, full = '';
  const parser = new moodp.MoodStreamParser(facesFromPacks());
  const trimLead = makeLeadTrimmer();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch (e) { continue; }
        let delta = '';
        if (j.type === 'content_block_delta' && j.delta && typeof j.delta.text === 'string') delta = j.delta.text;
        else if (j.type === 'message_delta' && j.delta && typeof j.delta.text === 'string') delta = j.delta.text;
        if (j.type === 'error' && j.error && j.error.message) { emit({ t: 'error', text: String(j.error.message).slice(0, 200) }); }
        if (!delta) continue;
        const taken = parser.feed(delta);
        for (const m of taken.moods) { lastMood = m; emit({ t: 'mood', ...m, src: 'agent' }); moodLogLine('stream', m, full); }
        const s = trimLead(taken.text);
        if (s) { emit({ t: 'token', text: s }); tokens++; full += s; }
      }
    }
  } catch (e) { emit({ t: 'error', text: '读取 LLM 流失败：' + e.message }); }
  const tail = parser.flush();
  for (const m of tail.moods) { lastMood = m; emit({ t: 'mood', ...m, src: 'agent' }); moodLogLine('stream', m, full); }
  const ts = trimLead(tail.text);
  if (ts) { emit({ t: 'token', text: ts }); tokens++; full += ts; }
  // 整轮一条标记都没有 —— 模型把协议忘了。拿它刚说的正文单独补问一次（见 repairMood）。
  if (!lastMood && full.trim()) {
    const m = await repairMood(cfg, facesFromPacks(), full);
    if (m) { lastMood = m; emit({ t: 'mood', ...m, src: 'agent' }); moodLogLine('repair', m, full); }
  }
  emit({ t: 'done', tokens: Math.max(1, tokens), mood: lastMood || undefined });
}

/** 当前所有素材包的表情标签（给 LLM 的 system 提示词用） */
function facesFromPacks() {
  const out = new Set();
  for (const p of listCharpacks()) for (const t of Object.keys(p.moods || {})) out.add(t);
  return [...out].sort();
}

// ─────────────────────────────── 对话存档（AGENT 多标签 = 多个对话）
//
// 目录与上限那几个常量在**文件头**（ROOT 旁边）—— 启动自检要扫存档，所以必须定义在
// 自检之前，原因见那里。这一节只放读写函数。

function convPath(id) { return path.join(CONV_DIR, id + '.json'); }

/** 只留下有意义的字段：流式中间态（stream/done）、时间戳、界面态都不落盘 */
function cleanMsgs(msgs) {
  const out = [];
  if (!Array.isArray(msgs)) return out;
  for (const m of msgs.slice(-CONV_MAX_MSGS)) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || '');
    if (!CONV_ROLES.has(role)) continue;
    const text = String(m.text === undefined || m.text === null ? '' : m.text).slice(0, CONV_MAX_TEXT);
    const o = { role, text };
    if (m.result) o.result = String(m.result).slice(0, CONV_MAX_TEXT);
    out.push(o);
  }
  return out;
}
const hasUser = (msgs) => msgs.some((m) => m.role === 'user' && m.text.trim());

function listConvs() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(CONV_DIR); } catch (e) { return out; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -5);
    if (!CONV_ID_RE.test(id)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(convPath(id), 'utf8'));
      const msgs = Array.isArray(j.msgs) ? j.msgs : [];
      // **落盘即入列**：写档那一步（writeConv）已经把"不值得留的"挡在外面了 ——
      // 能躺在 run/conversations 里的，要么有用户消息、要么配过 LLM、要么是客户端
      // 明确说了要留的标签（keep，见 writeConv）。这里再挑一遍会让"标签数在重启后对不上"：
      // 用户开的那个空标签被写到盘里了，却在列表里被过滤掉 → 一开 HUD 就少一个（2026-10-14 报的）。
      out.push({ id, title: String(j.title || ''), updatedAt: Number(j.updatedAt) || 0, count: msgs.length });
    } catch (e) { /* 坏文件跳过，不要因此让整个列表接口挂掉 */ }
  }
  out.sort((a, b) => a.updatedAt - b.updatedAt);      // 旧 → 新：恢复成标签时顺序稳定
  return out;
}

function readConv(id) {
  if (!CONV_ID_RE.test(String(id || ''))) return null;
  try {
    const j = JSON.parse(fs.readFileSync(convPath(id), 'utf8'));
    return {
      id, title: String(j.title || ''), updatedAt: Number(j.updatedAt) || 0,
      msgs: cleanMsgs(j.msgs),
      llm: llmOf(j.llm),                  // 洗过一遍再给出去：没配 / 存的是坏值 → null
      // 形象也一样洗一遍：'auto' 或干净的包 id（旧存档没这个字段 → 'auto'）
      charpack: normArtOf(j.charpack),
      charpackPicked: ART_ID_RE.test(String(j.charpackPicked || '').trim()) ? String(j.charpackPicked).trim() : '',
      // 标签色号（色板下标）。存档里没有 / 越界 / 不是整数 → null，由前端自己派一个。
      // 这跟"形象"不一样：形象是**内容**（谁在跟谁说话），色号只是**认标签的记号** ——
      // 但用户就是靠它认"那个蓝的是我刚才问问题那个"，所以也得跨重启记住（2026-10-15 报的）。
      ci: normCi(j.ci),
      // 性格（见 moodprotocol.js 的 PERSONAS）：白名单外的脏值回落 default
      persona: moodp.normPersona(j.persona),
      // 这个对话自己的心情快照（没有 / 脏了 → null，前端就当"从头开始"）
      mood: moodp.normMoodSnap(j.mood),
    };
  } catch (e) { return null; }
}

/** 标签色号：非负整数且在色板内才认（色板长度前端定，这里只挡脏值/越界） */
function normCi(v) {
  const n = Number(v);
  return (Number.isInteger(n) && n >= 0 && n < CONV_MAX) ? n : null;
}

function writeConv(id, title, msgs, llm, keep, charpack, charpackPicked, ci, persona, mood) {
  if (!CONV_ID_RE.test(String(id || ''))) return false;
  const clean = cleanMsgs(msgs);
  const cfg = llmOf(llm);
  // 没说过话的对话本来不落盘 —— 但有两种必须落：
  //   ① 配过 LLM 的（llm 有值）：那份地址与 Key 只存在这个对话里，
  //      不写盘的话"新建对话 → 填好配置 → 还没说话就关掉 HUD"等于让人白填一遍。
  //   ② 客户端明确说要留的（keep）：标签栏里**真实存在**的标签。用户新建了一个对话、
  //      或启动时那个还没配好的标签 —— 关掉 HUD 再开，标签数得跟关之前一样，
  //      不能因为"它还没内容"就悄悄少一个（2026-10-14 用户报的）。
  // 形象（charpack）跟着对话存，但**它自己不构成落盘理由**：一个空对话选了什么形象
  // 不值得为它留个档（那种对话本来就会因为 keep 留下来）。
  if (!hasUser(clean) && !cfg && !keep) return false;
  const art = normArtOf(charpack);
  const picked = ART_ID_RE.test(String(charpackPicked || '').trim()) ? String(charpackPicked).trim() : '';
  const color = normCi(ci);            // 标签色号：脏值/越界就当没给（前端会自己派一个）
  const per = moodp.normPersona(persona);   // 性格：脏值回落 default（同上，不猜）
  const moodSnap = moodp.normMoodSnap(mood);   // 心情：脏值整条丢掉（同上，不猜）
  try {
    fs.mkdirSync(CONV_DIR, { recursive: true });
    const data = {
      id, title: String(title || '').slice(0, 120), updatedAt: Date.now(), msgs: clean,
      ...(cfg ? { llm: cfg } : {}),     // 没配就不写这个字段 —— 旧存档的结构原样保持
      // 同上：'auto' 且没挑到东西就不写，别让每个老对话都被塞两个字段
      ...((art !== 'auto' || picked) ? { charpack: art, ...(picked ? { charpackPicked: picked } : {}) } : {}),
      ...(color === null ? {} : { ci: color }),
      // 同上：'default' 的语义是"没设置"，不写这个字段（别把每个老对话都塞一个 persona）
      ...(per === 'default' ? {} : { persona: per }),
      // 心情：**每个对话一份**（2026-10-17 起）。洗完再存 —— 前端是唯一的写入方，
      // 但存档文件用户能直接改，脏值不能直接喂回 restore（见 normMoodSnap）。
      ...(moodSnap ? { mood: moodSnap } : {}),
    };
    fs.writeFileSync(convPath(id), JSON.stringify(data));
    return true;
  } catch (e) { return false; }
}

function dropConv(id) {
  if (!CONV_ID_RE.test(String(id || ''))) return false;
  try { fs.unlinkSync(convPath(id)); return true; } catch (e) { return false; }
}

// ─────────────────────────────── 界面状态落盘（心情快照）
//
// 只做一件事：把前端"这一刻长什么样"存下来，下次开 HUD 原样还给它。
// 校验按"宁缺毋滥"：state 必须是那个封闭枚举，不合法**整条丢掉**（宁可回到待机，
// 也不要让界面停在一个不存在的状态上）；其余字段一律截断到有界长度，别让一个坏文件
// 把几百 KB 塞进渲染进程。
const UI_MAX_NOTE = 200;
function normUiMood(m) {
  if (!m || typeof m !== 'object') return null;
  const state = String(m.state || '').trim().toLowerCase();
  if (!UI_MOOD_STATES.has(state)) return null;
  const face = String(m.face == null ? '' : m.face).trim().slice(0, 40);
  const noteText = String(m.noteText || '').slice(0, UI_MAX_NOTE);
  const nkRaw = String(m.noteKey || '');
  const noteKey = /^[A-Za-z0-9._]{0,60}$/.test(nkRaw) ? nkRaw : '';
  const source = UI_MOOD_SOURCES.has(m.source) ? m.source : 'auto';
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const iRaw = num(m.intensity);
  const vRaw = num(m.value);
  return {
    state,
    face: face || null,
    // note 是**内容**（agent 自己那句话），原样留着；空串表示它没说过
    noteText,
    noteKey,
    source,
    intensity: iRaw === null ? 0.45 : Math.max(0, Math.min(1, iRaw)),
    value: vRaw === null ? null : Math.round(Math.max(2, Math.min(100, vRaw)) * 100) / 100,
    savedAt: Number(m.savedAt) || Date.now(),   // 墙上时间：只是给"上次什么时候存的"留个底
  };
}

/**
 * 落在哪个对话上：只认"长得像对话 id"的（同一个 CONV_ID_RE），其余一律当没存。
 * 空串 = 没存过（新装机 / 老版本写的文件），前端就按自己的默认（最近更新的那个）落。
 */
function normUiActive(v) {
  const s = String(v == null ? '' : v).trim();
  return CONV_ID_RE.test(s) ? s : '';
}

/** 读回到 { mood: {...}|null, active: 'cxxx'|'' } —— 文件不存在 / 坏了都当成"没有"，不报错 */
function readUiState() {
  try {
    const j = JSON.parse(fs.readFileSync(UI_PATH, 'utf8'));
    return { mood: normUiMood(j && j.mood), active: normUiActive(j && j.active) };
  } catch (e) { return { mood: null, active: '' }; }
}

/**
 * 写。语义跟 writeConv 的"没配就不写"不同：这里是**逐字段显式设置** ——
 * body 里带了哪个字段就以它为准（哪怕是 null / 空串，那是"清掉"），
 * 没带的字段**保留原来那份**（心情和 active 分别从两个地方写，谁都不许把对方抹掉）。
 */
function writeUiState(body) {
  const has = (k) => !!body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, k);
  const prev = readUiState();
  const mood = has('mood') ? normUiMood(body.mood) : prev.mood;
  const active = has('active') ? normUiActive(body.active) : prev.active;
  try {
    fs.mkdirSync(UI_DIR, { recursive: true });
    fs.writeFileSync(UI_PATH, JSON.stringify({ v: 1, mood, active }));
    return true;
  } catch (e) { return false; }
}

// ─────────────────────────────── 素材包
// 注意：用**函数声明**而不是模块级 const —— 启动时的 assetStat() 在文件靠上的位置就调用
// listCharpacks()，那时靠后的 const 还在 TDZ 里，抛错会被下面的 catch 吞掉，
// 于是一个包都扫不到（启动画面如实报"没找到素材包"）。函数声明会提升，没这个问题。
function isArtFile(f) { return /\.(png|jpe?g|webp)$/i.test(f); }

function listCharpacks() {
  const out = [];
  if (!fs.existsSync(CHARS)) return out;
  for (const d of fs.readdirSync(CHARS)) {
    const dir = path.join(CHARS, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    const packPath = path.join(dir, 'frames', 'pack.json');
    if (!fs.existsSync(packPath)) continue;
    try {
      const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
      const entry = { id: d, ...pack, base: `/characters/${d}/frames/` };
      // 高清立绘：src/ 下的图，文件名（去掉 _0/_1 帧号）就是标签。
      // 前端拿到 artBase + art 就直接 drawImage，绕开字符网格 —— 同标签多帧只取第一张。
      const srcDir = path.join(dir, 'src');
      if (fs.existsSync(srcDir)) {
        const art = {};
        for (const f of fs.readdirSync(srcDir)) {
          if (!isArtFile(f)) continue;
          const lab = f.replace(/_\d+$/, '').replace(/\.[^.]+$/, '');
          if (!(lab in art)) art[lab] = f;
        }
        if (Object.keys(art).length) {
          entry.art = art;
          entry.artBase = `/characters/${d}/src/`;
        }
      }
      out.push(entry);
    } catch (e) { /* 坏包跳过 */ }
  }
  return out;
}

// ─────────────────────────────── Tab 补全用的命令表
//
// 补全一个词要先知道"这个 shell 认识哪些命令"。PowerShell 的别名 / 函数 / cmdlet 拿不到
// （那得问 pwsh 自己，见 complete.js 开头为什么不用 TabExpansion2），但**可执行文件**能扫：
// 把 PATH 里每个目录列一遍，留下 .exe/.cmd/.bat/.com/.ps1 的主干名去重就是。
//
// 扫一遍要读二十来个目录（System32 一个就几千个文件），本机实测 ~25ms（23 个目录 / 1300 个
// 可执行文件）。虽然不算贵，但也不能放在用户按 Tab 那一瞬间做，所以开机后预热一次，
// 之后 5 分钟内直接用缓存。
const EXE_EXT = new Set(['.exe', '.cmd', '.bat', '.com', '.ps1']);
let _cmdAt = 0;
let _cmdNames = [];
function commandNames(force) {
  if (!force && _cmdNames.length && Date.now() - _cmdAt < 300000) return _cmdNames;
  const names = [];
  const seen = new Set();
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!EXE_EXT.has(ext)) continue;
      const base = e.name.slice(0, e.name.length - ext.length);
      const k = base.toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k); names.push(base);
    }
  }
  names.sort((a, b) => a.localeCompare(b));
  _cmdAt = Date.now();
  _cmdNames = names;
  return names;
}

// ─────────────────────────────── 路由
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname);

  try {
    if (p === '/api/sys') return sendJson(res, sysinfo.snapshot());
    // shell 当前状态（前端面板启动时拉一次，避免首屏用写死的 C:\）
    if (p === '/api/shell/state') {
      const s = getSess(u.searchParams.get('s'));
      if (!s) return sendJson(res, { cwd: '', shell: 'pwsh', error: '会话数已达上限' });
      return sendJson(res, { cwd: s.cwd, shell: s.kind, session: s.id });
    }
    // 会话清单：前端可用来对账（每个标签一个）
    if (p === '/api/sessions') {
      return sendJson(res, { sessions: listSess(), pty: listPtySessions(), max: MAX_SESSIONS });
    }
    // Tab 补全：把"这一行 + 光标位置"发过来，回候选 + 这个词在行里的范围。
    // cwd 取**后端会话里那份**（前端那份是跟着 cd 回来的镜像，可能还没同步）。
    // 取不到会话也不报错：按 USERPROFILE 补，至少比什么都不补强。
    if (p === '/api/complete') {
      const s = getSess(u.searchParams.get('s'), false);
      const line = u.searchParams.get('line') || '';
      const raw = Number(u.searchParams.get('caret'));
      return sendJson(res, complete.completeLine({
        line,
        caret: Number.isFinite(raw) ? raw : line.length,
        cwd: (s && s.cwd) || process.env.USERPROFILE || 'C:\\',
        kind: (s && s.kind) || 'pwsh',
        commands: commandNames(),
        home: process.env.USERPROFILE || '',
      }));
    }
    // （原来的 /api/llm/config 已经删掉：那份全局配置不再存在，见文件头那一节。
    //  现在配置随对话走，由 /api/conv 一起存、随 /api/agent 一起带上。）
    // LLM 连通性验证：真的打一次远端接口（**纯探测，不写任何文件**），前端据此决定存不存
    if (p === '/api/llm/test' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      return sendJson(res, await testLlm(body));
    }
    // 「自动」形象：让这个对话配好的模型从候选里自己挑一个（**纯调用，不写任何文件**，
    // 挑出来的结果由前端存进那个对话）。报错按上面那条规矩：只给原文，措辞交给语言包。
    if (p === '/api/llm/pick-art' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const cfg = llmOf(body);
      if (!cfg) return sendJson(res, { ok: false, error: '缺少 API 地址或 Key' });
      return sendJson(res, await pickArt(cfg, body.packs));
    }
    if (p === '/api/charpacks') return sendJson(res, listCharpacks());
    // 启动记录：前端启动画面取回去回放（每行都是真事，见 server/bootlog.js）
    if (p === '/api/bootlog') return sendJson(res, bootlog.snapshot({ port: PORT }));

    // 心情协议：state 枚举 + 素材包可用表情 + 可直接塞给 LLM 的 system 提示词
    if (p === '/api/mood/protocol') {
      const faces = facesFromPacks();
      return sendJson(res, {
        states: moodp.STATES,
        stateKeys: moodp.STATE_KEYS,
        faces,
        tags: moodp.TAG_RE.source,
        systemPrompt: moodp.buildSystemPrompt(faces),
      });
    }
    if (p === '/api/netgeo') return sendJson(res, await netgeo.netgeo(u.searchParams.get('refresh') === '1'));

    // 单个 IP 的地理位置（shell 输出里扫到 IP 时在地球上打标记用）
    if (p === '/api/geo') {
      const ip = u.searchParams.get('ip') || '';
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return sendJson(res, { ip, none: true });
      if (netgeo.isPrivate(ip)) return sendJson(res, { ip, private: true });
      const map = await netgeo.geoMany([ip]);
      return sendJson(res, map[ip] || { ip, none: true });
    }

    if (p === '/api/shell' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      // 中断：只查不建（别为了点一下中断就凭空造出一个会话）
      if (body.abort) {
        const s = getSess(body.session, false);
        return sendJson(res, { aborted: s ? killCommand(s) : false });
      }
      const s = getSess(body.session);
      if (!s) {
        return sendJson(res, { ok: false, error: '会话数已达上限（' + MAX_SESSIONS + '）' });
      }
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Transfer-Encoding': 'chunked',
      });
      // 先把当前 shell 类型 + 真实工作目录同步给前端（前端默认写的 C:\ 是错的，
      // 真实会话起始在 USERPROFILE；命令执行后还会再发一次 cwd 反映 cd 结果）
      res.write(JSON.stringify({ t: 'shell', text: s.kind, session: s.id }) + '\n');
      res.write(JSON.stringify({ t: 'cwd', text: s.cwd, session: s.id }) + '\n');
      runCommand(s, body.cmd || '',
        (line, kind) => res.write(JSON.stringify({ t: kind, text: line, session: s.id }) + '\n'),
        (code, err) => { res.write(JSON.stringify({ t: 'exit', code, error: err, session: s.id }) + '\n'); res.end(); });
      return;
    }

    if (p === '/api/agent' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      // body.llm = **这个对话自己的** API 配置（每个对话一份，见文件头那一节）。
      // 没带 / 带得不完整 → llmOf() 返回 null → 走演示用的假 agent，不报错。
      // body.persona / body.mood = 性格 + "此刻心情"（都要挡脏值，见 agentMoodOpts）。
      return await streamAgent(res, body.text || '', body.history || [], body.llm, agentMoodOpts(body));
    }

    // 对话存档（AGENT 多标签）。落在 run/conversations/ —— 该目录不入库，不会被推到 GitHub。
    if (p === '/api/convs') return sendJson(res, { convs: listConvs(), max: CONV_MAX });
    if (p === '/api/conv' && req.method === 'GET') {
      const c = readConv(u.searchParams.get('s'));
      return c ? sendJson(res, c) : sendJson(res, { error: 'not found' }, 404);
    }
    if (p === '/api/conv' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      return sendJson(res, {
        ok: writeConv(b.id, b.title, b.msgs, b.llm, b.keep, b.charpack, b.charpackPicked, b.ci, b.persona, b.mood),
      });
    }
    if (p === '/api/conv/delete' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      return sendJson(res, { ok: dropConv(b.id) });
    }

    // 界面状态（重启后画面跟关掉时一样）：目前就是心情快照。见 UI_PATH 那段注释。
    if (p === '/api/ui-state' && req.method === 'GET') return sendJson(res, readUiState());
    if (p === '/api/ui-state' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      return sendJson(res, { ok: writeUiState(b) });
    }

    // ── PTY：真终端会话（每个标签一份；session 省略即默认会话 '0'）
    if (p === '/api/pty' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      // 关闭会话必须在"取会话"之前处理，否则 getSess 又会把它建回来
      if (b.op === 'close') return sendJson(res, { ok: dropSess(b.session) });
      const s = getSess(b.session);
      if (!s) return sendJson(res, { ok: false, msg: '会话数已达上限（' + MAX_SESSIONS + '）' });
      const P = s.pty;
      if (b.op === 'start') {
        const r = await P.start({ shell: b.shell, cwd: b.cwd || s.cwd,
          cols: b.cols || 100, rows: b.rows || 30 });
        return sendJson(res, { ok: r.ok, msg: r.msg || '', error: P.lastError || '', session: s.id });
      }
      if (b.op === 'write') { P.write(b.text || ''); return sendJson(res, { ok: true }); }
      if (b.op === 'resize') { P.resize(b.cols || 100, b.rows || 30); return sendJson(res, { ok: true }); }
      if (b.op === 'stop') { P.stop(); return sendJson(res, { ok: true }); }
      return sendJson(res, { ok: false, msg: 'unknown op' });
    }

    // 终端输出流：NDJSON 长连接（out / exit / error）。?s=<会话 id>
    if (p === '/api/pty/stream') {
      const s = getSess(u.searchParams.get('s'), false);
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Transfer-Encoding': 'chunked',
        'X-Accel-Buffering': 'no',
      });
      if (!s) {
        res.write(JSON.stringify({ t: 'error', msg: '会话不存在（可能已被关闭）' }) + '\n');
        return res.end();
      }
      const P = s.pty;
      // 订阅前已经吐出来的内容要补上（前端可能晚几百毫秒才连上来）
      const subGen = P.gen;                          // 只收当前这代会话的事件
      if (P.backlogText()) {
        res.write(JSON.stringify({ t: 'out', text: P.backlogText(), backlog: true, session: s.id }) + '\n');
      }
      res.write(JSON.stringify({ t: 'status', running: P.running, session: s.id }) + '\n');
      const off = P.on((ev) => {
        if (ev.gen !== undefined && ev.gen !== subGen) return;   // 旧会话残响（如被顶掉时的 exit），不投递
        const out = { t: ev.t, code: ev.code, reason: ev.reason, msg: ev.msg, text: ev.text, session: s.id };
        try { res.write(JSON.stringify(out) + '\n'); } catch (e) { /* 连接已断 */ }
        if (ev.t === 'exit') { try { res.end(); } catch (e) {} }
      });
      req.on('close', off);
      return;
    }

    if (p === '/api/pty/status') {
      const s = getSess(u.searchParams.get('s'), false);
      if (!s) return sendJson(res, { running: false, shell: '', error: '' });
      return sendJson(res, { running: s.pty.running, shell: s.pty.shell, error: s.pty.lastError || '', session: s.id });
    }

    // 静态文件
    let file = p === '/' ? '/index.html' : p;
    let full = path.normalize(path.join(APP, file));
    if (file.startsWith('/characters/')) full = path.normalize(path.join(ROOT, file));
    if (!full.startsWith(APP) && !full.startsWith(CHARS)) return send(res, 403, 'forbidden');

    fs.stat(full, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'not found: ' + file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(full).pipe(res);
    });
  } catch (e) {
    sendJson(res, { error: String(e && e.message || e) }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Ponko-HUD backend  http://127.0.0.1:${PORT}/`);
  bootlog.emit('node', 'boot.node.listen', { port: PORT, ms: bootlog.settle() });
  setImmediate(probePython);              // 端口先开，再慢慢探解释器（见上面注释）
  // 预热 Tab 补全的命令表：扫 PATH 要读二十来个目录，不能等用户按下 Tab 那一刻才做
  setTimeout(() => { try { commandNames(); } catch (e) { /* 扫不动就算了，补全只是少一半候选 */ } }, 3000);
  // 预热：外部地理查询要几秒，别让首次点开地球时干等。顺带把真实结果记进启动日志
  netgeo.netgeo().then((g) => {
    const s = g && g.self;
    if (s && s.ip) {
      const where = [s.country, s.region, s.city].filter(Boolean).join(' ') || '@boot.net.unknownPlace';
      bootlog.emit('net', 'boot.net.egress', {
        ip: s.ip, where,
        isp: s.isp || '@boot.net.unknownIsp',
        as: s.as ? ' · ' + s.as : '',
      });
    } else {
      bootlog.emit('net', 'boot.net.empty');
    }
    if (g && (g.dns || []).length) bootlog.emit('net', 'boot.net.dns', { n: g.dns.length, fp: g.fp || '-' });
  }).catch((e) => bootlog.emit('net', 'boot.net.error', { err: firstLine(e && e.message) }));
});
