#!/usr/bin/env node
// post-install.mjs —— 安装时步骤钩子（随包分发，装完由更新器/安装器显式调用）。
//
// 为什么存在：qika-update 自身也是被更新的包的一部分，更新器里写死的安装时
// 步骤永远晚一班车（0.2.66→0.2.67 的 host 自动注册第一遍没跑，实锤）。安装时
// 步骤放本文件，随新包落盘、装完立即被外部调用，新步骤当次生效；更新器退化
// 为稳定外壳（停旧 → 装 → 调钩子 → 拉起），以后加安装时步骤只改本文件。
//
// 千万不要改成 npm postinstall 生命周期：git 依赖带 scripts 会触发 npm 的
// "内嵌 install 预备"流程，嵌套 npm 继承外层 global 配置后在全局树里自我冲突
// (ENOTEMPTY/junction 残留，v0.2.19 实测)。必须由调用方显式 `node post-install.mjs`。
//
// 约定：幂等（重复跑无副作用）；失败退出码非 0，但调用方只警告不阻断安装。
// 用法：node post-install.mjs [--no-hint] [--skip-host]
//   --no-hint   跳过扩展加载提示
//   --skip-host 跳过 Native Messaging host 注册（写注册表）；测试或无浏览器的机器用
// 环境：PI_CODING_AGENT_DIR 覆盖 pi 的 agent 目录（默认 ~/.pi/agent），与 server 取法一致。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isWin = process.platform === 'win32';
// 本文件位于包根（<全局>/pi-web/post-install.mjs），相对自身定位包内资源——
// 保证"新装的包的钩子操作新装的包自己"，不依赖 npm root -g 的解析时机。
const pkgRoot = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(`[post-install] ${m}`);
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');

let failed = false;
if (process.argv.includes('--skip-host')) log('按 --skip-host 跳过 host 注册。');
else if (!setupNativeHost()) failed = true;
const sync = syncPiAgent(pkgRoot, agentDir, log);
if (!sync.ok) failed = true;
if (!process.argv.includes('--no-hint')) printExtensionHint(sync);
process.exit(failed ? 1 : 0);

// 注册内置 browser-takeover 的 Native Messaging host。
// 步骤：跑 setup-host.js（生成含本机绝对路径的 manifest + 复制 node.exe）
// → Windows 跑 register.bat 写 HKCU 注册表（Brave + Chrome）。失败只警告不阻断
// （可手动补：进 native-host/ 跑 setup-host.js && register.bat）。返回是否成功。
function setupNativeHost() {
  const hostDir = path.join(pkgRoot, 'browser-takeover', 'native-host');
  const setupJs = path.join(hostDir, 'setup-host.js');
  if (!fs.existsSync(setupJs)) {
    log('未找到内置 browser-takeover 的 host 配置脚本，跳过 host 自动注册。');
    return true;
  }
  try {
    log(`生成 host 配置:${setupJs}`);
    const r = spawnSync(process.execPath, [setupJs], { encoding: 'utf8' });
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
    return true;
  } catch (e) {
    log(`host 自动注册失败（不影响安装，可稍后手动补）：${e.message}`);
    return false;
  }
}

// 把包内 browser-takeover/pi-agent/（browser_ctl 工具 + browser-agent 技能）同步进 pi 的 agent 目录。
// 此前这一步只写在 INSTALL.md 里靠人手拷，qika-update 之后同事机器上的工具永远停在第一次手拷的版本
//（或根本没有）。规则：目标缺失 → 写入；内容与包内一致 → 跳过；不一致 → 先备份为 .bak-<时间> 再覆盖，
// 用户自己改过的不丢。只写包内列出的文件，不删目标目录里的其他文件。
// 返回 { ok, written, skipped, backedUp, agentDir }。
function syncPiAgent(root, targetDir, out) {
  const src = path.join(root, 'browser-takeover', 'pi-agent');
  const result = { ok: true, written: [], skipped: [], backedUp: [], agentDir: targetDir };
  if (!fs.existsSync(src)) {
    out('包内无 browser-takeover/pi-agent，跳过工具/技能同步。');
    return result;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const walk = (dir, rel = '') => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = path.join(rel, ent.name);
      if (ent.isDirectory()) { walk(path.join(dir, ent.name), relPath); continue; }
      if (!ent.isFile()) continue;
      const from = path.join(dir, ent.name);
      const to = path.join(targetDir, relPath);
      try {
        const next = fs.readFileSync(from);
        if (fs.existsSync(to)) {
          const cur = fs.readFileSync(to);
          if (cur.equals(next)) { result.skipped.push(relPath); continue; }
          const bak = `${to}.bak-${stamp}`;
          fs.copyFileSync(to, bak);
          result.backedUp.push(path.relative(targetDir, bak));
        }
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, next);
        result.written.push(relPath);
      } catch (e) {
        result.ok = false;
        out(`同步 ${relPath} 失败：${e.message}`);
      }
    }
  };
  try {
    walk(src);
  } catch (e) {
    result.ok = false;
    out(`同步 pi-agent 失败：${e.message}`);
  }
  if (result.written.length) out(`工具/技能已同步到 ${targetDir}：${result.written.join(', ')}`);
  if (result.backedUp.length) out(`原文件已备份：${result.backedUp.join(', ')}`);
  if (!result.written.length && result.skipped.length) out(`工具/技能已是最新（${targetDir}）。`);
  return result;
}

// 安装结束的提示：教用户怎么在浏览器里加载未打包扩展（自动化绕不开的一步），
// 以及已加载过的机器为什么还要重载一次（未打包扩展改了文件浏览器不会自己重读）。
function printExtensionHint(sync) {
  const extDir = path.join(pkgRoot, 'browser-takeover', 'extension');
  let extVersion = null;
  try { extVersion = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8')).version ?? null; } catch { /* 旧包或缺文件：不带版本提示 */ }
  console.log('\n' + '='.repeat(60));
  console.log('下一步：浏览器扩展（两种情况选一）');
  console.log('='.repeat(60));
  console.log(`  扩展目录: ${extDir}${extVersion ? `（本包扩展版本 ${extVersion}）` : ''}\n`);
  console.log('  首次安装 : Brave 地址栏 brave://extensions（Chrome 用 chrome://extensions）→');
  console.log('            打开右上角“开发者模式” → “加载已解压的扩展程序” → 选中上面的扩展目录');
  console.log('            （本包 manifest 带固定 key，扩展 ID 稳定，无需改配置）');
  // 未打包扩展改了文件浏览器不会自己重读，但只有扩展本身变过才需要重载——用版本号当判据，别让用户每次更新都白点一次
  console.log(extVersion
    ? `  已装过的 : 同一页面看 QikaCode 卡片上的版本号——不是 ${extVersion} 就点一次“重新加载”（是就不用动，扩展没变）\n`
    : '  已装过的 : 同一页面对 QikaCode 点一次“重新加载”（浏览器不会自动重读未打包扩展）\n');
  if (sync?.written?.length) {
    console.log(`  browser_ctl 工具与 browser-agent 技能已同步到 ${sync.agentDir}，重启 QiKa Code 后新会话生效。`);
  } else {
    console.log(`  browser_ctl 工具与 browser-agent 技能位于 ${sync.agentDir}（已是最新）。`);
  }
  console.log('  完成   : 重启 QiKa Code 后 bridge 自动启动，即可用 browser_ctl 操作浏览器。\n');
}
