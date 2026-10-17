// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// MOOD：角色（高清立绘 / 方块字符立绘，二选一）+ 心情数值
// 立绘来自素材包：characters/<pack>/src/*.png（高清贴图，优先）或 frames/*.json（字符画，回退），
// 标签由文件名决定，用户可自定义
import { blit } from '../charpack.js';
import { ATTR } from '../grid.js';
import { dotsCached } from '../dots.js';
import { t } from '../i18n/index.js';
import { moodLabel, MOOD_KEYS } from '../mood.js';

// 立绘区高度（行）：面板 30x31，扣掉顶部 1 行 + 底部信息区（心情名/来源/条/说明）约 6 行
const ART_ROWS = 19;
const ART_SAT = 0.9;   // 轻微降饱和，让原画融进深色主题（1 = 不动）

// 手动覆盖（调试）在界面上的**三处痕迹，默认都不上屏**（用户 2026-10-17）：
//   SHOW_MOOD_CHIPS —— 入口：那排可点的心情标签（也是另两处的总开关）
//   MUTE_NOTES      —— 触发之后写在框底的那句「手动覆盖（调试）」
//   来源行的「手动」   —— 框里那行「AGENT/手动 · 脸」中的调试档（见 draw 里 src 那段）
// ⚠ 这条改过三回、错了两回：先只藏了框底那句字（入口和来源行还在），用户又看见「手动 · 生气」。
//   教训：**这套调试功能派生的每一处界面痕迹都要一起藏**，别拿"这是入口不是痕迹"给自己分类。
//   能力（?mood= / ^M / mood.force）与 i18n 词条一条都没删：
//   开发时把 SHOW_MOOD_CHIPS 改成 true，再把这行从 MUTE_NOTES 里去掉即可全看回来。
const SHOW_MOOD_CHIPS = false;
const MUTE_NOTES = new Set(['ui.mood.manualOverride']);

// 立绘怎么渲染（2026-10-15 用户："把形象粒子化，看看会不会更符合终端风格" → 选定点阵）：
//   'dots'  采样成方块点阵（终端风，见 ../dots.js）—— 当前默认
//   'photo' 直接把原图贴上去（旧的"照片"观感）
// 启动参数 ?art=photo / ?art=dots 可临时覆盖（跟 ?lang= / ?mood= 同一类调试开关）。
// 想换回照片风：改这一行的默认值即可。
const ART_MODE = urlArt() || 'dots';
const ART_PITCH = 2;   // 点距（CSS 像素）：对照稿里「细」= 2，「粗」= 4

/** 读启动参数里的 ?art=（非浏览器环境 / 非法值都返回 null，走默认） */
function urlArt() {
  try {
    const v = new URLSearchParams(location.search).get('art');
    return (v === 'dots' || v === 'photo') ? v : null;
  } catch (e) { return null; }
}

export class CharPanel {
  constructor(mood, pack) {
    this.rect = null;
    this.mood = mood;
    this.pack = pack;
    this.frame = null;
    this._frameTag = '';   // this.frame 是哪张脸的（帧是异步来的，光有对象不知道它属于谁）
    this._want = '';
    this._t = 0;
    // 立绘区**这一刻显示的东西**（快照）：{ key, kind:'art'|'frame', image|frame }
    // 关键：它是"已经画出来的"，不是"想要画的" —— 换形象的等待期里，它一直是旧的那个。
    this.art = null;
    // 点阵预热登记：缓存 key → 1 排队中 / 2 已完成（见 _warm）
    this._warmQ = new Map();
    if (pack && pack.preloadArt) pack.preloadArt();
  }

  layout(r) { this.rect = r; }

  /**
   * 换形象（素材包）。形象是**每个对话一份**的，切标签就会调到这里。
   *
   * 必须把 frame / _want 一起清掉：那是上一个包的帧，留着会被当成"这个包也有了"而不去加载
   * （_want 的 key 里没有包 id，光比 tag@cols 会撞上）。
   *
   * ⚠️ **故意不清 this.art** —— 那是"现在屏幕上那个"。清掉就会变成
   * 「旧形象消失 → 空白等加载 → 新形象出现」，正是用户 2026-10-15 说的"卡一下"。
   * 留着它，sync() 会等新形象备齐了再一次性换过去。
   */
  setPack(pack) {
    if (this.pack === pack) return false;
    this.pack = pack || null;
    this.frame = null;
    this._frameTag = '';
    this._want = '';
    // 没有包可显示才清快照；换到别的包时旧形象继续顶着（见上面的 ⚠️）
    if (!this.pack) this.art = null;
    else if (this.pack.preloadArt) this.pack.preloadArt();   // 包内立绘先铺开：之后换表情也是瞬时的
    return true;
  }

  /** 左上角标题 = 形象名称（素材包自己的名字，没写名就退回 id） */
  title() {
    const n = this.pack && (this.pack.name || this.pack.id);
    return n ? String(n).toUpperCase() : 'CHAR';
  }

  async ensureFrame(cols, tSec = 0) {
    const tag = this.pack ? this.pack.tagFor(this.mood.frameTag()) : null;
    if (!tag) return;
    // 有高清立绘就不必加载字符帧（省一次请求）；加载失败时才回退
    if (this.pack.hasArt(tag) && !this.pack.artFailed(tag)) {
      if (this.frame) this.frame = null;
      this._frameTag = '';
      this._want = '';
      return;
    }
    const entry = this.pack.moods && this.pack.moods[tag];
    const multi = entry && Array.isArray(entry.frames) && entry.frames.length > 1;
    const key = multi
      ? `${tag}@${cols}@${Math.floor(tSec * (entry.fps || 2))}`
      : `${tag}@${cols}`;
    if (key === this._want && this.frame) return;
    this._want = key;
    const f = await this.pack.frame(tag, cols, tSec);
    if (f && this._want === key) { this.frame = f; this._frameTag = tag; }
  }

  /**
   * 决定立绘区这一刻该显示谁 —— 只在**新形象完全就绪**时才换掉 this.art。
   *
   * 用户 2026-10-15 要的顺序：「已显示 > 切换形象（旧形态不退场，继续显示）> 加载 >
   * 旧形态退出并且显示新形象」。所以这里宁可多等，也不中途清空：
   *   · 图还没到（首次 fetch + 解码）→ 保持旧快照，本帧照画旧的
   *   · 图到了但点阵还没算（首次要遍历上万块）→ 先安排一次帧外预热，本帧仍不切 ——
   *     否则"卡一下"只是从加载期挪到了切换那一帧，等于没解决
   * 于是真正切换的那一帧只剩一次 drawImage。
   */
  sync(g, tag, useArt, iw, opts) {
    const id = this.pack && this.pack.id ? this.pack.id : '';

    if (useArt) {
      const key = `art:${id}:${tag}`;
      if (this.art && this.art.key === key) return;
      const im = this.pack.artImage(tag);          // 首次调用发起加载，下一帧再问就拿到了
      if (!im) return;                             // 还在路上 → 旧形象继续显示
      if (!this._warm(g, im, iw, opts)) return;    // 点阵还没备好 → 再等一帧（预热中）
      this.art = { key, kind: 'art', image: im };
      return;
    }

    const key = `frame:${id}:${tag}`;
    if (this.art && this.art.key === key) return;
    // 字符画回退：帧是 ensureFrame() 异步取的（在 draw 之后才落地），取到才算数
    if (this.frame && this._frameTag === tag) this.art = { key, kind: 'frame', frame: this.frame };
  }

  /**
   * 点阵就绪了吗？没就绪就安排一次**帧外**预热并返回 false（本帧先别切）。
   * 用 setTimeout(0) 而不是 requestIdleCallback：要和渲染循环一样"确定会发生"，
   * 不能指望浏览器还有空闲（而且此刻屏幕上是旧形象，掉一帧看不出来）。
   */
  _warm(g, im, iw, opts) {
    if (!opts.dots) return true;                   // 直接贴原图：没有二次加工，图到即就绪
    const wk = g.artKey(iw, ART_ROWS, im, opts);
    if (dotsCached(wk)) return true;
    const st = this._warmQ.get(wk);
    if (st === 2) return true;
    if (!st) {
      this._warmQ.set(wk, 1);
      setTimeout(() => {
        g.warmImg(iw, ART_ROWS, im, opts);
        this._warmQ.set(wk, 2);
        if (this._warmQ.size > 24) this._warmQ.delete(this._warmQ.keys().next().value);
      }, 0);
    }
    return false;
  }

  draw(g, C) {
    const r = this.rect, T = C.theme, m = this.mood;
    if (!r || r.w < 10 || r.h < 8) return;

    const tag = this.pack ? this.pack.tagFor(m.frameTag()) : null;
    const useArt = !!(tag && this.pack.hasArt(tag) && !this.pack.artFailed(tag));
    const opts = ART_MODE === 'dots'
      ? { sat: ART_SAT, dots: true, pitch: ART_PITCH }
      : { sat: ART_SAT };

    // 左上角 = 形象名称。右上角**不再标画法**（用户 2026-10-15："点阵""高清"那些都不用显示）
    g.box(r.x, r.y, r.w, r.h, T.accent, T.panel, this.title(), T.accent);
    this._t = C.t;
    const x = r.x + 1, iw = r.w - 2;
    let y = r.y + 1;

    // 该显示谁（只在新形象就绪时才会改 this.art，见 sync 的注释）
    this.sync(g, tag, useArt, iw, opts);

    const cur = this.art;
    if (cur && cur.kind === 'art') {
      g.img(x, y, iw, ART_ROWS, cur.image, opts);
      y += ART_ROWS + 1;
    } else if (cur && cur.kind === 'frame') {
      const fx = x + Math.max(0, Math.floor((iw - cur.frame.cols) / 2));
      blit(g, fx, y, cur.frame, T.panel);
      y += cur.frame.rows + 1;
    } else {
      g.text(x + Math.floor(iw / 2) - 5, y + 2, 'loading…', T.dim, T.panel);
      y += 5;
    }

    const mid = r.x + Math.floor(r.w / 2);
    const ctr = (s, col, attr) => {
      const w = g.strWidth(s);
      g.text(Math.max(r.x + 1, mid - Math.floor(w / 2)), y, s, col, T.panel, attr || 0);
      y++;
    };

    // 面板顶上这行 = 心情的名字。**来自角色包**（pack.json 的 moods.<标签>.label），
    // 不是语言包 —— 见 mood.js 的 moodLabel()。
    if (y < r.y + r.h - 1) ctr(moodLabel(this.pack, m.key), T.accent, ATTR.BOLD);
    if (y < r.y + r.h - 1) {
      // 这一行 = `<角色名> · <心情 id>`（用户 2026-10-17：「改成<角色名>·<mood_id>」）。
      // 角色名取素材包自己的 name（没写就用 id）—— **不转大写**：左上角标题已经是 PONKO
      // 那种大写装饰，这里保持原样，一眼能分出"标题"和"数据"。
      // id = MOOD_STATES 的键（封闭枚举，协议里的原值，永远不翻）—— 跟上一行那个**名字**
      // 是两回事：名字来自角色包、会跟着语言变，排查问题时看 id。
      // 不写来源（AGENT / 本地 / 手动）：那是调试信息，界面上不需要，之前正是「手动」
      // 两个字把用户绕进去的（见文件顶部那段注释）。
      const who = this.pack ? String(this.pack.name || this.pack.id || '') : '';
      const miss = m.face && !m.faceOk() ? t('ui.char.missing') : '';   // 只有"要的脸包里没有"才多出这截
      const full = who ? `${who} · ${m.key}${miss}` : `${m.key}${miss}`;
      // 角色名是用户自定义的、长度不可控 —— 居中画会溢出到隔壁面板，超宽就退回只报 id
      ctr(g.strWidth(full) > iw ? `${m.key}${miss}` : full, T.dim);
    }
    if (y < r.y + r.h - 1) {
      const v = Math.round(m.value);
      const w = Math.max(6, iw - 8);
      const n = Math.round((v / 100) * w);
      const s = '▐' + '█'.repeat(n) + '░'.repeat(w - n) + '▌';
      ctr(s, T.accent);
    }
    if (y < r.y + r.h - 1) ctr(`mood ${Math.round(m.value)} / 100`, T.dim);
    // 「情绪历史」那根 sparkline 已删（用户 2026-10-17：「情绪历史不需要」）——
    // 连带 mood.js 里的 history 环形缓冲也去掉了，别只删这里而把喂它的代码留着。

    // 表情标签（点一下手动切心情）—— **调试入口，默认不画**，见 SHOW_MOOD_CHIPS。
    // ⚠ `_chips` 无论如何都要清空：留下上一帧的命中区，鼠标点上去照样会生效 ——
    //   那就成了"看不见但能点"，比直接显示还糟。
    this._chips = [];
    if (SHOW_MOOD_CHIPS && y < r.y + r.h - 1) {
      y++;
      // 从枚举取，**不要**再手写数组：写死的话加/删一个 state 时这里会静默少一个标签。
      const keys = MOOD_KEYS;
      this._chipY = y;
      let cx = r.x + 1;
      for (let i = 0; i < keys.length; i++) {
        const s = moodLabel(this.pack, keys[i]);   // 名字来自角色包（见 moodLabel）
        const w = g.strWidth(s);
        if (cx + w + 1 > r.x + r.w - 1) break;     // 面板宽度不够就少显示几个（不会画出去）
        const on = m.key === keys[i];
        g.text(cx, y, s, on ? T.panel : T.dim, on ? T.accent : T.panel, on ? ATTR.BOLD : 0);
        this._chips.push({ x: cx, w, key: keys[i] });
        cx += w + 1;
      }
      y += 2;
    }

    if (y < r.y + r.h - 1) {
      const note = MUTE_NOTES.has(m.noteKey) ? '' : (m.note || '');
      const max = iw;
      if (note) g.text(x, y, note.slice(0, max), T.dim, T.panel);
    }
  }

  /** 命中表情标签 → 返回心情 key */
  chipAt(gx, gy) {
    if (!this._chips) return null;
    for (const c of this._chips) if (gy === this._chipY && gx >= c.x && gx < c.x + c.w) return c.key;
    return null;
  }
}
