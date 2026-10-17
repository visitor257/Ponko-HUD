// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 界面状态的落盘调度：只做"变了才存、连着变只存最后一次"。
//
// 为什么单独一层：主循环每帧都会问一次"要不要存"，而这件事既要有去抖、又要在关窗时
// 立刻补一刀 —— 混在 main.js 的渲染逻辑里既不好读，也没法单独测。
// 这里不依赖 DOM、不依赖 fetch：只认一个"有 sig() 和 snapshot() 的对象"，
// 所以 tools/test_uistate.mjs 能直接拿假对象把它测穿。
//
// 目前唯一的使用者：心情快照（见 mood.js 的 snapshot/restore）。它决定整幅配色，
// 是**全局**的一份 —— 跟"形象"那种每个对话一份的字段不是一回事。

/**
 * @param {(snap: object) => void} save 真去写盘的回调（一般包一层 saveUiState({mood: snap})）
 * @param {number} [delay] 去抖窗口（毫秒）
 */
export function mkMoodSaver(save, delay = 600) {
  let last = null;       // 上次排过/写过的签名
  let pending = null;    // 排着还没写的那个对象（存引用，真正写的时候才取快照）
  let timer = null;
  // 开机到"跟盘上对过账"之前，一笔都不写。
  // 为什么必须有这道闸：主循环第一帧跑的时候，开机那趟"读快照"还没回来，此刻 mood 是默认的
  // 待机 —— 抢着存下去，就把盘上那份好快照盖成待机了（正好是这次要修的那个症状的反面）。
  // seed() 是开闸的唯一入口（main.js 在"读到快照并恢复完 / 确认没有快照"之后调它）。
  let primed = false;

  // 写的时候**现取** snapshot：防抖窗口里又变过的话，写下去的就是最新的那份
  const write = (m) => { try { save(m.snapshot()); } catch (e) { /* 后端没起来就算了 */ } };
  const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };

  return {
    /**
     * 每帧调一次。签名变了才排一次落盘。
     * @returns {boolean} 这一步有没有发现变化（还没开闸时永远 false）
     */
    pump(m) {
      if (!m || !primed) return false;
      const sig = m.sig;
      if (sig === last) return false;
      last = sig;
      pending = m;
      if (!timer) {
        timer = setTimeout(() => { timer = null; const x = pending; pending = null; if (x) write(x); }, delay);
      }
      return true;
    },

    /** 关窗 / 切后台：把防抖窗口里那一笔立刻写掉（别把最后一次改动丢在窗口里） */
    flush() {
      stop();
      const x = pending; pending = null;
      if (x) write(x);
      return !!x;
    },

    /**
     * 刚**从盘上恢复**完时调一次：把当前状态记成"已经同步过了"（并**开闸**），
     * 免得紧接着的 pump() 又把刚读回来的东西原样写回去。
     */
    seed(m) { stop(); pending = null; last = m ? m.sig : null; primed = true; },

    /** 测试用：开闸了没有 / 还有没有排着没写的那一笔 */
    get primed() { return primed; },
    get queued() { return pending ? 1 : 0; },
  };
}
