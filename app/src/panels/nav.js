// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
//
// NAV：agent 与技能的**导航框**（左列下半，正对 GLOBE 下方）
//
// 用户 2026-11-02 的原话：「在那个位置上再弄一个框，这个框有 3 个标签页，Agents、Skills（公）
// 和 Skills（私）。Agents 那里像 tree 指令的输出那样显示已有的 agent 和对应对话。其他两个
// 标签页里的 ui 你来设计。llm 框的标签页改成为当前 agent 的各对话」。
//
// 所以这个框是"整个 HUD 的地图"：AGENT 框的标签栏只显示**当前 agent** 的对话，
// 别的 agent 的对话没有标签，只能从这儿的树里找 —— 点一下就把当前 agent 换成它、
// 把对话换过去，AGENT 的标签栏随之重画（见 agent.js 的 visibleTabs）。
//
// 三个标签页（标签文字沿用英文，同 SYS 面板的 CPU / MEM / NET：它们是**数据视图的栏目名**，
// 不是给人读的句子。按 i18n 第 3 条"本来就是英文的不进字典"）：
//   ① Agents  —— 每个 agent 一行（id + 模型 + 几个对话），下面用 tree 的 ├─ └─ 列它的对话。
//                 对话那行的色标就是它在 AGENT 标签栏里的那个颜色 —— 同一个对话到哪儿都是同一色。
//   ② Skills  —— 公有技能（所有 agent 共用）：一行名字 + 一行描述。
//   ③ Private —— **当前 agent** 的私有技能（换个 agent 就是另一份，这正是 2026-11-02 改的模型）。
//                 选中的那个技能，路径显示在最底下一行（那是树里学不到、但真要用时得抄的东西）。
//
// 这一框是**只读的导航**：不是编辑器，也不负责建/删。技能库的权威在磁盘
// （run/skills/…，见 server/skills.js），所以每次都现取，不缓存内容 —— 只缓存"刚取过"这件事。
import { ATTR, mix } from '../grid.js';
import { listSkills } from '../api.js';

const TABS = [
  { label: 'Agents', short: 'Ag' },
  { label: 'Skills', short: 'Sk' },
  { label: 'Private', short: 'Pv' },
];

// 技能清单多久重取一次（毫秒）。为什么要有它：agent 能用 shell 自己写 SKILL.md（技能自举），
// 写着写着就多出一个技能 —— 这个框得跟上，不用人手动刷新。两次 readdir + 读几份小文件，
// 比 SYS 面板每秒一次的 /api/sys 还便宜。
const SKILL_TTL = 4000;

/** 按列宽截断（宽字符算两格），末尾补 '…'。返回值一定能塞进 max 列 */
function fit(g, s, max) {
  const str = String(s == null ? '' : s);
  if (max <= 0) return '';
  if (g.strWidth(str) <= max) return str;
  let out = '', w = 0;
  for (const ch of str) {
    const cw = g.chWidth(ch);
    if (w + cw > max - 1) break;          // 留一列给 '…'
    out += ch; w += cw;
  }
  return out + '…';
}

/** 一行的高度：技能是"名字 + 描述"两行，其余都是一行 */
const rowH = (row) => (row.kind === 'skill' && row.desc ? 2 : 1);

export class NavPanel {
  constructor() {
    this.rect = null;
    this.tab = 0;                  // 0 Agents / 1 Skills / 2 Private
    this.scroll = 0;               // 当前页滚到第几行
    this._scroll = [0, 0, 0];      // 每页各记一份（来回切不该被对方带着滚）
    this._rows = [];               // 上一帧的行模型
    this._rowHits = [];            // [{ y, y1, x0, x1, row }]
    this._tabHits = [];            // [{ x0, x1, idx }]
    this._maxScroll = 0;
    this.sel = { 1: '', 2: '' };   // 两页各自选中的技能名（按名字记，刷新后仍认得）
    // 技能清单：按 agent 缓存。state: idle / loading / ok / err
    this.skills = { agent: '', at: 0, list: [], state: 'idle' };
    this._inFlight = false;
    // 由主装配注入（nav.js 不认识 AgentPanel，也不该认识 —— 同 agent.js 的 getPacks）
    this.getTabs = () => [];
    this.getActive = () => 0;
    this.pickTab = () => {};
  }

  layout(r) { this.rect = r; }

  // ── 当前 agent ────────────────────────────────────────────────
  /** 当前 agent = **当前对话所属的**那个（不看变量，看 active 落在谁身上 —— 见 agent.js） */
  currentAgent() {
    const tabs = this.getTabs() || [];
    const c = tabs[this.getActive()];
    return c ? c.agent : '';
  }

  /** 切标签页（点页签走这儿）。返回 true = 真的换了 */
  setTab(i) {
    if (i < 0 || i >= TABS.length || i === this.tab) return false;
    this._scroll[this.tab] = this.scroll;
    this.tab = i;
    this.scroll = this._scroll[i] || 0;
    if (this.tab !== 0) this._refreshSkills(true);
    return true;
  }

  /**
   * 取技能清单。同 agent 且没到 TTL 就什么都不做（除非 force）。
   * **失败不抛**：后端没起来时这一框显示 'library offline'，其余照常画 ——
   * 导航框不该因为一个接口挂了就整块消失。
   */
  _refreshSkills(force) {
    const agent = this.currentAgent();
    const now = Date.now();
    const st = this.skills;
    if (!force && st.agent === agent && now - st.at < SKILL_TTL) return;
    if (this._inFlight) return;
    this._inFlight = true;
    // 换 agent 了 / 一个都还没有 → 显示 loading；同一个 agent 只是过期 → 先沿用旧清单（不闪）
    if (st.agent !== agent || !st.list.length) st.state = 'loading';
    st.agent = agent;
    st.at = now;
    Promise.resolve(listSkills(agent)).then((r) => {
      // 回来的这一趟可能是给**上一个** agent 取的（中途切过去了）→ 丢掉，让下一次重取
      if (st.agent !== this.currentAgent()) { st.at = 0; return; }
      const ok = !!(r && Array.isArray(r.list));
      st.list = ok ? r.list : [];
      st.state = ok ? 'ok' : 'err';
    }).catch(() => {
      st.state = 'err';
      st.at = 0;                                // 失败别占着 TTL，下次还试
    }).finally(() => { this._inFlight = false; });
  }

  // ── 行模型：绘制与命中用同一份，别各算一遍 ──────────────────
  /**
   * 把"这一页要显示什么"拍平成行数组。每行都带 kind：绘制按 kind 画、点击按 kind 分派，
   * 两边看的是同一份数据 —— 不会出现"画在这儿、点在那儿"错一行。
   */
  _build() {
    const out = [];
    const tabs = this.getTabs() || [];
    const act = this.getActive();
    if (this.tab === 0) {
      // agent 的顺序 = 它第一次出现在标签里的顺序。**不按活跃度排**：
      // 列表一跳，刚要点的那一行就换人了。
      const order = [];
      for (const c of tabs) if (!order.includes(c.agent)) order.push(c.agent);
      for (const id of order) {
        const idxs = [];
        for (let i = 0; i < tabs.length; i++) if (tabs[i].agent === id) idxs.push(i);
        const first = tabs[idxs[0]];
        out.push({
          kind: 'agent', id, idxs, n: idxs.length,
          cur: idxs.includes(act),
          model: (first && first.llm && first.llm.model) ? String(first.llm.model) : 'local',
        });
        idxs.forEach((i, k) => {
          const c = tabs[i];
          out.push({
            kind: 'conv', idx: i, id: c.id, last: k === idxs.length - 1,
            // 标题取存档里那份（saveTitle）：title() 在没名字时会返回"新对话"这种界面文案，
            // 那句是灰的占位，扔进树里会让每个 agent 看起来都有一堆真对话
            title: c.saveTitle() || '',
            color: c.color(), cur: i === act, busy: !!c.busy,
          });
        });
      }
      return out;
    }
    // 技能两页
    const agent = this.currentAgent();
    out.push(this.tab === 2
      ? { kind: 'note', text: 'private · ' + (agent || '-') }
      : { kind: 'note', text: 'public · shared by all agents' });
    const want = this.tab === 2 ? 'private' : 'public';
    const st = this.skills;
    if (st.state === 'loading') { out.push({ kind: 'note', text: '…' }); return out; }
    if (st.state === 'err') { out.push({ kind: 'note', text: 'library offline' }); return out; }
    const list = (st.list || []).filter((s) => s.scope === want);
    if (!list.length) {
      out.push({ kind: 'note', text: want === 'public' ? 'no public skills' : 'no private skills yet' });
      // 私有那一页空着是**常态**（新 agent 一个技能都没有）→ 顺手说清它是怎么长出来的
      if (want === 'private') out.push({ kind: 'note', text: 'agents write their own via shell' });
      return out;
    }
    for (const s of list) {
      out.push({
        kind: 'skill', key: s.name, name: s.name, desc: s.description || '',
        path: s.path || '', sel: this.sel[this.tab] === s.name,
      });
    }
    return out;
  }

  // ── 绘制 ──────────────────────────────────────────────────────
  draw(g, C) {
    const r = this.rect, T = C.theme;
    if (!r || r.w < 10 || r.h < 6) return;
    if (this.tab !== 0) this._refreshSkills(false);      // 到点就顺手取一次（见 SKILL_TTL）

    const rows = this._build();
    this._rows = rows;
    const hdr = this.tab === 0
      ? (rows.filter((x) => x.kind === 'agent').length + ' agents')
      : String((this.skills.list || []).filter((s) => s.scope === (this.tab === 2 ? 'private' : 'public')).length);
    g.box(r.x, r.y, r.w, r.h, T.accent, T.panel, 'NAV', T.accent, hdr);

    const iw = r.w - 2, x = r.x + 1;
    this._drawTabs(g, T, r, x, iw);
    const sepY = r.y + 2;                                 // 页签与内容之间的一条分隔线（框内）
    g.text(x, sepY, '─'.repeat(iw), T.line, T.panel);

    const top = sepY + 1, bot = r.y + r.h - 2;            // 内容区含两端；底边线留给缩放按钮
    const vis = Math.max(0, bot - top + 1);
    // 技能页选中有东西时，最后一行留给路径
    const foot = (this.tab !== 0 && this.sel[this.tab]) ? 1 : 0;
    const listH = Math.max(1, vis - foot);

    // 滚动上限要按**实际行高**算：从末尾往前堆，能堆进 listH 的最靠前的那个下标就是上限
    let acc = 0, k = rows.length;
    while (k > 0) {
      const hh = rowH(rows[k - 1]);
      if (acc + hh > listH) break;
      acc += hh; k--;
    }
    this._maxScroll = k;
    if (this.scroll > this._maxScroll) this.scroll = this._maxScroll;
    if (this.scroll < 0) this.scroll = 0;

    this._rowHits = [];
    let y = top, i = this.scroll;
    while (i < rows.length && y < top + listH) {
      const row = rows[i], hh = rowH(row);
      if (y + hh > top + listH) break;                    // 放不下就整行不画（不画半截）
      this._rowHits.push({ y, y1: y + hh - 1, x0: x, x1: x + iw - 1, row });
      this._drawRow(g, T, x, y, iw, row);
      y += hh; i++;
    }
    // 内容超出：右边一列画条极简滚动条（没有它，看树的人不知道下面还有东西）
    if (this._maxScroll > 0) {
      const bx = r.x + r.w - 2;
      for (let n = 0; n < listH; n++) g.set(bx, top + n, '│', T.darker, T.panel);
      const totalH = rows.reduce((n, rr) => n + rowH(rr), 0);
      const barH = Math.max(1, Math.min(listH, Math.round(listH * listH / Math.max(listH, totalH))));
      const barY = top + Math.round((listH - barH) * (this.scroll / Math.max(1, this._maxScroll)));
      for (let n = 0; n < barH; n++) g.set(bx, barY + n, '█', T.dim, T.panel);
    }
    if (foot) this._drawFoot(g, T, r, bot);
  }

  /**
   * 页签：`▌Agents  Skills  Private`。
   * 框窄了就退到两字母缩写（Ag / Sk / Pv）—— 默认 34 列放得下全称，用户把左列拖窄以后
   * 硬撑着画会被右边框切掉半截，比缩写更难懂。
   */
  _drawTabs(g, T, r, x0, iw) {
    const y = r.y + 1;
    this._tabHits = [];
    for (let k = 0; k < iw; k++) g.set(x0 + k, y, ' ', T.dim, T.panel);
    const need = TABS.reduce((n, t) => n + 1 + g.strWidth(t.label), 0) + (TABS.length - 1) * 2;
    const narrow = need > iw;
    let x = x0;
    for (let i = 0; i < TABS.length; i++) {
      const on = i === this.tab;
      const label = narrow ? TABS[i].short : TABS[i].label;
      const w = 1 + g.strWidth(label);
      if (x + w > x0 + iw) break;
      const bg = on ? mix(T.panel, T.accent, 0.16) : T.panel;
      if (on) for (let k = 0; k < w; k++) g.set(x + k, y, ' ', T.accent, bg);
      g.set(x, y, on ? '█' : '▌', on ? T.accent : T.darker, bg);
      g.text(x + 1, y, label, on ? T.accent : T.dim, bg, on ? ATTR.BOLD : 0);
      this._tabHits.push({ x0: x, x1: x + w - 1, idx: i });
      x += w + 2;
    }
  }

  _drawRow(g, T, x, y, iw, row) {
    const bg = T.panel;
    g.fill(x, y, iw, 1, ' ', T.text, bg);
    if (row.kind === 'note') { g.text(x, y, fit(g, row.text, iw), T.darker, bg); return; }

    if (row.kind === 'agent') {
      // ▾ = tree 的展开箭头（永远展开：用户要的就是"tree 指令的输出"）
      const idf = row.cur ? T.accent : T.text;
      g.set(x, y, '▾', row.cur ? T.accent : T.dim, bg);
      g.text(x + 2, y, row.id, idf, bg, row.cur ? ATTR.BOLD : 0);
      const cnt = String(row.n);
      const cx = x + iw - g.strWidth(cnt);              // 数量靠右（一眼能比大小）
      g.text(cx, y, cnt, row.cur ? T.accent : T.dim, bg);
      const mw = cx - 2 - (x + 2 + g.strWidth(row.id));  // 模型名剩多少列
      if (mw > 2) g.text(x + 2 + g.strWidth(row.id) + 1, y, fit(g, row.model, mw), T.dim, bg);
      return;
    }

    if (row.kind === 'conv') {
      // 树线 `  ├ ` / `  └ `；色标 = 它在 AGENT 标签栏里的那个颜色（同一个对话到哪儿都同色）
      g.text(x, y, '  ' + (row.last ? '└' : '├') + ' ', T.darker, bg);
      g.set(x + 4, y, row.cur ? '█' : '▄', row.color, bg);
      let tx = x + 6;
      if (row.busy) { g.set(tx, y, '•', T.warn, bg); tx += 2; }   // 后台还在吐字
      g.text(tx, y, fit(g, row.title || '(empty)', x + iw - tx),
        row.cur ? row.color : T.dim, bg, row.cur ? ATTR.BOLD : 0);
      return;
    }

    if (row.kind === 'skill') {
      const bg2 = row.sel ? mix(T.panel, T.accent, 0.12) : bg;
      if (row.sel) g.fill(x, y, iw, rowH(row), ' ', T.text, bg2);
      g.set(x, y, row.sel ? '█' : '▌', row.sel ? T.accent : T.darker, bg2);
      g.text(x + 1, y, fit(g, row.name, iw - 1), row.sel ? T.accent : T.text, bg2,
        row.sel ? ATTR.BOLD : 0);
      if (rowH(row) === 2) {
        g.text(x + 2, y + 1, fit(g, row.desc, iw - 2), T.dim, bg2);
      }
    }
  }

  /** 技能页脚：选中那个技能的**完整路径**（树里学不到、但真要用时得抄的那一条） */
  _drawFoot(g, T, r, bot) {
    const x = r.x + 1, iw = r.w - 2;
    g.fill(x, bot, iw, 1, ' ', T.text, T.panel);
    const s = (this.skills.list || []).find((v) => v.name === this.sel[this.tab]);
    const path = s ? String(s.path || '') : '';
    if (!path) return;
    // 太长就留尾巴：前面是各库共有的前缀，末尾那两段才是"哪个技能的哪一份"
    let shown = path;
    if (g.strWidth(shown) > iw) {
      let out = '', w = 0;
      for (const ch of Array.from(path).reverse()) {
        const cw = g.chWidth(ch);
        if (w + cw > iw - 1) break;
        out = ch + out; w += cw;
      }
      shown = '…' + out;
    }
    g.text(x, bot, shown, T.accentDim, T.panel);
  }

  // ── 交互 ──────────────────────────────────────────────────────
  onWheel(dy) {
    if (!this._maxScroll) return false;
    const d = dy > 0 ? 1 : -1;
    const next = Math.max(0, Math.min(this._maxScroll, this.scroll + d));
    if (next === this.scroll) return true;      // 到底了也算"这一框收下了"（别让地球跟着滚）
    this.scroll = next;
    this._scroll[this.tab] = next;
    return true;
  }

  /** 鼠标点一下（格子坐标）。返回 true = 这一下归 NAV 管 */
  onClick(cx, cy) {
    const r = this.rect;
    if (!r || !this._inBox(cx, cy)) return false;
    if (cy === r.y + 1) {
      for (const h of this._tabHits) if (cx >= h.x0 && cx <= h.x1) { this.setTab(h.idx); return true; }
      return true;
    }
    for (const h of this._rowHits) {
      if (cy < h.y || cy > h.y1 || cx < h.x0 || cx > h.x1) continue;
      const row = h.row;
      if (row.kind === 'conv') { this.pickTab(row.idx); return true; }
      // 点 agent 那一行 = 切到它**最近用过的那个**对话（标签顺序里最后那个）
      if (row.kind === 'agent') { this.pickTab(row.idxs[row.idxs.length - 1]); return true; }
      if (row.kind === 'skill') { this.sel[this.tab] = row.sel ? '' : row.key; return true; }
      return true;
    }
    return true;                                // 框内空白处：吃掉，别落到别处
  }

  _inBox(cx, cy) {
    const r = this.rect;
    return !!r && cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h;
  }
}
