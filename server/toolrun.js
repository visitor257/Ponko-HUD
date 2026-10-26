// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
//
// 唯一的工具：shell。agent 靠它读文件、写技能、跑脚本 —— 包括**给自己加能力**。
//
// 为什么每次都开一个**独立进程**，不复用 SHELL 面板那个持久 pwsh：
//   ① 用户可能正对着 SHELL 面板敲命令，agent 把命令塞进同一根管道会互相踩（抢回包、
//      改掉 cwd、前台任务被顶）。用户看得见的 shell 是**他的**，不该被后台偷偷写。
//   ② 命令之间不共享状态反而可预期：`cd` 之后下一次调用回到起点，模型照着 description
//      里那句"每次都是新进程"写命令就行，比"有时记得有时忘"好。
//   ③ 超时/回收能只杀这一棵树，不牵连用户会话。
// 代价是每次启动 pwsh 有 200~500ms 开销 —— 相对一次 LLM 往返可以忽略。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PS = process.env.PONKO_POWERSHELL || 'powershell.exe';

const DEFAULT_TIMEOUT = 60000;
const MAX_TIMEOUT = 300000;
const OUT_CAP = 12000;           // stdout 上限（字符）
const ERR_CAP = 4000;            // stderr 上限

// 三档策略。默认 allow = 用户 2026-10-26 的原话「全放行，权限越高越好」。
// 拦截不写死在这里，而是由技能带 guard.json 提供（见 skills.guardRules）——
// 这样"要不要拦什么"本身也能成为一个可写、可删、可版本化的技能。
const POLICIES = ['allow', 'guard', 'deny'];
const DEFAULT_POLICY = 'allow';

/** 给 OpenAI 兼容端点用的 tools 定义 */
const TOOL_SPEC = [{
  type: 'function',
  function: {
    name: 'shell',
    description: [
      '在这台 Windows 机器上执行一段 PowerShell 命令，返回 stdout / stderr / 退出码。',
      '**每次调用都是全新的独立进程**：上一条命令里 `cd` 过、设过的变量、改过的环境，这一条都不在。',
      '要换目录就在同一条命令里写 `cd <目录>; <然后是实际命令>`，或者用 -LiteralPath 写绝对路径。',
      '不要用它跑需要交互的程序（vim、ssh、python 的 REPL、pause 之类）——没有 stdin，会一直等到超时。',
      '输出上限 stdout ' + OUT_CAP + ' 字符 / stderr ' + ERR_CAP + ' 字符，超出部分被截断并标注长度。',
      '默认超时 ' + (DEFAULT_TIMEOUT / 1000) + ' 秒，最长 ' + (MAX_TIMEOUT / 1000) + ' 秒。',
      '写文件要指定编码（中文用 `Set-Content -Encoding UTF8`），否则控制台默认代码页会把汉字写坏。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 PowerShell 命令原文' },
        cwd: { type: 'string', description: '工作目录（绝对路径）。省略则用 Ponko-HUD 工程根目录' },
        timeout_ms: { type: 'integer', description: '超时毫秒数，默认 ' + DEFAULT_TIMEOUT },
      },
      required: ['command'],
    },
  },
}];

/** 给 Anthropic 原生端点用的 tool 定义（schema 位置不同：input_schema 而不是 parameters） */
const ANTHROPIC_TOOLS = TOOL_SPEC.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters,
}));

/** 文本协议降级时给模型看的说明（端点不支持 tools 时用） */
const TEXT_PROTOCOL_BRIEF = [
  '## 工具用法（shell）',
  '要执行命令时，在回复里放一个 ```sh 代码块，块里**只写命令**：',
  '```sh',
  'Get-ChildItem -LiteralPath \'C:\\\' | Select-Object -First 20',
  '```',
  '我执行完会把输出贴回来，你再继续。**一次只放一个块**，等结果再决定下一步。',
  '每次执行都是全新进程：上一条里 `cd` 过、设过的变量这里都不在，'
    + '要换目录就在同一条命令里写 `cd <目录>; <实际命令>`。',
  '不需要执行命令时，正常说话就行——不要为了凑格式而放代码块。',
].join('\n');

function normPolicy(p) {
  const s = String(p || '').trim();
  return POLICIES.includes(s) ? s : DEFAULT_POLICY;
}

/**
 * 按策略检查一条命令能不能跑。
 *
 * 返回 { ok:true } 或 { ok:false, why }。被拒时 why 会原样回给模型 ——
 * 它需要知道"为什么被拒"才能换方案，只回一句"失败"它会原样重试。
 */
function checkCommand(command, ctx) {
  const cmd = String(command || '');
  const policy = normPolicy(ctx && ctx.policy);
  if (!cmd.trim()) return { ok: false, why: '命令是空的。' };
  if (policy === 'deny') {
    return { ok: false, why: '当前 shell 策略是 deny（全拦截），任何命令都不会执行。'
      + '这不是你的错，也不是命令写错了——换别的办法，或者直接说明做不了。' };
  }
  if (policy === 'guard') {
    const rules = (ctx && ctx.guardRules) || [];
    for (const r of rules) {
      let re = null;
      try { re = new RegExp(r.pattern, 'i'); } catch (e) { continue; }   // 坏正则在 skills.js 里就丢了，这里再兜一次
      if (re.test(cmd)) {
        return { ok: false, why: '被技能「' + r.from + '」的规则拦下'
          + (r.why ? '：' + r.why : '') + '。这条命令不会执行。换一种更安全的方式，'
          + '或者先跟用户确认他是否真的要这么做。' };
      }
    }
  }
  return { ok: true, policy };
}

/** 杀掉整棵进程树（Windows 上 child.kill() 只杀外层，孙进程会留下） */
function killTree(pid) {
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch (e) { /* 进程可能已经走了 */ }
}

/**
 * 真的跑一条命令。
 *
 * 返回 { ok, code, stdout, stderr, ms, timeout, policy, refused }
 * —— 不管成功失败都返回对象（**不 throw**），因为失败信息本身就是要喂给模型的素材。
 */
function runShell(args, ctx) {
  const a = args || {};
  const command = String(a.command == null ? '' : a.command);
  const gate = checkCommand(command, ctx);
  const started = Date.now();
  if (!gate.ok) {
    return Promise.resolve({
      ok: false, refused: true, code: null, stdout: '', stderr: gate.why,
      ms: 0, timeout: false, policy: normPolicy(ctx && ctx.policy), command,
    });
  }

  let ms = Number(a.timeout_ms);
  if (!Number.isFinite(ms) || ms <= 0) ms = DEFAULT_TIMEOUT;
  ms = Math.min(MAX_TIMEOUT, Math.max(1000, Math.round(ms)));

  let cwd = String(a.cwd || '').trim();
  if (!cwd) cwd = ROOT;
  try { if (!fs.statSync(cwd).isDirectory()) cwd = ROOT; } catch (e) { cwd = ROOT; }

  // 命令经 -EncodedCommand 传（UTF-16LE + base64）：**中文和引号都不会被命令行转义搞坏**。
  // 开头那行把输出编码钉成 UTF8 —— 本机控制台是 936(GBK)，不设它 Node 收到的中文是乱码。
  const script = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()',
    '$OutputEncoding = [Console]::OutputEncoding',
    command,
  ].join('\r\n');
  const b64 = Buffer.from(script, 'utf16le').toString('base64');

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(PS, [
        '-NoLogo', '-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', b64,
      ], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({
        ok: false, code: null, stdout: '', stderr: '启动 pwsh 失败：' + e.message,
        ms: Date.now() - started, timeout: false, policy: gate.policy, command,
      });
    }

    let out = '', err = '', outLen = 0, errLen = 0, timedOut = false, done = false;
    // 采集时就把长度记下来：截断要报"原长多少"，事后再量就没这个数了。
    // 只留前 cap 个字符，后面的直接丢——几 MB 的构建日志全留着只会拖垮内存和上下文。
    child.stdout.on('data', (b) => {
      const s = b.toString('utf8');
      outLen += s.length;
      if (out.length < OUT_CAP) out = (out + s).slice(0, OUT_CAP);
    });
    child.stderr.on('data', (b) => {
      const s = b.toString('utf8');
      errLen += s.length;
      if (err.length < ERR_CAP) err = (err + s).slice(0, ERR_CAP);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, ms);

    const finish = (code, extraErr) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const nOut = outLen > out.length ? outLen : out.length;
      let errText = err + (extraErr ? (err ? '\n' : '') + extraErr : '');
      const nErr = errLen > err.length ? errLen : err.length;
      // 截断标记必须**在这里**拼：collect 阶段已经把 out 砍到 OUT_CAP 了，
      // 再走一遍"长度超过就截断"的判断永远不成立（`clip(out, CAP)` 是个死分支，别用）。
      resolve({
        ok: !timedOut && code === 0,
        code: code === undefined ? null : code,
        stdout: out + (nOut > out.length ? '\n…（已截断，原长 ' + nOut + ' 字符）' : ''),
        stderr: errText + (nErr > err.length ? '\n…（已截断，原长 ' + nErr + ' 字符）' : ''),
        ms: Date.now() - started,
        timeout: timedOut,
        policy: gate.policy,
        command,
        truncated: { stdout: nOut > out.length, stderr: nErr > err.length },
      });
    };

    child.on('error', (e) => finish(null, '执行失败：' + e.message));
    child.on('close', (code) => finish(code));
  });
}

/** 把执行结果整理成**给模型看**的一段文本（分节、带退出码和耗时） */
function toolResultText(r) {
  const L = [];
  if (r.timeout) L.push('[超时 ' + r.ms + 'ms —— 命令被强制结束，可能有残留进程]');
  else if (r.refused) L.push('[未执行]');
  else L.push('[退出码 ' + (r.code === null ? '?' : r.code) + ' · ' + r.ms + 'ms]');
  if (r.stdout) L.push('--- stdout ---\n' + r.stdout);
  if (r.stderr) L.push('--- stderr ---\n' + r.stderr);
  if (!r.stdout && !r.stderr) L.push('(没有输出)');
  return L.join('\n');
}

module.exports = {
  TOOL_SPEC, ANTHROPIC_TOOLS, TEXT_PROTOCOL_BRIEF,
  POLICIES, DEFAULT_POLICY, normPolicy,
  checkCommand, runShell, toolResultText,
  OUT_CAP, ERR_CAP, DEFAULT_TIMEOUT, MAX_TIMEOUT,
};
