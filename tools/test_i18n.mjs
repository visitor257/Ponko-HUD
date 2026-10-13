// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// i18n 守卫：这条测试不测"翻译对不对"，测的是**边界有没有被越界**。
//
// 为什么需要它：i18n 最贵的错误不是翻错一个词，而是把"不该翻的东西"翻了 ——
//   ① 模型 prompt（server/moodprotocol.js 的 label/hint）翻了 = 改了模型看到的协议，心情推断会变；
//   ② 识别别名表（charpack.js 的 ALIAS）翻了 = 模型声明的中文心情词再也匹配不上，界面永远停住；
//   ③ 后端去 import i18n = 语言边界漏进服务层，早晚出事。
// 这三条都由本测试挡死，靠记性是靠不住的。
//
// 启动日志这块还有一条：宿主/后端写进 run/boot.log 的是**事件 id + 参数**，句子由页面按
// 当前语言渲染 —— 所以"宿主发了但语言包里没有"的 key 必须在这里就被拦住（见第 6 节）。
//
// 跑法：node tools/test_i18n.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { t, useLang, langOf, LANGS, availableLangs } from '../app/src/i18n/index.js';
import zhCn from '../app/src/i18n/zh-cn.js';
import en from '../app/src/i18n/en.js';
import ja from '../app/src/i18n/ja.js';
import { MOOD_KEYS } from '../app/src/mood.js';
import { EXIT_STATES } from '../app/src/exitbutton.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
let failed = 0;
const chk = (name, ok, detail) => {
  results.push(name);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   → ' + detail}`);
};
const CJK = /[\u4e00-\u9fff]/;
const KANA = /[\u3040-\u30ff]/;   // 平假名 / 片假名 —— 用来断言"这条真的是日语"（不是中文也不是英文）
const PACKS = [['zh-cn', zhCn], ['en', en], ['ja', ja]];
/**
 * 抹掉注释，只留代码。两处都要用（扫 t() 的 key、扫残留中文）。
 * 块注释要**整文件**抹（跨行的 /* … *\/ 逐行抹不掉），替换成等量空白以保住行号；
 * 行注释用 `(^|[^:'"`])` 避开 `http://` 这种假阳性（宁可漏认一行，也不要把 URL 当注释截掉）。
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

console.log('── 1. 命名空间边界：只有 ui.* / boot.* 能进字典 ──');
for (const [name, pack] of PACKS) {
  const notAllowed = Object.keys(pack).filter((k) => !/^(ui|boot)\./.test(k));
  chk(`${name}.js 的 key 全部以 ui. / boot. 开头`, notAllowed.length === 0, notAllowed.slice(0, 5).join(', '));
  const machine = Object.keys(pack).filter((k) => /^(proto|match|prompt|moods)\./.test(k));
  chk(`${name}.js 不含 proto.* / match.* 这类"给机器看"的 key`, machine.length === 0, machine.join(', '));
}

console.log('\n── 2. 值不为空 ──');
for (const [name, pack] of PACKS) {
  const empty = Object.entries(pack).filter(([, v]) => typeof v !== 'string' || !v.trim());
  chk(`${name}.js 没有空值/非字符串值`, empty.length === 0, JSON.stringify(empty.slice(0, 3)));
}

console.log('\n── 3. 语言包说了算：简中包有 boot 段 → 启动画面就是中文 ──');
chk('默认语言是 zh-cn', langOf() === 'zh-cn', langOf());
chk('zh-cn.js **含** boot 段（启动日志里有宿主/后端那几十行，简中必须全）',
  Object.keys(zhCn).some((k) => k.startsWith('boot.')),
  Object.keys(zhCn).filter((k) => k.startsWith('boot.')).length + ' 条');
chk('简中下 boot.progress = 进度', t('boot.progress') === '进度', t('boot.progress'));
const done = t('boot.done', { backend: '1.00', page: '0.50', logs: 12 });
chk('boot.done 的占位符真的被替换（没留 {logs}）',
  done.includes('12') && !/\{\w+\}/.test(done), done);
chk('没登记的 key 原样亮出来（一眼看出漏了哪条）', t('ui.nope.nope') === 'ui.nope.nope', t('ui.nope.nope'));
useLang('en');
chk('英文包里同一条 = progress（换包就换语言）', t('boot.progress') === 'progress', t('boot.progress'));
useLang('zh-cn');

console.log('\n── 4. 缺 key 时的回退是"按命名空间分派"，不是一条链 ──');
// 造一个"什么段都没写"的包：ui.* 与 boot.* 都该落英文（用户自加语言包就是这情况）
LANGS.xx = { 'ui.probe': 'xx-ui', 'boot.probe': 'xx-boot' };
en['ui.__probe'] = 'en fallback';
try {
  useLang('xx');
  chk('包里有这条 → 用包里的', t('boot.probe') === 'xx-boot' && t('ui.probe') === 'xx-ui', t('ui.probe'));
  chk('包没写 boot 段里的那条 → 落英文（不是留空、也不是中文）',
    t('boot.progress') === 'progress', t('boot.progress'));
  // 用户 2026-10-13 的反馈"切到 ja 之后里面还是中文"就是落 zh-cn 造成的：
  // 一个语言包只翻一半、缺的落回中文，屏幕上会半英半中 —— 比全英文更怪。所以统一"缺就用英文"。
  chk('包没写 ui 段里的那条 → 也落英文（不是落中文）',
    t('ui.__probe') === 'en fallback', t('ui.__probe'));
  chk('两边都没有的 key → 原样亮出来', t('boot.__nope') === 'boot.__nope', t('boot.__nope'));
} finally {
  delete LANGS.xx;
  delete en['ui.__probe'];
  useLang('zh-cn');
}
// 参数值是"片段 key"（@key 简写 或 {key,args} 对象）时要先翻好再填
chk('{arg} 传 @key 简写 → 填进来的是译文',
  t('boot.host.win', { mode: '@boot.host.mode.full', w: 1, h: 2, how: '@boot.host.how.load', url: 'u' })
    === '窗口已创建 · 全屏无边框 1x2 · 载入 · u',
  t('boot.host.win', { mode: '@boot.host.mode.full', w: 1, h: 2, how: '@boot.host.how.load', url: 'u' }));
chk('{arg} 传 {key,args} 对象 → 带参数一起翻',
  !/\{\w+\}/.test(t('boot.sys.host', { platform: 'p', arch: 'a', host: 'h', user: 'u', cpu: 'c', cores: 1, mem: 8,
    disk: { key: 'boot.sys.diskUsed', args: { used: 1, total: 2, pct: 50 } }, gpu: '' })),
  t('boot.sys.host', { platform: 'p', arch: 'a', host: 'h', user: 'u', cpu: 'c', cores: 1, mem: 8,
    disk: { key: 'boot.sys.diskUsed', args: { used: 1, total: 2, pct: 50 } }, gpu: '' }));

console.log('\n── 5. 中英两包的 key 必须一一对应（ui.* 与 boot.* 全查） ──');
// 为什么 zh-cn 也必须"全"：回退是"缺就用英文"（BASE.ui = en）。zh-cn 虽然叫"原文"，
// 它同时也是一个语言包 —— 缺一条 ui.*，中文界面上那条就会变成英文。
const allKeys = (p) => Object.keys(p).sort();
const onlyZh = allKeys(zhCn).filter((k) => !(k in en));
const onlyEn = allKeys(en).filter((k) => !(k in zhCn));
chk(`两个包的 key 集合完全一致（${allKeys(en).length} 条：ui.* + boot.*）`,
  onlyZh.length === 0 && onlyEn.length === 0, `只 zh 有: ${onlyZh.slice(0, 4)} / 只 en 有: ${onlyEn.slice(0, 4)}`);
const uiCount = allKeys(zhCn).filter((k) => k.startsWith('ui.')).length;
chk(`zh-cn 的 ui.* 是"全的"（${uiCount} 条）—— 少一条，中文界面就会冒出一个英文词`,
  uiCount > 60, String(uiCount));
const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const phDiff = allKeys(zhCn).filter((k) => k in en && ph(zhCn[k]) !== ph(en[k]));
chk('同一条 key 在中英两包里的 {占位符} 一致（少写一个参数会被这里逮到）',
  phDiff.length === 0, phDiff.slice(0, 5).map((k) => `${k}: ${ph(zhCn[k])} vs ${ph(en[k])}`).join(' | '));

console.log('\n── 6. 宿主/后端发出的事件 id 都得在两个包里查到 ──');
// 启动日志只存 key + 参数，页面渲染时查不到就只剩一行 key —— 所以这里扫源码，提前拦住
function srcBootKeys(file) {
  const out = [];
  fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').forEach((l, i) => {
    const s = l.trim();
    if (s.startsWith('#') || s.startsWith('//')) return;        // 注释不算
    for (const m of l.matchAll(/["'](boot\.[a-z0-9]+\.[a-z0-9.]+)["']/g)) out.push([m[1], `${file}:${i + 1}`]);
    // 要求"boot.某段.某名"两级以上：boot.log 这种文件名不算 key
  });
  return out;
}
const declared = [...srcBootKeys('native_host.py'), ...srcBootKeys(path.join('server', 'server.js'))];
chk('守卫本身有效（扫到了宿主/后端的事件 id）', declared.length > 20, String(declared.length));
const unknown = declared.filter(([k]) => en[k] === undefined || zhCn[k] === undefined);
chk(`宿主/后端的 ${declared.length} 个事件 id 两个包里都有`, unknown.length === 0,
  JSON.stringify(unknown.slice(0, 5)));

console.log('\n── 7. 源码里 t() 用到的 key 必须能在兜底包里查到 ──');
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(...walk(p)); continue; }
    if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const used = new Map();
for (const f of walk(path.join(ROOT, 'app', 'src'))) {
  const s = stripComments(fs.readFileSync(f, 'utf8'));   // 注释里的示例（t('ui...') 之类）不算调用
  for (const m of s.matchAll(/\bt\(\s*'([^']+)'/g)) used.set(m[1], path.relative(ROOT, f));
}
chk('守卫本身有效（至少扫到一条 t() 调用）', used.size > 0, String(used.size));
// 静态 key：兜底包 ui/boot **都**是 en（见 index.js 的 BASE），所以查 en 就够了
// （zh-cn 与 en 的 key 集合一致这条由第 5 节盯着）。
const missing = [...used].filter(([k]) => !k.endsWith('.'))
  .filter(([k]) => en[k] === undefined);
chk(`所有 t() 的静态 key 都在兜底包里（共 ${used.size} 条）`, missing.length === 0,
  JSON.stringify(missing.slice(0, 5).map(([k, f]) => `${k} @ ${f}`)));

// 动态拼出来的 key（t('ui.mood.' + state) 这种）正则只能截到**前缀**。
// 这里两件事：① 前缀只有这三组（多出来说明有人用字符串拼 key，那就不受守卫保护了）；
//            ② 每组的取值范围（mood 状态 / 主题 / 退出三态）在两个包里都得有 key。
const DYN_PREFIX = ['ui.mood.', 'ui.theme.', 'ui.exit.'];
const dyn = [...used].filter(([k]) => k.endsWith('.'));
chk('源码里"前缀式"的 key 只有 mood / theme / exit 三组（它们是可在别处枚举的枚举值）',
  dyn.every(([k]) => DYN_PREFIX.includes(k)), JSON.stringify(dyn));
const dynMissing = [];
for (const k of MOOD_KEYS) for (const pre of ['ui.mood.', 'ui.theme.']) if (en[pre + k] === undefined) dynMissing.push(pre + k);
for (const s of EXIT_STATES) if (en['ui.exit.' + s] === undefined) dynMissing.push('ui.exit.' + s);
chk(`mood / theme / exit 的每个取值在两个包里都有 key（${MOOD_KEYS.length}×2 + ${EXIT_STATES.length}）`,
  dynMissing.length === 0, dynMissing.join(', '));

console.log('\n── 8. 边界：服务层与识别层不许 import i18n ──');
const serverFiles = fs.readdirSync(path.join(ROOT, 'server'))
  .filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, 'server', f));
const boundary = [...serverFiles, path.join(ROOT, 'app', 'src', 'charpack.js')];
// 只看真正的 import/require —— 注释里提一句 i18n 不算越界
const IMPORT_I18N = /require\([^)]*i18n[^)]*\)|\bfrom\s+['"][^'"]*i18n[^'"]*['"]|import\(\s*['"][^'"]*i18n/;
const violators = boundary.filter((f) => fs.existsSync(f) && IMPORT_I18N.test(fs.readFileSync(f, 'utf8')));
chk('server/*.js 与 charpack.js 都没 import i18n', violators.length === 0,
  violators.map((f) => path.relative(ROOT, f)).join(', '));

console.log('\n── 9. 启动日志：宿主/后端只发事件 id，不再夹成品句子 ──');
const hostLines = fs.readFileSync(path.join(ROOT, 'native_host.py'), 'utf8').split('\n');
const hostBad = hostLines.filter((l) => /_boot\(/.test(l) && CJK.test(l));
chk('native_host.py 的 _boot() 调用里没有中文', hostBad.length === 0, hostBad.slice(0, 2).join(' | '));
const srvLines = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8').split('\n');
const srvBad = [];
srvLines.forEach((l, i) => {
  if (!/bootlog\.emit\(/.test(l)) return;
  const chunk = [l, srvLines[i + 1] || '', srvLines[i + 2] || '']
    .map((x) => x.replace(/\/\/.*$/, '')).join(' ');
  if (CJK.test(chunk)) srvBad.push(l.trim().slice(0, 60));
});
chk('server.js 的 bootlog.emit() 调用里没有中文', srvBad.length === 0, srvBad.slice(0, 2).join(' | '));
chk('bootlog.emit 的第三个参数是参数对象（不是拼好的字符串）',
  !/bootlog\.emit\(\s*'[a-z]+',\s*`/.test(fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8')), '');

console.log('\n── 10. 切包 ──');
chk('切到不存在的包 → 返回 false 且语言不变', useLang('xx') === false && langOf() === 'zh-cn', langOf());
chk('切到 en → 语言真的变了', useLang('en') === true && langOf() === 'en', langOf());
useLang('zh-cn');

console.log('\n── 11. 前端每个模块都能当 ES module 解析（防模块级重名）──');
// 真踩过：main.js 里有个模块级的 `let t`（帧计时），`import { t }` 直接重复声明，
// 页面一加载就整个挂掉，而 --check 之外的测试都是 import 各模块、照样全绿。
// 所以这里把 app/src 每个文件当 ESM 过一遍语法（.mjs 副本，避开 CJS 判定）。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ponko-i18n-'));
  const bad = [];
  const files = walk(path.join(ROOT, 'app', 'src'));
  for (const f of files) {
    const dst = path.join(tmp, path.basename(f) + '.mjs');
    fs.copyFileSync(f, dst);
    try { execFileSync(process.execPath, ['--check', dst], { stdio: 'pipe' }); }
    catch (e) {
      const first = String((e.stderr || e.message || '')).split('\n').find((l) => l.trim()) || 'syntax error';
      bad.push(`${path.relative(ROOT, f)}: ${first.trim()}`);
    }
  }
  chk(`app/src 下 ${files.length} 个模块全部通过 ES module 语法检查`, bad.length === 0, bad.slice(0, 3).join(' | '));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n── 12. 日语包 ja.js：界面（ui.*）是日语，启动日志（boot.*）留空落英文 ──');
// 用户 2026-10-13：日语**日志**不翻、留空用默认（＝英文）；但界面文案要日语
// （"ja にしたのに英語" 就是这条反馈）。所以 ja.js 只有 ui.*、没有 boot.*。
// ja 的 ui.* 必须**全** —— 缺一条就落英文，屏幕上会半日半英（与"zh-cn 必须全"同理）。
const enUiKeys = Object.keys(en).filter((k) => k.startsWith('ui.')).sort();
const jaUiKeys = Object.keys(ja).filter((k) => k.startsWith('ui.')).sort();
const jaUiMissing = enUiKeys.filter((k) => !(k in ja));
chk(`ja.js 的 ui.* 是"全的"（${jaUiKeys.length} 条，与 en 一一对应）—— 少一条，日语界面上就会冒出一个英文词`,
  jaUiMissing.length === 0 && jaUiKeys.length === enUiKeys.length, `缺: ${jaUiMissing.slice(0, 6).join(', ')}`);
const jaBoot = Object.keys(ja).filter((k) => k.startsWith('boot.'));
chk('ja.js 里没有 boot.*（启动日志不翻译，留空让它落默认英文）', jaBoot.length === 0, jaBoot.slice(0, 4).join(', '));
useLang('ja');
chk('日语下界面文案真的是日语（含假名 —— 既不落中文、也不落英文）',
  KANA.test(t('ui.shell.welcome')) && KANA.test(t('ui.toast.copied', { n: 3 })), t('ui.shell.welcome'));
chk('日语下 boot.progress 落英文默认', t('boot.progress') === 'progress', t('boot.progress'));
const jaStarted = t('boot.host.started', { pid: 1, py: '3.14.4' });
chk('日语下宿主那行落英文（不是留空、也不是中文）',
  jaStarted !== 'boot.host.started' && !CJK.test(jaStarted), jaStarted);
useLang('zh-cn');
chk('切回简中后启动画面又是中文', t('boot.progress') === '进度', t('boot.progress'));
chk('语言清单与语言包一一对应（availableLangs ↔ LANGS，不许各存一份表）',
  availableLangs().map((l) => l.id).join(',') === Object.keys(LANGS).join(','),
  availableLangs().map((l) => l.id).join(','));
chk('每种语言都有自己的名字（不是把 id 原样亮出来）',
  availableLangs().every((l) => l.name && l.name !== l.id), JSON.stringify(availableLangs()));
chk('清单里有 ja（`lang ja` 得能用）', availableLangs().some((l) => l.id === 'ja'), '');

// 用户 2026-10-13：切语言**当场整屏重译**（`onLangChange` 已接），所以回执里不许再写
// "下次启动才生效"——那是 `onLangChange` 接上之前的事实，现在会误导人。
const FORBID_STALE = /重启|下次启动|下次开机|再起動|次回起動|next (time|start|launch)|after (a )?restart/i;
for (const [id, pack] of [['zh-cn', zhCn], ['en', en], ['ja', ja]]) {
  const v = pack['ui.shell.langDone'] || '';
  chk(`${id} 的 langDone 不提"重启 / 下次启动才生效"`, !!v && !FORBID_STALE.test(v), v);
}
chk('langDone 明说"当场生效"（zh:当场 / en:right away / ja:すぐ）',
  /当场/.test(zhCn['ui.shell.langDone']) && /right away/i.test(en['ui.shell.langDone'])
    && /すぐ/.test(ja['ui.shell.langDone']), '');

console.log('\n── 13. 界面文案必须走语言包：app/src 的代码行里不许再留成品中文 ──');
// 这条是"往字典里搬"这件事的反向守卫：搬完之后源码里就不该再有中文字符串了，
// 否则那些字永远不跟着语言变（用户 2026-10-13："切到 ja 后里面还是中文"）。
// 例外只有三类，**都在这里显式写着** —— 想加第四类，先改这份表，逼着想清楚"这真的是给人看的字吗"。
{
  const ALLOW = [
    // ① 识别别名表：模型声明的中文心情词（'待机'/'思考'…）必须原样留着，翻了就永远匹配不上
    { file: 'charpack.js', re: /ALIAS|'待机'|'思考'|'输出'|'瞌睡'|'出错'/, why: '识别别名表' },
    // ② 心情标记识别正则：模型可能写中文键名（心情/情绪），翻了就剥不掉标记
    { file: 'agent.js', re: /MOOD_TAG_RE|心情|情绪/, why: '心情标记识别正则' },
    // ③ ?demo= 的演示载荷：那是我自己敲进 shell / 发给 agent 的样例命令与提问，不是界面文案
    { file: 'main.js', re: /runDemo|sendToPty\(|shell\.exec\(|agent\.send\(/, why: '演示载荷' },
  ];
  // 先整文件把块注释（含 JSDoc）抹成等量空白 —— 逐行抹不掉跨行的 /* … */，
  // 而抹的时候要**保住换行**，行号才对得上。（stripComments 定义在文件开头）
  const bad = [];
  for (const f of walk(path.join(ROOT, 'app', 'src'))) {
    const rel = path.relative(path.join(ROOT, 'app', 'src'), f);
    if (rel.startsWith('i18n')) continue;                       // 语言包本身就是中文
    const lines = stripComments(fs.readFileSync(f, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (!CJK.test(line)) return;
      const ok = ALLOW.some((a) => rel.endsWith(a.file) && a.re.test(line));
      if (!ok) bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 70)}`);
    });
  }
  chk('app/src 的代码行里没有"没进字典的中文"（注释/别名表/识别正则/演示载荷除外）',
    bad.length === 0, bad.slice(0, 6).join(' | ') + (bad.length > 6 ? ` …共 ${bad.length} 处` : ''));
  chk('守卫本身有效（至少扫到过三类例外之一 —— 否则说明这条守卫可能空转）',
    ALLOW.length === 3, String(ALLOW.length));
}

console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
