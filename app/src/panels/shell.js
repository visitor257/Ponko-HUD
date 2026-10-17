// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// SHELL：真命令执行（后端持久 pwsh 会话，cd / 变量都保留）
//
// 两种渲染模式：
//   · 管道模式（默认）：后端持久会话逐行回传，中文/退出码/cwd 都稳
//   · PTY 模式：命中交互式程序（python/node/ssh…）或输入 `pty <cmd>` 时切到 ConPTY
//     真终端，输出是 ANSI 流，交给 vt.js 维护屏幕缓冲后按格渲染（颜色/光标/全屏都对）
//
// 多标签（对齐 eDEX-UI 的终端标签）：ShellTab = 一个标签的全部状态，ShellPanel = 标签栏 +
// 当前标签。每个标签在后端是一个独立的会话（自己的持久 pwsh、cwd、shell 种类、PTY），
// 后台标签的 PTY 流也不退订 —— 切回来屏幕内容、滚屏位置都还在。
import { ATTR, mix } from '../grid.js';
import { TAB_COLORS } from '../tabcolors.js';
import { runShell, abortShell, ptyWrite, ptyResize, ptyStop, ptyClose, ptyStream, shellState,
  completeShell } from '../api.js';
// 只为了 `lang` 这条面板命令：它要报"现在是什么语言 / 有哪些可选 / 切过去"。
// 语言清单只有 i18n 那份（availableLangs），这里不另抄一张表。
import { availableLangs, langOf, useLang, t } from '../i18n/index.js';
import { VT, cellColor } from '../vt.js';

const MAX_TABS = TAB_COLORS.length;      // 上限 = 色板容量（每个标签一个独有色）

// ── 一个标签：所有状态都在实例上，标签之间互不共享 ────────────────────────
export class ShellTab {
  constructor(mood, id, ci) {
    this.mood = mood;
    this.id = id;              // 后端会话 id（也是 /api/shell、/api/pty 的 session）
    this.ci = ci;              // 色标下标 —— 这个标签的"身份色"，替代原来的数字编号
    this.lines = [];           // {kind:'cmd'|'out'|'err'|'info', text}
    this.cwd = 'C:\\';
    this.busy = false;
    this.scroll = 0;
    this.input = '';
    this.caret = 0;
    this.focus = false;
    this.rect = null;
    this._cancel = null;
    this.kind = 'pwsh';            // pwsh | cmd（由后端同步）
    this.onLine = null;            // 输出钩子（主装配拿它扫 IP 往地球上打标记）
    this.onDead = null;            // 会话被收掉（用户在 shell 里 exit 了）→ 由面板关掉这个标签
    this.pty = null;               // {vt, off, scroll} —— 非 null 即真终端模式
    this._ptyLabel = '';           // 真终端里跑的程序名（显示用）
    this._lastCmd = '';            // 最近一条命令（用来给真终端取名字）
    this._resizeAt = 0;
    this.hist = [];                // 管道模式本地命令历史（↑/↓ 浏览）
    this.histIdx = -1;             // -1 = 未在浏览历史
    this.histDraft = '';           // 进入浏览前正在编辑的草稿
    this._histShown = null;        // 上次由 ↑/↓ 填进输入框的内容（判断用户是否又改了）
    this.pushT('info', 'ui.shell.welcome');
    this.refreshState();
  }

  /** 拉一次后端真实状态：会话实际起始目录是 USERPROFILE，前端默认写的 C:\ 是错的 */
  refreshState() {
    return shellState(this.id).then((s) => {
      if (s && s.cwd) this.cwd = s.cwd;
      if (s && s.shell) this.kind = s.shell || 'pwsh';
    }).catch(() => { /* 后端没起来就先用默认 C:\，不影响功能 */ });
  }

  /** 本标签的颜色（标签栏色标、顶线小方块都用它认标签） */
  color() { return TAB_COLORS[this.ci % TAB_COLORS.length]; }

  /** 标签栏上的名字：真终端就显示程序名 */
  title() {
    if (this.pty) return this._ptyLabel || 'term';
    return this.kind === 'cmd' ? 'cmd' : 'pwsh';
  }

  /** 关标签时调用：退订、中止、让后端回收整个会话（连 pwsh 子进程一起） */
  dispose() {
    try { this._cancel && this._cancel(); } catch (e) { /* 已经结束了 */ }
    try { this.pty && this.pty.off && this.pty.off(); } catch (e) { /* 流已经断了 */ }
    this.pty = null;
    this._cancel = null;
    ptyClose(this.id);
  }

  // ── PTY：真终端 ────────────────────────────────────────
  inPty() { return !!this.pty; }

  async enterPty(cmd) {
    if (this.pty) { if (cmd) ptyWrite(cmd + '\r', this.id); return; }
    const vt = new VT(100, 24);
    const off = ptyStream(this.id,
      (e) => {
        if (e.t === 'out') { vt.write(e.text || ''); if (this.onLine) this.onLine(e.text || ''); }
        else if (e.t === 'exit') this.leavePty('ui.shell.ptyExit');
        else if (e.t === 'error') this.pushT('err', 'ui.shell.ptyError', { msg: e.msg || t('ui.shell.unknownError') });
      },
      () => { /* 流断即视为会话结束 */ },
    );
    this.pty = { vt, off, scroll: 0 };
    // 会话由后端拉起（后端才知道该喂什么命令），前端只连流 + 同步尺寸
    if (cmd) setTimeout(() => ptyWrite(cmd + '\r', this.id), 1500);
  }

  /**
   * 退出真终端。reason 传**语言包 key**（'ui.shell.ptyExit' 之类），不传就落到默认那句 ——
   * 存 key 才能让这行在切语言后跟着重译（见 pushT / retranslate）。
   */
  leavePty(reason) {
    if (!this.pty) return;
    try { this.pty.off && this.pty.off(); } catch (e) {}
    this.pty = null;
    this.ime = null;
    this._ptyLabel = '';
    ptyStop(this.id);
    // 退出真终端后重新拉一次后端状态，保证 shell 种类/cwd 跟后端一致（cmd/pwsh 不同步过）
    this.refreshState();
    this.pushT('info', reason || 'ui.shell.leftPty');
  }

  /** 真终端里的按键：整行提交 + 回车；程序自己负责回显 */
  sendToPty(text) {
    if (!this.pty) return;
    ptyWrite(text + '\r', this.id);
  }

  /** 按键直通：可打印字符（含中文 IME 结果）。粘贴的多行按终端惯例换成回车。 */
  ptyType(text) {
    if (!this.pty || !text) return;
    ptyWrite(String(text).replace(/\r?\n/g, '\r'), this.id);
  }

  /** 按键直通：控制序列原始字节（\x03 / \x1b[A / \x7f …） */
  ptyKey(seq) {
    if (!this.pty || !seq) return;
    ptyWrite(seq, this.id);
  }

  get prompt() { return this.kind === 'cmd' ? `${this.cwd}>` : `PS ${this.cwd}> `; }

  /**
   * 记一行**程序输出/命令回显** —— 那是数据，不翻，原样显示。
   * 界面自己说的话（欢迎语、帮助、报错话术）走 pushT()：存 key，切语言时能整屏重译。
   */
  push(kind, text) {
    for (const l of String(text === undefined || text === null ? '' : text).split('\n')) {
      this.lines.push({ kind, text: l });
      if (this.onLine) { try { this.onLine(l); } catch (e) { /* 钩子炸了不能拖垮面板 */ } }
    }
    if (this.lines.length > 500) this.lines.splice(0, this.lines.length - 500);
    this.scroll = 0;
  }

  /**
   * 记一行**界面文案**：存 key + 参数，不存成品句子。
   * 成品句子一旦推进行缓冲就定死了，切语言只有"以后新推的行"会变、老行留在旧语言里 ——
   * 屏幕上就是半中半英。存 key 才有 retranslate() 这条回头路。
   * （启动日志那套也是同一个思路，见 server/bootlog.js：存事件 id + 参数。）
   */
  pushT(kind, key, args) {
    const s0 = t(key, args);
    for (const l of String(s0).split('\n')) {
      this.lines.push({ kind, text: l, k: key, a: args });
      if (this.onLine) { try { this.onLine(l); } catch (e) { /* 同上 */ } }
    }
    if (this.lines.length > 500) this.lines.splice(0, this.lines.length - 500);
    this.scroll = 0;
  }

  /** 语言变了：把带 key 的历史行重译一遍（真程序输出的行没有 key，原样不动） */
  retranslate() {
    for (const l of this.lines) if (l.k) l.text = t(l.k, l.a);
  }

  /**
   * `lang` —— 看语言 / 换语言（面板内置命令，见 exec 里的截获点）。
   *   lang            → 当前 lang_id + 用法 + 可切换的 lang_id（**一个一行**）
   *   lang <lang_id>  → 切过去（**当场整屏重译，不用重开**；偏好写进浏览器，下次开还是它）
   * 认不出的 id **不切**（useLang 返回 false）—— 把可选清单再列一遍，
   * 免得打错一个字就"看起来什么都没发生"。
   * 只列 id、**不解释每个 id 是哪种语言**（用户 2026-10-13 定的）：id 本身就是给
   * 打命令的人看的标识，多一列语言名只是噪声。语言名留给以后的选择界面。
   */
  langCmd(c) {
    const ids = availableLangs().map((l) => l.id);
    const arg = c === 'lang' ? '' : c.split(/[ \t]+/)[1].toLowerCase();
    // id 是**标识**不是文案（`zh-cn` / `en` / `ja`），逐行原样列出，不翻、也不解释是哪种语言
    if (!arg) {
      this.pushT('info', 'ui.shell.langCurrent', { id: langOf() });
      for (const id of ids) this.push('info', id);
      return;
    }
    if (!useLang(arg)) {
      this.pushT('err', 'ui.shell.langBad', { id: arg });
      for (const id of ids) this.push('info', id);
      return;
    }
    this.pushT('info', 'ui.shell.langDone', { id: arg });
  }

  async exec(cmd) {
    if (this.busy) return;
    const c = cmd.trim();
    this.push('cmd', c);
    if (!c) return;
    if (this.pty) { this.sendToPty(c); return; }   // 真终端里：整行发进去，由程序自己回显
    // 记入命令历史（与上一条相同则不重复记）；↑/↓ 用它回翻
    if (this.hist[this.hist.length - 1] !== c) this.hist.push(c);
    this.histIdx = -1; this.histDraft = ''; this._histShown = null;
    if (c === 'clear' || c === 'cls') { this.lines.length = 0; return; }
    // 用 ponko-help 而不是 help：后者会盖掉 PowerShell 的 help（Get-Help）与 CMD 的 help.exe，
    // 而本面板的非 PTY 模式下内置命令是优先拦截的，原生那条就永远执行不到。
    // 语言：`lang` 报当前 + 用法 + 可选清单，`lang <id>` 切过去。
    // 跟 clear / ponko-help 一样是**面板自己的命令**（真 shell 里没有 lang 这一条），
    // 所以在这里截住、不发给后端。只认"整条恰好是 lang 或 lang <一个词>"——
    // `lang a b` 这种当普通命令送下去，绝不吞用户打的东西。
    if (c === 'lang' || /^lang[ \t]+\S+$/.test(c)) {
      this.langCmd(c);
      return;
    }
    if (c === 'ponko-help') {
      this.pushT('info', 'ui.shell.help.title');
      this.pushT('info', 'ui.shell.help.shell', { kind: this.kind === 'cmd' ? 'CMD' : 'PowerShell' });
      this.pushT('info', 'ui.shell.help.cmd');
      this.pushT('info', 'ui.shell.help.exit');
      this.pushT('info', 'ui.shell.help.clear');
      this.pushT('info', 'ui.shell.help.lang');
      this.pushT('info', 'ui.shell.help.pty');
      this.pushT('info', 'ui.shell.help.keys');
      this.pushT('info', 'ui.shell.help.tabs');
      this.pushT('info', 'ui.shell.help.tabs2');
      this.pushT('info', 'ui.shell.help.agent');
      this.pushT('info', 'ui.shell.help.agent2');
      this.pushT('info', 'ui.shell.help.agent3');
      this.pushT('info', 'ui.shell.help.boot');
      return;
    }
    this.busy = true;
    // 命令成败是事实，不是情绪——是否反映到心情上由 agent 决定
    // （想让 shell 反向影响时加 ?local=1，或直接改 mood.localSignals）
    this._cancel = runShell(c, (e) => {
      if (e.t === 'out') this.push('out', e.text);
      else if (e.t === 'err') this.push('err', e.text);
      else if (e.t === 'cwd') this.cwd = e.text;
      else if (e.t === 'shell') this.kind = e.text || 'pwsh';
      else if (e.t === 'pty') {                    // 后端开好真终端了，前端切渲染模式
        // 给真终端取个名字：'python' / 'pty python' / 'pty pwsh' 都取到程序名
        this._ptyLabel = String(c).replace(/^!?pty\s+/i, '').split(/\s+/)[0] || '';
        this.enterPty();
        this.busy = false;
        return;
      }
      else if (e.t === 'dead') {           // 后端把会话收了（用户执行了 exit）：标签寿终正寝
        this.busy = false;
        if (this.onDead) this.onDead(this);
      }
      else if (e.t === 'exit') {
        this.busy = false;
        if (e.code !== 0) {
          if (e.error === 'timeout') this.pushT('err', 'ui.shell.timeout');
          else this.pushT('err', 'ui.shell.exitCode', { code: e.code });
          if (this.mood.localSignals) this.mood.fromLocal('error', 'ui.shell.cmdFailed');
        }
      } else if (e.t === 'error') {
        this.busy = false;
        this.push('err', e.text);                 // 后端给的错误原文 —— 数据，不翻
        if (this.mood.localSignals) this.mood.fromLocal('error', 'ui.shell.shellError');
      }
    }, undefined, this.id);
  }

  abort() {
    if (this.pty) { ptyWrite('\x03', this.id); return; }   // 真终端里：^C 就是中断当前程序
    if (!this.busy) return;
    abortShell(this.id);
    try { this._cancel && this._cancel(); } catch (e) {}
    this.busy = false;
    this.pushT('info', 'ui.shell.interrupted');
  }

  /** ↑ / ↓：真终端里交给程序（命令历史），管道模式里翻本地命令历史（滚屏交给鼠标滚轮） */
  onArrow(dir) {
    if (this.pty) { ptyWrite(dir > 0 ? '\x1b[A' : '\x1b[B', this.id); return true; }
    if (!this.hist.length) return true;
    // 用户又改了输入（跟上次回翻填进去的不一样）→ 重新开始浏览
    if (this.histIdx === -1 || this.input !== this._histShown) {
      this.histDraft = this.input;
      this.histIdx = this.hist.length;
    }
    if (dir > 0) { if (this.histIdx > 0) this.histIdx--; }             // ↑ 往旧翻
    else { if (this.histIdx < this.hist.length) this.histIdx++; }      // ↓ 往新翻
    this.input = this.histIdx >= this.hist.length ? this.histDraft : this.hist[this.histIdx];
    this._histShown = this.input;
    this.caret = this.input.length;
    return true;
  }

  /**
   * Tab 补全（**只在管道模式**：真终端里 Tab 是原样发给程序的 —— `pty pwsh` / `pty python`
   * 的补全由那个程序自己做，权限比我们大得多，这里别去抢）。
   *
   * 为什么要问后端：管道模式下 cwd 底下有什么，前端根本不知道（浏览器没有文件系统）。
   * 后端拿**会话里那份 cwd**（不是前端这份可能还没同步的镜像）列目录 + 扫 PATH 出命令名，
   * 回候选和"这个词在行里的替换范围"；插入、公共前缀、候选太多时列出来，都在这一层做。
   *
   * @returns {Promise<boolean>} 输入行或屏幕有没有变化（false = 没补出东西，调用方别白同步）
   */
  async tabComplete() {
    if (this.pty) return false;
    const line = this.input;
    const caret = Math.max(0, Math.min(this.caret, line.length));
    let r = null;
    try { r = await completeShell(this.id, line, caret); } catch (e) { return false; }
    if (!r || !r.ok || !Array.isArray(r.items) || !r.items.length) return false;
    // 等回包这几毫秒里用户又打字了 → 这份结果已经过期，丢掉（宁可这次不补，也不能把字吞了）
    if (this.input !== line || this.caret !== caret) return false;

    const q = r.quote || '';
    // 引号要包回去（`cd "My Doc"` 补完不能把引号丢了）；没引号但结果里带空格 → 自己补一对
    const wrap = (s) => (q ? q + s + q : (/\s/.test(s) ? '"' + s + '"' : s));

    let ins = '';
    if (r.items.length === 1) {
      ins = wrap(r.items[0]);
      // 文件补完接一个空格（这个参数打完了）；目录不接 —— 结尾那个 `\` 就是"进这一层"，
      // 接着按 Tab 就能继续往里补，多一个空格反而把路径截断了。
      if (!/\\$/.test(r.items[0])) ins += ' ';
    } else if (r.common && r.common.length > r.prefix.length) {
      ins = wrap(r.common);            // 有更长的公共前缀就先进到那一层，候选另外列出来
    }
    if (ins) {
      this.input = line.slice(0, r.start) + ins + line.slice(r.end);
      this.caret = r.start + ins.length;
    }
    if (r.items.length > 1) this._listCandidates(r.items);
    return !!ins || r.items.length > 1;
  }

  /**
   * 把候选铺成几行推上去（按估算宽度分栏；中文按两列算）。
   * 只是"给你看看有哪些"，点不动也选不了 —— 真正的补全是再打几个字再按 Tab。
   * 超过 100 个只列前 100（`C:` 底下那种上千项全铺上去会淹掉整个屏幕）。
   */
  _listCandidates(items) {
    const CAP = 100;
    const list = items.length > CAP ? items.slice(0, CAP) : items;
    const width = (s) => { let n = 0; for (const ch of s) n += (ch.codePointAt(0) || 0) > 0x2e7f ? 2 : 1; return n; };
    const maxW = Math.max(...list.map(width)) + 2;
    const lineW = Math.max(20, (this.rect ? this.rect.w - 2 : 80));
    const per = Math.max(1, Math.floor(lineW / maxW));
    for (let i = 0; i < list.length; i += per) {
      const row = list.slice(i, i + per)
        .map((s) => s + ' '.repeat(Math.max(0, maxW - width(s))))
        .join('').replace(/\s+$/, '');
      this.push('info', row);
    }
    if (items.length > CAP) this.push('info', '…');
  }

  /** 面板主体（不含外框：外框由 ShellPanel 画，标签栏在框外顶部） */
  body(g, C) {
    const r = this.rect, T = C.theme;
    if (!r || r.w < 8 || r.h < 4) return;
    if (this.pty) return this.drawPty(g, C);

    const x = r.x + 1, iw = r.w - 2;
    const viewH = r.h - 3;                 // 留 1 行输入
    const prompt = this.prompt;
    const indent = '  ';

    // 可见行（从底部往上排）
    const items = [];
    for (const l of this.lines) {
      const pre = l.kind === 'cmd' ? prompt : indent;
      const full = pre + l.text;
      const n = Math.max(1, Math.ceil(g.strWidth(full) / iw));
      for (let i = 0; i < n; i++) {
        items.push({ text: full.slice(i * iw, (i + 1) * iw), kind: l.kind, first: i === 0 });
      }
    }
    const start = Math.max(0, items.length - viewH - this.scroll);
    let y = r.y + 1;
    for (let i = start; i < Math.min(items.length, start + viewH); i++) {
      const it = items[i];
      const col = it.kind === 'cmd' ? T.accent
        : it.kind === 'err' ? T.err
        : it.kind === 'info' ? T.dim : T.text;
      g.text(x, y, it.text, col, T.panel);
      y++;
    }
    while (y < r.y + r.h - 2) { g.text(x, y, ' '.repeat(iw), T.text, T.panel); y++; }

    // 输入行
    const iy = r.y + r.h - 2;
    let cx = g.text(x, iy, prompt, T.accent, T.panel);
    const maxLen = Math.max(1, r.x + r.w - 1 - cx - 1);
    // 长命令把光标推进可视区内：窗口跟着 caret 滑，而不是永远从头开始截断
    const caret = Math.max(0, Math.min(this.caret, this.input.length));
    const off = Math.max(0, caret - maxLen + 1);
    const tx0 = cx;
    g.text(tx0, iy, this.input.slice(off, off + maxLen), T.text, T.panel);
    // 光标必须画在 caret 对应的那一列（原来直接拿 g.text 的返回列 = 永远贴末尾）
    if (this.focus && Math.floor(C.t * 2) % 2 === 0) {
      const col = tx0 + g.strWidth(this.input.slice(off, caret));
      if (col < r.x + r.w - 1) g.set(col, iy, '█', T.accent, T.accent);
    }
  }

  /** 真终端渲染：逐格把 VT 屏幕缓冲画进网格（保留程序自己的颜色） */
  drawPty(g, C) {
    const r = this.rect, T = C.theme, p = this.pty, vt = p.vt;
    const x = r.x + 1, iw = r.w - 2, viewH = r.h - 2;

    // 面板尺寸变了（拖动分割条 / 窗口缩放）要同步给 PTY，否则换行位置不对
    if (vt.cols !== iw || vt.rows !== viewH) {
      vt.resize(iw, viewH);
      const now = Date.now();
      if (now - this._resizeAt > 400) { this._resizeAt = now; ptyResize(iw, viewH, this.id); }
    }

    const start = Math.max(0, vt.totalLines - viewH - p.scroll);
    let hasContent = false;                // 启动阶段（pwsh 还没吐字）给个提示，别让面板干等
    for (let row = 0; row < viewH; row++) {
      const line = vt.line(start + row);
      let cx = x;
      const yy = r.y + 1 + row;
      for (let col = 0; col < iw && cx < r.x + r.w - 1; col++) {
        const cell = line ? line[col] : null;
        const ch = cell ? cell.ch : ' ';
        if (ch !== ' ' && ch !== '') hasContent = true;
        const fg = cell ? (cellColor(cell.fg) || T.text) : T.text;
        const bg = cell ? (cellColor(cell.bg) || T.panel) : T.panel;
        g.set(cx, yy, ch, fg, bg, cell && cell.bold ? ATTR.BOLD : 0);
        const w = g.chWidth(ch);
        for (let k = 1; k < w; k++) g.set(cx + k, yy, '', fg, bg);
        cx += w;
      }
      while (cx < r.x + r.w - 1) { g.set(cx, yy, ' ', T.text, T.panel); cx++; }
    }
    if (!hasContent) {
      g.text(x + 2, r.y + 1 + (viewH >> 1),
        this._ptyLabel ? t('ui.shell.startingPtyNamed', { name: this._ptyLabel }) : t('ui.shell.startingPty'),
        T.dim, T.panel);
      g.text(x + 2, r.y + 2 + (viewH >> 1), t('ui.shell.ptyHint'), T.darker, T.panel);
    }

    // IME 合成中：拼音预览画在光标处（还没发进程序，只是让你看见自己正在打什么）
    const absY0 = vt.scrollback.length + vt.y;
    if (this.ime && !p.scroll && absY0 >= start && absY0 < start + viewH) {
      g.text(x + vt.x, r.y + 1 + (absY0 - start), this.ime, T.accent, T.panel);
    }

    // 光标：只在"当前屏"且可视时画
    const absY = vt.scrollback.length + vt.y;
    if (!p.scroll && absY >= start && absY < start + viewH) {
      const cy = r.y + 1 + (absY - start);
      const cell = vt.line(absY) ? vt.line(absY)[vt.x] : null;
      const ch = cell && cell.ch !== ' ' ? cell.ch : ' ';
      const blink = Math.floor(C.t * 2) % 2 === 0;
      g.set(x + vt.x, cy, blink ? ch : ' ', T.panel, blink ? T.accent : T.panel);
    }
  }

  onWheel(d) {
    if (this.pty) {
      const vt = this.pty.vt;
      this.pty.scroll = Math.max(0, Math.min(Math.max(0, vt.totalLines - this.rect.h + 2),
        this.pty.scroll + (d > 0 ? -1 : 1)));
      return true;
    }
    this.scroll = Math.max(0, Math.min(400, this.scroll + (d > 0 ? -1 : 1)));
    return true;
  }
}

// ── 面板：标签栏 + 当前标签（对外 API 与单标签时代完全一致，主装配不用改）──
export class ShellPanel {
  constructor(mood) {
    this.mood = mood;
    this.rect = null;
    this.tabs = [];
    this.active = 0;
    this._focus = false;
    this._onLine = null;
    this._tabHits = [];        // 最近一帧标签栏的命中区 [{x0,x1,idx}]，idx=-1 是“+”
    this._seq = 0;
    this._colorSeq = 0;        // 下一个要派的色（轮转，但先跳过正在用的）
    this.newTab();
    this._reapStale();
  }

  // ── 当前标签 ──
  get tab() { return this.tabs[this.active] || null; }
  _nextId() { return 't' + (++this._seq) + Math.random().toString(36).slice(2, 6); }

  /**
   * 页面刚加载时，后端可能还挂着上次刷新遗留的标签会话（每个都占一个 pwsh/PTY 子进程）。
   * 把不是本页的、以 't' 开头的会话收掉；默认会话 '0' 不动（老路径还在用）。
   */
  async _reapStale() {
    try {
      const r = await fetch('/api/sessions').then((x) => x.json());
      const mine = new Set(this.tabs.map((t) => t.id));
      for (const s of (r && r.sessions) || []) {
        if (/^t/.test(s.id) && !mine.has(s.id)) ptyClose(s.id);
      }
    } catch (e) { /* 后端没起来就算了 */ }
  }

  // ── 转发给当前标签的属性（主装配按老接口用，不用感知多标签）──
  get focus() { return this._focus; }
  set focus(v) {
    this._focus = !!v;
    for (const t of this.tabs) t.focus = this._focus && t === this.tab;
  }

  get onLine() { return this._onLine; }
  set onLine(fn) { this._onLine = fn; for (const t of this.tabs) t.onLine = fn; }

  get input() { return this.tab ? this.tab.input : ''; }
  set input(v) { if (this.tab) this.tab.input = v; }
  get caret() { return this.tab ? this.tab.caret : 0; }
  set caret(v) { if (this.tab) this.tab.caret = v; }
  get ime() { return this.tab ? this.tab.ime : null; }
  set ime(v) { if (this.tab) this.tab.ime = v; }
  get prompt() { return this.tab ? this.tab.prompt : ''; }
  get kind() { return this.tab ? this.tab.kind : 'pwsh'; }
  get cwd() { return this.tab ? this.tab.cwd : ''; }
  get lines() { return this.tab ? this.tab.lines : []; }
  get busy() { return this.tab ? this.tab.busy : false; }

  // ── 转发给当前标签的方法 ──
  layout(r) { this.rect = r; this._syncRect(); }
  inPty() { return !!(this.tab && this.tab.inPty()); }
  exec(text) { return this.tab ? this.tab.exec(text) : undefined; }
  abort() { if (this.tab) this.tab.abort(); }
  sendToPty(t) { if (this.tab) this.tab.sendToPty(t); }
  ptyType(t) { if (this.tab) this.tab.ptyType(t); }
  ptyKey(s) { if (this.tab) this.tab.ptyKey(s); }
  leavePty(reason) { if (this.tab) this.tab.leavePty(reason); }
  enterPty(cmd) { return this.tab ? this.tab.enterPty(cmd) : undefined; }
  onArrow(dir) { return this.tab ? this.tab.onArrow(dir) : true; }
  tabComplete() { return this.tab ? this.tab.tabComplete() : Promise.resolve(false); }
  onWheel(d) { return this.tab ? this.tab.onWheel(d) : false; }
  push(kind, text) { if (this.tab) this.tab.push(kind, text); }
  pushT(kind, key, args) { if (this.tab) this.tab.pushT(kind, key, args); }
  /** 语言变了：**所有**标签（含后台标签）的历史行都要重译，不只是当前那个 */
  retranslate() { for (const tab of this.tabs) tab.retranslate(); }

  /**
   * 取一个当前没人用的颜色（全占满才复用）。
   * 关键是"不按位置分配"：关掉中间某个标签时，剩下的颜色不会跟着重排，
   * 否则"那个颜色 = 那个标签"的对应关系就断了，刚建立起的肌肉记忆也废了。
   */
  _pickColor() {
    const used = new Set(this.tabs.map((t) => t.ci));
    for (let k = 0; k < TAB_COLORS.length; k++) {
      const ci = (this._colorSeq + k) % TAB_COLORS.length;
      if (!used.has(ci)) { this._colorSeq = (ci + 1) % TAB_COLORS.length; return ci; }
    }
    return this._colorSeq++ % TAB_COLORS.length;
  }

  // ── 标签管理 ──
  newTab() {
    if (this.tabs.length >= MAX_TABS) return null;
    const t = new ShellTab(this.mood, this._nextId(), this._pickColor());
    t.onLine = this._onLine;
    t.onDead = (tab) => this._onTabDead(tab);
    this.tabs.push(t);
    this.active = this.tabs.length - 1;
    this._syncRect();
    this.syncFocus();
    return t;
  }

  selectTab(i) {
    if (typeof i !== 'number' || i < 0 || i >= this.tabs.length) return false;
    if (i === this.active) return false;
    this.active = i;
    this.syncFocus();
    return true;
  }

  /** dir>0 下一个，dir<0 上一个（循环） */
  nextTab(dir) {
    const n = this.tabs.length;
    if (n < 2) return false;
    this.active = (this.active + (dir > 0 ? 1 : -1) + n) % n;
    this.syncFocus();
    return true;
  }

  /**
   * 标签里的 shell 会话自己结束了（用户在里面执行了 exit）。
   * 跟 closeTab 的语义不一样：closeTab 是 UI 上"关掉这个标签"，所以保护最后一个；
   * 这里关的是"会话"——最后一个也没关系，关完自动补一个新的，面板不能空着没法用。
   */
  _onTabDead(tab) {
    const k = this.tabs.indexOf(tab);
    if (k < 0) return;
    try { tab.dispose(); } catch (e) { /* 可能已经清过了 */ }
    this.tabs.splice(k, 1);
    if (this.tabs.length === 0) { this.newTab(); return; }   // newTab 内部会 syncFocus/_syncRect
    if (k < this.active) this.active--;
    if (this.active >= this.tabs.length) this.active = this.tabs.length - 1;
    this.syncFocus();
    this._syncRect();
  }

  /**
   * UI 语义地关掉一个标签（保护最后一个 —— 面板不能空着）。
   * 现在**没有键位入口**：^⇧W 已按用户要求删掉，关标签是在那个标签里打 `exit`
   * （走的是会话语义 _onTabDead，最后一个也会照关并自动补新的）。这条留着是因为
   * "想关掉某个标签"和"那个 shell 自己结束了"是两件事（见 _onTabDead 的说明），
   * 以后要加鼠标上的关闭入口（标签上的 ×）时接的就是它。
   */
  closeTab(i) {
    if (this.tabs.length <= 1) return false;            // 留最后一个，别把面板清空
    const k = (i === undefined || i === null) ? this.active : i;
    if (k < 0 || k >= this.tabs.length) return false;
    this.tabs[k].dispose();
    this.tabs.splice(k, 1);
    if (k < this.active) this.active--;
    if (this.active >= this.tabs.length) this.active = this.tabs.length - 1;
    this.syncFocus();
    return true;
  }

  /** 命中标签栏：返回标签下标；-1 = “+”新建；null = 没点标签栏 */
  tabAt(x, y) {
    for (const h of this._tabHits) if (x >= h.x0 && x <= h.x1) return h.idx;
    return null;
  }

  /** 标签栏在 SHELL 框**外**：紧贴在框顶线上面那一行 */
  tabBarRow() { return this.rect ? this.rect.y - 1 : -1; }

  syncFocus() {
    for (const t of this.tabs) t.focus = this._focus && t === this.tab;
    this._syncRect();
  }

  _syncRect() {
    const r = this.rect;
    if (!r) return;
    // 标签栏搬到框外了 → 框内空间整块还给终端正文（tab.rect = 整框）
    for (const t of this.tabs) t.rect = { x: r.x, y: r.y, w: r.w, h: r.h };
  }

  draw(g, C) {
    const r = this.rect, T = C.theme;
    if (!r || r.w < 12 || r.h < 4) return;
    g.box(r.x, r.y, r.w, r.h, this._focus ? T.accent : T.line, T.panel, 'SHELL', T.accent);
    this._drawTabMarks(g, C, r);
    const tab = this.tab;
    if (tab) { tab.rect = { x: r.x, y: r.y, w: r.w, h: r.h }; tab.focus = this._focus; tab.body(g, C); }
  }

  /**
   * 框顶线右端：每个标签一个属于自己的小方块（当前那个点亮成实心），
   * 取代原先的 "2/3" 数字编号 —— 认标签靠颜色，"是第几个"本来就没意义。
   */
  _drawTabMarks(g, C, r) {
    const T = C.theme, n = this.tabs.length;
    if (n < 1) return;
    const need = n * 2 - 1;                      // 方块之间空一格
    const x0 = (r.x + r.w - 1) - need;           // 右端对齐，最右一列留给 '┐'
    const titleEnd = r.x + 2 + g.strWidth('SHELL');
    if (x0 <= titleEnd + 1) return;              // 框太窄就别画了，不能压到标题
    for (let i = 0; i < n; i++) {
      const on = i === this.active;
      const x = x0 + i * 2;
      const col = this.tabs[i].color();
      // 颜色就是身份，别再压暗：只要实心/半块就能分出是不是当前标签，
      // 压暗反而让它跟标签栏上的色标对不上号
      g.set(x, r.y, on ? '█' : '▄', col, T.panel);
      if (i < n - 1) g.set(x + 1, r.y, ' ', T.accent, T.panel);
    }
  }

  /**
   * 标签栏画在 SHELL 框的顶部边缘线**之上**那一行（框外）。
   * 必须晚于全局 chrome 的分隔线绘制，否则会被那行 '─' 盖掉（见 main.js 的调用点）。
   */
  drawTabBar(g, C) {
    const r = this.rect, T = C.theme;
    if (!r) return;
    const y = r.y - 1;
    if (y < 0) return;
    this._tabHits = [];
    const maxX = r.x + r.w;                      // 独占：[r.x, r.x+r.w)
    let x = r.x;
    for (let i = 0; i < this.tabs.length; i++) {
      const t = this.tabs[i];
      const name = t.title();
      const w = 2 + g.strWidth(name) + 1;        // 色标 + 空格 + 名字 + 空格
      if (x + w > maxX - 3) { g.text(x, y, '…', T.darker, T.bg); x += 1; break; }
      const on = i === this.active;
      const col = t.color();
      // 当前标签：淡染一层自己的颜色当底；其余保持面板底色，只靠色标/字色区分
      const bg = on ? mix(T.panel, col, 0.16) : T.panel;
      for (let k = 0; k < w; k++) g.set(x + k, y, ' ', T.dim, bg);
      // 色标实心 = 当前；半块 = 后台。形状 + 颜色两条通道，都不用数数
      g.set(x, y, on ? '█' : '▄', col, bg);
      g.text(x + 2, y, name, on ? col : T.dim, bg, on ? ATTR.BOLD : 0);
      this._tabHits.push({ x0: x, x1: x + w - 1, idx: i });
      x += w;
    }
    if (this.tabs.length < MAX_TABS && x + 3 <= maxX) {
      g.text(x, y, ' + ', T.dim, T.bg);
      this._tabHits.push({ x0: x, x1: x + 2, idx: -1 });
      x += 3;
    }
    // 剩下的部分让原来的顶部分隔线继续延伸，看起来就是“标签挂在线上”
    while (x < maxX) { g.set(x, y, '─', T.line, T.bg); x++; }
  }
}
