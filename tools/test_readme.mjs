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
chk('中文明说形象保留所有权利', /保留所有权利/.test(zh), '没写清楚');
chk('英文同样说清形象另有授权', /all rights reserved/i.test(en), '没写清楚');

console.log(`\n${failed ? failed + ' 项失败' : '全部通过'}`);
process.exit(failed ? 1 : 0);
