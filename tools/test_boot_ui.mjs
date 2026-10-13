// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 启动画面回归（离线，注入假时钟，不用真等 1.7 秒也不用开浏览器）：
//   ① 生命周期：begin → replay/log → finish → 放完 → done（没放完绝不能 done）
//   ② 时间戳：屏上显示的就是真实 ts；打字只"截短"原文，绝不改字、绝不编字
//   ③ 节奏：真实间隔被夹进 [45,150]ms，整体再压进预算 —— 只压间隔，不动时间戳
//   ④ 版式：头部 / 分隔线 / 时钟列 / 标签列 / 正文列 / 底部进度条都在该在的位置
//   ⑤ 收尾：全部上屏 → 停顿 → **整屏同时淡出**（共用一个 alpha）→ 才进 HUD
// 跑法：node tools/test_boot_ui.mjs
import { BootScreen, clockOf } from '../app/src/boot.js';
import { mix } from '../app/src/grid.js';
import { useLang } from '../app/src/i18n/index.js';

// 1~7 节断言的句子锚定英文（语言包改了文案不该让版式测试红）；
// 第 8 节专门验"语言包决定启动画面语言"，那里自己切包。
useLang('en');

const results = [];
let failed = 0;
const chk = (name, ok, detail) => {
  results.push(name);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   → ' + detail}`);
};

function mkGrid(cols = 120, rows = 32) {
  const t = [];
  const s = [];
  const g = {
    cols, rows, texts: t, sets: s,
    // 与真 Grid 同名的三个淡出字段：淡出走的就是这条通道（见 grid.set）
    fade: 1, fadeBg: 0, fadeAll: false,
    fill() {},
    // 真 Grid 是 text → set，set 里按 fade/fadeAll 把前景（fadeAll 时连底色）往 fadeBg 混。
    // 这里照抄那条规则，淡出才测得出"颜色真的在往背景收、而且用的是同一个 alpha"。
    text(x, y, str, fg, bg) {
      let f2 = fg, b2 = bg;
      if (g.fade < 1) {
        const target = (bg != null && !g.fadeAll) ? bg : g.fadeBg;
        if (f2 != null) f2 = mix(f2, target, 1 - g.fade);
        if (g.fadeAll && b2 != null) b2 = mix(b2, g.fadeBg, 1 - g.fade);
      }
      t.push({ x, y, s: String(str), fg: f2, bg: b2 });
    },
    set(x, y, ch, fg, bg) { s.push({ x, y, ch, fg, bg }); },
    chWidth(ch) { return String(ch).charCodeAt(0) > 0x1100 ? 2 : 1; },
    strWidth(str) { let w = 0; for (const c of String(str)) w += c.charCodeAt(0) > 0x1100 ? 2 : 1; return w; },
  };
  return g;
}

// 假时钟：完全受测试控制，节奏断言才可复算
let NOW = 5000;
const now = () => NOW;
const step = (ms) => { NOW += ms; };

const T = {
  bg: 0x080c10, panel: 0x0c1218, line: 0x22343e, text: 0xcee2ea, dim: 0x688492,
  darker: 0x3c525e, accent: 0x48d6d0, ok: 0x58d68d, err: 0xf05858, warn: 0xf0be50,
};

console.log('── 1. clockOf：真实时间戳 → 屏上的时分秒毫秒 ──');
{
  const ts = new Date(2026, 9, 11, 22, 41, 3, 104).getTime();
  chk('格式是 HH:MM:SS.mmm', clockOf(ts) === '22:41:03.104', clockOf(ts));
  const ts2 = new Date(2026, 0, 2, 9, 5, 7, 8).getTime();
  chk('个位数的时/分/秒/毫秒都补零', clockOf(ts2) === '09:05:07.008', clockOf(ts2));
}

console.log('\n── 2. replay：按真实时间排、只传差异 ──');
{
  const g = mkGrid();
  const b = new BootScreen(g, { now });
  b.begin();
  const src = [
    { ts: 1000, tag: 'node', text: '第三行（乱序传进来）' },
    { ts: 900, tag: 'host', text: '第一行' },
    { ts: 950, tag: 'host', text: '第二行' },
  ];
  const added = b.replay({ t0: 900, elapsedMs: 380, lines: src });
  chk('返回新增行数', added === 3, String(added));
  chk('按真实时间重排（不是照传入顺序）',
    b.queue.map((l) => l.text).join('|') === '第一行|第二行|第三行（乱序传进来）',
    b.queue.map((l) => l.text).join('|'));
  chk('后端自检耗时取自快照', b.backendMs === 380, String(b.backendMs));
  chk('同一份快照再 replay 一次不会重复上屏', b.replay({ t0: 900, lines: src }) === 0, '');
  const t2 = { ts: 2000, tag: 'net', text: '第四行（后补的）' };
  chk('第二趟补进来的行也能进队列', b.replay({ lines: [t2] }) === 1, '');
  chk('后补的行按时间插在正确的相对位置',
    b.queue[b.queue.length - 1].text === t2.text, b.queue.map((l) => l.text).join('|'));
}

console.log('\n── 3. 节奏：按真实间隔分额度，总时长受预算约束 ──');
{
  const g = mkGrid();
  const b = new BootScreen(g, { now });
  b.begin();
  b.replay({ t0: 0, lines: [
    { ts: 0, tag: 'host', text: 'a' },
    { ts: 5000, tag: 'node', text: 'b' },      // 真实间隔 5s：真的等过，屏上就该停一下
    { ts: 5001, tag: 'node', text: 'c' },      // 真实间隔 1ms：几乎不停
  ] });
  const gaps = b.queue.map((l) => l.gap);
  chk('第一行立即上屏（间隔 0）', gaps[0] === 0, JSON.stringify(gaps));
  chk(`真的等了很久的那步有可感知的停顿（${gaps[1]}ms ≥ 35，但不超上限 260）`,
    gaps[1] >= 35 && gaps[1] <= 260, String(gaps[1]));
  chk('几乎同时发生的那步几乎不停（比例关系是对的）',
    gaps[2] < gaps[1], `${gaps[2]} vs ${gaps[1]}`);
  chk('时间戳原样保留（没被节奏改写）',
    b.queue.map((l) => l.ts).join(',') === '0,5000,5001', b.queue.map((l) => l.ts).join(','));
  chk('每行都记了打字时间（由真实文本长度算出来）',
    b.queue.every((l) => l.typeMs > 0), JSON.stringify(b.queue.map((l) => l.typeMs)));

  // 整段回放的总时长（打字 + 间隔）应当落在预算附近，不随行数爆炸
  let total = 0;
  for (const l of b.queue) total += l.typeMs + l.gap;
  chk(`3 行的整段时长 ≈ 预算（${Math.round(total)}ms ≤ ${b.budget + 200}）`,
    total <= b.budget + 200, String(Math.round(total)));
}
{
  const g = mkGrid();
  const b = new BootScreen(g, { now, budget: 600 });
  b.begin();
  const many = [];
  for (let i = 0; i < 40; i++) many.push({ ts: i * 300, tag: 'node', text: 'x' + i });
  b.replay({ t0: 0, lines: many });
  const dispSum = b.queue.reduce((a, l) => a + l.gap, 0);
  chk(`行数远超预算时把间隔压成 0（${dispSum} = 0，时间只花在打字上）`, dispSum === 0, String(dispSum));
  chk('每行的打字时间仍不被压没（屏上不会一帧闪完整屏）',
    b.queue.every((l) => l.typeMs >= 42), JSON.stringify(b.queue.slice(0, 3).map((l) => l.typeMs)));
}

console.log('\n── 4. 生命周期：没放完绝不 done ──');
{
  const g = mkGrid();
  const b = new BootScreen(g, { now, budget: 300 });
  b.begin();
  b.replay({ t0: 0, lines: [
    { ts: 0, tag: 'host', text: '一' }, { ts: 100, tag: 'node', text: '二' },
    { ts: 200, tag: 'pack', text: '三' },
  ] });
  b.log('ui', '页面自己的一步');
  chk('begin 之后 active=true、done=false', b.active === true && b.done === false, '');
  chk('finish() 不会立刻 done（日志还没放完）', b.finish() === false && b.done === false, '');
  let guard = 0;
  while (!b.done && guard++ < 2000) { step(16); b.advance(NOW); }
  chk('推进到位后 done=true（并在上限内收敛）', b.done === true && guard < 2000, String(guard));
  chk('done 之后 active=false（主循环不再走启动画面分支）', b.active === false, '');
  chk('所有行都上过屏（含页面自己的那行）', b.lines.length === 5, `${b.lines.length}`);
  chk('最后一屏是 READY 汇总', b.lines[b.lines.length - 1].tag === 'ready', b.lines[b.lines.length - 1].tag);
  chk('READY 里写了真实条数与后端耗时',
    /boot complete/.test(b.lines[b.lines.length - 1].text) && /backend self-check/.test(b.lines[b.lines.length - 1].text),
    b.lines[b.lines.length - 1].text);
  chk('live 行排在 server 行之后（按真实到达顺序）',
    b.lines.findIndex((l) => l.src === 'live') > 2, b.lines.map((l) => l.src).join(','));
}

console.log('\n── 5. 打字只截短、不编字 ──');
{
  const g = mkGrid();
  const b = new BootScreen(g, { now, cps: 10 });     // 慢速打字，好逐帧观察
  b.begin();
  b.replay({ t0: 0, lines: [
    { ts: 0, tag: 'host', text: '第一句完整的真实文本' },
    { ts: 100, tag: 'node', text: '第二句完整的真实文本' },
  ] });
  b.finish();
  const byClock = new Map();      // 时钟字符串 → 最近一次画出来的正文
  let bad = '';
  let guard = 0;
  while (!b.done && guard++ < 4000) {
    step(16); b.advance(NOW);
    g.texts.length = 0;
    b.draw(g, T);
    for (const op of g.texts) {
      if (op.y < 5 || op.x !== 17) continue;         // 只看正文列
      const clk = g.texts.find((o) => o.y === op.y && o.x === 0);
      if (!clk) continue;
      const key = clk.s;
      const prev = byClock.get(key);
      if (prev !== undefined && !op.s.startsWith(prev)) bad = `${key}: "${prev}" → "${op.s}"`;
      byClock.set(key, op.s);
    }
  }
  chk('每行都是原文的前缀、只会越来越长（没有字符被改写/跳变）', bad === '', bad);
  for (const l of b.lines) {
    if (l.tag === 'ready') continue;
    chk(`"${l.text.slice(0, 8)}…" 画出来的最终文本 = 原文`,
      byClock.get(clockOf(l.ts)) === l.text, `${byClock.get(clockOf(l.ts))} vs ${l.text}`);
  }
}

console.log('\n── 6. 版式：头部 / 分隔线 / 列位置 / 底部进度 ──');
{
  const g = mkGrid(120, 32);
  const b = new BootScreen(g, { now, cps: 1e6 });      // 打字瞬间完成，直接看排版
  b.begin();
  const ts = new Date(2026, 9, 11, 22, 41, 3, 104).getTime();
  b.replay({ t0: ts, lines: [{ ts, tag: 'host', text: '单实例互斥体已获取' }] });
  b.finish();
  while (b.lines.length < 2 && !b.done) { step(80); b.advance(NOW); }
  g.texts.length = 0;
  b.draw(g, T);
  const at = (x, y) => (g.texts.find((o) => o.x === x && o.y === y) || {}).s;
  const rowStr = (y) => g.texts.filter((o) => o.y === y).map((o) => o.s).join('');
  const titleOp = g.texts.find((o) => o.y === 1 && /PONKO-HUD/.test(o.s));
  chk('头部标题在第 1 行、水平居中（反色块）',
    !!titleOp && Math.abs((titleOp.x + titleOp.s.length / 2) - 120 / 2) <= 1
      && titleOp.fg === T.bg && titleOp.bg === T.accent,
    JSON.stringify(titleOp));
  chk('第 2 行是空的（顶上不再有"启动自检…"那句副标题）',
    !g.texts.some((o) => o.y === 2), JSON.stringify(g.texts.filter((o) => o.y === 2)));
  chk('整屏任何位置都不再出现"启动自检"字样',
    !g.texts.some((o) => /启动自检/.test(o.s)),
    JSON.stringify(g.texts.filter((o) => /启动自检/.test(o.s)).slice(0, 3)));
  chk('第 3 行是整幅分隔线', rowStr(3).startsWith('─') && rowStr(3).length === 120, String(rowStr(3).length));
  chk('日志从第 5 行开始', g.texts.some((o) => o.y === 5), JSON.stringify(g.texts.map((o) => o.y).slice(0, 6)));
  chk('第 5 行第 0 列是真实时间戳（HH:MM:SS.mmm）',
    at(0, 5) === '22:41:03.104', String(at(0, 5)));
  chk('标签画在第 13 列', at(13, 5) === 'host', String(at(13, 5)));
  chk('正文画在第 17 列，且是原文', at(17, 5) === '单实例互斥体已获取', String(at(17, 5)));
  chk('底部倒数第 2 行是分隔线', rowStr(30).startsWith('─'), rowStr(30).slice(0, 8));
  chk('底部最后一行有真实进度（分子/分母）',
    /progress/.test(rowStr(31)) && /\d+\/\d+/.test(rowStr(31)), rowStr(31).slice(0, 60));
  chk('进度里写了"多少行来自后端、多少行来自页面"',
    /from page/.test(rowStr(31)) && /from host/.test(rowStr(31)), rowStr(31).slice(0, 90));
}
{
  const g = mkGrid(120, 32);
  const b = new BootScreen(g, { now, cps: 1e6 });
  b.begin();
  b.log('unknown-tag', '未知标签也不崩');
  while (!b.done) {
    step(60);
    if (!b.pendingDone) b.finish();
    b.advance(NOW);
  }
  chk('未知 tag 不会崩，也能上屏', b.lines.some((l) => l.text === '未知标签也不崩'), '');
}

{
  const g = mkGrid(120, 32);
  const b = new BootScreen(g, { now, cps: 1e6 });
  b.begin();
  b.replay({ t0: 0, lines: [{ ts: 0, tag: 'host', text: '一' }, { ts: 100, tag: 'node', text: '二' }] });
  b.log('ui', '页面的一行');
  b.finish();
  b.forceDone();
  chk('forceDone()：一次性把剩下的行全摆上屏（不丢信息）',
    b.lines.length === 4 && b.lines.every((l) => l.reveal === l.text.length) && b.queue.length === 0,
    `lines=${b.lines.length} queue=${b.queue.length}`);
  chk('forceDone() 之后 done=true、active=false（主循环立刻接手画 HUD）',
    b.done === true && b.active === false, '');
  chk('forceDone() 走的是"立刻收工"这条路，不摆淡出（兜底不能还让人等）',
    b.fading === false && b.alpha(NOW) === 1, `${b.fading}/${b.alpha(NOW)}`);
}

console.log('\n── 7. 收尾：全部上屏 → 停顿 → 整屏同时淡出 → 才进 HUD ──');
{
  const g = mkGrid(120, 32);
  const FADE = 340;
  const b = new BootScreen(g, { now, cps: 1e6, budget: 200, fadeMs: FADE });
  b.begin();
  const ts = new Date(2026, 9, 12, 0, 5, 7, 8).getTime();
  b.replay({ t0: ts, lines: [
    { ts, tag: 'host', text: '第一行真日志' },
    { ts: ts + 20, tag: 'node', text: '第二行真日志' },
  ] });
  b.finish();

  // ① 推到"所有行都上屏"，但还没到 done：这段就是停顿（HOLD）
  let guard = 0;
  while ((b.cur || b.queue.length) && guard++ < 500) { step(16); b.advance(NOW); }
  chk('全部上屏那一刻还没 done（后面还有停顿 + 淡出）',
    b.done === false && b.active === true, `${b.done}/${b.active}`);
  chk('停顿期间 alpha 恒为 1（这一屏是完整可见的）', b.alpha(NOW) === 1, String(b.alpha(NOW)));

  // ② 推进到淡出开始：先停 HOLD_MS，然后 fading 变 true —— 但**还不是 done**
  const tAllOn = NOW;
  while (!b.fading && guard++ < 500) { step(16); b.advance(NOW); }
  const fadeStart = NOW;
  chk('全部上屏后先停顿再淡出（不是一闪就没）', fadeStart - tAllOn >= 300, `${fadeStart - tAllOn}ms`);
  chk('淡出已经开始，但此时仍不算 done（HUD 还不能上）',
    b.fading === true && b.done === false && b.active === true, `${b.fading}/${b.done}/${b.active}`);

  // ③ 逐帧采样淡出过程：alpha 单调下降；标题块底色与正文前景用的是**同一个** alpha
  const alphas = [];
  const dual = [];
  let textIntact = '';
  while (b.fading && guard++ < 500) {
    step(16);
    b.advance(NOW);
    if (!b.fading) break;                 // 这一帧已经收工，不再采（收工后画面交给 HUD）
    const a = b.alpha(NOW);
    alphas.push(a);
    g.texts.length = 0;
    b.draw(g, T, NOW);
    const header = g.texts.find((o) => o.y === 1 && /PONKO-HUD/.test(o.s));       // 反色标题块
    const body = g.texts.find((o) => o.y === 5 && o.x === 17);                    // 正文列
    const clk = g.texts.find((o) => o.y === 5 && o.x === 0);                      // 时间戳列
    if (header && body && clk) {
      dual.push({
        a,
        hb: header.bg === mix(T.accent, T.bg, 1 - a),      // 底色跟着淡（fadeAll）
        bf: body.fg === mix(T.text, T.bg, 1 - a),          // 正文前景跟着淡
        same: header.bg === mix(T.accent, T.bg, 1 - a) && body.fg === mix(T.text, T.bg, 1 - a),
        chars: body.s === '第一行真日志' && clk.s === clockOf(ts),
      });
    }
    if (body && clk && body.s + '|' + clk.s !== '第一行真日志|' + clockOf(ts)) {
      textIntact = `${body.s}|${clk.s}`;
    }
  }
  chk(`淡出期间 alpha 严格下降（${alphas.length} 帧，采样到 1 以下、0 以上）`,
    alphas.length >= 5 && alphas.every((v, i) => i === 0 || v < alphas[i - 1])
      && alphas[0] < 1 && alphas[alphas.length - 1] > 0,
    JSON.stringify(alphas.map((v) => +v.toFixed(2))));
  chk('所有元素同时淡：标题块底色与正文前景都用同一个 alpha（逐帧等于 mix(原色, 背景, 1-α)）',
    dual.length >= 5 && dual.every((d) => d.same),
    JSON.stringify(dual.find((d) => !d.same) || dual.slice(0, 2)));
  chk('淡出只改颜色、不改字（正文与时间戳逐帧逐字不变）', textIntact === '', textIntact);

  // ④ 淡出正好花 FADE_MS，之后才 done；且 grid 上的淡出开关必须复位，别漏给 HUD
  chk(`淡出时长 ≈ ${FADE}ms（不拖成一秒，也不一闪而过）`,
    NOW - fadeStart >= FADE && NOW - fadeStart < FADE + 40, `${NOW - fadeStart}ms`);
  chk('淡出结束才 done/active=false（HUD 的进场动画从这一刻开始）',
    b.done === true && b.active === false && b.fading === false, `${b.done}/${b.active}/${b.fading}`);
  chk('淡到几乎看不见才交给 HUD（淡出的最后一帧 alpha ≤ 0.12）',
    alphas[alphas.length - 1] <= 0.12, String(alphas[alphas.length - 1]));
  chk('收工之后 alpha() 回到 1（它只管启动画面自己：那会儿已经在画 HUD 了）',
    b.alpha(NOW) === 1, String(b.alpha(NOW)));
  chk('grid 的淡出开关复位（fade=1 / fadeAll=false，不会把 HUD 也压暗）',
    g.fade === 1 && g.fadeAll === false, `${g.fade}/${g.fadeAll}`);
}

console.log('\n── 8. 启动画面（含日志行）跟着语言包走 ──');
{
  const ts = new Date(2026, 9, 13, 0, 40, 0, 0).getTime();
  // 宿主/后端写进 boot.log 的是「事件 id + 参数」，不是句子；句子在这一步才生成
  const raw = [
    { ts, tag: 'host', key: 'boot.host.mutex', args: { id: 'Ponko-HUD.Desktop' } },
    { ts: ts + 10, tag: 'sys', key: 'boot.sys.host', args: {
      platform: 'win32 10', arch: 'x64', host: 'PC', user: 'u', cpu: 'X', cores: 4, mem: '8',
      disk: { key: 'boot.sys.diskUsed', args: { used: '40', total: '100', pct: '41' } }, gpu: '',
    } },
  ];

  useLang('en');
  const g1 = mkGrid(120, 32);
  const b1 = new BootScreen(g1, { now, cps: 1e6 });
  b1.begin();
  b1.replay({ t0: ts, lines: raw });
  chk('英文包：事件 id 渲染成英文句子',
    b1.queue[0].text === 'single-instance mutex Ponko-HUD.Desktop.Mutex acquired', b1.queue[0].text);
  chk('嵌套片段（disk）也一起渲染，不留 {占位符}',
    !/\{\w+\}/.test(b1.queue[1].text) && /disk 40\/100GB 41%/.test(b1.queue[1].text), b1.queue[1].text);

  useLang('zh-cn');
  const g2 = mkGrid(120, 32);
  const b2 = new BootScreen(g2, { now, cps: 1e6 });
  b2.begin();
  b2.replay({ t0: ts, lines: raw });
  chk('简中包：同一条 id 渲染成中文（语言包说了算）',
    b2.queue[0].text === '单实例互斥体 Ponko-HUD.Desktop.Mutex 已获取', b2.queue[0].text);
  chk('简中下嵌套片段也是中文',
    /系统盘 40\/100GB 41%/.test(b2.queue[1].text), b2.queue[1].text);
  b2.finish();
  while (b2.lines.length < 3 && !b2.done) { step(80); b2.advance(NOW); }
  g2.texts.length = 0;
  b2.draw(g2, T);
  const row = g2.texts.filter((o) => o.y === 31).map((o) => o.s).join('');
  chk('简中下底部进度也是中文（进度 / 来自 host/node / 来自页面）',
    /进度/.test(row) && /来自/.test(row), row.slice(0, 70));
  chk('简中下收尾行是中文', /启动完成/.test(b2.lines[b2.lines.length - 1].text),
    b2.lines[b2.lines.length - 1].text);

  // 中文一行 2 列：正文按**列**截断，不能切到框外
  const g3 = mkGrid(60, 32);
  const b3 = new BootScreen(g3, { now, cps: 1e6 });
  b3.begin();
  b3.replay({ t0: ts, lines: [{
    ts, tag: 'node', key: 'boot.llm.off', args: {},
  }] });
  while (b3.lines.length < 1) { step(80); b3.advance(NOW); }
  g3.texts.length = 0;
  b3.draw(g3, T);
  const body = g3.texts.filter((o) => o.y === 5 && o.x === 17).map((o) => o.s).join('');
  chk('60 列的窄框里，中文正文按列截断（宽度 ≤ 可用列数）',
    !!body && g3.strWidth(body) <= 60 - 17, `${g3.strWidth(body)} 列 / 可用 ${60 - 17}：${body}`);

  useLang('en');      // 复位，别把语言状态漏给别的测试
}

console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
