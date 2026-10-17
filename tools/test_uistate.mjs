// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 回归：界面状态的落盘调度（uistate.js）+ 心情快照的取/还（mood.js）
//
// 这两件事是"关掉 HUD 再开，画面要跟退出前一样"的全部逻辑：
//   · 变了才存、连着变只存最后一次、关窗时立刻补一刀（uistate）
//   · 快照里该带什么、脏值怎么挡、'stream' 为什么不能还原、保持时长为什么从开机重算（mood）
// 真页面那一趟（tools/_verify_persist.mjs）验的是"确实写进了 run/ 又确实读了回来"，
// 这里验的是**逻辑**本身 —— 不用起浏览器，改一行就能立刻跑。
import { readFileSync } from 'node:fs';
import { Mood, MOOD_STATES } from '../app/src/mood.js';
import { mkMoodSaver } from '../app/src/uistate.js';

let fail = 0;
const chk = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   → ' + got}`);
  if (!ok) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 假被观察对象：只要 sig / snapshot 两个字（mkMoodSaver 就认这个）──
function fake(init) {
  const o = { sig: init, snaps: [], snapshot() { return { state: this.sig }; } };
  return o;
}

console.log('── ① 落盘调度：变了才存 / 去抖 / 关窗补一刀 ──');
{
  const writes = [];
  const saver = mkMoodSaver((s) => writes.push(s), 60);
  const a = fake('idle');

  // 开闸之前一笔都不许写：主循环第一帧跑的时候，"读快照"那趟还没回来，
  // 此刻 mood 是默认待机 —— 抢着存就把盘上那份好快照盖成待机了（这次要修的就是这个）。
  chk('seed（开闸）之前 pump 一律空转', saver.pump(a) === false && saver.queued === 0 && writes.length === 0,
    `${saver.primed}/${saver.queued}/${writes.length}`);
  chk('seed 之前 flush 也没东西可写', saver.flush() === false && writes.length === 0, '');

  saver.seed(a);                       // = 读快照那趟回来（有快照 → 恢复完；没有 → 确认没有）
  chk('seed 之后开闸', saver.primed === true, '');
  chk('seed 之后第一帧也是"没变化"（刚对过账）', saver.pump(a) === false, '');
  a.sig = 'error';
  chk('之后真的变了才发现变化', saver.pump(a) === true, '');
  chk('排上了一笔（还没写）', saver.queued === 1 && writes.length === 0, `${saver.queued}/${writes.length}`);
  chk('签名没变 → 不再排队', saver.pump(a) === false && writes.length === 0, '');

  a.sig = 'sleepy';
  saver.pump(a);
  chk('窗口内连变两次 → 仍然只一笔', saver.queued === 1, '');

  await sleep(140);
  chk('窗口到了就写', writes.length === 1, JSON.stringify(writes));
  chk('写下去的是**最后一次**那份（不是排队时那份）', writes[0].state === 'sleepy', JSON.stringify(writes));
  chk('写完就不留尾巴', saver.queued === 0, '');

  // flush：关窗那一刻不该等窗口
  const t0 = Date.now();
  a.sig = 'think';
  saver.pump(a);
  const did = saver.flush();
  chk('flush 立刻写掉待写那笔', did === true && writes.length === 2 && writes[1].state === 'think', JSON.stringify(writes));
  chk('flush 没等去抖窗口（< 40ms）', Date.now() - t0 < 40, Date.now() - t0 + 'ms');
  chk('没有待写时 flush 不写', saver.flush() === false && writes.length === 2, '');

  // seed：刚恢复完的状态不该被立刻写回去
  const b = fake('error');
  saver.seed(b);
  chk('seed 之后同签名不再排（不会把刚读回来的又写一遍）', saver.pump(b) === false && writes.length === 2, '');
  b.sig = 'idle';
  chk('seed 之后真变了还是要写', saver.pump(b) === true, '');
  saver.flush();
  chk('那一笔写下去了', writes.length === 3 && writes[2].state === 'idle', '');

  // 写盘失败不能把主循环带下水
  const boom = mkMoodSaver(() => { throw new Error('后端没了'); }, 10);
  let threw = false;
  try { boom.seed(fake('idle')); boom.pump(fake('error')); await sleep(40); } catch (e) { threw = true; }
  chk('写盘抛错不会把 pump / 定时器带崩', threw === false, '');
}

console.log('\n── ② 心情快照：取 ──');
{
  const m = new Mood();
  m.state = 'error'; m.face = 'sad'; m.value = 31.25; m.intensity = 0.9;
  m.source = 'agent'; m.noteText = '炸了'; m.noteKey = '';
  const s = m.snapshot();
  chk('state / face 带上', s.state === 'error' && s.face === 'sad', JSON.stringify(s));
  chk('intensity / 来源带上', s.intensity === 0.9 && s.source === 'agent', JSON.stringify(s));
  chk('agent 那句话带上（note 是内容，不是界面文案）', s.noteText === '炸了' && s.noteKey === '', JSON.stringify(s));
  chk('配色当前值带上（恢复时不用从 62 淡过去）', s.value === 31.25, String(s.value));
  chk('带墙上时间 savedAt', typeof s.savedAt === 'number' && s.savedAt > 1e12, String(s.savedAt));

  const before = m.sig;
  m.value = 88;
  chk('value 每帧都在动 —— 但它**不算**进签名（否则等于每帧写盘）', m.sig === before, '');
  m.state = 'think';
  chk('state 变了签名就得变', m.sig !== before, '');
}

console.log('\n── ③ 心情快照：还 ──');
{
  const snap = {
    state: 'error', face: 'sad', intensity: 0.9, noteText: '炸了', noteKey: '',
    source: 'agent', value: 31.25, savedAt: 1,
  };

  const m = new Mood();
  chk('恢复成功', m.restore(snap) === true, '');
  chk('state 还回来了', m.key === 'error', m.key);
  chk('face 还回来了（立绘的表情）', m.face === 'sad', String(m.face));
  chk('intensity 还回来了（配色的浓淡）', m.intensity === 0.9, String(m.intensity));
  chk('note 原样还回来', m.note === '炸了', m.note);
  chk('来源标成 AGENT', m.sourceTag === 'AGENT', m.sourceTag);
  chk('配色当前值也还回来（不从 62 起步）', Math.abs(m.value - 31.25) < 1e-6, String(m.value));
  // （原有一条"曲线也从同一个高度起步"的断言 —— 2026-10-17 用户要求删掉「情绪历史」，
  //   mood.history 这个缓冲连同那根曲线一起下线了，断言随之删除。）

  // 用户真正在意的：关掉再开**不该**又变回待机
  for (let i = 0; i < 30; i++) m.tick(0.016);
  chk('恢复之后跑半秒仍在 error（保持时长从开机重算，不按墙上时间判过期）', m.key === 'error', m.key);

  // 2026-10-17 用户："心情应该完全由 agent 控制" —— 程序不许自己改心情。
  // 曾经有两条自动路径：静默两分钟→瞌睡、声明到期→待机。它们都让"没人说话"变成一次情绪事件，
  // 而且那份 state 还会被当成 agent 自己的心情喂给模型（模型于是回"我本来还困着"）。已删。
  const mAuto = new Mood();
  mAuto.fromAgent({ state: 'angry', note: '火' });
  for (let i = 0; i < 200; i++) mAuto.tick(0.016);      // 跑几秒（含跨过原来的 120s 判据不可能，但至少证不靠帧数）
  chk('agent 声明的心情跑多久都还在（不会自己过期回待机）', mAuto.key === 'angry', mAuto.key);
  chk('来源也还是 agent（没被折成"本地兜底"）', mAuto.source === 'agent', mAuto.source);

  const moodSrc = readFileSync(new URL('../app/src/mood.js', import.meta.url), 'utf8');
  const tickFn = (moodSrc.match(/tick\(dt\) \{[\s\S]*?\n  \}/) || [''])[0];
  chk('tick 只算数值，不写 state / source / note（自动改心情的路子彻底没了）',
    tickFn.length > 0 && !/this\.(state|source|noteKey|noteText)\s*=/.test(tickFn), tickFn.slice(0, 100));
  chk('静默兜底那套常量与开关已经不在源码里（SILENCE_MS / autoFallback）',
    !/SILENCE_MS|autoFallback/.test(moodSrc), '');

  // 手动锁定过的：调试旁路**只活在这一趟运行里**，不跨重启（用户 2026-10-17 报的"手动 · 生气"）
  const m2 = new Mood();
  m2.restore({ ...snap, state: 'sleepy', source: 'manual', face: null });
  chk('旧档里的 manual 降级成 auto（来源不再是"手动"）', m2.source === 'auto', m2.source);
  chk('锁不还魂：_forced 从空开始', m2._forced === null, String(m2._forced));
  chk('降级只动来源，画面照旧（state 还是 sleepy，不是被折成待机）', m2.key === 'sleepy', m2.key);
  m2.fromLocal('error', 'ui.agent.noBackend');
  chk('没有锁拦着，本地兜底能立刻接手', m2.key === 'error', m2.key);

  const m2b = new Mood();
  m2b.restore({ ...snap, state: 'angry', source: 'manual', noteKey: 'ui.mood.manualOverride', noteText: '' });
  chk('旧档里那句调试说明被清掉（否则开机又看到"手动覆盖（调试）"）', m2b.note === '', JSON.stringify(m2b.note));

  // manual 也不落盘：盘上永远只有 agent / auto 两档
  const m2c = new Mood();
  m2c.force('angry');
  chk('force 之后内存里确实是 manual（能力没删）', m2c.source === 'manual' && m2c._forced === 'angry', m2c.source);
  const s2c = m2c.snapshot();
  chk('但写盘时来源折成 auto（调试态不许进档）', s2c.source === 'auto', s2c.source);
  chk('调试说明也不进档', s2c.noteKey === '' && s2c.noteText === '', JSON.stringify(s2c.noteKey));
  chk('画面（state/face）照存 —— 那才是"关掉再开一样"要的', s2c.state === 'angry', s2c.state);

  // 'stream' 也是 agent 声明过的心情（提示词里"被夸 / 来劲"发出来就是它）—— 不许折
  const m3 = new Mood();
  m3.restore({ ...snap, state: 'stream', face: 'streaming' });
  chk("'stream' 原样还回来（曾经被折成 idle —— 用户 2026-10-18 报的重开变待机）", m3.key === 'stream', m3.key);
  chk("face 也照原样还回来（立绘那张脸）", m3.face === 'streaming', String(m3.face));

  // 脏值一律挡在外面
  const m4 = new Mood();
  m4.state = 'sleepy';
  chk('不存在的 state 整条丢掉', m4.restore({ state: 'nope' }) === false, '');
  chk('丢掉时**不改**当前状态（宁可维持现状也不猜）', m4.key === 'sleepy', m4.key);
  chk('null / 非对象也丢掉', m4.restore(null) === false && m4.restore('x') === false && m4.restore(7) === false, '');
  chk('空对象丢掉（没有 state）', m4.restore({}) === false, '');

  const m5 = new Mood();
  m5.restore({ state: 'think', intensity: 9, value: -5, source: 'zzz', face: 123, noteText: 456 });
  chk('intensity 越界夹到 1', m5.intensity === 1, String(m5.intensity));
  chk('value 越界夹到 2', m5.value === 2, String(m5.value));
  chk('来源脏值收敛成 auto', m5.source === 'auto', m5.source);
  chk('face 非字符串也变成字符串', m5.face === '123', String(m5.face));
  chk('noteText 非字符串也变成字符串', m5.noteText === '456', String(m5.noteText));

  // 快照 → 还原 → 快照：往返稳定（存两次的结果该一样，除了时间戳）
  const a = new Mood();
  a.restore(snap);
  const s1 = a.snapshot(), s2 = new Mood();
  s2.restore(s1);
  const s3 = s2.snapshot();
  const strip = (o) => { const { savedAt, ...r } = o; return JSON.stringify(r); };
  chk('快照往返一轮后内容不变', strip(s1) === strip(s3), strip(s1) + ' vs ' + strip(s3));
}

console.log('\n── ④ 状态枚举与服务端同一份 ──');
{
  // server/moodprotocol.js 的 STATES 是权威；前端这边不能自己长出新状态
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const p = req('../server/moodprotocol.js');
  const a = Object.keys(MOOD_STATES).sort().join(',');
  const b = p.STATE_KEYS.slice().sort().join(',');
  chk('前后端状态枚举一致（' + a + '）', a === b, a + ' vs ' + b);
  for (const k of p.STATE_KEYS) {
    chk(`'${k}' 是可恢复的（都能被 restore 接受）`, new Mood().restore({ state: k }) === true, '');
  }
}

console.log('\n── ⑤ 接线守卫（主装配真的把它接上了）──');
{
  const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const main = rd('app/src/main.js');
  const api = rd('app/src/api.js');
  const zh = rd('app/src/i18n/zh-cn.js');
  const en = rd('app/src/i18n/en.js');
  const ja = rd('app/src/i18n/ja.js');

  chk('主循环每帧都在问"要不要存"', /moodSaver\.pump\(mood\)/.test(main), '');
  chk('开机时去读快照', /uiStateP\.then/.test(main) && /mood\.restore\(snap\.mood\)/.test(main), '');
  // 读快照那趟无论成败都得开闸：失败走 catch、卡住走超时（现在两件事共用一个带超时的 promise）
  chk('读快照那趟无论成败都会开闸（后端没起来 / 请求卡住也照样能记账）',
    /Promise\.race\(\[[\s\S]{0,200}setTimeout\(\(\) => r\(null\), 2500\)/.test(main)
      && /catch\(\(\) => \{ moodBooted\(null\); \}\)/.test(main), '');
  chk('?mood= 明确指定时不吃盘上那份', /if \(q\.get\('mood'\)\) \{\s*\n\s*moodBooted\(null\)/.test(main), '');
  // 落在哪个对话（2026-10-17 用户报的：切到第一个、关掉再开却落在第二个）
  chk('开机会把"上次落在哪个对话"拨回去', /selectSavedConv\(ui\.active\)/.test(main), '');
  chk('拨回去要发生在"按对话换形象"之前（否则形象还留在默认那个上）',
    /selectSavedConv\(ui\.active\)[\s\S]{0,400}?applyConvArt\(\)/.test(main), '');
  const ag = rd('app/src/panels/agent.js');
  chk('切标签时记一笔（selectTab / nextTab / 新建 / 关闭四处都记）',
    /selectTab\(i\) \{[\s\S]{0,400}_saveActive\(\)/.test(ag)
      && /nextTab\(dir\) \{[\s\S]{0,400}_saveActive\(\)/.test(ag)
      && /this\.active = this\.tabs\.length - 1;\s*\n\s*this\.syncFocus\(\);\s*\n\s*this\._saveActive\(\);\s*\/\/ 按完/.test(ag)
      && /if \(this\.active >= this\.tabs\.length\) this\.active = this\.tabs\.length - 1;[\s\S]{0,200}_saveActive\(\)/.test(ag), '');
  chk('恢复存档那一刻**不**记（那时还没播出正确落点，早写一笔会盖掉盘上那份）',
    /this\.active = this\.tabs\.length - 1;\s*\n\s*this\.syncFocus\(\);\s*\n  \}/.test(ag), '');
  // 构造函数里那个起手对话也是走 newTab 建的 —— 它那一笔要是在读档前写下去，
  // 盘上"上次落在哪个对话"就被盖成一个注定被丢弃的新 id，重开永远落回默认（踩过一次）。
  chk('读档前一律不记账（起手对话不算数）',
    /_saveActive\(\) \{\s*\n\s*if \(!this\._restored\) return;/.test(ag) && /this\._restored = false;/.test(ag), '');
  chk('恢复这一趟无论怎么收尾都开闸（后端没起来 / 没存档也开）',
    /finally \{ this\._restored = true; \}/.test(ag), '');
  const srv = rd('server/server.js');
  chk('后端认得 active，且只收"长得像对话 id"的值（挡路径穿越）',
    /function normUiActive/.test(srv) && /CONV_ID_RE\.test\(s\) \? s : ''/.test(srv), '');
  chk('后端写盘逐字段（只带 active 的那次不会把心情抹掉）',
    /has\('mood'\) \? normUiMood\(body\.mood\) : prev\.mood/.test(srv)
      && /has\('active'\) \? normUiActive\(body\.active\) : prev\.active/.test(srv), '');
  chk('关窗那一刻两样都补一刀（对话 + 心情）',
    /panels\.agent\.flushSaves\(\)[\s\S]{0,120}moodSaver\.flush\(\)/.test(main), '');
  chk('接口指向 /api/ui-state', /'\/api\/ui-state'/.test(api), '');
  chk('启动画面那行文案两份都备齐了（ja 按老规矩落回 en）',
    /'boot\.ui\.moodRestored'/.test(zh) && /'boot\.ui\.moodRestored'/.test(en)
      && !/^\s*'boot\./m.test(ja), '');
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
