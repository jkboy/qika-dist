#!/usr/bin/env node
// qika（QiKa Code）服务登录自启（Windows）：由计划任务「qika-server」在用户登录时调用。
//
// 动因：此前只有 SSH 隧道登录自启（pi-web-ssh-tunnel），server 本身靠安装器/qika-update 拉起一次，
// 电脑重启后远程域名 502，必须手敲 `qika`（2026-10-02 对照 claude-web 守护进程时发现）。
//
// 行为：已在运行（server.lock 的 pid 存活且端口 health 通）→ 什么都不做；否则按 qika-update 同款
// 方式后台拉起（node 直接 detached + windowsHide，不经 cmd shim——经 cmd 拉起的 node 会被分配
// 可见控制台窗，关窗即杀服务），日志追加到 ~/.pi-web/pi-web.log。
// PI_WEB_ACCESS_TOKEN / PI_WEB_ALLOWED_HOSTS 从用户注册表补读：计划任务进程的环境未必带上它们，
// 漏了 token 会以「无鉴权」状态经隧道暴露公网。
//
// 注册：node qika-autostart.mjs --register    取消：node qika-autostart.mjs --unregister
// 随包分发：post-install（已配远程隧道的机器）与安装器远程分支调用 --ensure——用户 --unregister 过
// 就留下 autostart.disabled 标记，--ensure 尊重它不再注册；--register 显式重开并清除标记。
// 每次 qika-update 都会经 post-install 重新注册，任务里的 node 路径与脚本路径随之刷新。
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TASK = 'qika-server';
const self = fileURLToPath(import.meta.url);
const dataDir = process.env.PI_WEB_DATA_DIR || path.join(os.homedir(), '.pi-web');
const disabledMark = path.join(dataDir, 'autostart.disabled');
const log = (m) => {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, 'autostart.log'), `${new Date().toISOString()} ${m}\n`);
  } catch {
    /* 忽略 */
  }
  console.log(`[qika-autostart] ${m}`);
};

if (process.platform !== 'win32') {
  console.log('[qika-autostart] 仅 Windows（macOS/Linux 请用 launchd / systemd --user 托管 qika）');
  process.exit(0);
}

function winText(buf) {
  if (!buf?.length) return '';
  try {
    return new TextDecoder('gbk').decode(buf).trim();
  } catch {
    return buf.toString().trim();
  }
}

function userId() {
  const r = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), [], {
    encoding: 'buffer',
    windowsHide: true,
  });
  const id = winText(r.stdout);
  if (!id.includes('\\')) throw new Error(`取当前用户失败：${winText(r.stderr) || id}`);
  return id;
}

function register() {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const uid = esc(userId());
  // 登录后延迟 30s：等网络与代理就绪（server 启动即会尝试连 MCP/模型）
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>QiKa Code server 登录自启（已在运行则跳过）</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${uid}</UserId><Delay>PT30S</Delay></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${uid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>${esc(process.execPath)}</Command><Arguments>"${esc(self)}"</Arguments></Exec>
  </Actions>
</Task>`;
  const xmlPath = path.join(dataDir, `${TASK}.task.xml`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(xmlPath, '\uFEFF' + xml, 'utf16le');
  const r = spawnSync('schtasks', ['/create', '/tn', TASK, '/xml', xmlPath, '/f'], { encoding: 'buffer', windowsHide: true });
  const ok = r.status === 0 && spawnSync('schtasks', ['/query', '/tn', TASK], { stdio: 'ignore', windowsHide: true }).status === 0;
  if (!ok) {
    console.error(`[qika-autostart] 计划任务注册失败：${winText(r.stderr) || winText(r.stdout)}`);
    process.exit(1);
  }
  console.log(`[qika-autostart] 已注册登录自启（计划任务 ${TASK}，登录后 30s 检查并拉起）`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function healthOk(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/meta/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

function registryEnv() {
  const env = { ...process.env };
  for (const name of ['PI_WEB_ACCESS_TOKEN', 'PI_WEB_ALLOWED_HOSTS', 'PI_WEB_PORT']) {
    if (env[name]) continue;
    try {
      const v = execFileSync('powershell', ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable("${name}","User")`], {
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
      if (v) env[name] = v;
    } catch {
      /* 读不到按默认 */
    }
  }
  return env;
}

async function ensureRunning() {
  let lock = null;
  try {
    lock = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.lock'), 'utf8'));
  } catch {
    /* 无锁 */
  }
  const env = registryEnv();
  const port = Number(env.PI_WEB_PORT || lock?.port || 7318);
  if ((lock?.pid && isAlive(Number(lock.pid)) && (await healthOk(lock.port || port))) || (await healthOk(port))) {
    log(`已在运行（port ${lock?.port || port}），跳过`);
    return;
  }
  // 随包分发时本脚本就在包根，bin 是兄弟目录；手工拷到别处的旧部署才回落 npm root -g
  let binJs = path.join(path.dirname(self), 'bin', 'pi-web.js');
  if (!fs.existsSync(binJs)) {
    const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true, windowsHide: true }).trim();
    binJs = path.join(npmRoot, 'pi-web', 'bin', 'pi-web.js');
  }
  if (!fs.existsSync(binJs)) {
    log(`未找到全局安装的 qika（${binJs}），跳过`);
    return;
  }
  const outLog = path.join(dataDir, 'pi-web.log');
  const child = spawn(process.execPath, [binJs], {
    stdio: ['ignore', fs.openSync(outLog, 'a'), fs.openSync(outLog, 'a')],
    detached: true,
    windowsHide: true,
    cwd: os.homedir(), // 别把 cwd 钉在 npm 全局目录里：会锁目录导致 qika-update EBUSY
    env,
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await healthOk(port)) {
      log(`已拉起 qika（pid ${child.pid}，port ${port}，鉴权${env.PI_WEB_ACCESS_TOKEN ? '已启用' : '未启用'}）`);
      return;
    }
  }
  log(`拉起后 60s 内未就绪，查看 ${outLog}`);
}

if (process.argv.includes('--register')) {
  fs.rmSync(disabledMark, { force: true });
  register();
} else if (process.argv.includes('--ensure')) {
  if (fs.existsSync(disabledMark)) console.log(`[qika-autostart] 已按用户选择关闭登录自启（${disabledMark}），跳过；重开用 --register`);
  else register();
} else if (process.argv.includes('--unregister')) {
  spawnSync('schtasks', ['/delete', '/tn', TASK, '/f'], { stdio: 'ignore', windowsHide: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(disabledMark, `${new Date().toISOString()} --unregister\n`);
  console.log(`[qika-autostart] 已取消登录自启（${TASK}），之后更新不会再自动注册；重开用 --register`);
} else await ensureRunning();
