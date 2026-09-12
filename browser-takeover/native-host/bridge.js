// ============================================================
// QikaCode —— Bridge（常驻主程序）
//
// 角色：持久的 TCP 服务端，教师 CLI 连它、被 Chrome 拉起的瘦 host 也连它。
// 它负责把「CLI 的命令」转发给「当前活动的 native messaging 通道（host→扩展）」,
// 再把「扩展的执行结果」原路送回 CLI。
//
//   教师 CLI ──TCP──▶ bridge ──▶ host(瘦) ──stdout帧──▶ Chrome ──▶ 扩展(执行)
//   教师 CLI ◀──TCP── bridge ◀── host(瘦) ◀──stdin帧─── Chrome ◀─── 扩展(结果)
//
// 唯一的例外是 screenshot：bridge 先问扩展窗口可见性，窗口最小化/被遮挡时借 win32 助手
// 不抢焦点地把窗口露一下再截、截完放回（见 visible-capture.js）——Chromium 对不可见页面不出帧。
//
// 用法：node native-host/bridge.js
// ============================================================

const net = require("net");
const { Win32Window } = require("./win32-window");
const { captureWithVisibleWindow } = require("./visible-capture");

const PORT = Number(process.env.BRIDGE_PORT || 9204);      // CLI 连这个
const HOST_PORT = Number(process.env.BRIDGE_HOST_PORT || 9205); // host(Chrome拉起)连这个
const HOST = "127.0.0.1";

let msgId = 0;
// id -> { handle(msg), cli? }：CLI 转发的条目把回包写回 cli；bridge 自己发起的条目（见 askExtension）走回调
const pending = new Map();
let activeHost = null;       // 当前活动的 host 连接（Chrome 可能按需拉起多个，取最新）

// 截图时把最小化的浏览器窗口"悄悄"露一下再放回（不抢焦点），仅 Windows 有原生能力
const win32 = new Win32Window({ log: (m) => console.error(`[bridge] ${m}`) });

// ---- 处理来自 CLI（教师驾驶员）的连接 --------------------------
const cliServer = net.createServer((cli) => {
  console.error(`[bridge] 教师 CLI 已连接: ${cli.remoteAddress}`);
  let buf = "";
  cli.on("data", (d) => {
    buf += d.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) handleCliLine(cli, line);
    }
  });
  cli.on("error", () => {});
  cli.on("close", () => {
    console.error("[bridge] 教师 CLI 断开");
  });
});

function handleCliLine(cli, line) {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    cli.write(JSON.stringify({ ok: false, error: "非法命令" }) + "\n");
    return;
  }

  if (!activeHost || activeHost.destroyed) {
    cli.write(
      JSON.stringify({
        ok: false,
        error: "没有活动的扩展连接（请确认扩展已加载、host 已注册、浏览器已开）",
      }) + "\n"
    );
    return;
  }

  // 优先用 CLI 自带的 id（便于 CLI 与回包配对），否则自增生成
  const id = cmd.id != null ? cmd.id : ++msgId;
  if (cmd.cmd === "screenshot") {
    handleScreenshot(cli, cmd, id);
    return;
  }
  pending.set(id, { cli, handle: (msg) => replyCli(cli, msg, id) });
  // 给 host 的消息带上 id；host→chrome→扩展执行后，扩展会回带同样 id
  activeHost.write(JSON.stringify({ ...cmd, id }) + "\n");
  console.error(`[bridge] 转发命令 #${id}: ${cmd.cmd}`);
}

function replyCli(cli, msg, id) {
  if (cli.destroyed) return;
  cli.write(JSON.stringify({ ...msg, id }) + "\n");
  console.error(`[bridge] 命令 #${id} 结果已回传 CLI`);
}

// bridge 自己向扩展发命令（截图编排要先问 windowState）。id 用独立前缀，不与 CLI 的数字 id 撞。
let internalSeq = 0;
function askExtension(cmd, extra = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!activeHost || activeHost.destroyed) return reject(new Error("没有活动的扩展连接"));
    const id = `bridge#${++internalSeq}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${cmd} 等待扩展回包超时`));
    }, timeoutMs);
    pending.set(id, { handle: (msg) => { clearTimeout(timer); resolve(msg); } });
    activeHost.write(JSON.stringify({ ...extra, cmd, id }) + "\n");
  });
}

function unwrap(msg) {
  if (!msg || !msg.ok) throw new Error((msg && msg.error) || "扩展返回失败");
  return msg.result;
}

// 截图单独编排：窗口最小化/被遮挡时页面不出帧，先不抢焦点地把窗口露出来，截完放回。
async function handleScreenshot(cli, cmd, id) {
  console.error(`[bridge] 转发命令 #${id}: screenshot（含窗口可见性编排）`);
  const tabArg = cmd.tabId != null ? { tabId: cmd.tabId } : {};
  try {
    const msg = await captureWithVisibleWindow({
      win32,
      hostPid: activeHost && !activeHost.destroyed ? activeHost.hostPid ?? null : null,
      ask: (c, extra = {}) => askExtension(c, { ...tabArg, ...extra }).then(unwrap),
      forward: () => askExtension("screenshot", { ...tabArg, ...(cmd.options ? { options: cmd.options } : {}) }, 30000),
      log: (m) => console.error(`[bridge] ${m}`),
    });
    replyCli(cli, msg, id);
  } catch (e) {
    replyCli(cli, { ok: false, error: e.message }, id);
  }
}

// ---- 处理来自 host（Chrome 拉起的瘦桥）的连接 -------------------
const hostServer = net.createServer((host) => {
  console.error(`[bridge] host 已连接: ${host.remoteAddress}:${host.remotePort}（pid=${host.localPort}）`);
  // 新 host 成为「当前活动通道」（Chrome 每次 connectNative 拉新进程）
  activeHost = host;

  let buf = "";
  host.on("data", (d) => {
    buf += d.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) handleHostLine(host, line);
    }
  });

  host.on("error", () => {});
  host.on("close", () => {
    console.error("[bridge] host 断开");
    if (activeHost === host) activeHost = null;
  });
});

// host 发来的可能是：绑定消息 / 扩展回传的命令结果
function handleHostLine(host, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // 绑定消息：记下 host 进程 pid——它的父链指向拉起它的浏览器，即装了扩展的那一个；
  // 截图编排据此只碰这个浏览器进程的窗口，机器上别的浏览器（哪怕同款）一概不动。
  if (msg.type === "bind") {
    host.hostPid = typeof msg.pid === "number" ? msg.pid : null;
    console.error(`[bridge] 绑定 native messaging 通道（host pid=${msg.pid}）`);
    return;
  }

  // 扩展回传的命令结果：msg 里有我们发出去的 id
  if (msg.id != null && pending.has(msg.id)) {
    const entry = pending.get(msg.id);
    pending.delete(msg.id);
    entry.handle(msg);
  }
}

cliServer.listen(PORT, HOST, () => {
  console.error(`[bridge] 就绪。CLI 请连 tcp://${HOST}:${PORT}`);
});
hostServer.listen(HOST_PORT, HOST, () => {
  console.error(`[bridge] host 请连 tcp://${HOST}:${HOST_PORT}`);
});

// 端口绑定失败（如 Windows 偶发 EACCES/端口被占）时不崩溃，重试
function retryBind(server, port, label) {
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE" || e.code === "EACCES") {
      console.error(`[bridge] ${label} ${port} 绑定失败（${e.code}），1s 后重试`);
      setTimeout(() => retryBind(server, port, label), 1000);
    } else {
      console.error(`[bridge] ${label} ${port} 出错:`, e.message);
    }
  });
}
retryBind(cliServer, PORT, "CLI 端口");
retryBind(hostServer, HOST_PORT, "host 端口");

// 兜底：若 CLI 断开但命令没回，清掉等待，避免内存泄漏（bridge 自己的条目有各自的超时）
setInterval(() => {
  for (const [id, entry] of pending) {
    if (entry.cli && entry.cli.destroyed) pending.delete(id);
  }
}, 5000).unref();

process.on("SIGINT", () => process.exit(0));
process.on("exit", () => win32.dispose());
