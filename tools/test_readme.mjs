// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// README 守卫：**两份 README 必须同构**（README.md 中文 / README.en.md 英文）。
//
// 为什么需要它：文档漂移不会报错，只会慢慢变成假话。靠记性是不可靠的 ——
// 往中文那份加一节、删一条、多一行表格，英文那份就悄悄落后一截，等有人照着它操作时
// 才发现对不上。这里钉的是**骨架**（章节层级 / 表格数 / 代码块数 / 列表条目数），
// 不是措辞：两份允许说得不一样（那是翻译），**结构不许不一样**（那是漏了）。
//
// 跑法：node tools/test_readme.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
let failed = 0;
const chk = (name, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   → ' + detail}`);
};

const read = (rel) => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

/**
 * 抽出"骨架签名"：只看结构，不看措辞。
 * 代码块（```）内部整段跳过 —— 那里的 | 与 - 是文件内容，不是 Markdown 结构。
 */
const skeleton = (src) => {
  let heads = [], tables = 0, fences = 0, bullets = 0, inFence = false;
  for (const raw of src.split(/\r?\n/)) {
    const l = raw.trim();
    if (/^```/.test(l)) { if (!inFence) fences++; inFence = !inFence; continue; }
    if (inFence) continue;
    const h = /^(#{1,6})\s+/.exec(l);
    if (h) heads.push(h[1].length);
    else if (/^\|[\s:|-]+\|?\s*$/.test(l)) tables++;      // 表格分隔行 | --- | --- |
    else if (/^[-*+]\s+/.test(l)) bullets++;
  }
  return { heads: heads.join(','), tables, fences, bullets };
};

const CJK = /[\u4e00-\u9fff]/g;

const zh = read('README.md');
const en = read('README.en.md');

console.log('── 两份 README 必须同构（改了一份就要改另一份）──');
chk('README.md（中文）存在', !!zh, '缺文件');
chk('README.en.md（英文）存在', !!en, '缺文件');
if (!zh || !en) { console.log('\n1 项失败'); process.exit(1); }

const A = skeleton(zh), B = skeleton(en);
console.log(`  中文：标题 [${A.heads}] · 表格 ${A.tables} · 代码块 ${A.fences} · 列表条目 ${A.bullets}`);
console.log(`  英文：标题 [${B.heads}] · 表格 ${B.tables} · 代码块 ${B.fences} · 列表条目 ${B.bullets}`);

chk('章节层级序列一致（不许只有一份加了/删了小节）', A.heads === B.heads, `zh[${A.heads}] vs en[${B.heads}]`);
chk('表格数量一致', A.tables === B.tables, `${A.tables} vs ${B.tables}`);
chk('代码块数量一致', A.fences === B.fences, `${A.fences} vs ${B.fences}`);
chk('列表条目数一致', A.bullets === B.bullets, `${A.bullets} vs ${B.bullets}`);
chk('章节数不为零（否则这条守卫等于没跑）', A.heads.split(',').length >= 5, A.heads);

// 互链：不知道另一份存在，等于没加英文版
chk('README.md 里指向英文版', /README\.en\.md/.test(zh), '没有链接');
chk('README.en.md 里指回中文版', /README\.md/.test(en), '没有链接');

// 语言纯度：英文版里不该混进成段中文
const enCjk = (en.match(CJK) || []).length;
chk(`英文版里几乎不含汉字（${enCjk} 个，阈值 30）`, enCjk <= 30, String(enCjk));
const zhCjk = (zh.match(CJK) || []).length;
chk(`中文版确实是中文（${zhCjk} 个汉字）`, zhCjk > 500, String(zhCjk));

// 两份都指向同一个 LICENSE，别出现各写一份的情况
chk('两份都链到根 LICENSE（代码）', /\]\(LICENSE\)/.test(zh) && /\]\(LICENSE\)/.test(en), '一处缺失');
// 形象不在 MIT 内（2026-10-18 用户明确）：README 必须把这条边界写出来，并链到那份说明
chk('两份都说明形象另有授权', /characters\/LICENSE/.test(zh) && /characters\/LICENSE/.test(en), '缺形象授权说明');
// 应用图标同样是美术资源，别只写了立绘就当成写全了（MIT 默认会连图标一起覆盖）
chk('两份都把应用图标划出 MIT', /tools\/assets\/LICENSE/.test(zh) && /tools\/assets\/LICENSE/.test(en), '缺图标授权说明');
chk('中文明说形象保留所有权利', /保留所有权利/.test(zh), '没写清楚');
chk('英文同样说清形象另有授权', /all rights reserved/i.test(en), '没写清楚');
// 两份声明的一致性：非商业引用条款要么都有，要么都没有，别一边允许一边禁止
chk('非商业引用条款两边一致', /非商业/.test(zh) === /non-commercial/i.test(en), '两边不一致');

// ── 2026-10-19：授权文本自身的守卫 ────────────────────────────────────────
// 起因：根 LICENSE 是裸 MIT，字面上把 characters/ 也覆盖了。第一次尝试是把范围声明**写进**
// 根 LICENSE —— 结果 GitHub 的许可证识别直接掉成 `Other/NOASSERTION`（MIT 正文被"污染"，
// 相似度不够）。所以边界归 NOTICE，根 LICENSE 必须保持纯 MIT。这里两条一起钉。
{
  const rootLic = read('LICENSE');
  const notice = read('NOTICE');
  chk('根 LICENSE 是纯 MIT（不含范围声明 —— 塞了会掉出 GitHub 的 MIT 识别）',
    /^MIT License\n\nCopyright/.test(rootLic.replace(/\r/g, ''))
      && !/covers the source code/i.test(rootLic), '根 LICENSE 被改动了');
  chk('MIT 正文完整',
    /Permission is hereby granted, free of charge/.test(rootLic)
      && /THE SOFTWARE IS PROVIDED "AS IS"/.test(rootLic), '');
  chk('NOTICE 存在并划清两类东西', !!notice && /Source code/.test(notice) && /All Rights Reserved/.test(notice), '缺文件');
  chk('NOTICE 点名形象与图标不在 MIT 内',
    /characters\/\*\*/.test(notice) && /tools\/assets\/\*\*/.test(notice)
      && /不属于/.test(notice), '没点名');
  chk('NOTICE 指向两份素材许可',
    /characters\/LICENSE/.test(notice) && /tools\/assets\/LICENSE/.test(notice), '链接缺失');
  chk('两份 README 都链到 NOTICE（边界得能被找到）',
    /\]\(NOTICE\)/.test(zh) && /\]\(NOTICE\)/.test(en), '缺链接');
}

// 三份许可文件里的相对链接必须真的能打开 —— 之前 tools/assets/LICENSE 里写的 `../LICENSE`
// 指向 tools/LICENSE（不存在），中英四处全是死链，而且没有任何测试会发现。
{
  const files = ['LICENSE', 'NOTICE', 'characters/LICENSE', 'tools/assets/LICENSE'];
  const broken = [];
  let checked = 0;
  for (const f of files) {
    const txt = read(f);
    for (const m of txt.matchAll(/\]\(([^)]+)\)/g)) {
      const href = m[1].trim();
      if (/^(https?:|#|mailto:)/i.test(href)) continue;
      checked++;
      const target = path.resolve(path.dirname(path.resolve(ROOT, f)), href.split('#')[0]);
      if (!fs.existsSync(target)) broken.push(`${f} → ${href}`);
    }
    // 文本里直接写的路径（不是 markdown 链接）也要能解析，例如 "see ../../characters/LICENSE"
    for (const m of txt.matchAll(/(?:see|见)\s+((?:\.\.\/)+[A-Za-z0-9_./-]+)/g)) {
      checked++;
      const target = path.resolve(path.dirname(path.resolve(ROOT, f)), m[1]);
      if (!fs.existsSync(target)) broken.push(`${f} → ${m[1]}`);
    }
  }
  chk('三份许可文件里的相对链接都指向真实文件', broken.length === 0, broken.join(' | '));
  // 别让上面那条空转：一个链接都没扫到的时候，它永远是绿的
  chk(`链接检查确实扫到了链接（${checked} 个）`, checked >= 5, String(checked));
  // NOTICE 里的路径是裸写的（不带 ../），单独核一遍：它指的这三份必须真的在
  {
    const notice = read('NOTICE');
    const wants = ['LICENSE', 'characters/LICENSE', 'tools/assets/LICENSE'];
    const miss = wants.filter((p) => !notice.includes(p) || !fs.existsSync(path.join(ROOT, p)));
    chk('NOTICE 指向的三份许可文件都存在', miss.length === 0, miss.join(','));
  }
}

// 条款本身的守卫：这两句是 2026-10-19 补的，改措辞时别把它们弄丢
{
  const artLic = read('characters/LICENSE');
  const iconLic = read('tools/assets/LICENSE');
  const near = (s) => /non-commercial/.test(s) && /non-commercial quoting|明文允许的非商业引用/.test(s);
  chk('「摘出来再分发」写明了非商业引用是唯一例外（中英都要有）',
    near(artLic) && near(iconLic), '');
  chk('都写了「未明确授予的权利一律保留」',
    /not expressly granted/i.test(artLic) && /没有明确授予的权利/.test(artLic)
      && /not expressly granted/i.test(iconLic) && /没有明确授予的权利/.test(iconLic), '');
  chk('图标那份的条款不再比形象那份松（也点名了封面/缩略图与商店提交物）',
    /covers or thumbnails/.test(iconLic) && /store submission/.test(iconLic)
      && /封面或缩略图/.test(iconLic) && /商店提交物/.test(iconLic), '');
  // README 两份都要提到"分发构建产物"这条 —— 它是最容易被漏掉的实质条款
  chk('两份 README 都写了「不得分发构建产物」',
    /APK/.test(zh) && /AAB/.test(zh) && /构建产物/.test(zh)
      && /APK/.test(en) && /AAB/.test(en) && /build/i.test(en), '缺一条');
  // 录像可以、截帧当封面不行：这条不明说的话，两个允许/禁止读起来就是矛盾的
  chk('「录像可以、截帧当封面不行」两边都说清了',
    /截出来当封面/.test(artLic) && /frame out of that footage/i.test(artLic), '');
  // 2026-10-19 用户明确：**不允许商业使用** —— 不是"经作者书面许可可以商用"。
  // 那种写法读起来就是"问一声/交钱就能用"，与实际意图相反；四份文本都必须把口子焊死。
  const notice = read('NOTICE');
  const noAsk = (s) => !/prior written permission|未经作者书面许可|open an issue first|开 issue 问一声/i.test(s);
  chk('四份文本都把商业使用写成"一律不允许"',
    /Commercial use is\s+not\s+permitted at all/.test(artLic) && /商业使用一律不允许/.test(artLic)
      && /no commercial rights/i.test(iconLic) && /商业使用一律不允许/.test(iconLic)
      && /Commercial use is\s+not\s+permitted at all/.test(notice) && /商业使用一律不允许/.test(notice)
      && /商业使用一律不允许/.test(zh) && /not\s+permitted at all/i.test(en), '有文件没写死');
  chk('不再保留"申请/询问后即可商用"的口子',
    noAsk(artLic) && noAsk(iconLic) && noAsk(notice) && noAsk(zh) && noAsk(en), '还留着口子');
  chk('素材许可把授权范围限定为个人、非商业用途',
    /personal, non-commercial use only/i.test(artLic) && /仅限个人、非商业用途/.test(artLic)
      && /personal, non-commercial use only/i.test(iconLic) && /仅限个人、非商业用途/.test(iconLic), '');
  // 2026-10-19：立绘里埋了不可见标记（tools/watermark.py）。这是**举证**手段，
  // 但它只在"文件还在、标记还在"时有用 —— 文档里必须写出来，否则没人会去跑 --verify。
  chk('素材许可声明了不可移除的溯源标记',
    /invisible provenance mark/.test(artLic) && /不可见.*溯源标记|溯源标记/.test(artLic)
      && /MANIFEST\.json/.test(artLic), '');
  chk('两份 README 都写了立绘带不可见标记',
    /溯源标记/.test(zh) && /provenance mark/i.test(en)
      && /watermark\.py/.test(zh) && /watermark\.py/.test(en), '缺说明');
}

console.log(`\n${failed ? failed + ' 项失败' : '全部通过'}`);
process.exit(failed ? 1 : 0);
