// ============================================================
// QikaCode —— Windows 窗口显隐助手（bridge 用）
//
// 为什么需要它：Chromium 对不可见页面（窗口最小化 / 被完全遮挡）不出帧，CDP 截图拿不到画面；
// 而用户希望 agent 专用的浏览器窗口一直最小化、别弹出来打断工作。扩展 API 里只有
// chrome.windows.update({state:"normal"})，它会激活窗口（抢焦点）。真正"悄悄露一下"只能靠 user32：
//   ShowWindow(SW_SHOWNOACTIVATE)   还原最小化窗口，不激活、留在原 z 序
//   SetWindowPos(HWND_TOP|SWP_NOACTIVATE) 抬到 z 序顶但不激活（被完全遮挡时用）
//   ShowWindow(SW_SHOWMINNOACTIVE)  最小化回去，活动窗口保持不变
//
// 实现：常驻一个 PowerShell 子进程跑 win32-window.ps1（Add-Type 编译 user32 绑定只做一次，
// 之后每条命令毫秒级），JSON 行协议 stdin→stdout，串行处理。闲置一段时间自动退出，下次按需再拉。
// 非 Windows 平台 available=false，调用方应跳过。
// ============================================================

const { spawn } = require("child_process");
const path = require("path");

const PS1 = path.join(__dirname, "win32-window.ps1");
const IDLE_EXIT_MS = 10 * 60 * 1000;

class Win32Window {
  constructor({ log = () => {}, requestTimeoutMs = 8000 } = {}) {
    this.log = log;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.queue = []; // 等待回包的 {resolve, reject, timer}，与 ps1 的串行回包一一对应
    this.buf = "";
    this.warm = false; // 首条回包到达后为 true：之后的请求不再给启动余量
    this.idleTimer = null;
  }

  get available() {
    return process.platform === "win32";
  }

  ensureChild() {
    if (this.child && this.child.exitCode === null) return this.child;
    // windowsHide 必须带：bridge 由无控制台的 server 拉起时，不带它 PowerShell 会分配一个可见控制台窗口。
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", PS1],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.child = child;
    this.buf = "";
    this.warm = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => this.onData(d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => this.log(`win32 helper stderr: ${String(d).trim()}`));
    child.on("exit", (code, sig) => {
      if (this.child === child) this.child = null;
      const err = new Error(`win32 helper 已退出 code=${code} sig=${sig}`);
      for (const p of this.queue.splice(0)) { clearTimeout(p.timer); p.reject(err); }
    });
    child.on("error", (e) => this.log(`win32 helper 启动失败: ${e.message}`));
    return child;
  }

  onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      const p = this.queue.shift();
      if (!p) continue;
      clearTimeout(p.timer);
      this.warm = true;
      let msg;
      try { msg = JSON.parse(line); } catch { p.reject(new Error(`win32 helper 回包不是 JSON: ${line.slice(0, 120)}`)); continue; }
      if (msg && msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg);
    }
  }

  request(op, args = {}) {
    if (!this.available) return Promise.reject(new Error("win32 helper 仅支持 Windows"));
    return new Promise((resolve, reject) => {
      const child = this.ensureChild();
      // 首条请求要等 PowerShell 启动 + Add-Type 编译（约 1s），给足余量
      const timeoutMs = this.requestTimeoutMs + (this.warm ? 0 : 4000);
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const i = this.queue.indexOf(entry);
        if (i !== -1) this.queue.splice(i, 1);
        reject(new Error(`win32 helper ${op} 超时`));
        // 超时说明助手卡住了，杀掉让下次重拉；排队中的其余请求随 exit 一起失败
        try { child.kill(); } catch {}
      }, timeoutMs);
      this.queue.push(entry);
      this.touchIdle();
      child.stdin.write(JSON.stringify({ ...args, op }) + "\n", (e) => {
        if (e) { clearTimeout(entry.timer); const i = this.queue.indexOf(entry); if (i !== -1) this.queue.splice(i, 1); reject(e); }
      });
    });
  }

  touchIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.queue.length === 0) this.dispose();
    }, IDLE_EXIT_MS);
    this.idleTimer.unref();
  }

  dispose() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      try { child.stdin.end(); } catch {}
      setTimeout(() => { try { child.kill(); } catch {} }, 1000).unref();
    }
  }

  // ---- 语义化封装 ----
  // owner：从 native messaging host 进程沿父链爬到拉起它的浏览器进程——装了扩展的那一个。
  // 后续 find 只在这个进程的窗口里找，机器上别的浏览器（哪怕同款）一概不碰。
  owner(hostPid) { return this.request("owner", { hostPid }); }
  // wantIconic：调用方已知目标窗口是最小化的；标题匹配失败时才允许退回该浏览器唯一一个最小化窗口
  find(title, { ownerPid, wantIconic = false } = {}) {
    return this.request("find", { title: title || "", ownerPid, wantIconic });
  }
  show(hwnd) { return this.request("show", { hwnd }); }
  raise(hwnd) { return this.request("raise", { hwnd }); }
  lower(hwnd, prev) { return this.request("lower", { hwnd, prev: prev || 0 }); }
  minimize(hwnd) { return this.request("minimize", { hwnd }); }
  state(hwnd) { return this.request("state", { hwnd }); }
  ping() { return this.request("ping"); }
}

module.exports = { Win32Window };
