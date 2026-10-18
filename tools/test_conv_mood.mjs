// Ponko-HUD · 心情是**每个对话一份**的（2026-10-17）
//
// 用户报的原话：「我现在第一个对话是生气，然后我按 +，怎么还是生气」。
// 根因：形象 / 性格 / LLM 配置都是每对话一份，只有心情是全局一个 Mood 实例 ——
// 于是新对话继承上一段对话的火气，后台对话的流式心情还会改前台的脸色，
// 新对话的模型在 system 提示词里收到的也是**别的对话**的心里话。
//
// 这个脚本钉住四件事：
//   ① 新对话从待机开始（不继承）；② 对话之间互不串；
//   ③ 存档往返（mood 跟着 run/conversations/<id>.json 走，不是全局）；
//   ④ 屏幕那层视图（moodView）跟着当前对话换人。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { AgentPanel, AgentConv } from '../app/src/panels/agent.js';
import { Mood, moodView } from '../app/src/mood.js';

// moodprotocol 是 CommonJS（server 那边 require 它），ESM 里用 createRequire 引
const require = createRequire(import.meta.url);
const { normMoodSnap } = require('../server/moodprotocol.js');

let failed = 0;
function chk(name, ok, extra) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined && extra !== '' ? '   → ' + extra : ''}`);
}

const states = (c) => (c.mood ? c.mood.state : '(no mood)');

console.log('\n── ① 每个对话自带一份心情，不是共用一个实例 ──');
{
  const a = new AgentPanel();
  a.tab.mood.fromAgent({ state: 'angry', intensity: 0.9, note: '他刚骂我' });
  const b = a.newTab(true);

  chk('两个对话的 mood 不是同一个对象', a.tabs[0].mood !== b.mood, `${a.tabs[0].mood === b.mood}`);
  chk('第一个对话确实是生气（前置条件）', states(a.tabs[0]) === 'angry', states(a.tabs[0]));
  chk('按 + 新建的对话从待机开始（不继承火气）', states(b) === 'idle', states(b));
  chk('新对话没有上一段对话的心里话', b.mood.noteText === '', JSON.stringify(b.mood.noteText));
  chk('新对话的来源是 auto（不是 agent/manual）', b.mood.source === 'auto', b.mood.source);
}

console.log('\n── ② 对话之间互不串（后台的流不改前台的脸色） ──');
{
  const a = new AgentPanel();
  const c1 = a.tabs[0];
  c1.mood.fromAgent({ state: 'angry', intensity: 0.9, note: '生气' });
  const c2 = a.newTab(true);
  c2.mood.fromAgent({ state: 'working', intensity: 1, note: '兴奋' });

  chk('在 B 里改成 working，A 仍是 angry', states(c1) === 'angry', states(c1));
  chk('B 自己是 working', states(c2) === 'working', states(c2));
  // 后台对话（非当前活动）收到心情声明，不该落到前台的视图上
  a.selectTab(0);
  chk('切回 A：活动对话是 A', a.tab === c1, a.tab === c1);
  chk('切回 A 时屏幕心情 = A 的 angry（不是 B 的 working）', a.activeMood().state === 'angry', a.activeMood().state);
}

console.log('\n── ③ 屏幕那层视图（moodView）跟着当前对话换人 ──');
{
  const a = new AgentPanel();
  const view = moodView(() => a.activeMood());
  a.tabs[0].mood.fromAgent({ state: 'angry' });
  const b = a.newTab(true);

  chk('活动在 B → 视图读到 idle', view.key === 'idle', view.key);
  a.selectTab(0);
  chk('切回 A → 视图读到 angry（同一个 view 对象，不用重建）', view.key === 'angry', view.key);
  // 写也要落到活动那份上
  view.fromAgent({ state: 'sleepy', note: '写进来' });
  chk('通过视图写心情 → 落在 A 上', a.tabs[0].mood.state === 'sleepy', a.tabs[0].mood.state);
  chk('B 一滴都没沾到', b.mood.state === 'idle', b.mood.state);
  // 方法要绑到实例上（否则 this 指向代理，写进去的字段会丢）
  const snap = view.snapshot();
  chk('视图上调方法也是真方法（snapshot 拿得到真快照）', snap && snap.state === 'sleepy', JSON.stringify(snap));
  // 关掉当前标签 → 视图跟着新的活动对话
  a.selectTab(1);
  a.closeTab(1);
  chk('关掉一个对话后视图仍指向活着的那份', view.key === 'angry' || view.key === 'sleepy', view.key);
}

console.log('\n── ④ 每个对话自己的"此刻心情"（喂给模型那一段） ──');
{
  const a = new AgentPanel();
  const c1 = a.tabs[0];
  c1.mood.fromAgent({ state: 'angry', note: '他又这么说' });
  const c2 = a.newTab(true);

  const b1 = c1._moodBrief();
  const b2 = c2._moodBrief();
  chk('A 的 brief 是自己的 angry + 自己的心里话', b1.state === 'angry' && b1.note === '他又这么说', JSON.stringify(b1));
  chk('B 还没声明过心情 → 不发 brief（初始待机不算它的心情）', b2 === null, JSON.stringify(b2));

  // 2026-10-17 用户："心情应该完全由 agent 控制" —— 这段提示词写的是"你给自己定的是…"，
  // 所以只有 agent 真声明过才允许发。本地兜底（断连/命令失败）只上屏，不许冒充它的心里话。
  c2.mood.fromLocal('error', 'ui.agent.noBackend');
  chk('本地兜底不进 brief（只改配色，不改模型的自我认知）', c2._moodBrief() === null, JSON.stringify(c2._moodBrief()));

  // 后端那半：没带 mood 就**不许**拿盘上/屏幕那份兜底（2026-10-17 用户问"记忆串通"时查出来的：
  // 原来 agentMoodOpts 缺 mood 时会退回 readUiState().mood —— 那是全局最后一帧，
  // 随时可能是隔壁那个对话的火气）。这里做源码守卫，接错回去就红。
  const srv = readFileSync(new URL('../server/server.js', import.meta.url), 'utf8');
  const fn = (srv.match(/function agentMoodOpts\(body\) \{[\s\S]*?\n\}/) || [''])[0];
  chk('找不到 agentMoodOpts（改名了就把这条守卫一起改）', fn.length > 0, String(fn.length));
  chk('没带 mood 时不读 ui-state 那份全局缓存（否则就是串通的通道）',
    !/readUiState\(\)/.test(fn), fn.split('\n').filter((l) => /readUiState/.test(l)).join(' | '));
}

console.log('\n── ⑤ 存档往返：心情跟着对话文件走 ──');
{
  const a = new AgentPanel();
  a.tabs[0].mood.fromAgent({ state: 'angry', intensity: 0.8, note: '存档里的话' });
  const snap = a.tabs[0].mood.snapshot();
  chk('快照带上了 state / 心里话 / 强度',
    snap.state === 'angry' && snap.noteText === '存档里的话' && snap.intensity === 0.8, JSON.stringify(snap));

  const conv = new AgentConv('c-1', 0, snap);
  chk('用快照建出来的对话还原成 angry', conv.mood.state === 'angry', conv.mood.state);
  chk('心里话也还回来了', conv.mood.noteText === '存档里的话', conv.mood.noteText);
  chk('没给快照 → 待机（老存档没有 mood 字段时的行为）', new AgentConv('c-2', 1).mood.state === 'idle', '');

  // working 也是 agent 声明过的心情（"被夸 / 来劲"）—— 关掉再开必须还是它
  const s2 = new AgentConv('c-3', 0, { ...snap, state: 'working' });
  chk('快照里的 working 原样还原（不许折成待机）', s2.mood.state === 'working', s2.mood.state);
  // 2026-10-18 改名：旧存档里还写着 'stream'，读回来要变成 'working'（不是丢掉、更不是回待机）
  const s2b = new AgentConv('c-3b', 0, { ...snap, state: 'stream' });
  chk('旧档里的 stream 升格成 working（不是丢弃、也不是待机）', s2b.mood.state === 'working', s2b.mood.state);

  // manual（调试旁路）不许被存档粘住 —— 2026-10-17「手动·生气」那次的教训
  const man = new AgentConv('c-4', 0, { ...snap, source: 'manual', noteKey: 'ui.mood.manualOverride' });
  chk('manual 快照不会把锁还回来', man.mood.source === 'auto' && man.mood._forced === null,
    `${man.mood.source} / ${man.mood._forced}`);
}

console.log('\n── ⑥ 后端：存档里的心情要洗过再用（脏值整条丢掉） ──');
{
  chk('非法 state → null（调用方当"没有心情"）', normMoodSnap({ state: 'nope' }) === null, '');
  chk('不是对象 → null', normMoodSnap(null) === null && normMoodSnap('angry') === null, '');
  const ok = normMoodSnap({ state: 'angry', face: 'angry', intensity: 2, noteText: 'x', value: 999 });
  chk('越界的 intensity / value 被夹回范围', ok.intensity === 1 && ok.value === 100, JSON.stringify(ok));
  const m = normMoodSnap({ state: 'angry', source: 'manual', noteKey: 'ui.mood.manualOverride', noteText: '调试' });
  chk('manual 一律折成 auto，调试说明清空', m.source === 'auto' && m.noteText === '' && m.noteKey === '', JSON.stringify(m));
  const src = normMoodSnap({ state: 'angry', source: 'weird' });
  chk('未知来源回落 auto（不猜）', src.source === 'auto', src.source);
}

console.log('\n── ⑦ Mood.reset()：新建对话的"从零开始" ──');
{
  const m = new Mood();
  m.fromAgent({ state: 'angry', note: '火' });
  m.force('sleepy');
  m.reset();
  chk('reset 后回待机、没有锁、没有心里话',
    m.state === 'idle' && m._forced === null && m.noteText === '' && m.source === 'auto',
    `${m.state}/${m._forced}/${m.noteText}/${m.source}`);
  chk('reset 不是"淡过去"：value 直接落到待机高度', Math.abs(m.value - 62) < 0.001, String(m.value));
}

console.log('\n── ⑧ 省略 face 时不许沿用上一次的脸（2026-10-18 报的"心情设错了"） ──');
{
  const m = new Mood();
  m.fromAgent({ state: 'angry', face: 'angry', intensity: 0.7 });
  chk('先来的带 face:angry', m.frameTag() === 'angry', m.frameTag());
  m.fromAgent({ state: 'error', intensity: 0.6 });     // 省略 face → 用 STATE 的默认表情
  chk('下一条没写 face → 回到 error 自己的默认表情，不是还挂着 angry',
    m.state === 'error' && m.face === null && m.frameTag() === 'error',
    `${m.state}/${m.face}/${m.frameTag()}`);
  m.fromAgent({ state: 'think', face: 'thinking' });
  chk('显式给的 face 照旧生效', m.frameTag() === 'thinking', m.frameTag());
  m.fromAgent({ state: 'idle', face: '' });
  chk('给空串等于没给：回默认', m.state === 'idle' && m.face === null && m.frameTag() === 'idle',
    `${m.state}/${m.face}/${m.frameTag()}`);
}

console.log(`\n${failed ? 'FAILED ' + failed : '全部通过'}`);
process.exit(failed ? 1 : 0);
