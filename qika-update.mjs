#!/usr/bin/env node
// qika(QiKa Code)一键更新:停旧实例 → npm i -g 装新版 → 重新拉起。
// 注意:npm 包名和启动器路径保持 pi-web/bin/pi-web.js 不改——存量用户旧版
// pi-web-update 按此路径停旧/拉起,改了会断升级链;只有 bin 命令名叫 qika。
// 为什么需要它:Windows 上运行中的实例锁定原生模块(.node 为 DLL),
// 服务在跑时直接 npm i -g 会在复制文件阶段 EBUSY 失败,还可能把全局安装
// 搬成半残——必须先停再装。注意包本身不能挂 postinstall 之类生命周期脚本
// 来做这件事:git 依赖带 scripts 会触发 npm 的内嵌 install 预备流程,嵌套
// npm 继承外层 global 配置后在全局树里自我冲突(v0.2.19 实测翻车)。
//
// 语义:更新前在跑 → 装完自动拉起;更新前没在跑 → 只装不启动。
// 本脚本自包含(仅 node 内置模块),运行期间包目录被整体替换也不受影响。
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';
const DIST_URL = 'git+https://github.com/jkboy/qika-dist.git';
const log = (m) => console.log(`[qika-update] ${m}`);

// ---------- 1. 停旧 ----------
const running = await findRunning();
const { pids } = running;
const wasRunning = pids.length > 0;
// 重启要回到更新前的端口:手敲 `qika --port 8000` 的实例,端口只在锁文件里
const PORT = process.env.PI_WEB_PORT || running.port || '7318';
if (wasRunning) {
  log(`停止运行中的 qika(PID ${pids.join(', ')})…`);
  for (const pid of pids) {
    try {
      if (isWin) execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
      else process.kill(Number(pid), 'SIGTERM');
    } catch {
      /* 已退出忽略 */
    }
  }
  // 优雅退出要等所有会话收尾,时长不定;不等到真退出就装,旧进程还占着端口,
  // 装完拉起的新实例会被单实例锁拒掉,而 health 探活却会被旧进程"答对"。
  let left = await waitExit(pids, 8000);
  if (left.length && !isWin) {
    for (const pid of left) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        /* 已退出忽略 */
      }
    }
    left = await waitExit(left, 2000);
  }
  if (left.length) log(`警告:PID ${left.join(', ')} 仍未退出,继续安装…`);
  await sleep(500); // 等端口/文件锁释放
} else {
  log('未检测到运行中的 qika。');
}

// ---------- 1b. Windows:暂停浏览器 native host,防止安装目录被锁 ----------
// 浏览器扩展经 Native Messaging 拉起的 host 进程跑在全局安装目录内
// (native-host\node.exe 运行中被锁) → npm rename 包目录必 EBUSY(0.2.68 实测);
// 且扩展 onDisconnect 有 500ms 自动重连,单杀进程会被立刻重新拉起。
// 正解:先摘 HKCU 注册(阻断重生)再杀进程;顺带清掉孤儿 bridge(server 被
// taskkill 后 bridge 子进程残留,占着 9204 会让新 server 跳过拉起、一直跑旧
// 代码)。安装成功后 post-install 钩子/setupNativeHost 会重新注册;失败则在
// 恢复路径把注册表原值写回。
const savedHostReg = isWin ? await disarmNativeHost() : [];

// ---------- 2. 清理历史坏状态 + 安装 ----------
// 中断过的安装可能留下:缺 package.json 的半残包目录、指向 npm 缓存 tmp 的
// junction、.pi-web-* staging 目录。不清掉的话 npm 会在坏状态上继续打转。
preClean();
log(`安装最新版:npm i -g ${DIST_URL}`);
const r = spawnSync('npm', ['install', '-g', DIST_URL], {
  stdio: 'inherit',
  shell: isWin,
});
if ((r.status ?? 1) !== 0) {
  log('安装失败!');
  restoreNativeHostReg(savedHostReg);
  if (wasRunning) {
    log('尝试拉起磁盘上现存版本以恢复服务…');
    startDetached();
    const back = await waitHealth(`http://127.0.0.1:${PORT}/api/meta/health`, 6, 2000);
    log(back ? '旧版已恢复运行。' : '恢复失败,请手动检查:qika');
  }
  process.exit(1);
}
const ver = installedVersion();
log(`已安装 qika v${ver || '?'}`);

// ---------- 2b. 安装时步骤：优先调新包内的 post-install 钩子 ----------
// 钩子随包分发（<全局>/pi-web/post-install.mjs），新版本的安装时步骤当次生效，
// 不受"本脚本是旧版"拖累（0.2.67 的 host 注册第一遍没跑就是这个坑）。
// 钩子不存在（装到不带钩子的旧版包）才落回下面的内联逻辑。
if (!runPostInstallHook()) {
  setupNativeHost();
  printExtensionHint();
}

// ---------- 3. 拉起 ----------
if (!wasRunning) {
  log('更新前服务未在运行,不自动启动。启动:qika');
  process.exit(0);
}
log('重新启动 qika…');
startDetached();
const up = await waitHealth(`http://127.0.0.1:${PORT}/api/meta/health`, 8, 2000);
if (up) {
  log(`完成:qika v${ver} 运行中(http://localhost:${PORT})`);
} else {
  log(`未能确认启动,查看日志:${path.join(os.homedir(), '.pi-web', 'pi-web.log')}`);
  process.exit(1);
}
process.exit(0);

// ---------- 辅助 ----------
// 两路信号取并集:server 自己写的锁文件(与启动方式无关)+ 进程命令行扫描(兜底)。
// 返回 { pids: string[], port: string|null },port 来自锁文件。
async function findRunning() {
  const pids = new Set(scanProcessList());
  const lock = await readLiveLock();
  if (lock) pids.add(String(lock.pid));
  return { pids: [...pids], port: lock ? String(lock.port) : null };
}

// server 启动时写 <dataDir>/server.lock = {pid, port},优雅退出时删。
// 锁可能陈旧(taskkill /F 不走优雅退出;pid 之后可能被无关进程复用),所以
// pid 存活还不算数,必须锁里端口的 health 也通才认——否则会误杀别人的进程。
// (health 在启用口令未登录时只回 {ok:true},不能拿它的 pid 来比对。)
async function readLiveLock() {
  const dataDir = process.env.PI_WEB_DATA_DIR || path.join(os.homedir(), '.pi-web');
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.lock'), 'utf8'));
  } catch {
    return null;
  }
  const pid = Number(lock?.pid);
  const port = Number(lock?.port);
  if (!pid || !port || !isAlive(pid)) return null;
  const ok = await healthOk(`http://127.0.0.1:${port}/api/meta/health`, 1500);
  return ok ? { pid, port } : null;
}

function scanProcessList() {
  try {
    if (isWin) {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          // 严格匹配安装版启动器路径,不误伤源码仓库 tsx 开发实例/npm 进程
          "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'pi-web[\\\\/]bin[\\\\/]pi-web\\.js' } | ForEach-Object { $_.ProcessId }",
        ],
        { encoding: 'utf8' },
      );
      return out.split(/\s+/).filter(Boolean);
    }
    // 命令行有两种形态:①node <全局根>/pi-web/bin/pi-web.js(本脚本/安装器拉起,
    // volta/pnpm shim 也是);②node <prefix>/bin/qika(手敲命令:npm 的 bin 是符号
    // 链接,shebang 执行时 argv 是链接自身路径,不含 pi-web/bin/pi-web.js——只匹配
    // ①在 mac 上漏检,0.2.101 实测)。老命令名 pi-web 同理;( |$) 排除
    // qika-update / pi-web-update 自身。pgrep 模式是 ERE(macOS/Linux 皆然)。
    const out = execFileSync('pgrep', ['-f', 'pi-web/bin/pi-web\\.js|/bin/(qika|pi-web)( |$)'], {
      encoding: 'utf8',
    });
    return out.split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 存在但无权限发信号,仍算活着
  }
}

// 轮询直到全部退出或超时,返回仍存活的 pid
async function waitExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let left = pids;
  while (left.length && Date.now() < deadline) {
    await sleep(250);
    left = left.filter((p) => isAlive(Number(p)));
  }
  return left;
}

async function healthOk(url, timeoutMs) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function globalRoot() {
  try {
    return execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: isWin })
      .trim()
      .split(/\r?\n/)
      .pop();
  } catch {
    return '';
  }
}

function installedVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(globalRoot(), 'pi-web', 'package.json'), 'utf8'))
      .version;
  } catch {
    return '';
  }
}

// 调新装的包内的 post-install 钩子（安装时步骤的单一事实源，随包演进）。
// 返回 true = 钩子存在且已执行（无论钩子内部成败，钩子自己负责警告不阻断）；
// false = 包里没有钩子（旧版包），调用方落回内联逻辑。
function runPostInstallHook() {
  const hook = path.join(globalRoot(), 'pi-web', 'post-install.mjs');
  if (!fs.existsSync(hook)) return false;
  const r = spawnSync(process.execPath, [hook], { stdio: 'inherit' });
  if ((r.status ?? 1) !== 0) log('post-install 钩子报告了失败（不影响安装，详见上方输出）。');
  return true;
}

// 更新期间暂停浏览器 native host:摘 HKCU 注册(键与 register.bat 写入的一致)
// + 杀掉跑在全局安装目录里的 host/bridge 进程。返回被摘除的注册项(供失败恢复)。
async function disarmNativeHost() {
  const keys = [
    'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.example.browser_takeover',
    'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.example.browser_takeover',
  ];
  const saved = [];
  for (const key of keys) {
    try {
      const out = execFileSync('reg', ['query', key, '/ve'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = out.match(/REG_SZ\s+(.+)/);
      execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore' });
      saved.push({ key, value: m ? m[1].trim() : '' });
    } catch {
      /* 该浏览器未注册,跳过 */
    }
  }
  let killed = 0;
  // 摘完注册再杀:此后扩展重连只会 "host not found",不会再拉起新进程。
  // 多扫几遍,兜住摘除瞬间已在拉起路上的 host。
  for (let i = 0; i < 3; i++) {
    const pids = findNativeHostPids();
    if (pids.length === 0) break;
    for (const pid of pids) {
      try {
        execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
        killed++;
      } catch {
        /* 已退出忽略 */
      }
    }
    await sleep(600);
  }
  if (saved.length || killed) {
    log(`已暂停浏览器接管 host(摘注册 ${saved.length} 处、结束进程 ${killed} 个),安装完成后自动恢复。`);
  }
  return saved;
}

// 找跑在全局安装目录里的 native host/bridge 进程(node.exe,命令行含
// pi-web\browser-takeover\native-host)。不会误伤源码仓库开发实例——
// 其路径是 pi-web\packages\browser-takeover\...,不匹配。
function findNativeHostPids() {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'pi-web[\\\\/]browser-takeover[\\\\/]native-host' } | ForEach-Object { $_.ProcessId }",
      ],
      { encoding: 'utf8' },
    );
    return out.split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

// 安装失败时把摘掉的注册表原值写回,恢复浏览器接管可用性。
// (成功路径不需要:post-install 钩子/setupNativeHost 会重新生成 manifest 并注册。)
function restoreNativeHostReg(saved) {
  for (const { key, value } of saved) {
    if (!value) continue;
    try {
      execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], {
        stdio: 'ignore',
      });
    } catch {
      log(`恢复 host 注册失败:${key}(可手动重跑 register.bat)`);
    }
  }
  if (saved.length) log('已恢复浏览器 host 注册。');
}

// 安装后自动注册内置 browser-takeover 的 Native Messaging host。
// 步骤：定位安装包内 native-host/ → 跑 setup-host.js（生成 manifest + 复制 node.exe）
// → Windows 跑 register.bat 写 HKCU 注册表。失败只警告不阻断（可手动补：
// 跑 setup-host.js && register.bat）。
function setupNativeHost() {
  const hostDir = path.join(globalRoot(), 'pi-web', 'browser-takeover', 'native-host');
  const setupJs = path.join(hostDir, 'setup-host.js');
  if (!fs.existsSync(setupJs)) {
    log('未找到内置 browser-takeover 的 host 配置脚本，跳过 host 自动注册。');
    return;
  }
  try {
    log(`生成 host 配置:${setupJs}`);
    const r = spawnSync('node', [setupJs], { encoding: 'utf8', shell: isWin });
    if (r.status !== 0) throw new Error(r.stderr || 'setup-host.js 退出码 ' + r.status);
    if (isWin) {
      const regBat = path.join(hostDir, 'register.bat');
      log('注册 host 到浏览器注册表（Brave + Chrome）…');
      const rr = spawnSync('cmd', ['/c', regBat], { encoding: 'utf8', stdio: 'inherit' });
      if (rr.status !== 0) throw new Error('register.bat 退出码 ' + rr.status);
      log('host 已注册。');
    } else {
      log('（非 Windows：已生成 host 配置，请按需手动注册 Native Messaging host）');
    }
  } catch (e) {
    log(`host 自动注册失败（不影响安装，可稍后手动补）：${e.message}`);
  }
}

// 安装结束的提示：教用户怎么在浏览器里加载未打包扩展（自动化绕不开的一步）。
function printExtensionHint() {
  const extDir = path.join(globalRoot(), 'pi-web', 'browser-takeover', 'extension');
  console.log('\n' + '='.repeat(60));
  console.log('下一步：在浏览器里加载扩展（这是唯一需要手动的一步）');
  console.log('='.repeat(60));
  console.log(`  扩展目录: ${extDir}\n`);
  console.log('  Brave  : 地址栏输入 brave://extensions');
  console.log('  Chrome : 地址栏输入 chrome://extensions');
  console.log('  步骤   : 打开右上角“开发者模式” →');
  console.log('          “加载已解压的扩展程序” → 选中上面的扩展目录');
  console.log('          （本包 manifest 带固定 key，扩展 ID 稳定，无需改配置）');
  console.log('  完成   : 重启 QiKa Code 后 bridge 自动启动，即可用 browser_ctl 操作浏览器。\n');
}

function preClean() {
  const root = globalRoot();
  if (!root) return;
  const pkgDir = path.join(root, 'pi-web');
  try {
    const stat = fs.lstatSync(pkgDir);
    const broken =
      stat.isSymbolicLink() || !fs.existsSync(path.join(pkgDir, 'package.json'));
    if (broken) {
      log(`检测到半残的全局安装(${pkgDir}),清理…`);
      fs.rmSync(pkgDir, { recursive: true, force: true });
    }
  } catch {
    /* 不存在 = 干净 */
  }
  // 清 staging 残留
  try {
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith('.pi-web-')) {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
      }
    }
  } catch {
    /* 忽略 */
  }
}

function startDetached() {
  const confDir = path.join(os.homedir(), '.pi-web');
  fs.mkdirSync(confDir, { recursive: true });
  const outLog = path.join(confDir, 'pi-web.log');
  // 直接用 node 拉 bin/pi-web.js,不走 cmd shim(shell:true):Windows 上
  // detached 的 cmd 自身无控制台,其子进程 node 会被系统分配一个可见的
  // 新控制台窗口——关窗即杀服务。node 作为 detached 直接子进程则无窗口。
  const binJs = path.join(globalRoot(), 'pi-web', 'bin', 'pi-web.js');
  const child = spawn(process.execPath, [binJs], {
    stdio: ['ignore', fs.openSync(outLog, 'a'), fs.openSync(outLog, 'a')],
    detached: true,
    windowsHide: true,
    env: withRegistryEnv(),
  });
  child.unref();
}

function withRegistryEnv() {
  const env = { ...process.env, PI_WEB_PORT: PORT };
  if (isWin) {
    for (const name of ['PI_WEB_ACCESS_TOKEN', 'PI_WEB_ALLOWED_HOSTS']) {
      if (!env[name]) {
        try {
          const v = execFileSync(
            'powershell',
            ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable("${name}","User")`],
            { encoding: 'utf8' },
          ).trim();
          if (v) env[name] = v;
        } catch {
          /* 读不到按纯本机模式启动 */
        }
      }
    }
  }
  return env;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitHealth(url, tries, interval) {
  for (let n = 0; n < tries; n++) {
    await sleep(interval);
    if (await healthOk(url, interval)) return true;
  }
  return false;
}
