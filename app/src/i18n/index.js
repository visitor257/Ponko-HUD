// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// i18n 入口：一个语言包 = 一个文件（zh-cn.js / en.js / …），代码里只写 key。
//
// 四条硬约定（改动前先读 .workbuddy/memory/ponkohud.md「i18n 架构核实」）：
//
//   1) **只有"屏幕上会出现给人看的字"才进字典**。模型 prompt（server/moodprotocol.js）、
//      识别别名表（charpack.js 的 ALIAS）都不进 —— 它们不是给人看的，翻了等于改行为。
//      所以字典里只允许 ui.* / boot.* 前缀，proto.* / match.* 由守卫测试挡住。
//
//   2) **回退按命名空间分派，不是一条链**：
//        ui.*   界面文案  → 兜底 **en**（语言包翻到哪算哪，没翻的落英文）
//        boot.* 启动画面  → 兜底 **en**（语言包提供 boot 段就听语言包的；没提供才落英文）
//      为什么两个都落 en 而不是落 zh-cn：zh-cn 是"原文"，但它同时也是一个语言。
//      如果一个语言包只翻了一半，缺的那些落回中文，屏幕上就会**半英半中** ——
//      比全英文更怪（用户 2026-10-13 的反馈："切到 ja 之后里面还是中文"，那就是落 zh-cn 造成的）。
//      所以规则统一成一句：**缺就用英文**。要中文界面就把 zh-cn 选回来（它是默认语言，且是全的）。
//      别改成 ru→en→zh 这种链：半吊子译文夹在另一种语言里比原文更怪。
//
//   3) **只翻"现在屏幕上是中文"的那些字**。本来就是英文的（面板名 SHELL / AGENT、
//      键位提示 [TAB]、单位 GB/ms、IP 与城市名…）**写死英文不进字典** —— 进字典只会招来
//      半吊子译文，而且中文下看着还不如原文。日语包（ja.js）照这条留空：一条都不翻，
//      于是 ja 下 = boot.* 落 en + ui.* 落 en = **整屏英文**（不是半屏中文）。
//
//   4) **启动日志存的是"事件 id + 参数"，不是成品句子**。宿主/后端在页面拿到语言包
//      之前就把行写进 run/boot.log 了，只有存 id 才能让页面用当前语言重新渲染。
//      见 server/bootlog.js 的格式说明与 boot.js 的 replay()。
//      参数里可以放 **`@其它key`**：渲染时被替换成那条 key 的译文（用于 mode/how 这种小片段）。
import zhCn from './zh-cn.js';
import en from './en.js';
import ja from './ja.js';

export const LANGS = { 'zh-cn': zhCn, en, ja };
// 语言名用**它自己的语言**写（选语言的界面里这是通行做法，也不受当前语言影响）。
// 只登记"有包"的语言 —— 这一份和 LANGS 的键一一对应，测试会盯着它别漂。
const NAMES = { 'zh-cn': '简体中文', en: 'English', ja: '日本語' };
const BASE = { ui: en, boot: en };            // 命名空间 → 兜底语言（缺就用英文）
const PREF_KEY = 'ponko.lang';
const DEFAULT_LANG = 'zh-cn';

let lang = DEFAULT_LANG;
const listeners = new Set();

export function langOf() { return lang; }

/** 语言自己的名字（'zh-cn' → '简体中文'），没登记就退回 id 本身 */
export function langName(tag) { const k = String(tag || '').toLowerCase(); return NAMES[k] || k; }

/**
 * 可切换的语言清单：[{ id, name }]。
 * 顺序 = 注册顺序（LANGS 的插入序）：简中在前，其余按加入时间 —— 这是给 `lang` 命令和
 * 以后的语言选择界面用的唯一来源，别在别处再抄一份语言表。
 */
export function availableLangs() {
  return Object.keys(LANGS).map((id) => ({ id, name: langName(id) }));
}

/** 切换语言包。没有这个包就**不动**（宁可保持现状，也别切成一片 key） */
export function useLang(tag) {
  const k = String(tag || '').toLowerCase();
  if (!LANGS[k]) return false;
  lang = k;
  try { localStorage.setItem(PREF_KEY, k); } catch (e) { /* 无痕模式等，忽略 */ }
  for (const fn of listeners) { try { fn(k); } catch (e) { /* 监听者自己的问题 */ } }
  return true;
}

export function onLangChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** 首次进入时定语言：?lang=xx 覆盖 > localStorage > 默认 zh-cn */
export function initLang() {
  let want = '';
  try { want = new URLSearchParams(location.search).get('lang') || ''; } catch (e) { /* 非浏览器环境 */ }
  if (!want) { try { want = localStorage.getItem(PREF_KEY) || ''; } catch (e) { /* 同上 */ } }
  if (want) useLang(want);
  return lang;
}

/**
 * 取一条文案。vars 用 {name} 占位。
 * 语言包没有 → 按命名空间落兜底包 → 再没有就把 key 亮在屏幕上（一眼看出漏了哪条）。
 */
export function t(key, vars) {
  const k = String(key);
  const ns = k.split('.', 1)[0];
  const pack = LANGS[lang];
  let s = pack ? pack[k] : undefined;
  if (s === undefined) {
    const base = BASE[ns] || zhCn;
    s = base ? base[k] : undefined;
  }
  if (s === undefined) s = k;
  if (!vars) return String(s);
  return String(s).replace(/\{(\w+)\}/g, (m, n) => {
    const v = vars[n];
    if (v === undefined) return m;
    // 片段本身又是一条 key 的两种写法（启动日志里 disk / gpu / mode / how 这类小片段）：
    //   { key: 'boot.sys.diskUsed', args: {...} }  —— 需要带参数时用这个
    //   '@boot.host.mode.full'                     —— 不需要参数时的简写
    if (v !== null && typeof v === 'object' && typeof v.key === 'string') return t(v.key, v.args);
    if (typeof v === 'string' && v.charCodeAt(0) === 0x40) return t(v.slice(1));
    return String(v);
  });
}
