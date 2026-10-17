// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 回归：配置框里的「形象」那一栏（2026-10-15 加）
//
// 三件事必须验住：
//   ① 候选项 = 自动 + 所有已保存的素材包（包清单由主装配注入，agent.js 不认识素材包那套）；
//   ② 形象是**每个对话一份**的：保存只写当前这个对话，切标签换人；
//   ③ 选「自动」时，保存流程会带着候选清单去问**这个对话配好的模型**，把结果存进 charpackPicked；
//      挑失败**不影响配置保存**（配置本身是好的），只是形象回退默认包。
// 全程 stub 掉 fetch（不连真后端、更不连真 LLM），只验前端这条链。
import { AgentPanel } from '../app/src/panels/agent.js';
import { langOf } from '../app/src/i18n/index.js';

let fail = 0;
const chk = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   → ' + got}`);
  if (!ok) fail++;
};

// ── 极简网格替身（画一帧，核对屏幕上写了什么字）
function mkGrid() {
  const rows = new Map();
  const g = {
    cols: 200, rows: 80, rows,
    chWidth: (c) => (c && c.charCodeAt(0) > 0x2e80 ? 2 : 1),
    strWidth(s) { let n = 0; for (const ch of s) n += g.chWidth(ch); return n; },
    text(x, y, s) {
      let col = x; const r = rows.get(y) || {};
      for (const ch of String(s)) { r[col] = ch; for (let k = 1; k < g.chWidth(ch); k++) r[col + k] = '~'; col += g.chWidth(ch); }
      rows.set(y, r);
      return col;
    },
    set(x, y, ch) { const r = rows.get(y) || {}; r[x] = ch; rows.set(y, r); },
    box() {}, fill() {}, inBounds: () => true, idx: (x, y) => y * 200 + x,
  };
  return g;
}
const TH = { text: 1, panel: 0, accent: 2, line: 3, dim: 4, darker: 5, err: 6, warn: 7, ok: 8, bg: 9 };
const C = { theme: TH, t: 0, tokRate: 0 };
const rowText = (g, y) => {
  const r = g.rows.get(y) || {};
  let s = '';
  for (let x = 0; x < 80; x++) { const ch = r[x]; s += ch === undefined ? ' ' : (ch === '~' ? '' : ch); }
  return s.replace(/\s+$/, '');
};
const anyRow = (g, s) => [...g.rows.keys()].some((y) => rowText(g, y).includes(s));

const field = (p, k) => p.form.fields.find((x) => x.key === k);
const setField = (p, k, v) => { const x = field(p, k); if (x) x.value = v; };
const PK = [{ id: 'ponko', name: 'ponko' }, { id: 'kuro', name: 'kuro' }];
const stop = (p) => { p._dirty.clear(); if (p._saveTimer) { clearTimeout(p._saveTimer); p._saveTimer = null; } };

/** 假后端：/api/llm/test 一律通过；/api/llm/pick-art 按 artReply 回；/api/conv 收下 payload */
function mkFetch(rec, artReply) {
  return async (url, init) => {
    const u = String(url);
    const ok = (o) => ({ ok: true, json: async () => o });
    if (u.startsWith('/api/llm/test')) return ok({ ok: true, ms: 7, model: 'm', via: 'models', provider: 'openai' });
    if (u.startsWith('/api/llm/pick-art')) {
      rec.pickBody = JSON.parse((init && init.body) || '{}');
      rec.pickCalls++;
      return ok(artReply || { ok: true, id: 'ponko' });
    }
    if (u.startsWith('/api/conv/')) return ok({ ok: true });
    if (u.startsWith('/api/conv')) { rec.convBody = JSON.parse((init && init.body) || '{}'); return ok({ ok: true }); }
    return ok({});
  };
}

console.log('── 1. 配置框里有「形象」这一栏，候选项 = 自动 + 已保存的包 ──');
{
  const p = new AgentPanel({});
  chk('agent.js 不认识素材包加载那套（清单靠注入）', p.getPacks === null, String(p.getPacks));
  p.getPacks = () => PK;
  p.refreshArtOpts();                              // 主装配在包加载完叫这一下
  const f = field(p, 'charpack');
  chk('配置框有『形象』字段', !!f, JSON.stringify(p.form.fields.map((x) => x.key)));
  chk('默认值是 auto（= 让模型挑，不是"拿第一个包"）', f && f.value === 'auto', f && f.value);
  chk('候选项 = 自动 + 所有已保存的包',
    JSON.stringify(f.opts.map((o) => o[0])) === JSON.stringify(['auto', 'ponko', 'kuro']),
    JSON.stringify(f.opts.map((o) => o[0])));
  chk('『心情语句』那一栏已经没了', !p.form.fields.some((x) => x.key === 'moodTags'), '');
  // 2026-10-15：这一栏旁边又加了「性格」（persona），所以字段数 5 → 6。
  // 数字**故意写死**：以后再加字段，这条会红，逼人回来确认"保存/取消的序号也跟着挪了"。
  chk('字段数 = 6（协议 / 形象 / 性格三栏都在）', p.form.fields.length === 6, String(p.form.fields.length));
  chk('NOTE 面板上「保存/取消」的序号仍然对得上（字段数 + 2 个按钮）', p.form.fields.length + 2 === 8, '');

  const g = mkGrid();
  p.layout({ x: 0, y: 0, w: 60, h: 24 });
  p.draw(g, C);
  chk('屏幕上写着「形象」这一行', anyRow(g, '形象'), '');
  chk('屏幕上写着「心情语句」的那一行没了', !anyRow(g, '心情语句'), '');
  chk('候选值显示成「自动」', anyRow(g, '自动'), '');
}

console.log('\n── 2. ←→ 在候选项里转圈（不立刻生效，保存才算数）──');
{
  const p = new AgentPanel({});
  p.getPacks = () => PK;
  p.refreshArtOpts();
  p.form.idx = p.form.fields.findIndex((x) => x.key === 'charpack');
  p.configCycle(1);
  chk('→ 到第一个包', field(p, 'charpack').value === 'ponko', field(p, 'charpack').value);
  p.configCycle(1);
  chk('→ 到第二个包', field(p, 'charpack').value === 'kuro', field(p, 'charpack').value);
  p.configCycle(1);
  chk('转回「自动」', field(p, 'charpack').value === 'auto', field(p, 'charpack').value);
  p.configCycle(-1);
  chk('← 往回也是这个圈', field(p, 'charpack').value === 'kuro', field(p, 'charpack').value);
  chk('转圈**不**改对话身上的设置（点了保存才算）', p.tab.charpack === 'auto', p.tab.charpack);
}

console.log('\n── 3. 保存：直接选了某个包 → 落进这个对话，并通知主装配换立绘 ──');
{
  const realFetch = globalThis.fetch;
  const rec = { convBody: null, pickBody: null, pickCalls: 0 };
  globalThis.fetch = mkFetch(rec);
  try {
    const p = new AgentPanel({});
    p.getPacks = () => PK;
    p.refreshArtOpts();
    setField(p, 'baseUrl', 'http://127.0.0.1:1/v1');
    setField(p, 'apiKey', 'sk-test');
    setField(p, 'model', 'm');
    setField(p, 'charpack', 'kuro');
    setField(p, 'provider', 'openai');
    let artCalls = 0;
    p.onArtChange = () => { artCalls++; };
    await p.configSave();
    chk('保存成功（配置落到这个对话）', !!p.tab.llm, JSON.stringify(p.tab.llm));
    chk('形象落到这个对话', p.tab.charpack === 'kuro', p.tab.charpack);
    chk('选了具体包就不去问模型（省一次请求）', rec.pickCalls === 0, String(rec.pickCalls));
    chk('通知了主装配换立绘', artCalls === 1, String(artCalls));
    p.flushSaves();
    chk('落盘 payload 带上了形象', rec.convBody && rec.convBody.charpack === 'kuro',
      JSON.stringify(rec.convBody && rec.convBody.charpack));
    stop(p);
  } finally { globalThis.fetch = realFetch; }
}

console.log('\n── 4. 保存：选「自动」→ 让这个对话配好的模型自己挑 ──');
{
  const realFetch = globalThis.fetch;
  const rec = { convBody: null, pickBody: null, pickCalls: 0 };
  globalThis.fetch = mkFetch(rec, { ok: true, id: 'kuro', said: 'kuro' });
  try {
    const p = new AgentPanel({});
    p.getPacks = () => PK;
    p.refreshArtOpts();
    setField(p, 'baseUrl', 'http://127.0.0.1:1/v1');
    setField(p, 'apiKey', 'sk-test');
    setField(p, 'model', 'm');
    setField(p, 'charpack', 'auto');
    setField(p, 'provider', 'openai');
    let artCalls = 0;
    p.onArtChange = () => { artCalls++; };
    await p.configSave();
    chk('问了模型一次', rec.pickCalls === 1, String(rec.pickCalls));
    chk('候选清单只给包（不含 auto），带 id + 名字',
      rec.pickBody && JSON.stringify(rec.pickBody.packs) === JSON.stringify(PK),
      JSON.stringify(rec.pickBody && rec.pickBody.packs));
    chk('请求里带着这个对话的配置（地址 / Key / 模型）',
      rec.pickBody && rec.pickBody.model === 'm' && rec.pickBody.apiKey === 'sk-test', '');
    chk('用户选的那个值还是 auto（它选的不是用户选的）', p.tab.charpack === 'auto', p.tab.charpack);
    chk('模型挑出来的存进 charpackPicked', p.tab.charpackPicked === 'kuro', p.tab.charpackPicked);
    chk('artId() 用挑出来的那个', p.artId() === 'kuro', p.artId());
    chk('通知了主装配换立绘', artCalls === 1, String(artCalls));
    p.flushSaves();
    chk('落盘 payload 两个字段都带上', rec.convBody && rec.convBody.charpack === 'auto'
      && rec.convBody.charpackPicked === 'kuro', JSON.stringify(rec.convBody));
    // 「自动」挑完了要在对话里留一句（状态行一会儿就没了，这句留得住）。
    // 那句是收表单时（900ms 后）才推进去的 —— 等它一下。
    await new Promise((r) => setTimeout(r, 1000));
    const info = p.tab.msgs.filter((m) => m.role === 'info').map((m) => m.k || m.text);
    chk('挑完了会把结果记进对话（不只是一闪而过的状态行）',
      info.some((s) => String(s).includes('artAuto')), JSON.stringify(info));
    stop(p);
  } finally { globalThis.fetch = realFetch; }
}

console.log('\n── 5. 「自动」只有一个包时不问模型（没得挑）──');
{
  const realFetch = globalThis.fetch;
  const rec = { convBody: null, pickBody: null, pickCalls: 0 };
  globalThis.fetch = mkFetch(rec);
  try {
    const p = new AgentPanel({});
    p.getPacks = () => [PK[0]];
    p.refreshArtOpts();
    setField(p, 'baseUrl', 'http://127.0.0.1:1/v1');
    setField(p, 'apiKey', 'sk-test');
    setField(p, 'model', 'm');
    setField(p, 'charpack', 'auto');
    setField(p, 'provider', 'openai');
    await p.configSave();
    chk('没去问模型', rec.pickCalls === 0, String(rec.pickCalls));
    chk('配置照样保存成功', !!p.tab.llm, JSON.stringify(p.tab.llm));
    chk('artId() 为空 → 主装配回退默认包', p.artId() === '', p.artId());
    stop(p);
  } finally { globalThis.fetch = realFetch; }
}

console.log('\n── 6. 挑形象失败 ≠ 保存失败 ──');
{
  const realFetch = globalThis.fetch;
  const rec = { convBody: null, pickBody: null, pickCalls: 0 };
  globalThis.fetch = mkFetch(rec, { ok: false, error: '它回的不是候选里的形象：呜' });
  try {
    const p = new AgentPanel({});
    p.getPacks = () => PK;
    p.refreshArtOpts();
    setField(p, 'baseUrl', 'http://127.0.0.1:1/v1');
    setField(p, 'apiKey', 'sk-test');
    setField(p, 'model', 'm');
    setField(p, 'charpack', 'auto');
    setField(p, 'provider', 'openai');
    await p.configSave();
    chk('配置仍然保存了（不会因为挑不出形象就把配置也丢掉）', !!p.tab.llm, JSON.stringify(p.tab.llm));
    chk('charpackPicked 留空', p.tab.charpackPicked === '', JSON.stringify(p.tab.charpackPicked));
    chk('artId() 为空 → 回退默认包', p.artId() === '', p.artId());
    chk('状态行如实报错（没假装挑成功）', String(p.form.msgKey) === 'ui.agent.form.pickArtFail',
      String(p.form.msgKey));
    stop(p);
  } finally { globalThis.fetch = realFetch; }
}

console.log('\n── 7. 存档带回来的形象（含脏值收敛）──');
{
  const realFetch = globalThis.fetch;
  const convs = [
    { id: 'c-a1', charpack: 'kuro', charpackPicked: '' },
    { id: 'c-a2', charpack: '../../etc/passwd', charpackPicked: 'kuro' },
    { id: 'c-a3', charpack: 'auto', charpackPicked: '   ' },
  ];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/convs')) {
      return { json: async () => ({ convs: convs.map((c, i) => ({ id: c.id, title: '', updatedAt: i + 1, count: 0 })), max: 8 }) };
    }
    const m = /[?&]s=([^&]+)/.exec(u);
    const id = m ? decodeURIComponent(m[1]) : '';
    const c = convs.find((x) => x.id === id) || {};
    return { json: async () => ({ id, title: '', msgs: [], llm: null, ...c }) };
  };
  try {
    const p = new AgentPanel({});
    await p.restore();
    const t1 = p.tabs.find((t) => t.id === 'c-a1');
    const t2 = p.tabs.find((t) => t.id === 'c-a2');
    const t3 = p.tabs.find((t) => t.id === 'c-a3');
    chk('存档里的包被读回来', t1 && t1.charpack === 'kuro', t1 && t1.charpack);
    chk('存档里的脏值收敛成 auto（不把 "../../etc/passwd" 带下去）',
      t2 && t2.charpack === 'auto', t2 && t2.charpack);
    chk('自动 + 挑过 → artId 用它', t2 && t2.artId() === 'kuro', t2 && t2.artId());
    chk('charpackPicked 是空白 → 当作没挑', t3 && t3.charpackPicked === '', JSON.stringify(t3 && t3.charpackPicked));
    stop(p);
  } finally { globalThis.fetch = realFetch; }
}

console.log('\n── 8. 新对话预填"按 + 时所在那个对话"的形象（跟配置同一条规矩：保存才生效）──');
{
  const p = new AgentPanel({});
  p.getPacks = () => PK;
  p.refreshArtOpts();
  p.tabs[0].charpack = 'kuro';
  p.tabs[0].charpackPicked = 'ponko';
  const made = p.newTab(true);                     // 用户点「+」
  chk('表单里预填的就是按 + 时看着的那个对话的设置',
    field(p, 'charpack').value === 'kuro', field(p, 'charpack').value);
  // 跟 LLM 配置同一条规矩：prefill 只灌进表单，**点了保存才算数**。
  // 所以新对话在保存前 artId() 是空的 → 主装配画默认包（它本来也还没接 LLM）。
  chk('保存前不算数（新对话仍是 auto）', made.charpack === 'auto', made.charpack);
  chk('保存前 artId() 为空 → 画默认包', made.artId() === '', JSON.stringify(made.artId()));
  chk('"模型挑的结果"不继承（新对话的模型会自己再挑）', made.charpackPicked === '', JSON.stringify(made.charpackPicked));
  chk('老对话没被改动', p.tabs[0].charpack === 'kuro' && p.tabs[0].charpackPicked === 'ponko', '');
  chk('当前语言仍是简中（测试没把语言带跑偏）', langOf() === 'zh-cn', langOf());
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
