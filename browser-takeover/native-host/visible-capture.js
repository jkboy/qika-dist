// ============================================================
// QikaCode —— 截图前后的窗口可见性编排（bridge 侧）
//
// 约束：Chromium 对不可见页面（窗口最小化 / 被别的窗口完全遮挡）不出帧，CDP Page.captureScreenshot
// 拿不到画面（会一直等）。而用户希望 agent 专用的浏览器窗口常驻最小化、别弹出来打断工作。
// 曾经的实际后果：截图超时 → 模型自己写 ShowWindow/SetForegroundWindow 脚本把浏览器拉到前台"修复"，
// 用户正在用的窗口被抢走——这就是"总是弹出来"的来源。
//
// 折中：截图那一刻把窗口"悄悄"露出来，截完立刻放回，全程不激活、不抢焦点：
//   1. 问扩展 windowState；页面已 visible → 直接截。
//   2. 窗口 minimized → SW_SHOWNOACTIVATE 还原（不激活）；还原后多半仍被用户的前台窗口盖着，
//      所以接着抬到 z 序顶（SetWindowPos HWND_TOP + SWP_NOACTIVATE，同样不激活）。
//      窗口未最小化但页面 hidden（被完全盖住）→ 只抬升，记住原来压在它上面的窗口。
//   3. 截图。无论成败：还原过的重新最小化（SW_SHOWMINNOACTIVE，活动窗口不变）；只抬升过的放回原 z 位。
// 窗口定位只在「拉起 native host 的那个浏览器进程」里找（host pid 沿父链爬到 chrome.exe/brave.exe），
// 机器上装了别的浏览器、或同款浏览器开了第二个实例，一律不碰。
// 任一步原生操作失败都退回"直接截"，由扩展侧的可见性守卫给出明确报错（不再是 20s 超时误报 bridge）。
// 非 Windows（无 win32 助手）直接透传。
// ============================================================

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ask(cmd, extra) → 扩展命令的 result（失败抛错）；forward() → 转发截图并解析为回包消息；
// win32 → Win32Window 实例（或 null）；hostPid → 当前活动 host 进程 pid（bridge 从 bind 消息拿到），
// 用来锁定「装了扩展的那个浏览器进程」——机器上别的浏览器（哪怕同款）一律不碰。
// 返回给 CLI 的回包消息（不含 id，由调用方补）。
async function captureWithVisibleWindow({ ask, win32, forward, hostPid, log = () => {}, settleMs = 150, sleep = defaultSleep }) {
  if (!win32 || !win32.available) return forward();

  let st;
  try {
    st = await ask("windowState");
  } catch (e) {
    log(`windowState 失败，直接截图: ${e.message}`);
    return forward();
  }
  // 标签不在其窗口前台时 visibility 必为 hidden，但那是扩展自己切标签能解决的；
  // 这里只管窗口层面：最小化，或标签已在前台却仍 hidden（整窗被盖住）。
  const minimized = st.state === "minimized";
  const covered = !minimized && st.visibility === "hidden" && st.tabActive;
  if (!minimized && !covered) return forward();

  let hwnd = null;
  let restored = false;
  let raised = null;
  try {
    if (hostPid == null) throw new Error("不知道 host 进程 pid，无法定位装了扩展的浏览器");
    const owner = await win32.owner(hostPid);
    const found = await win32.find(st.windowTitle, { ownerPid: owner.pid, wantIconic: minimized });
    hwnd = found.hwnd;
    if (minimized) {
      await win32.show(hwnd);
      restored = true;
    }
    raised = await win32.raise(hwnd);
    await sleep(settleMs);
    log(`截图：已无激活${restored ? "还原并" : ""}抬升浏览器窗口 hwnd=${hwnd}（${owner.name} pid=${owner.pid}，${found.title}）`);
  } catch (e) {
    log(`窗口还原失败，改为直接截图: ${e.message}`);
  }

  try {
    return await forward();
  } finally {
    if (hwnd != null) {
      if (restored) {
        await win32.minimize(hwnd).catch((e) => log(`重新最小化失败: ${e.message}`));
      } else if (raised) {
        await win32.lower(hwnd, raised.prev).catch((e) => log(`放回原 z 位失败: ${e.message}`));
      }
    }
  }
}

module.exports = { captureWithVisibleWindow };
