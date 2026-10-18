// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 心情标记剥离回归：真模型写标记从来不规矩，任何"没认出来就原样吐回正文"的路径
// 都会让用户直接在对话里看到 [[mood:...]] 这种控制符。
// 这里把常见畸形写法（全角冒号、中文逗号、单括号、中文键名、自创 state、未闭合）
// 逐字符喂给流式解析器，断言正文里一个控制符都不留。
//   用法：node tools/test_mood_strip.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const moodp = require(path.join(ROOT, 'server', 'moodprotocol.js'));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   → ' + detail : ''}`);
}

/** 把整段文本按随机 1~3 字切片喂进去（模拟 token 边界），返回拼回来的正文与心情 */
function feed(s, step = 1) {
  const p = new moodp.MoodStreamParser([]);
  let text = '';
  const moods = [];
  for (let i = 0; i < s.length; i += step) {
    const r = p.feed(s.slice(i, i + step));
    text += r.text;
    moods.push(...r.moods);
  }
  const t = p.flush();
  text += t.text;
  moods.push(...t.moods);
  return { text, moods };
}

const CASES = [
  ['标准写法', '[[mood:think|face:thinking|i:0.6|note:让我想想]]正文来了', 'think'],
  // 旧名 'stream'（2026-10-18 改叫 working）：旧对话历史里还留着这种标记，必须照样认
  ['全角冒号（旧名 stream）', '[[mood：stream|face:smile]]正文', 'working'],
  ['中文逗号分隔', '[[mood:think，face:thinking，i:0.5]]正文', 'think'],
  ['单侧括号', '[mood:idle|face:idle]正文', 'idle'],
  ['中文键名', '[[心情:error|face:error|note:糟了]]正文', 'error'],
  ['state 键名', '[[state:sleepy|face:sleep]]正文', 'sleepy'],
  ['自创 state（猜）', '[[mood:专注|face:thinking]]正文', 'think'],
  ['自创 state 英文（猜）', '[[mood:explaining|face:streaming]]正文', 'working'],
  ['自创 state 完全猜不出', '[[mood:zzzqqq|face:smile]]正文', null],
  ['标记前后带空行', '[[mood:think|note:想想]]\n\n正文', 'think'],
  ['嵌套多余空格', '[[ mood : idle | face : idle ]]正文', 'idle'],
  ['等号分隔', '[[mood=working|face:smile]]正文', 'working'],
  ['note 里含全角冒号', '[[mood:idle|note:我说：好了]]正文', 'idle'],
  ['大写的 MOOD', '[[MOOD:idle|face:idle]]正文', 'idle'],
  ['emo 键名', '[[emo:error|note:出错]]正文', 'error'],
  // 情绪词：模型直接拿"感受"当 state 写（被骂→沮丧、被夸→来劲），必须接得住，
  // 否则标记会被静默丢掉、界面永远停在平静（用户报"骂它它都是平静的"）。
  ['情绪词·委屈', '[[mood:委屈]]正文', 'error'],
  ['情绪词·被骂', '[[心情：被骂]]正文', 'error'],
  ['情绪词·难过', '[[mood:难过|face:error]]正文', 'error'],
  ['情绪词·开心', '[[mood:开心|face:happy]]正文', 'happy'],
  ['情绪词·得意', '[[mood:得意]]正文', 'happy'],
  // happy 是 2026-10-18 从 working 拆出来的第 7 档：纯情绪词必须归 happy，
  // 还落到 working 的话那张高兴的立绘永远轮不到（加 state 又白加一次）。
  ['情绪词·高兴', '[[mood:高兴]]正文', 'happy'],
  ['情绪词·兴奋', '[[心情：兴奋|note:这个我能吹一天]]正文', 'happy'],
  ['情绪词·被夸', '[[mood:被夸]]正文', 'happy'],
  ['情绪词·被晾', '[[mood:被晾]]正文', 'sleepy'],
  // 生气（angry）与委屈（error）是一对方向相反的坏心情，2026-10-17 拆开后必须各归各位：
  // 混着的话那张生气立绘永远轮不到（模型写"生气"却走到 error 上）。
  ['情绪词·生气', '[[mood:生气]]正文', 'angry'],
  ['情绪词·不爽', '[[mood:不爽|note:这我不认]]正文', 'angry'],
  ['情绪词·火大', '[[心情：火大]]正文', 'angry'],
  ['情绪词·英文 angry', '[[mood:angry|face:angry]]正文', 'angry'],
  ['情绪词·自创"气炸了"（猜）', '[[mood:气炸了]]正文', 'angry'],
];

for (const [name, body, wantState] of CASES) {
  for (const step of [1, 3]) {
    const r = feed(body, step);
    const leaks = /\[\[|mood\s*[:：=]|心情\s*[:：=]|^\[mood/.test(r.text);
    const gotBody = r.text.includes('正文') && !leaks;
    const stateOk = wantState === null ? true : (r.moods[0] && r.moods[0].state === wantState);
    record(`切片${step}字 · ${name}：不漏控制符且正文完整`, gotBody, JSON.stringify(r.text));
    if (wantState !== null) {
      record(`切片${step}字 · ${name}：心情识别为 ${wantState}`, stateOk, JSON.stringify(r.moods[0] || null));
    }
  }
}

// 未闭合的半截标记：流结束时必须整段丢弃
{
  const r = feed('前面正文[[mood:think|face:think', 2);
  record('流尾未闭合标记被丢弃', r.text === '前面正文', JSON.stringify(r.text));
}
{
  const r = feed('正文A[[心情：开心', 1);
  record('中文键名未闭合也被丢弃', r.text === '正文A', JSON.stringify(r.text));
}

// 不能误伤：正文里正常的双括号（wiki 链接式、数组下标）要原样保留
{
  const r = feed('参考 [[双括号]] 与 [[另一条]] 的说明', 2);
  record('普通 [[...]] 不被误删', r.text === '参考 [[双括号]] 与 [[另一条]] 的说明', JSON.stringify(r.text));
}

// 一条消息里多次声明：都要生效，且一个都不显示
{
  const r = feed('[[mood:think|note:想想]]先说结论。[[mood:idle|face:idle|note:收工]]以上', 2);
  const ok = r.text === '先说结论。以上' && r.moods.length === 2
    && r.moods[0].state === 'think' && r.moods[1].state === 'idle';
  record('一轮多次声明：全部生效且全部剥除', ok, JSON.stringify({ text: r.text, moods: r.moods.map((m) => m.state) }));
}

// raw：标记被剥掉的同时要把原文带出去 —— 界面要显示"agent 下了什么心情指令"就靠它
{
  const r = feed('[[mood:think|face:thinking|note:想想]]正文', 2);
  record('心情事件带 raw 原文', r.moods[0] && r.moods[0].raw === '[[mood:think|face:thinking|note:想想]]',
    JSON.stringify(r.moods[0] && r.moods[0].raw));
}
{
  // 歪写的标记也要带原文（前端显示的就是模型自己写的那句）
  const r = feed('[[心情：专注，face:thinking]]正文', 1);
  record('畸形标记的 raw 也是原文', r.moods[0] && /^\[\[心情/.test(r.moods[0].raw || ''),
    JSON.stringify(r.moods[0] && r.moods[0].raw));
}

// stripTags 兜底：直接给一段带标记的成品文本也要清干净
{
  const s = moodp.stripTags('你好[[mood:idle|face:idle]]世界[[心情：开心|note:好]]结束');
  record('stripTags 清掉成品文本里的标记', s === '你好世界结束', JSON.stringify(s));
}

// 提示词：结尾不许"归零"，也不许为了凑数硬发一条
// 之前写的是"回复收尾时各一条 + 不要连续重复同一个 STATE + 收尾那条决定结束态"，
// 三条叠加逼着模型收尾必换成 idle，前面演的情绪全白费（用户：结尾又把心情设回去）。
{
  const sys = moodp.buildSystemPrompt(['idle', 'thinking', 'smile']);
  record('提示词不再逼模型"不许重复 STATE"', !sys.includes('不要连续重复同一个 STATE'), '');
  record('提示词明确收尾不要改回 idle', sys.includes('不要一到收尾就改回'), '');
  record('提示词把收尾定义成"定格不是归零"', sys.includes('定格') && sys.includes('归零'), '');
  record('提示词不再要求结尾硬发一条', !sys.includes('回复收尾时各一条') && sys.includes('不要为了凑数在结尾硬发'), '');

  // 人格 + 情绪反应：不能只有"工作模式"，要教它对用户的态度有反应
  record('提示词给了角色人格（有脾气/有情绪）', sys.includes('有脾气') && sys.includes('不是只会干活的机器'), '');

  // 2026-10-17 用户报："llm 回复时有出现类似'你我之间隔着的是一整层终端'这样的语句"。
  // 根因是身份句把角色绑在了媒介上（"一个住在终端里的角色"），模型于是拿媒介抒情；
  // 另一处"你和我之间的控制信道"同向助推。这两处都不许回来，且必须有一条明确的禁则。
  record('身份句不再把角色绑在"终端"上（否则模型会拿媒介抒情）',
    !sys.includes('住在终端'), '');
  record('不再有"你和我之间的控制信道"这种营造空间感的说法',
    !sys.includes('你和我之间') && !sys.includes('控制信道'), '');
  record('提示词明确禁止自我指涉的元叙述（谈自己是什么/隔着什么）',
    sys.includes('别拿"你是什么"当话题') && sys.includes('感慨你和他之间隔着什么'), '');
  record('提示词把 STATE 解释成感受而非工作模式', sys.includes('感受') && sys.includes('工作模式'), '');
  record('提示词明确"别什么都回一句平静"', sys.includes('别什么都回一句平静'), '');
  record('被骂 → error 的触发规则在', sys.includes('骂你') && /骂你[^\n]*error/.test(sys), '');
  record('被夸 → happy 的触发规则在', sys.includes('夸你') && /夸你[^\n]*happy/.test(sys), '');
  record('提示词写了 happy 与 working 的分工（否则两档永远只用一个）',
    sys.includes('happy 和 working 也别混'), '');
  // 2026-10-18 改名：提示词里只该出现新名。旧名留给解析器（STATE_ALIAS）认历史，不该再教给模型；
  // 也防住"把开发注释写进 STATES.hint"—— hint 是整句注入的，写进去模型会当设定念出来。
  record('提示词里不再出现旧名 stream', !/\bstream\b/.test(sys), '');

  // 2026-10-18 用户："我看到有输出「（愣了下，别过脸）」，不要这种动作描绘，这样像写剧本一样"。
  // 禁则必须有，而且**不许带例句** —— 把用户贴的那句写进提示词，模型会原样抄回来
  // （"你和我之间隔着终端"就是这么被喂出来的）。
  record('提示词禁止括号/星号式的动作神态描写', sys.includes('不要写动作或神态'), '');
  record('禁则里没有抄用户那句当范例（否则模型会照着演）',
    !sys.includes('别过脸') && !sys.includes('愣了下'), '');
  record('note 也点明是"说的话"不是动作', /note[^\n]*心里话[\s\S]{0,60}不要写成动作/.test(sys), '');
}

// ─────────────────────────────────────────────────────────────────────────────
// 情绪拟人化（2026-10-15 用户："要让 llm 的情绪更拟人……简单来说就是要像具有情感那样"）
//
// 三层都要**真的落进提示词**——写了实现不等于模型看得见，这几条就是钉这个的。
// 另外两条属于架构级：情绪记忆（把"此刻心情"喂回去）与性格（配置框里选）。

console.log('\n── ⑨ 提示词：三层拟人 ──');
{
  const sys = moodp.buildSystemPrompt(['idle', 'thinking', 'smile']);

  // ① 心情面板更活：note 必须是"心里话"，不是状态说明
  record('note 要求写心里话（给了好/差对照）',
    sys.includes('心里话') && sys.includes('这报错看着眼熟') && sys.includes('正在分析问题'), '');
  record('要求心情具体到这件事上', sys.includes('要具体到这件事上'), '');
  record('允许一轮里情绪有起伏、也可以不变（真实的人不会每句话都在切）',
    sys.includes('也可以一直没变') && sys.includes('先犯难、后得意'), '');
  record('禁止每轮搬同一句话糊弄', sys.includes('别每轮都搬同一句话'), '');

  // ② 说话也带情绪
  record('要求说话像人、不要客服腔', sys.includes('客服腔') && sys.includes('作为一个 AI 助手'), '');
  record('说明心情会改变说话方式', sys.includes('心情会改变你说话的方式'), '');

  // ③ 情绪影响干活（但要守住底线）
  record('允许因情绪先抱怨两句、然后照常把活干完',
    sys.includes('先把不高兴说出来') && sys.includes('该办的活照样办完'), '');
  record('有底线：不许故意给错答案、不许假装做完',
    sys.includes('不许故意给错的答案') && sys.includes('不许假装做完了'), '');
}

console.log('\n── ⑩ 情绪记忆：把"此刻的心情"喂回给模型 ──');
// 之前 mood 标记是"往界面的单行道"（agent.js 发历史前会 stripMood），模型每轮从白纸开始，
// 只能按"夸→working / 骂→error"那张表现推 —— 表现就是每轮重置、机械。
{
  const before = moodp.buildSystemPrompt(['idle']);
  record('没给心情 → 不凭空编一段"你此刻的心情"', !before.includes('【你此刻的心情】'), '');

  const after = moodp.buildSystemPrompt(['idle'], { mood: { state: 'error', note: '算了', minutes: 3.4 } });
  record('给了心情 → 注入"你此刻的心情"', after.includes('【你此刻的心情】'), '');
  record('注入了这个 state 的中文名', after.includes('出错'), '');
  record('注入了当时的心里话（原话）', after.includes('算了'), '');
  record('注入了"保持了多久"', after.includes('3 分钟'), '');
  record('明确要求它有情绪惯性、不要每轮重置', after.includes('情绪是有惯性的'), '');

  record('脏 state 不注入（不猜）',
    !moodp.buildSystemPrompt(['idle'], { mood: { state: 'zzz' } }).includes('【你此刻的心情】'), '');
  record('moodBriefing 对空值返回空串（不硬编一句假的顶上）',
    moodp.moodBriefing(null) === '' && moodp.moodBriefing({}) === '', '');
  record('心情笔记超长会被截断（不让它把 system 撑爆）',
    moodp.moodBriefing({ state: 'idle', note: 'x'.repeat(200) }).length
      < moodp.moodBriefing({ state: 'idle' }).length + 120, '');
}

console.log('\n── ⑪ 性格：配置框里选，每个对话一份 ──');
{
  record('persona=default 时**不加**人设段（留白，别把模型逼去演标签）',
    !moodp.buildSystemPrompt(['idle']).includes('**你的性格**'), '');
  for (const id of moodp.PERSONA_KEYS) {
    const s = moodp.buildSystemPrompt(['idle'], { persona: id });
    record(`persona=${id} ${id === 'default' ? '不加人设段' : '加上了人设段'}`,
      s.includes('**你的性格**') === (id !== 'default'), '');
  }
  record('除 default 外每个性格都有实打实的文案（不是空条）',
    moodp.PERSONA_KEYS.every((k) => k === 'default' || (moodp.PERSONAS[k].line || '').trim().length > 20), '');

  // 归一化：这一项**没有"猜"的余地**，非法一律回落 default（不是随便挑一个像的）
  const dirty = [null, undefined, '', 'nope', 123, {}, [], '傲娇', 'defaultx'];
  record('非法性格 id 一律回落 default', dirty.every((v) => moodp.normPersona(v) === 'default'),
    JSON.stringify(dirty.map((v) => [v, moodp.normPersona(v)])));
  record('大小写 / 前后空白都能收敛',
    moodp.normPersona('  TSUNDERE ') === 'tsundere' && moodp.normPersona('Genki') === 'genki', '');
  record('default 本身也认（不是被当成非法值）', moodp.normPersona('default') === 'default', '');
}

console.log('\n── ⑫ 前端的候选表不许和后端漂移 ──');
// 前端跑在浏览器里、后端是 CommonJS，共用不了一份常量表 —— 那就用这条守卫钉住：
// 单边加人（多一个/少一个/顺序变了）在这里就红。
{
  const src = fs.readFileSync(path.join(ROOT, 'app/src/panels/agent.js'), 'utf8');
  const block = src.match(/const PERSONA_OPTS = \[([\s\S]*?)\];/);
  const ids = block ? [...block[1].matchAll(/\['([a-z]+)'\s*,/g)].map((m) => m[1]) : [];
  record('前端 PERSONA_OPTS 读得到', ids.length > 0, JSON.stringify(ids));
  record('与后端 PERSONA_KEYS 完全一致（含顺序）',
    ids.join(',') === moodp.PERSONA_KEYS.join(','),
    `前端 [${ids.join(',')}] / 后端 [${moodp.PERSONA_KEYS.join(',')}]`);

  // 每个 id 都得有语言包文案，否则配置框会直接亮出原始 key（那种失败方式最难看）
  const keyOf = (k) => `'ui.agent.opt.persona${k[0].toUpperCase()}${k.slice(1)}'`;
  for (const f of ['zh-cn', 'en', 'ja', 'ru', 'tlh']) {
    const dict = fs.readFileSync(path.join(ROOT, `app/src/i18n/${f}.js`), 'utf8');
    const missing = moodp.PERSONA_KEYS.filter((k) => !dict.includes(keyOf(k)));
    record(`${f}.js 里 ${moodp.PERSONA_KEYS.length} 个性格名都在`, missing.length === 0, missing.join(','));
    record(`${f}.js 有「性格」那一栏的标签`, dict.includes("'ui.agent.field.persona'"), '');
  }

  // 接线守卫：请求真的把它带出去了吗（没带 = 选了半天白选）
  const api = fs.readFileSync(path.join(ROOT, 'app/src/api.js'), 'utf8');
  record('askAgent 把 persona / mood 带进请求体',
    /\bpersona\b/.test(api.split('/api/agent')[1] || '') && /\bmood\b/.test(api.split('/api/agent')[1] || ''), '');
  const srv = fs.readFileSync(path.join(ROOT, 'server/server.js'), 'utf8');
  record('后端 /api/agent 走 agentMoodOpts() 校验这两个参数',
    /streamAgent\(res, body\.text \|\| '', body\.history \|\| \[\], body\.llm, agentMoodOpts\(body\)\)/.test(srv), '');
  record('后端把 opts 一路传进 buildSystemPrompt',
    /buildSystemPrompt\(facesFromPacks\(\), opts\)/.test(srv), '');
}

console.log('\n── ⑬ 加/删一个 state 时最容易漏的几处（2026-10-17 加 angry 立的）──');
// 前端有三份**必须**互相同步的表，而且漏了都不会报错、只会静默走兜底：
//   mood.js  MOOD_STATES  → 心情条目标高度（漏了 → fromAgent 直接拒绝这个 state，心情永远切不过去）
//   theme.js MOODS        → 配色（漏了 → themeFor 兜底回 idle 配色，界面变青色但不报错）
//   charpack.js ALIAS     → state → 素材标签（漏了 → 切过去时脸变成待机）
{
  const moodMod = await import(new URL('../app/src/mood.js', import.meta.url).href);
  const themeMod = await import(new URL('../app/src/theme.js', import.meta.url).href);
  const be = moodp.STATE_KEYS;

  record('前端 mood.js 的 state 表与后端枚举完全一致',
    Object.keys(moodMod.MOOD_STATES).sort().join(',') === be.slice().sort().join(','),
    `前端 [${Object.keys(moodMod.MOOD_STATES)}] / 后端 [${be}]`);

  const missTheme = be.filter((k) => !themeMod.MOODS[k]);
  record(`前端 theme.js 配色表覆盖全部 ${be.length} 个 state（漏了会静默回落 idle 配色）`,
    missTheme.length === 0, missTheme.join(','));

  const aliasSrc = fs.readFileSync(path.join(ROOT, 'app/src/charpack.js'), 'utf8');
  const aliasBlock = aliasSrc.match(/const ALIAS = \{([\s\S]*?)\n\};/);
  const aliasKeys = aliasBlock ? [...aliasBlock[1].matchAll(/^\s*([a-z]+)\s*:/gm)].map((m) => m[1]) : [];
  const missAlias = be.filter((k) => !aliasKeys.includes(k));
  record(`charpack ALIAS 里每个 state 都有别名（漏了 → 切过去脸变待机）`,
    missAlias.length === 0, missAlias.join(','));

  // 表情标签是从枚举取的（以前是写死的数组，加 state 时会静默少一个点不到的标签）
  const charSrc = fs.readFileSync(path.join(ROOT, 'app/src/panels/char.js'), 'utf8');
  record('表情标签不再写死数组（从 MOOD_KEYS 取）',
    /const keys = MOOD_KEYS;/.test(charSrc) && !/\['idle', 'think', 'working', 'sleepy', 'angry', 'error'\]/.test(charSrc), '');

  // 提示词：模型只能看见这里写的 state，加了状态却没写进来 = 模型永远不会用它
  const sys = moodp.buildSystemPrompt(['idle', 'angry']);
  const missDoc = be.filter((k) => !new RegExp(`- ${k}\\s`).test(sys));
  record('提示词里逐个列出了所有 state（模型看不见就不会用）', missDoc.length === 0, missDoc.join(','));
  // 这句文案是硬编码的（不会跟着枚举变）—— 所以按**实际数量**拼出期望值再比，
  // 否则加一个 state 就得回来手改一次，改漏了这里还会假红/假绿。
  const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const nState = moodp.STATE_KEYS.length;
  const numWord = CN_NUM[nState] || String(nState);
  record('提示词按 state 数量改了"这几个 STATE"那句',
    sys.includes(`这${numWord}个 STATE`), `期望"这${numWord}个 STATE"`);
  record('angry 与 error 的区别写进了提示词',
    sys.includes('angry 和 error 别混') && sys.includes('顶回去') && sys.includes('蔫'), '');
  record('"被骂"那条同时给了 angry 与 error 两个去向',
    /骂你[^\n]*angry/.test(sys) && /骂你[^\n]*error/.test(sys), '');
}

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exitCode = failed.length ? 1 : 0;
