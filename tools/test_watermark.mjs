// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 水印守卫：立绘里的不可见溯源标记 + characters/MANIFEST.json 必须与磁盘上的文件一致。
//
// 为什么文档式地"记得更新清单"没用：改一张图不会报错，清单只会悄悄变旧 ——
// 等真要拿它举证时才发现对不上。这里把三件事钉死：
//   ① 清单覆盖每一张 src/*.png（漏一张 = 新加的图没有标记）
//   ② 清单里的 sha256 与文件字节一致（改了图忘了 --manifest 会红）
//   ③ 标记本体能被读回、且改过可见像素会被抓出来（--verify / --selftest）
//
// 跑法：node tools/test_watermark.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
let failed = 0;
const chk = (name, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   → ' + detail}`);
};

const MANIFEST = path.join(ROOT, 'characters', 'MANIFEST.json');
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

if (!fs.existsSync(MANIFEST)) {
  console.log('FAIL  缺 characters/MANIFEST.json（跑 python tools/watermark.py --manifest）');
  process.exit(1);
}
const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const entries = new Map(man.files.map((f) => [f.path.replace(/\\/g, '/'), f]));

// 磁盘上的素材（与 watermark.py 的 assets() 同一条 glob）
const srcRoot = path.join(ROOT, 'characters');
const onDisk = [];
for (const pack of fs.readdirSync(srcRoot, { withFileTypes: true })) {
  if (!pack.isDirectory()) continue;
  const dir = path.join(srcRoot, pack.name, 'src');
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.png')) onDisk.push(`characters/${pack.name}/src/${f}`);
  }
}

chk(`每个包都有 src/*.png（扫到 ${onDisk.length} 张）`, onDisk.length >= 6, String(onDisk.length));
chk('清单覆盖了磁盘上每一张图（多了/少了都不行）',
  onDisk.every((p) => entries.has(p)) && entries.size === onDisk.length,
  `清单 ${entries.size} 条 / 磁盘 ${onDisk.length} 张`);

const stale = [];
const noWm = [];
for (const p of onDisk) {
  const e = entries.get(p);
  if (!e) continue;
  if (sha256(path.join(ROOT, p)) !== e.sha256) stale.push(p);   // 改图没重跑 --manifest
  if (e.watermark !== 'ok') noWm.push(`${p}(${e.watermark})`);
}
chk('清单里的 sha256 与文件字节一致（改图后要重跑 --manifest）', stale.length === 0, stale.join(', '));
chk('清单里每张都标了 watermark=ok', noWm.length === 0, noWm.join(', '));

// 真去读图里的标记 —— 上面几条只比对 JSON，读不出标记就等于没有
const run = (args) => spawnSync('python', [path.join(ROOT, 'tools', 'watermark.py'), ...args],
  { cwd: ROOT, encoding: 'utf8' });
const ver = run(['--verify']);
chk('python tools/watermark.py --verify 通过（标记可读回、内容哈希相符）',
  ver.status === 0, (ver.stdout || '').split('\n').filter((l) => l.includes('FAIL')).join(' | ') || ver.stderr);
const self = run(['--selftest']);
chk('反向自检通过（改一个可见像素必须被抓出来）',
  self.status === 0, (self.stdout || '').split('\n').filter((l) => l.includes('FAIL')).join(' | ') || self.stderr);

console.log(`\n${failed ? failed + ' 项失败' : '全部通过'}`);
process.exit(failed ? 1 : 0);
