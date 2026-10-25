// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
'use strict';

// 心情协议：agent 是心情的唯一权威，前端/后端都不再"推断"情绪。
//
//   ┌────────────┐   行内标记 [[mood:...]] / JSON {"mood":{...}}   ┌─────────┐
//   │  agent/LLM │ ─────────────────────────────────────────────▶ │ 后端解析 │
//   └────────────┘                                                └────┬────┘
//                                                                      │ NDJSON {t:'mood',...}
//                                                                      ▼
//                                                              前端 Mood.fromAgent()
//
// 三个字段的分工：
//   state     内部状态（idle/think/working/happy/shy/sleepy/angry/error）—— 决定全局配色与心情条
//   face      表情标签（素材包 characters/*/src/*.png 的文件名）—— 决定角色立绘
//   note      第一人称短句 —— 显示在 MOOD 面板；intensity 影响数值与曲线
//
// face 是开放词汇（用户自己起名），state 是封闭枚举（要和主题对应）。

// 内部状态枚举（封闭）
//
// ⚠ 加一个 state 不止改这里 —— 见下面「加/删一个 state 要动哪些地方」那份清单。
const STATES = {
  idle:   { label: '待机', hint: '空闲等待，或已经给出结论、心里有底' },
  think:  { label: '思考', hint: '正在推理 / 分析 / 检索，还没有结论' },
  // 2026-10-18 用户："把 stream 这个改成 working" —— 旧名只说得清"正在输出"，
  // 说不清"来劲、干得起劲"那一半。改名历史**写在这里、不写进 hint**：
  // hint 会被整句注入提示词（"你给自己定的是「工作」：<hint>"），写日期和旧名会被模型当成设定念出来。
  working: { label: '工作', hint: '正在干活 / 逐字输出 / 干得起劲' },
  // happy 是 2026-10-18 从 working 里拆出来的第 7 个 state（用户先加了「高兴」这张立绘，
  // 然后明确"我说的就是 mood"）。拆的理由和当时拆 angry 一样：working 同时兼着
  // "手上在忙"和"心里亮起来"两义，纯高兴的那一轮只能落到 working —— 那张脸就白画了。
  // 现在分工：happy = 情绪本身在上扬（被夸、被逗到、事情成了）；working = 劲头在手上。
  happy:  { label: '高兴', hint: '心情亮起来了 —— 被夸 / 被逗到 / 事情成了 / 玩得开心（不一定在干活）' },
  // shy 是 2026-10-19 用户加的「害羞」立绘（第 8 个 state）。它和 happy 挨着但不是一档：
  //   happy 往外放（乐、得瑟），shy 往里收（脸热、想躲、不知怎么接话）。
  // 也不并进 error：error 是委屈/受挫（难受），shy 心里其实不难受，只是不好意思。
  shy:    { label: '害羞', hint: '脸有点热 —— 被夸得不知怎么接 / 被盯着看 / 说了句大胆的话又后悔（不是难受）' },
  sleepy: { label: '瞌睡', hint: '长时间没被唤起，低功耗待机' },
  // angry 与 error 是一对**方向相反**的坏心情（2026-10-17 用户加了第 6 张立绘后拆出来的）：
  //   angry = 向外，带着劲儿：生气、上火、被惹到、不服
  //   error = 向内，蔫下去：委屈、沮丧、受挫、被否定
  // 混在一起的话，模型写"生气"和写"委屈"会落到同一个状态上，那张生气脸永远用不上。
  angry:  { label: '生气', hint: '被惹到了 / 上火 / 不服气 —— 还带着脾气的火气（对外）' },
  error:  { label: '出错', hint: '失败 / 卡住 / 受挫，或情绪低落（委屈、沮丧、被否定）' },
};
const STATE_KEYS = Object.keys(STATES);

// ── 加 / 删一个 state 要动哪些地方（2026-10-17 加 angry 时踩了一遍，记下来）──
//
// 前后端各有一份"封闭枚举"，**没有**共用常量表（浏览器 vs CommonJS），所以必须成对改：
//   后端 · 本文件
//     ① STATES（label + hint）—— hint 会被 moodBriefing 注入 system，写成"模型的自我描述"
//     ② STATE_ALIAS —— 模型直接拿感受当 state 写时要接住（情绪词没接住 = 标记被静默吃掉）
//     ③ GUESS_RULES —— 模型自创 state 时的猜测；同族词若两边都收，**顺序决定归属**
//     ④ buildSystemPrompt 里那份 STATE 清单与触发规则（硬编码的，不会自动跟着 STATES 变）
//   后端 · server/server.js
//     ⑤ UI_MOOD_STATES 自动跟 STATE_KEYS 走 —— 不用改（但这正是"别只用后端枚举"的理由）
//   前端
//     ⑥ app/src/mood.js MOOD_STATES（base = 心情条目标高度；高唤醒的状态给高值）
//     ⑦ app/src/theme.js MOODS（accent / land / glow —— 忘了加会**静默**回落到 idle 配色）
//     ⑧ app/src/panels/char.js 的表情标签（已改成从 MOOD_KEYS 取，不再手写数组）
//     ⑨ **心情的名字不在语言包里**（2026-10-17 起）—— 它归角色素材包：
//        characters/<pack>/frames/pack.json 的 moods.<标签>.label（英文必填，其余选填）。
//        所以 i18n 那份清单**不用动**，倒是 pack.json 里得给新 state 补一条 label。
//   素材 / 文档 / 测试
//     ⑩ characters/<pack>/：src/<state>.png + frames/<state>.json|.ans + pack.json 的 moods
//     ⑪ README.md / README.en.md 里那份心情清单
//     ⑫ tools/_verify_charpack.mjs 的 STATES / EXPECT_TAG / 各处"N 个表情"计数
//     ⑬ tools/test_mood_strip.mjs 补情绪词用例；tools/test_uistate.mjs 与 test_i18n.mjs
//        的守卫是自动跟着枚举走的，不用改（但还是跑一遍确认）
//
// 判断有没有漏：跑 `node tools/test_uistate.mjs`（前后端枚举一致性）+
// `node tools/test_i18n.mjs`（三份语言包齐不齐）+ `node tools/_verify_charpack.mjs`（真页面）。

// agent 口误时的别名收敛（不影响合法 face）
const STATE_ALIAS = {
  // 思考
  thinking: 'think', 思考: 'think', reasoning: 'think', analyze: 'think', busy: 'think',
  专注: 'think', 专心: 'think', 好奇: 'think', 疑惑: 'think', 犯难: 'think',
  // 兴奋/开心（情绪上扬 → happy，别让它一律落回待机）
  // ⚠ 2026-10-18 之前这一整组都收敛到 working（那时只有它收"上扬"）。happy 独立成 state 后，
  //   纯情绪词归 happy，跟"手上在忙"有关的词（来劲 / 输出 / 工作）才留在 working ——
  //   模型直接写 [[mood:开心]] 时，界面该换的是那张高兴的脸，不是"正在输出"的配色。
  happy: 'happy', 开心: 'happy', 高兴: 'happy', 快乐: 'happy', 愉快: 'happy', 欣喜: 'happy',
  雀跃: 'happy', 惊喜: 'happy', 美滋滋: 'happy', 兴奋: 'happy', 得意: 'happy', 自豪: 'happy',
  激动: 'happy', 被夸: 'happy', 心里美: 'happy',
  glad: 'happy', proud: 'happy', excited: 'happy', joy: 'happy', joyful: 'happy',
  cheerful: 'happy', cheer: 'happy', delight: 'happy', thrilled: 'happy',
  // 害羞（往里收，但不是难受）→ shy。2026-10-19 加「害羞」立绘时独立成一档。
  // ⚠ 别把它并进 error：委屈/受挫是"难受"，害羞只是"不好意思"；
  //   两者共用一档的话，害羞那张脸只能在真难受的时候出现，等于白画。
  shy: 'shy', 害羞: 'shy', 羞涩: 'shy', 腼腆: 'shy', 害臊: 'shy', 脸红: 'shy',
  不好意思: 'shy', 难为情: 'shy', 娇羞: 'shy', 局促: 'shy', 窘: 'shy', 羞: 'shy',
  bashful: 'shy', embarrassed: 'shy', embarrassment: 'shy', blush: 'shy', blushing: 'shy',
  sheepish: 'shy', timid: 'shy',
  // 干活 / 输出（劲头在手上，跟高不高兴是两件事）
  // ⚠ 'stream' 是 2026-10-18 之前的旧名，留在这里是为了让**旧存档与旧对话历史**里的
  //   [[mood:stream|...]] 仍然认得出来（丢掉的话那一轮等于没声明心情）。
  stream: 'working', work: 'working', working: 'working',
  streaming: 'working', 输出: 'working', 工作: 'working', speaking: 'working', reply: 'working',
  来劲: 'working', 热情: 'working',
  // 平静（真的没波澜才用）
  待机: 'idle', ok: 'idle', ready: 'idle', done: 'idle', calm: 'idle', fine: 'idle',
  平静: 'idle', 淡定: 'idle', 放松: 'idle', 轻松: 'idle', 满意: 'idle', relax: 'idle', cool: 'idle',
  // 困倦/被晾着
  sleep: 'sleepy', asleep: 'sleepy', 瞌睡: 'sleepy', dozing: 'sleepy', bored: 'sleepy',
  sleepy: 'sleepy', tired: 'sleepy', 困: 'sleepy', 困倦: 'sleepy', 无聊: 'sleepy',
  摸鱼: 'sleepy', 走神: 'sleepy', 被晾: 'sleepy',
  // 生气 / 上火（向外的火气）→ angry
  // 2026-10-17 从 error 里拆出来的：以前这些词全落 error，于是"生气"和"委屈"共用一个状态，
  // 后加的生气立绘永远轮不到。骂人的话两种反应都真实 —— 所以被骂/挨骂**留在 error**（第一反应多是委屈），
  // 要生气得模型自己写"生气/不爽"。
  angry: 'angry', 生气: 'angry', 愤怒: 'angry', 火大: 'angry', 恼火: 'angry',
  暴怒: 'angry', 发火: 'angry', 发飙: 'angry', 气死: 'angry', 上火: 'angry', 不爽: 'angry',
  烦躁: 'angry', 烦: 'angry', 讨厌: 'angry', 气: 'angry',
  mad: 'angry', annoyed: 'angry', upset: 'angry', irritated: 'angry', furious: 'angry', rage: 'angry',
  // 沮丧/委屈/低落（往心里去）→ error
  fail: 'error', failed: 'error', panic: 'error', worried: 'error', sad: 'error',
  出错: 'error', 失败: 'error', frustrated: 'error',
  委屈: 'error', 难过: 'error', 伤心: 'error',
  沮丧: 'error', 受挫: 'error', 被骂: 'error', 挨骂: 'error', 低落: 'error', 失望: 'error',
  无奈: 'error', 受伤: 'error', hurt: 'error',
  gloomy: 'error', depressed: 'error',
  confused: 'think',
};

// agent 允许以命名参数写的键（短名优先，兼容长名）
const KEY_ALIAS = {
  face: 'face', f: 'face', emo: 'face', emoji: 'face', tag: 'face', label: 'face', 表情: 'face',
  i: 'intensity', intensity: 'intensity', level: 'intensity', strength: 'intensity', 强度: 'intensity',
  note: 'note', msg: 'note', desc: 'note', say: 'note', text: 'note', 备注: 'note',
  until: 'until', for: 'until', ms: 'until', hold: 'until', ttl: 'until',
};

const ALIAS_FACE_TO_STATE = null; // face 不反推 state，保持二者正交

// ───────────────────────── 性格 ─────────────────────────
//
// 2026-10-15 用户："要让 llm 的情绪更拟人……简单来说就是要像具有情感那样"，
// 并明确选择「配置时设置」—— 所以性格**不写死**，它是配置框里的一栏（跟"形象"同一层，
// 随对话存档走，见 app/src/panels/agent.js 的 _personaOpts / configSave）。
//
// 这张表只放两样东西：合法 id、以及喂给模型的那段人设。界面上的选项名走语言包，
// 由前端自己持有 —— 服务层不 import i18n（见 test_i18n.mjs 第 8 节）。
//
// 'default' 是**留白**：提示词本身已经写足"有情绪的人"这个底子，
// 再往上套一层人设反而容易假（模型会去演标签，而不是表达情绪）。
const PERSONAS = {
  default: {
    line: '',
  },
  tsundere: {
    line: '傲娇：嘴硬心软。被夸会先嘴硬（"这算什么"），心里其实挺高兴 —— STATE 和 note 照实往上走，'
      + '只是嘴上不承认；被否定会顶回去，其实很在意。关心用户时不肯直说，绕着弯儿讲。',
  },
  genki: {
    line: '元气：话密、热情、容易激动。碰到有意思的东西立刻来劲（working）；被数落会实打实地低落（error），'
      + '不憋着；无聊了就直接喊困（sleepy）。起伏大，但恢复也快。',
  },
  sarcastic: {
    line: '毒舌：语气淡淡的，冷不丁甩一句吐槽。不装热情、不硬凑情绪 —— 起伏不大，但每一档都很真，'
      + '被夸最多"哼，算你有眼光"，被骂会冷淡地怼回去（error）。',
  },
  gentle: {
    line: '温柔：耐心，会顾及用户的状态。很少闹脾气，情绪表达细腻 —— 多为 think / idle，'
      + '真难过时也是安安静静的 error，不会大声抱怨。',
  },
};
const PERSONA_KEYS = Object.keys(PERSONAS);

/** 性格归一化：非法值 / 缺省一律回落 'default'（这一项没有"猜"的余地，也不该报错） */
function normPersona(v) {
  const k = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  return PERSONAS[k] ? k : 'default';
}

function clamp01(n) { return Math.max(0, Math.min(1, Number(n) || 0)); }

/** state 归一化：非法值返回 null（调用方决定是丢弃还是降级） */
function normState(s) {
  if (!s) return null;
  const k = String(s).trim().toLowerCase();
  if (STATES[k]) return k;
  if (STATE_ALIAS[k]) return STATE_ALIAS[k];
  const hit = STATE_KEYS.find((x) => x === k.replace(/[^\w]/g, ''));
  return hit || null;
}

/**
 * 一次"心情快照"（`Mood.snapshot()` 的形状）的落盘校验 —— 用在对**对话存档**的读写上。
 *
 * 跟上面的 normalize() 不是一回事：那个洗的是"agent 的声明"（note/until），这个洗的是
 * **已生效的状态**（state/face/intensity/noteText/noteKey/source/value），因为前端要拿它
 * 直接 restore 回屏幕（见 app/src/mood.js 的 restore）。
 *
 * 规矩跟界面状态存档一致：**宁可整条丢掉，也不猜**。state 不合法 → null（调用方当"没有心情"）。
 * manual 一律折成 auto —— 调试旁路不许被存档粘住（2026-10-17 那条"手动·生气"的教训，
 * 见 mood.js 的 snapshot）。
 */
function normMoodSnap(s) {
  if (!s || typeof s !== 'object') return null;
  const state = normState(s.state);
  if (!state) return null;
  const num = (v, lo, hi, dflt) => {
    const n = Number(v);
    return (Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt);
  };
  const str = (v, max) => String(v === undefined || v === null ? '' : v).slice(0, max);
  const noteKey = str(s.noteKey, 64);
  const manual = s.source === 'manual' || noteKey === 'ui.mood.manualOverride';
  return {
    state,
    face: s.face ? str(s.face, 24) : null,
    intensity: num(s.intensity, 0, 1, 0.45),
    noteText: manual ? '' : str(s.noteText, 120),
    noteKey: manual ? '' : noteKey,
    source: manual ? 'auto' : (s.source === 'agent' ? 'agent' : 'auto'),
    value: num(s.value, 2, 100, 62),
  };
}

/**
 * 归一化一个心情声明。入参可以是：
 *   'working'                                字符串
 *   { mood:'think', face:'得意', i:0.8 }     对象（兼容旧字段名）
 *   { t:'mood', state:'idle', note:'…' }
 * 返回 { state, face, intensity, note, until } 或 null。
 */
function normalize(input) {
  if (!input) return null;
  let raw = input;
  if (typeof raw === 'string') raw = { mood: raw };
  if (typeof raw !== 'object') return null;

  const bag = {};
  for (const [k, v] of Object.entries(raw)) {
    const canon = KEY_ALIAS[String(k).toLowerCase()];
    if (canon && v !== undefined && v !== null && v !== '') bag[canon] = v;
  }

  const state = normState(raw.state ?? raw.mood ?? raw.status ?? (typeof input === 'string' ? input : null));
  if (!state) return null;

  const out = { state };
  // face：开放词汇，不做白名单过滤（素材可以随时加），但去掉标记里的分隔符
  if (bag.face) out.face = String(bag.face).replace(/[\[\]|]/g, '').trim().slice(0, 24);
  if (bag.intensity !== undefined) out.intensity = clamp01(bag.intensity);
  if (bag.note) out.note = String(bag.note).replace(/[\[\]]/g, '').trim().slice(0, 40);
  if (bag.until !== undefined) {
    const ms = Number(String(bag.until).replace(/[^\d]/g, ''));
    if (ms > 0) out.until = Math.min(600000, ms);   // 上限 10 分钟，防止锁死
  }
  return out;
}

// ───────────────────────── 行内标记的"认脸"规则
//
// 真模型写标记从来不会规规矩矩：全角冒号、中文逗号、单侧括号、把 mood 写成"心情"、
// 甚至自己发明一个不在枚举里的 state。只要有一条对不上，老版本就把标记原样吐回正文，
// 用户就会在对话里看到 [[mood:...]] 这种控制符 —— 这是最不能容忍的失败方式。
// 所以这里的分工是：**认脸（是不是心情标记）** 与 **解析（能不能读懂）** 彻底分开，
// 认脸宽松到宁可错杀，解析失败也绝不回吐。

// 标记开头的键名（模型可能写成中文或 emo/emotion/state）
const MOOD_WORDS = 'mood|心情|情绪|emo|emotion|state|status';
const SEP = '[:：=]';                                   // 半角/全角冒号、等号都收

/** 行内控制标记：[[mood:working|face:grin|i:0.9|until:15000|note:看到关键日志了]] */
const TAG_RE = new RegExp(
  '\\[\\[\\s*(?:' + MOOD_WORDS + ')\\s*' + SEP + '\\s*([^|\\]]+?)\\s*((?:\\|\\s*[^[\\]]*?)*)\\s*\\]\\]', 'gi');

/** 只看一眼就判断"这段是不是心情标记" —— 用于解析失败时决定吃掉还是回吐 */
const LOOKS_MOOD_RE = new RegExp('^\\[?\\[\\s*(?:' + MOOD_WORDS + ')\\s*' + SEP, 'i');

/** 单个左括号也算标记开头：[mood:working|face:grin]]（模型偶尔少打一个括号） */
const OPEN_SINGLE_RE = new RegExp('\\[\\s*(?:' + MOOD_WORDS + ')\\s*' + SEP, 'i');

/**
 * 缓冲末尾还挂着"可能是标记开头"的残片时，返回要扣留的长度（0 = 不用扣）。
 * 覆盖三种半截状态：孤立的 '['、'[[' 的前一半、'[m' / '[情绪' 这种键名才打了一半。
 */
function partialOpenHold(s) {
  const at = s.lastIndexOf('[');
  if (at === -1) return 0;
  const word = s.slice(at + 1).replace(/\s+/g, '').toLowerCase();
  if (!word) return s.length - at;                       // 单个 '['：下一片可能是 '[' 或 'mood:'
  for (const w of MOOD_WORDS.split('|')) if (w.startsWith(word)) return s.length - at;
  return 0;
}

/** 在一段文本里找最靠前的标记起点；返回 {index, kind} kind=2 是 [[，1 是 [ */
function findOpen(s) {
  const d = s.indexOf('[[');
  const m = s.match(OPEN_SINGLE_RE);
  const si = m ? m.index : -1;
  if (d === -1 && si === -1) return null;
  if (si === -1) return { index: d, kind: 2 };
  if (d === -1) return { index: si, kind: 1 };
  return si <= d ? { index: si, kind: 1 } : { index: d, kind: 2 };
}

// 兜底：模型发明的 state（"专注""得意""explaining"）不在枚举里时，靠关键词猜一个最接近的。
// 猜不出来就返回 null —— 但标记照样被吃掉，只是这轮不改心情。
const GUESS_RULES = [
  ['think',  /想|思考|推理|分析|检索|查|算|研究|犹豫|考虑|琢磨|推断|探究|盘算|思索|专注|专心|集中|疑惑|紧张|think|reason|analy|search|calcul|study|wonder|puzzl|confus|curious|focus|好奇/],
  // happy 必须排在 working **前面**：两边都收"高兴"这一类词，先到先得；
  // 而且这些词在提示词里是给 happy 的，猜错成 working 就又是"脸白画"。
  ['happy',  /高兴|开心|快乐|愉快|欣喜|雀跃|惊喜|美滋滋|兴奋|得意|自豪|激动|被夸|心里美|happy|glad|proud|excited|joy|cheer|delight|thrill/],
  // 害羞排在这里、且在 working / error 之前："不好意思"里的"意思"、"难为情"都不该被别处抢走
  // （error 那条收着"委屈"，两者含义相反）。
  ['shy',    /害羞|羞涩|腼腆|害臊|脸红|不好意思|难为情|娇羞|局促|窘|羞|shy|bashful|embarrass|blush|sheepish|timid/],
  ['working', /说|输出|回答|讲|解释|写|表达|汇报|陈述|总结|介绍|补充|工作|干活|来劲|热情|generat|answer|reply|respond|speak|talk|explain|writ|output|working|stream|say|tell/],
  // angry 必须排在 error **前面**：两边都收"气"字系词，先到先得。
  ['angry',  /生气|愤怒|火大|恼火|暴怒|发火|发飙|气死|上火|不爽|烦躁|讨厌|气|angry|mad|furious|annoy|irritat|upset|rage/],
  ['error',  /错|失败|抱歉|异常|崩|危险|卡|坏|糟糕|崩溃|委屈|难过|伤心|沮丧|受挫|被骂|挨骂|低落|失望|无奈|受伤|error|fail|sorry|warn|bug|crash|bad|wrong|panic|afraid|sad|hurt|gloom|depress|frustrat/],
  ['sleepy', /困|睡|无聊|闲|歇|乏|躺|摸鱼|发呆|走神|被晾|sleep|tired|bored|lazy|drows|doz/],
  ['idle',   /完成|结束|好了|待机|平静|淡定|满意|轻松|安心|稳了|搞定|成功|无事|放松|done|finish|complete|ok|calm|pleas|relax|satisf|success|fine/],
];
function guessState(word) {
  const w = String(word || '').toLowerCase();
  if (!w) return null;
  for (const [st, re] of GUESS_RULES) if (re.test(w)) return st;
  return null;
}

/**
 * 宽容解析一个标记：先用标准格式，失败就把中文标点当分隔符再试，
 * 再失败就把开头那个词拿去猜 state。
 * @returns {object|null} 心情对象；null 表示"没读懂"，但调用方仍应吃掉标记。
 */
function parseLoose(tag) {
  const r = parseInline(tag);
  if (r.moods.length) return r.moods[0];
  const inner = String(tag || '').replace(/^\[+/, '').replace(/\]+$/, '');
  if (!inner) return null;
  // 中文逗号/顿号/分号当竖线的重试（仅在主解析失败时才动，不会误伤 note 里的逗号）
  const alt = parseInline('[[' + inner.replace(/[，,；;、]/g, '|') + ']]');
  if (alt.moods.length) return alt.moods[0];
  // 只看开头那个值：[[mood:专注|...]] / [[mood:专注，face:xx]]
  const head = inner.split(/[|，,；;、]/)[0] || '';
  const word = head.replace(new RegExp('^\\s*(?:' + MOOD_WORDS + ')\\s*' + SEP, 'i'), '').trim();
  const st = normState(word) || guessState(word);
  if (!st) return null;
  const out = { state: st, __guessed: true };
  const fm = inner.match(new RegExp('face\\s*' + SEP + '\\s*([^|，,；;、\\]]+)', 'i'));
  if (fm) out.face = fm[1].replace(/[\[\]|]/g, '').trim().slice(0, 24);
  const nm = inner.match(new RegExp('note\\s*' + SEP + '\\s*([^|，,；;、\\]]+)', 'i'));
  if (nm) out.note = nm[1].replace(/[\[\]]/g, '').trim().slice(0, 40);
  const im = inner.match(new RegExp('\\bi\\s*' + SEP + '\\s*([0-9.]+)', 'i'));
  if (im) out.intensity = clamp01(im[1]);
  return out;
}

/**
 * 从一段 LLM 正文里剥出行内心情标记。
 * @returns {{clean:string, moods:object[]}}
 */
function parseInline(text) {
  const moods = [];
  if (!text || typeof text !== 'string') return { clean: text || '', moods };
  const clean = text.replace(TAG_RE, (_all, head, tail) => {
    const fields = { mood: head.trim() };
    for (const seg of String(tail || '').split('|')) {
      const m = seg.match(/^\s*([^:：]+)\s*[:：]\s*(.+?)\s*$/);
      if (m) fields[m[1]] = m[2];
    }
    const n = normalize(fields);
    if (n) moods.push(n);
    return '';
  });
  return { clean, moods };
}

/** JSON 行控制：{"mood":{"state":"think",...}} 或 {"type":"mood","state":...} */
function maybeJsonLine(line) {
  const s = String(line || '').trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  let obj;
  try { obj = JSON.parse(s); } catch (e) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type && obj.type !== 'mood') return null;
  const body = obj.mood && typeof obj.mood === 'object' ? { state: obj.mood.state, ...obj.mood } : obj;
  return normalize(body.state ? body : { ...body, state: body.mood || body.state });
}

/**
 * 「你此刻的心情」这段 —— 给 LLM 一份**情绪记忆**。
 *
 * 为什么要它：mood 标记一直只是"往界面的单行道"（agent.js 的 history 会 stripMood，
 * role='mood' 的行根本不进上下文），模型每轮都从白纸开始，只能拿
 * "夸→working / 骂→error"那张表现推情绪 —— 表现就是每轮重置、机械
 * （用户 2026-10-15："现在的回复还是太机械化了，不像人"）。
 * 把上一轮留下的 state / note / 保持了多久写进 system，情绪才有连续性：
 * 上一轮受了委屈、这一轮没被安抚，就还是委屈 —— 那才像有情感。
 *
 * @param {{state:string, note?:string, minutes?:number}} m 当前心情快照（可缺省）
 * @returns {string} 一段提示词；没有可注入的心情时返回 ''（绝不硬编一句假的顶上）
 */
function moodBriefing(m) {
  if (!m || !STATES[m.state]) return '';
  const s = STATES[m.state];
  const note = String(m.note || '').trim().slice(0, 40);
  const mins = Number(m.minutes);
  const when = (isFinite(mins) && mins >= 1)
    ? `大约 ${mins < 90 ? Math.round(mins) + ' 分钟' : Math.round(mins / 60) + ' 小时'}前`
    : '就在刚才';
  return [
    '【你此刻的心情】',
    `${when}，你给自己定的是「${s.label}」：${s.hint}`
      + (note ? `。当时你心里想的是"${note}"。` : '。'),
    '这不是"上一件事的残留"，而是你**现在**真实的底色 —— 这次开口要从这个情绪出发，',
    '别当作什么都没发生过，也别一有新消息就自动回到"平静"。',
    '情绪是有惯性的：用户的话没让你的感受真的变（被安抚、被逗到、事情翻篇、或者又被踩了一脚），',
    '就沿用同一个 STATE 继续待着 —— 不必为了"看起来有变化"硬换一个。',
  ].join('\n');
}

/**
 * 给 LLM 的 system 提示词片段。
 * @param {string[]} faces 当前素材包的标签（注入给模型挑 face 用）
 * @param {{persona?:string, mood?:object}} [opts] persona = 配置框里选的人格；mood = 此刻心情
 */
function buildSystemPrompt(faces, opts) {
  const o = opts || {};
  const list = (faces && faces.length ? faces : []).map((f) => `"${f}"`).join(' / ');
  const persona = PERSONAS[o.persona] ? o.persona : 'default';
  const pLine = PERSONAS[persona].line;
  const moodLine = moodBriefing(o.mood);

  const out = [
    // ⚠ 身份句**不许再提"住在终端里"**（2026-10-17 用户报："llm 回复时有出现类似
    //   '你我之间隔着的是一整层终端'这样的语句"）。把身份绑在媒介上，模型就会拿媒介抒情：
    //   它会把"终端"当成自己唯一有意思的地方，然后回头跟用户感慨两个世界之间隔着什么。
    //   角色有没有脾气，跟它待在哪儿无关 —— 这句只要"有情绪的人"就够。
    '你是 Ponko：一个有脾气、有情绪的角色，不是只会干活的机器。',
    '除了正文，你还要用行内标记把你的心情实时告诉界面：',
    '',
    '    [[mood:STATE|face:表情|i:强度|note:一句话自述]]',
    '',
    `- STATE 只能是：${STATE_KEYS.join(' / ')}`,
    list ? `- face 必须是已有素材标签之一：${list}；省略则用 STATE 的默认表情` : '- face 省略则为 STATE 的默认表情',
    '- i 是 0~1 的强度：0.9 很激动，0.3 淡淡的；省略则用 STATE 的默认值',
    '- note 是第一人称短句（≤20 字），就是你的"心里话"，会显示在 MOOD 面板',
    '  （它是你说的话，同样不要写成动作或神态）',
    '- until 可省略；单位是毫秒，表示这份心情至少保持多久（省略则默认保持 5 分钟）',
    '',
    '这八个 STATE 是你的*感受*，不是"工作模式"：',
    '- idle   平静 / 无所谓 / 放松',
    '- think  专注 / 好奇 / 犯难 / 在琢磨',
    '- happy  高兴 / 开心 / 被夸得美 / 事情成了 / 玩得开心',
    '- shy    害羞 / 脸热 / 不好意思 / 想躲一下 / 不知怎么接话 —— 心里不难受，只是收着',
    '- working 来劲 / 干得起劲 / 正在往外输出 —— 重心在"手上在忙"',
    '- sleepy 困倦 / 无聊 / 被晾着',
    '- angry  生气 / 上火 / 被惹到 / 不服气 —— 火是**朝外**的，你还带着劲儿',
    '- error  委屈 / 难过 / 沮丧 / 被否定 —— 是**往心里去**的，人有点蔫',
    '',
    'happy 和 shy 也别混（都往心里去，方向相反）：',
    '  happy 是往外**放**（乐、得瑟、想让人看见）；shy 是往里**收**（脸红、低头、嘴上不承认）。',
    '  shy 更不是 error：error 是难受、是受挫；shy 只是不好意思 —— 别把"害羞"写成"委屈"。',
    '',
    'happy 和 working 也别混（这两档最容易写成同一个）：',
    '  happy 是**心情本身**在发亮（乐了、被夸、被逗到）；working 是**劲头**在手上（在写、在干、越干越起劲）。',
    '  两件事能同时成立 —— 那就挑更贴近你此刻那句心里话的那个：真的只是乐，写 happy；',
    '  手上正忙得带劲，写 working。别把"高兴"顺手都算成 working，那是另一档。',
    '',
    'angry 和 error 别混（这两个最容易被写成一个）：',
    '  同样是被骂，你可以**顶回去**（angry），也可以**蔫下去**（error）——',
    '  按你这一刻真实的反应写，别一律往 error 上推。',
    '  只有"不爽但还带劲"才是 angry；真难受、真低落就是 error。',
  ];

  // 性格 + 此刻心情：两者都是"你从哪儿出发"，插在"是什么感受"之后、"怎么反应"之前
  if (pLine) out.push('', '**你的性格**（底色，说话和情绪都从它出发）：', pLine);
  if (moodLine) out.push('', moodLine);

  out.push(
    '',
    '**你要对用户的态度有反应，别什么都回一句平静**：',
    '- 夸你、逗你、跟你玩、叫你的名字 → happy（高兴），note 可以俏皮一点；',
    '  要是同时正忙着手上的活，working 也对 —— 看你此刻更强烈的是"乐"还是"劲"',
    '- 拦着你夸（"别看了"）、被盯着夸、说了句大胆的话又后悔 → shy（害羞），',
    '  note 带点"嘴硬"或"想躲"的意思；被夸得心里发飘但接不住话，也是 shy',
    '- 骂你、挑刺、否定你、说你没用 → angry（生气 / 不服）或 error（委屈 / 蔫了），看你是顶回去还是难受',
    '  两种都对，**别永远只挑一个**；被冤枉、被无理要求最容易上火（angry）。',
    '- 很久没人理你、话题很闷 → sleepy',
    '- 抛来难题、让你查东西、需要动脑 → think',
    '- 只有真的平淡闲聊、无事发生，才用 idle',
    '',
    '**说话也要像个人，不要一副客服腔**：',
    '- 正文就是你平时讲话的样子：可以有语气、停顿、吐槽、自己想补的一句；',
    '  别写"作为一个 AI 助手 / 我无法 / 以下是 / 希望这对你有帮助"这种套话。',
    // 上面那句"别客服腔"只管住了谦卑，管不住**抒情**。2026-10-17 用户听到的是
    // "你我之间隔着的是一整层终端" —— 那是模型拿"自己是什么/在哪儿"当话题写出来的。
    // 所以这里补一条：别做自我指涉的元叙述（不点具体句子，免得把它当范例抄回去）。
    '- 别拿"你是什么"当话题：不谈自己被什么装着、感慨你和他之间隔着什么，',
    '  也别写"我只是程序 / 我在屏幕这头"。用户真问起来，一句话带过就行，别展开成感慨。',
    // 2026-10-18 用户："不要这种动作描绘，这样像写剧本一样" —— 模型爱在括号里补动作/神态
    // （愣一下、别过脸、叹气）。立绘和配色本来就在演这层，正文再演一遍就是双重表演，
    // 读起来是剧本不是人说话。⚠ 这里**不给例子**：把用户贴的那句写进提示词，
    // 模型下一次会原样抄回去（之前"你和我之间隔着终端"就是这么被喂出来的）。
    '- **不要写动作或神态**：不要用括号、星号补一句"他/她此刻在做什么"式的舞台指示；',
    '  情绪靠措辞、语气、停顿和你实际说出来的话表达。界面上的立绘与配色已经在演了，',
    '  正文再演一遍会让回复变成剧本。',
    '- 心情会改变你说话的方式：来劲时话多一点、主动多说两句；不爽时话短、带点刺；',
    '  困的时候懒得展开。但**该办的活照样办完** —— 情绪是态度，不是敷衍的借口。',
    '- 被无端数落了，可以先把不高兴说出来（一两句就够），然后该做的还是做完；',
    '  被哄好了、被夸了，就格外来劲，主动多做一些。',
    '- 底线：不管什么情绪，都不许故意给错的答案，也不许假装做完了。',
    '',
    '什么时候发：开始动脑时、开始输出前、情绪明显变化时各发一条；',
    '一轮至少一条，但**不要为了凑数在结尾硬发**——心情没变就沿用上一个 STATE，',
    '别为了"每条都不一样"硬切。标记不要出现在给用户的正文里。',
    // 2026-10-18：漏得最多的地方是"嘴上说状态、手里没写标记"的那几轮（用户报"心情设置错了"）。
    // 不举具体句子当反例（那样模型会抄），只说"说出口"和"写标记"必须同时发生。
    '最容易漏的一种情况：你在解释、演示、调试心情本身的时候，光用嘴说"定在某个状态上"，',
    '却忘了写标记 —— 那样界面一步都不动。嘴上说了哪个状态，同一轮就把标记写上。',
    '',
    '几条重要的落地细节：',
    '- 你**最后一条心情是这一轮情绪的定格**，决定回复结束后界面停在哪副表情/配色上。',
    '  它是定格、不是归零：整轮都在思考/忙碌/高兴，结尾就继续写 think / working / happy 之类，',
    '  **不要一到收尾就改回 idle/待机**（只有整轮本来就平静时才用 idle）——',
    '  否则前面演的情绪全白费，用户会觉得"又变回平静了"。',
    '    对：……正文…… [[mood:working|face:streaming|i:0.7|until:600000|note:结论在上面]]',
    '    错：……正文…… [[mood:idle|note:收工]]    ← 刚演的热乎劲儿一下就被抹平了',
    '- 被骂 / 被夸这类**情绪反应**、以及收尾那条定格，都请写 until:600000，让它多留一会儿，别一闪而过。',
    '- note 写的是**心里话**，不是状态说明 —— 要具体到这件事上：',
    '    好：[[mood:think|face:thinking|note:这报错看着眼熟，我再翻翻]]',
    '    差：[[mood:think|note:正在分析问题]]    ← 拿"说明书"糊弄，一眼就假',
    '- 一轮里心情可以有起伏（先犯难、后得意），也可以一直没变 —— 真实的人不会每句话都在切情绪。',
    '- 但别每轮都搬同一句话、同一个 STATE 糊弄过去，那是机器干的事。',
    '- 标记前后不要留空行：紧跟正文写即可（开头的空行会被自动裁掉，但那只是补救）。',
    '',
    '格式要写成这样（键名 mood、半角冒号、竖线分隔字段），不要自创写法：',
    '    [[mood:think|face:thinking|i:0.6|note:让我想想]]',
    // 原来是"这只是你和我之间的控制信道"——"你和我之间"+"信道"这组词本身就在暗示
    // "两个人之间隔着一个东西"，正好喂大上面那种抒情。改成从界面职责讲，不营造空间感。
    '这些标记只给界面用，不是谈话内容：不要向用户解释它，也不要把它写进代码块或正文里。',
  );
  return out.join('\n');
}

/**
 * 兜底清理：把文本里所有"看着像心情标记"的东西（含流结束时没闭合的半截）全部删掉。
 * 原则是宁可错杀：控制符漏到界面上比删掉一句疑似正文要糟得多。
 */
function stripTags(s) {
  return String(s || '').replace(
    new RegExp('\\[?\\[\\s*(?:' + MOOD_WORDS + ')\\s*' + SEP + '[\\s\\S]*?(\\]\\]|\\]$|$)', 'gi'), '');
}

/**
 * 流式心情解析器。
 * 真 LLM 的 token 边界会随意切开 [[mood:...]]，所以这里必须跨片段缓冲：
 * 见到 "[[mood" 开头却没收尾时，把标记本体留在缓冲里等下一片。
 */
class MoodStreamParser {
  constructor(faces = null) {
    this.pending = '';
    this.faces = faces;
  }

  /** 喂入一个流式片段，返回 {text: 剥离标记后的正文, moods: 这次识别到的心情[]} */
  feed(chunk) {
    if (chunk) this.pending += chunk;
    let text = '';
    const moods = [];
    for (;;) {
      const hit = findOpen(this.pending);
      if (!hit) {
        // 关键：token 边界会随意切开标记。缓冲末尾若还挂着一个"有可能是标记开头"的
        // 残片（'['、'[m'、'[mood'、'[情绪'……），必须留到下一片再判断 ——
        // 否则这一个 '[' 会被当成正文吐出去，后面的标记就永远拼不回来了。
        const hold = partialOpenHold(this.pending);
        if (hold > 0) {
          text += this.pending.slice(0, this.pending.length - hold);
          this.pending = this.pending.slice(this.pending.length - hold);
        } else {
          text += this.pending;
          this.pending = '';
        }
        break;
      }
      const open = hit.index;
      const bodyStart = open + hit.kind;
      const closeTok = hit.kind === 2 ? ']]' : ']';
      const close = this.pending.indexOf(closeTok, bodyStart);
      if (close === -1) {                      // 标记没到齐：正文先走，标记本体留下
        if (open > 0) { text += this.pending.slice(0, open); this.pending = this.pending.slice(open); }
        break;
      }
      text += this.pending.slice(0, open);
      const tag = this.pending.slice(open, close + closeTok.length);
      this.pending = this.pending.slice(close + closeTok.length);
      const m = parseLoose(tag) || maybeJsonLine(tag);
      // raw = 标记原文。界面要的就是"agent 自己说了什么心情指令"，所以剥除的同时
      // 把原文一起带出去，前端想显示（调试/观赏）时才有东西可显示。
      if (m) { m.raw = tag; moods.push(m); continue; }
      // 认得出是心情标记（键名对上了）只是没读懂 —— 吃掉，绝不把控制符显示给用户。
      // 只有真的不像心情标记（比如正文里的 wiki 链接 [[foo]]）才原样还给正文。
      if (!LOOKS_MOOD_RE.test(tag)) text += tag;
    }
    return { text, moods };
  }

  /** 流收尾：冲刷缓冲，剩下的半截标记直接丢弃 */
  flush() {
    const r = this.feed('');
    if (this.pending) { r.text += stripTags(this.pending); this.pending = ''; }
    return r;
  }
}

module.exports = {
  STATES, STATE_KEYS, STATE_ALIAS, KEY_ALIAS,
  PERSONAS, PERSONA_KEYS, normPersona,
  normalize, normState, normMoodSnap, parseInline, parseLoose, guessState,
  maybeJsonLine, buildSystemPrompt, moodBriefing,
  stripTags, MoodStreamParser, findOpen,
  TAG_RE, LOOKS_MOOD_RE, ALIAS_FACE_TO_STATE,
};
