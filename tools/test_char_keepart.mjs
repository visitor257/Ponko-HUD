// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 回归：换形象时的**时序**（2026-10-15 用户反馈"第一次显示都会卡一下"）
//
// 用户要的顺序：
//   已显示 > 切换形象（旧形态**不退场**，继续显示）> 加载 > 旧形态退出并且显示新形象
// 现在的实现是三段式：
//   ① 新图还在路上（首次 fetch + 解码）        → 保持旧快照，照画旧的
//   ② 图到了、点阵还没采样（首次要遍历上万块）  → 帧外预热，本帧仍不切
//   ③ 都齐了                                    → 一次 drawImage 换过去
// 这个文件用真的 CharPack + 假 Image + 假网格把这三段钉死（不连后端、不起浏览器）。
//
// 顺带守住两件界面上的事：面板标题 = 形象名（左上），**不再标画法**（右上那行已按用户要求删掉）。
import { CharPack } from '../app/src/charpack.js';
import { CharPanel } from '../app/src/panels/char.js';
import { Mood } from '../app/src/mood.js';
import { dotsKey } from '../app/src/dots.js';
import { readFileSync, readdirSync } from 'node:fs';

let fail = 0;
const chk = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   → ' + got}`);
  if (!ok) fail++;
};

// ── 假 Image：谁被造出来、什么时候"到货"（onload）全由测试说了算 ────────────────
const IMGS = [];
globalThis.Image = class FakeImage {
  constructor() { this._src = ''; this.width = 0; this.height = 0; this.onload = null; this.onerror = null; IMGS.push(this); }
  get src() { return this._src; }
  set src(v) { this._src = v; }
  get currentSrc() { return this._src; }
};
const pendingImgs = (url) => IMGS.filter((i) => i.src === url && !i.width);
const deliver = (url) => {                 // 模拟"这张图加载完了"
  const im = pendingImgs(url)[0];
  if (!im) return false;
  im.width = 534; im.height = 630;         // 真素材的尺寸
  if (im.onload) im.onload();
  return true;
};

// ── 假网格：只记图片层 + 记录预热调用（点阵缓存那条线用真的 dotsKey 算 key）──────
function mkGrid() {
  const g = {
    cellW: 9, cellH: 18, dpr: 1,
    images: [], warmCalls: [], texts: [],
    box() {}, set() {}, fill() {}, inBounds: () => true,
    text(x, y, s) { g.texts.push(String(s)); return x + String(s).length; },
    strWidth: (s) => [...String(s)].length,
    img(x, y, w, h, image, opts) { g.images.push({ x, y, w, h, image, opts }); },
    artKey(w, h, image, opts) {
      return dotsKey(image, w * g.cellW, h * g.cellH, { pitch: opts.pitch, sat: opts.sat, dpr: g.dpr });
    },
    warmImg(w, h, image, opts) { g.warmCalls.push({ w, h, image }); return g.artKey(w, h, image, opts); },
  };
  return g;
}
const TH = { bg: 0, panel: 1, accent: 2, accentDim: 3, line: 4, dim: 5, moodName: 6, err: 7, warn: 8, ok: 9 };
const C = { theme: TH, t: 0 };
const RECT = { x: 0, y: 0, w: 30, h: 31 };
const tick = () => new Promise((r) => setTimeout(r, 8));   // 让 _warm 安排的 setTimeout(0) 跑掉

const mood = {
  frameTag: () => 'idle', key: 'idle', value: 50, history: [40, 45, 50],
  source: 'local', sourceTag: 'local', face: '', faceOk: () => true, note: '',
};
const meta = (id, tags) => ({
  id, name: id,
  grid: { cols: 48, rows: 28, charset: 'block' },
  base: `/characters/${id}/frames/`,
  artBase: `/characters/${id}/src/`,
  art: Object.fromEntries(tags.map((t) => [t, `${t}.png`])),
  moods: Object.fromEntries(tags.map((t) => [t, { frames: `${t}.json` }])),
});
const drawOnce = (panel, g) => { g.images.length = 0; g.texts.length = 0; panel.draw(g, C); };
/** 画两帧、中间让 _warm 安排的 setTimeout(0) 跑掉 —— 预热要跨一帧才生效，这是设计如此 */
const settle = async (panel, g) => { drawOnce(panel, g); await tick(); drawOnce(panel, g); };

console.log('── ① 首次显示：图 + 点阵都齐了才上屏 ──');
{
  IMGS.length = 0;
  const A = new CharPack(meta('A', ['idle']));
  const panel = new CharPanel(mood, A);
  panel.layout(RECT);
  const g = mkGrid();                       // 真实 app 里 render 之前一定先 layout，这里照做

  chk('构造时就铺开包内立绘（省一次首次请求等待）', pendingImgs('/characters/A/src/idle.png').length === 1,
    IMGS.map((i) => i.src).join(','));

  drawOnce(panel, g);
  chk('图还没到 → 什么都没上屏（不是先糊一版字符画再替换）',
    panel.art === null && g.images.length === 0, JSON.stringify(panel.art));
  chk('这时候屏上是 loading…（面板本来就这样）', g.texts.some((s) => /loading/.test(s)), g.texts.join('|'));

  deliver('/characters/A/src/idle.png');
  drawOnce(panel, g);
  chk('图到了但点阵没备好 → 仍然不上屏，先安排预热',
    panel.art === null && panel._warmQ.size === 1,
    `art=${JSON.stringify(panel.art)} queued=${panel._warmQ.size}`);

  await tick();
  drawOnce(panel, g);
  chk('预热完成 → 换上', panel.art && panel.art.key === 'art:A:idle', JSON.stringify(panel.art && panel.art.key));
  chk('上屏的就是这张图', g.images.length === 1 && g.images[0].image.width === 534, g.images.length);
  chk('点阵参数带上了（dots + pitch 2 + 降饱和）',
    !!(g.images[0].opts.dots && g.images[0].opts.pitch === 2 && g.images[0].opts.sat > 0),
    JSON.stringify(g.images[0].opts));
  chk('预热真的按立绘区尺寸算了一次（iw x ART_ROWS 个格子）',
    g.warmCalls.length === 1 && g.warmCalls[0].w === 28 && g.warmCalls[0].h === 19,
    JSON.stringify(g.warmCalls.map((c) => [c.w, c.h])));
  await settle(panel, g);
  chk('之后的帧不再重复预热（命中就绪状态）', g.warmCalls.length === 1, g.warmCalls.length);

  console.log('\n── ② 切形象：新图还没到 → 旧的继续显示（核心）──');
  const B = new CharPack(meta('B', ['idle']));
  const before = panel.art;
  chk('setPack 返回 true（确实换包了）', panel.setPack(B) === true, '');
  chk('**旧快照没被清掉**（这就是"不退场"）', panel.art === before, JSON.stringify(panel.art && panel.art.key));
  chk('新包的立绘立刻开始加载（不等下一帧）', pendingImgs('/characters/B/src/idle.png').length === 1, '');

  drawOnce(panel, g);
  chk('新图在路上 → 这一帧画的还是旧形象',
    panel.art === before && g.images.length === 1 && g.images[0].image === before.image,
    JSON.stringify(panel.art && panel.art.key));
  drawOnce(panel, g);
  chk('再来两帧也一样（不会闪空白）', panel.art === before && g.images.length === 1, '');

  console.log('\n── ③ 新图到了、点阵还在算 → 再等一帧 ──');
  deliver('/characters/B/src/idle.png');
  drawOnce(panel, g);
  chk('图到 ≠ 可以切（点阵还没算）', panel.art === before, JSON.stringify(panel.art && panel.art.key));
  await tick();
  drawOnce(panel, g);
  chk('预热完 → 这才换过去', panel.art && panel.art.key === 'art:B:idle', JSON.stringify(panel.art && panel.art.key));
  chk('换过去的是 B 的图，不是 A 的', panel.art.image !== before.image, '');

  console.log('\n── ④ 切回已就绪的形象 → 当帧就换，不再等 ──');
  panel.setPack(A);
  drawOnce(panel, g);
  chk('A 的图与点阵都在缓存里 → 一帧到位', panel.art && panel.art.key === 'art:A:idle',
    JSON.stringify(panel.art && panel.art.key));

  console.log('\n── ⑤ 没有包了 → 快照清掉（否则会一直画着一个不该存在的形象）──');
  panel.setPack(null);
  chk('pack = null → art 一并清空', panel.art === null, JSON.stringify(panel.art && panel.art.key));
}

console.log('\n── ⑥ 只有字符帧的包（回退路径）也守同一条时序 ──');
{
  IMGS.length = 0;
  const frames = { cols: 6, rows: 3, cells: Array.from({ length: 3 }, () => Array.from({ length: 6 }, () => [[9, 9, 9], [1, 2, 3]])) };
  let release = null;
  const D = {
    id: 'D', name: 'D', base: '/characters/D/frames/', artBase: '', art: {}, moods: { idle: { frames: 'idle.json' } },
    tags: () => ['idle'], hasArt: () => false, artFailed: () => false, artImage: () => null,
    tagFor: () => 'idle', preloadArt() {},
    frame: () => new Promise((res) => { release = () => res(frames); }),
  };
  const A = new CharPack(meta('A', ['idle']));
  const panel = new CharPanel(mood, A);
  panel.layout(RECT);
  const g = mkGrid();

  deliver('/characters/A/src/idle.png');
  await settle(panel, g);
  const artSnap = panel.art;
  chk('先立住一个高清形象', artSnap && artSnap.kind === 'art', JSON.stringify(artSnap && artSnap.key));

  panel.setPack(D);
  drawOnce(panel, g);
  chk('换成无高清图的包 → 旧形象仍不退场', panel.art === artSnap, JSON.stringify(panel.art && panel.art.key));

  const p = panel.ensureFrame(28, 0);      // 真实链路：main.js 在 draw 之后叫它
  drawOnce(panel, g);
  chk('字符帧还在路上 → 依旧画旧的', panel.art === artSnap && g.images.length === 1, '');
  release();
  await p;
  drawOnce(panel, g);
  chk('帧到了 → 换成字符画（kind=frame）',
    panel.art && panel.art.kind === 'frame' && panel.art.key === 'frame:D:idle',
    JSON.stringify(panel.art && panel.art.key));
  chk('这一帧不再登记图片层（走的是字符格）', g.images.length === 0, g.images.length);
}

console.log('\n── ⑦ 标题：左上 = 形象名，右上不再标画法 ──');
{
  const A = new CharPack({ ...meta('ponko', ['idle']), name: 'Ponko 酱' });
  const panel = new CharPanel(mood, A);
  chk('标题取的是包名', panel.title() === 'PONKO 酱', panel.title());
  const B = new CharPack({ ...meta('nomad', ['idle']), name: '' });
  chk('包没写名 → 退回 id', new CharPanel(mood, B).title() === 'NOMAD', new CharPanel(mood, B).title());
  chk('没有包 → 兜底 CHAR', new CharPanel(mood, null).title() === 'CHAR', '');

  const src = readFileSync(new URL('../app/src/panels/char.js', import.meta.url), 'utf8');
  chk('char.js 不再引用 ui.char.style*', !/ui\.char\.style/.test(src), '');
  chk('char.js 只给 g.box 传 8 个参数（没有右侧那段文字）',
    /g\.box\(r\.x, r\.y, r\.w, r\.h, T\.accent, T\.panel, this\.title\(\), T\.accent\)/.test(src), '');
  for (const f of ['zh-cn', 'en', 'ja', 'ru', 'tlh']) {
    const dict = readFileSync(new URL(`../app/src/i18n/${f}.js`, import.meta.url), 'utf8');
    // 只扫"键定义"，别把解释这件事的注释也当成漏网的（注释里确实提到了这组 key 的名字）
    chk(`${f}.js 里那组 key 也已删干净`, !/['"]ui\.char\.style['":]/.test(dict), '');
  }
}

console.log('\n── ⑧ "直接贴原图"模式（?art=photo）没有点阵这道工序 → 图到即切 ──');
{
  IMGS.length = 0;
  const A = new CharPack(meta('A', ['idle']));
  const panel = new CharPanel(mood, A);
  panel.layout(RECT);
  const g = mkGrid();
  const im = { width: 534, height: 630, currentSrc: '/x.png', src: '/x.png' };
  chk('opts 不带 dots → _warm 直接放行（不安排预热）', panel._warm(g, im, 28, { sat: 0.9 }) === true, '');
  chk('放行时没有产生任何预热调用', g.warmCalls.length === 0, g.warmCalls.length);
}

console.log('\n── ⑨ 手动覆盖是**调试功能**：入口/说明不上屏，那行只报 角色名·id ──');
// 用户 2026-10-17 三轮澄清：
//   ① 「我是让你把这个调试功能隐藏了，不是只隐藏字样」→ 藏那排**可点的标签**（入口）
//   ② 「手动覆盖的字样怎么又出现了」→ 我上一轮只藏了入口，把 2026-10-15 藏过的那行字放回来了
//   ③ 「为什么是手动·生气？手动是什么？」→ 来源行也在暴露调试态；随后「算了，那行改成 TAG·<mood_id>」
// 所以这里是**三件事**：入口不画 + 那行说明不写 + 来源行只报 TAG·id。能力（force/^M/?mood=）一条没删。
{
  const A = new CharPack(meta('ponko', ['idle', 'thinking', 'angry']));
  const panel = new CharPanel(mood, A);
  panel.layout(RECT);

  const g1 = mkGrid();
  panel.mood = { ...mood, state: 'idle', key: 'idle', noteKey: '', note: '炸了' };
  drawOnce(panel, g1);
  const row = g1.texts.join('\u0001');
  // 只有**别的**心情的名字才可能出现在那排标签里（当前这个心情的名字本来就该在标题里）。
  // 所以这里查 thinking / angry 有没有上屏 —— 它们不上屏就说明那排标签没画。
  chk('① 入口：那排可点的心情标签不画（别的标签一个都不上屏）',
    !row.includes('thinking') && !row.includes('angry'), JSON.stringify(g1.texts));
  chk('于是命中区也是空的（不许"看不见但点得着"）',
    Array.isArray(panel._chips) && panel._chips.length === 0, JSON.stringify(panel._chips));
  chk('chipAt 一律落空', panel.chipAt(panel.rect.x + 2, panel.rect.y + 20) === null, '');
  chk('agent 自己给的 note 照常显示', g1.texts.includes('炸了'), JSON.stringify(g1.texts));

  // ② 那行「手动覆盖（调试）」：noteKey 命中静音名单就不写（不是把字符串清空，是整条跳过）
  const g2 = mkGrid();
  panel.mood = { ...mood, source: 'manual', sourceTag: '手动', noteKey: 'ui.mood.manualOverride', note: '手动覆盖（调试）' };
  drawOnce(panel, g2);
  chk('② 说明：那句「手动覆盖（调试）」不上屏',
    !g2.texts.some((s) => s.includes('手动覆盖')), JSON.stringify(g2.texts));

  // ③ 那行（原来写「来源 · 脸名」）现在是 `<角色名> · <心情 id>`，如 `ponko · idle`
  //    —— 用户 2026-10-17：「改成<角色名>·<mood_id>」。
  chk('③ 那行是「<角色名> · <心情 id>」，且不含任何"手动"字样',
    g2.texts.includes('ponko · idle') && !g2.texts.some((s) => s.includes('手动')), JSON.stringify(g2.texts));

  // 而且**不看来源**：agent / 本地 / 手动，这行都长一样（来源不再上屏）
  for (const src of ['agent', 'auto', 'manual']) {
    const gg = mkGrid();
    panel.mood = { ...mood, source: src, sourceTag: src === 'agent' ? 'AGENT' : '本地兜底', key: 'idle' };
    drawOnce(panel, gg);
    chk(`④ 来源=${src} 时这行仍是「ponko · idle」（不写来源）`,
      gg.texts.includes('ponko · idle') && !gg.texts.some((s) => s.includes('AGENT') || s.includes('本地兜底')),
      JSON.stringify(gg.texts));
  }

  // 角色名是用户自定义的、可能很长 —— 超宽要退回只报 id，别把字画到隔壁面板去
  const gLong = mkGrid();
  const LongPack = new CharPack(meta('a-very-long-character-pack-name', ['idle']));
  const panelLong = new CharPanel(mood, LongPack);
  panelLong.layout(RECT);
  panelLong.mood = { ...mood, key: 'idle', state: 'idle' };
  drawOnce(panelLong, gLong);
  chk('⑤ 角色名太长时只报 id（不溢出面板）',
    !gLong.texts.some((s) => s.includes('a-very-long-character-pack-name')), JSON.stringify(gLong.texts));

  // 别的说明是**有用的状态提示**，不能被一起静音
  const g3 = mkGrid();
  panel.mood = { ...mood, noteKey: 'ui.mood.waiting', note: '等待 agent 接管' };
  drawOnce(panel, g3);
  chk('别的状态说明照常显示（只静音这一条）',
    g3.texts.includes('等待 agent 接管'), JSON.stringify(g3.texts));

  // 能力还在
  const m2 = new Mood();
  m2.force('angry');
  chk('能力没删：force() 仍能锁定心情', m2.key === 'angry' && m2.source === 'manual', String(m2.key));

  const src = readFileSync(new URL('../app/src/panels/char.js', import.meta.url), 'utf8');
  chk('界面那两处的开关都是显式常量、默认关',
    /const SHOW_MOOD_CHIPS = false;/.test(src) && /const MUTE_NOTES = new Set\(\['ui\.mood\.manualOverride'\]\)/.test(src), '');
  chk('③ 那行换成了「<角色名> · <心情 id>」（不是靠开关藏起来，是真的换掉了）',
    /\$\{who\} · \$\{m\.key\}/.test(src), '');
  chk('③a 而且这行里不再拼 sourceTag（来源彻底不上屏）',
    !/ctr\([^)]*sourceTag/.test(src), '');

  // 触发器本身也要收起来：Ctrl+M 在终端里就是回车，误触会**静默**改掉心情
  const mainSrc = readFileSync(new URL('../app/src/main.js', import.meta.url), 'utf8');
  chk('③b 触发键 Ctrl+M 默认关（是个显式常量，不是散在判断里的魔法值）',
    /const MOOD_DEBUG_KEY = false;/.test(mainSrc), '');
  chk('③c 而且真的挂在判断里（不是声明了没人用）', /MOOD_DEBUG_KEY && e\.ctrlKey/.test(mainSrc), '');
  chk('但 ?mood= 这种"得手改 URL 才用得上"的入口保留（能力没删）',
    /q\.get\('mood'\)/.test(mainSrc), '');
  for (const f of ['zh-cn', 'en', 'ja', 'ru', 'tlh']) {
    const dict = readFileSync(new URL(`../app/src/i18n/${f}.js`, import.meta.url), 'utf8');
    chk(`${f}.js 的 ui.mood.manualOverride 词条保留（只是不上屏，不是删掉）`,
      /['"]ui\.mood\.manualOverride['"]/.test(dict), '');
  }
}

console.log('\n── ⑨b 「情绪历史」整条下线（2026-10-17 用户："情绪历史不需要"）──');
{
  const A = new CharPack(meta('ponko', ['idle']));
  const panel = new CharPanel(mood, A);
  panel.layout(RECT);
  const g = mkGrid();
  // 刻意给一份有历史的 mood：没删干净的话那根 sparkline 会画出来（▁▄▇ 那种块字符）
  panel.mood = { ...mood, history: [10, 30, 50, 70, 90], value: 70 };
  drawOnce(panel, g);
  chk('面板上不再写「情绪历史」', !g.texts.includes('情绪历史'), JSON.stringify(g.texts));
  // 只看**曲线**用的那组块字符（U+2581..2587）。别把 █/░ 也算进来 ——
  // 那是心情条自己的刻度（▐██░░▌），它本来就该在。
  chk('也不再画那根曲线（没有任何曲线专用块字符上屏）',
    !g.texts.some((s) => /[\u2581-\u2587]/.test(s)), JSON.stringify(g.texts));

  // ⚠ 判据要绕开注释：我在 char.js 里留了一句提到 "sparkline" 的注释，
  //   直接 /sparkline/ 会把它也算上（第一次就是这么假红的）。只查真的 import 与调用。
  const charSrc = readFileSync(new URL('../app/src/panels/char.js', import.meta.url), 'utf8');
  chk('char.js 里不再 import / 调用 sparkline（注释里提一句不算）',
    !/import\s*\{[^}]*\bsparkline\b/.test(charSrc) && !/\bsparkline\s*\(/.test(charSrc), '');
  const moodSrc = readFileSync(new URL('../app/src/mood.js', import.meta.url), 'utf8');
  chk('mood.js 里的 history 环形缓冲一起删了（别只删消费端）',
    !/this\.history/.test(moodSrc), '');
  // sparkline 本身留着 —— SHELL/SYS 面板的 CPU 曲线还在用它
  const sysSrc = readFileSync(new URL('../app/src/panels/sys.js', import.meta.url), 'utf8');
  chk('sparkline 仍然导出（SYS 面板的 CPU 曲线还在用）',
    /export function sparkline/.test(sysSrc), '');
  for (const f of ['zh-cn', 'en', 'ja', 'ru', 'tlh']) {
    const dict = readFileSync(new URL(`../app/src/i18n/${f}.js`, import.meta.url), 'utf8');
    // 同上：查"定义"（后面跟冒号），不是查全文 —— 我留的说明注释里也写了这个 key 名
    chk(`${f}.js 的 ui.char.history 已删`, !/['"]ui\.char\.history['"]\s*:/.test(dict), '');
  }
}

console.log('\n── ⑩ 心情的名字来自角色包（不是语言包），缺了就落英文 ──');
{
  // 面板顶上那行 = 心情名。名字在 pack.json 的 moods.<标签>.label 里，不在 i18n 里。
  const withLabels = (id, moods) => new CharPack({
    id, name: id, grid: { cols: 48, rows: 28, charset: 'block' },
    base: `/characters/${id}/frames/`, artBase: `/characters/${id}/src/`,
    art: Object.fromEntries(Object.keys(moods).map((t) => [t, `${t}.png`])),
    moods,
  });
  const L = withLabels('L', {
    idle: { frames: 'idle.json', label: { en: 'idle', 'zh-cn': '待机' } },
    thinking: { frames: 'thinking.json', label: { en: 'thinking' } },   // 只有英文（必填那份）
  });

  // 默认语言是 zh-cn（i18n/index.js 的 DEFAULT_LANG），本文件没有切过语言
  const p1 = new CharPanel({ ...mood, state: 'idle', key: 'idle', frameTag: () => 'idle' }, L);
  p1.layout(RECT);
  const g1 = mkGrid();
  drawOnce(p1, g1);
  chk('标题用的是包里那份中文名', g1.texts.includes('待机'), JSON.stringify(g1.texts));

  const p2 = new CharPanel({ ...mood, state: 'think', key: 'think', frameTag: () => 'thinking' }, L);
  p2.layout(RECT);
  const g2 = mkGrid();
  drawOnce(p2, g2);
  chk('该语言没翻 → 标题落英文', g2.texts.includes('thinking'), JSON.stringify(g2.texts));

  // 真素材包：每个标签都得有英文名 —— 它是整条回退链的终点，漏了就把 id 亮在屏幕上
  const charsDir = new URL('../characters/', import.meta.url);
  const dirs = readdirSync(charsDir).filter((d) => !d.startsWith('_'));
  chk('扫到真素材包（守卫本身有效）', dirs.length > 0, dirs.join(','));
  for (const d of dirs) {
    let j = null;
    try { j = JSON.parse(readFileSync(new URL(`${d}/frames/pack.json`, charsDir), 'utf8')); } catch (e) { /* 没有 pack.json 的目录跳过 */ }
    if (!j) continue;
    const bad = Object.entries(j.moods || {})
      .filter(([, v]) => !(v && v.label && String(v.label.en || '').trim()))
      .map(([k]) => k);
    chk(`${d}: 每个心情都写了英文名（必填项）`, bad.length === 0, bad.join(','));
  }

  // 语言可以**不翻**（用户 2026-10-17：「日文不需要翻译，我要用日文来测试默认显示」）——
  // 但要保证不翻的那个语言下每个标签照样解得出名字（落到英文），不会把 id 亮在屏幕上。
  // 这条不钉"日文必须缺席"（那是内容选择，随时可加），只钉"缺席了也不难看"这个性质。
  for (const d of dirs) {
    let j = null;
    try { j = JSON.parse(readFileSync(new URL(`${d}/frames/pack.json`, charsDir), 'utf8')); } catch (e) { /* 同上 */ }
    if (!j) continue;
    const P = withLabels(d, j.moods);
    for (const lang of ['zh-cn', 'en', 'ja', 'ru', 'tlh']) {
      const naked = P.tags().filter((t) => {
        const lab = (j.moods[t] || {}).label || {};
        const want = lab[lang] || lab.en || t;
        return !want || P.labelOf(t, lang) !== want;
      });
      chk(`${d} @ ${lang}：${P.tags().length} 个标签都解得出名字`, naked.length === 0, naked.join(','));
    }
  }
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
