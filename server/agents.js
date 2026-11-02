// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
//
// agent 存档 —— 「一个 agent 能有多个对话」里的**那个 agent**
//
// 2026-11-02 用户原话：「现在是一个对话对应一个 agent，改成一个 agent 能有多个对话。
// 私有 skill 对应的是各 agent，而不是各对话。该 agent 里的对话可以共用该 agent 的私有 skill。」
//
// 于是"身份"和"话题"分成两层：
//
//   agent（run/agents/<agentId>.json）   人设、形象、LLM 配置、shell 口径、私有技能
//   ├─ 对话（run/conversations/<id>.json）  消息历史、心情、标签色号、标题
//   └─ 对话（……）
//
// 为什么单独一个文件而不是塞进对话存档：这几项**天生跨对话** ——
// 人设/形象/模型配置改一次，同一个 agent 的所有对话都该跟着变。塞进某个对话里，
// 就得在"谁是主"上撒谎，还会让"换个话题继续聊"变成"换个人"。
//
// 与 skills.js 同一个原则：**这一层只管存取，不做校验**。
// 白名单收敛（llmOf / normPersona / normArtOf / normPolicy）留在 server.js ——
// 那些函数依赖 provider、素材包、心情协议好几种东西，搬进来会绕成循环 require。
// 所以：写之前 server.js 洗一遍，读之后 server.js 再洗一遍；这个文件可以很蠢。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// PONKO_AGENTS_DIR 与 PONKO_CONV_DIR 同一套路：验证脚本把两者一起指到临时目录，
// 跑测试时不碰用户本机那份（里面有明文 API Key）。
//
// **目录是懒算的**，不在 require 时定死：验证脚本常常只设 PONKO_CONV_DIR，
// 这时 agent 存档要自动跟着它走（落到那个临时目录下的 agents/），
// 否则跑一次测试就往用户真实的 run/agents 里写东西。require 时求值做不到这件事，
// 因为 server.js 里 CONV_DIR 是在 require 之后才定义的。
let _dir = null;
function agentsDir() {
  if (_dir) return _dir;
  const env = process.env.PONKO_AGENTS_DIR;
  if (env) _dir = path.resolve(env);
  else if (process.env.PONKO_CONV_DIR) _dir = path.join(path.resolve(process.env.PONKO_CONV_DIR), 'agents');
  else _dir = path.join(ROOT, 'run', 'agents');
  return _dir;
}

// 与 server.js 的 CONV_ID_RE 一模一样：文件名直接来自 id，必须挡住 `../` 之类的穿越
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

const MAX_NAME = 24;

function agentPath(id) {
  return path.join(agentsDir(), String(id) + '.json');
}

function validId(id) {
  return AGENT_ID_RE.test(String(id || ''));
}

/**
 * 原样读回（不做任何字段校验）。文件不在 / 坏了 → null。
 * 调用方要当成"这个 agent 还没存过盘"，而不是"这个 agent 不存在"——
 * 对话可以指向一个还没落盘的 agent（刚建、还没配），那是正常状态。
 */
function readRaw(id) {
  if (!validId(id)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(agentPath(id), 'utf8'));
    return j && typeof j === 'object' ? { ...j, id: String(id) } : null;
  } catch (e) { return null; }
}

/**
 * 写盘。字段**只写调用方明确给的**（undefined 的键不写），
 * 因为"没设这一项"和"设成了默认值"在语义上是两回事，别用默认值去盖掉别人的存档。
 * createdAt 只有第一次写的时候落，之后的调用传什么都不改它。
 */
function writeRaw(id, rec) {
  if (!validId(id)) return false;
  const old = readRaw(id) || {};
  const out = {
    id: String(id),
    createdAt: Number(old.createdAt) || Number(rec && rec.createdAt) || Date.now(),
    updatedAt: Date.now(),
  };
  const name = String((rec && rec.name) !== undefined ? rec.name : old.name || '').trim().slice(0, MAX_NAME);
  if (name) out.name = name;                 // 空名字不写这个字段，别让"没起名"冒充一个空字符串
  for (const k of ['llm', 'persona', 'charpack', 'charpackPicked', 'shell']) {
    const v = rec && rec[k];
    if (v !== undefined) {
      if (v === null || v === '') continue;  // null / '' 都是"没设置"→ 不留字段
      out[k] = v;
    } else if (old[k] !== undefined) {
      out[k] = old[k];                       // 这次没提到 → 保留上一份
    }
  }
  try {
    fs.mkdirSync(agentsDir(), { recursive: true });
    fs.writeFileSync(agentPath(id), JSON.stringify(out));
    return true;
  } catch (e) { return false; }
}

/** 现存 agent 的 id 列表（只认合法文件名；坏文件也算存在，读的时候再判） */
function listIds() {
  let names = [];
  try { names = fs.readdirSync(agentsDir()); } catch (e) { return []; }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -5))
    .filter(validId);
}

/**
 * 这个 agent 现在挂着几个对话（`/agent` 命令和将来的界面要用）。
 * 要扫对话目录，所以由 server.js 在路由层算 —— 这里只留一个签名说明，
 * 免得两个模块互相 require（agents.js ← server.js 已经是一条单向依赖了）。
 */

module.exports = {
  agentsDir, AGENT_ID_RE, MAX_NAME,
  agentPath, validId, readRaw, writeRaw, listIds,
};
