#!/usr/bin/env node
// 可执行退出条件：扫描五层 KNOWLEDGE / EXPERIENCE 条目里的 exit_check / exit_expect，逐条执行，
// 报「退出条件已满足」的条目——把「满足了也没人执行」变成一条命令的输出（2026-09-28 五层审计 M2）。
//
// 条目写法（两种都认，同一文件取第一次出现）：
//   ① frontmatter：
//        exit_check: rg -c "getShellPath" "$APPDATA/npm/node_modules/pi-web/server/index.js"
//        exit_expect: ^[1-9]
//   ② 正文单独一行（EXPERIENCE 条目没有 frontmatter 时）：
//        - exit_check: `<命令>`
//        - exit_expect: `<正则>`
//   exit_check  一条 shell 命令（bash -c 执行；bash 取 settings.json 的 shellPath）。
//   exit_expect JS 正则（多行模式），匹配命令 stdout 即「已满足」。缺省 = 命令退出码 0 即满足。
//
// 只读约定：exit_check 只能是查询命令（rg/grep/cat/git log/node -p/版本号比对…），不得改文件、
// 发网络写请求、起进程常驻。本脚本不做沙箱——条目与本脚本同属用户自己的配置，信任边界相同；
// 写了有副作用的 exit_check 等于把副作用挂到每次发版上。
//
// 扫描范围：<agentDir>/{knowledge,experience}/*.md（跳过 index.md / INDEX.md / README.md / templates/ /
// deprecated/）+ Qika 项目列表（<dataDir>/app-data.json 的 projects[].path）下 .pi/{knowledge,experience}/*.md。
// cwd：全局库 = agentDir；项目库 = 项目根。单条超时 20s，串行执行。
//
// 用法：node exit-check.mjs [--json] [--agent-dir <dir>] [--data-dir <dir>] [--root <项目根>]...
//   --root 可重复，追加项目根（与 app-data 的项目列表合并）；测试用 --data-dir 指向空目录即只扫 --root。
// 退出码恒 0（结果是清单，不是门禁）；--fail-on-met 时有「已满足」即退出 1（接进发版脚本时用）。
// 召回：pi-web README「发版」章节发版后一步；five-layer-governance 审计。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 20_000;
const SKIP_FILES = new Set(['index.md', 'INDEX.md', 'README.md']);

export function parseArgs(argv) {
  const a = { json: false, failOnMet: false, agentDir: null, dataDir: null, roots: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--json') a.json = true;
    else if (x === '--fail-on-met') a.failOnMet = true;
    else if (x === '--agent-dir') a.agentDir = argv[++i];
    else if (x === '--data-dir') a.dataDir = argv[++i];
    else if (x === '--root') a.roots.push(argv[++i]);
  }
  a.agentDir ??= process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  a.dataDir ??= process.env.PI_WEB_DATA_DIR || path.join(os.homedir(), '.pi-web');
  return a;
}

const unquote = (v) => {
  let s = v.trim();
  if ((s.startsWith('`') && s.endsWith('`')) || (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.trim();
};

/** 取 exit_check / exit_expect；无 exit_check 返回 null */
export function parseExitFields(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  if (lines[0]?.trim() === '---') {
    for (i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
      const m = /^(exit_check|exit_expect)\s*:\s*(.+)$/.exec(lines[i]);
      if (m && out[m[1]] === undefined) out[m[1]] = unquote(m[2]);
    }
  }
  for (const line of lines) {
    const m = /^\s*(?:[-*]\s+)?`?(exit_check|exit_expect)`?\s*[:：]\s*(.+)$/.exec(line);
    if (m && out[m[1]] === undefined) out[m[1]] = unquote(m[2]);
  }
  return out.exit_check ? { check: out.exit_check, expect: out.exit_expect ?? null } : null;
}

export function projectRoots(dataDir, extra = []) {
  const roots = [];
  try {
    const app = JSON.parse(fs.readFileSync(path.join(dataDir, 'app-data.json'), 'utf8'));
    for (const p of Array.isArray(app.projects) ? app.projects : []) if (p && typeof p.path === 'string') roots.push(p.path);
  } catch {
    // 没有 Qika 数据目录：只扫全局 + --root
  }
  const seen = new Set();
  return [...roots, ...extra].filter((r) => {
    const k = path.resolve(r).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 列出所有库里的条目文件：{ file, lib, cwd } */
export function collectEntries(agentDir, roots) {
  const libs = [
    { dir: path.join(agentDir, 'knowledge'), lib: 'global:knowledge', cwd: agentDir },
    { dir: path.join(agentDir, 'experience'), lib: 'global:experience', cwd: agentDir },
  ];
  for (const r of roots) {
    for (const layer of ['knowledge', 'experience']) libs.push({ dir: path.join(r, '.pi', layer), lib: `${r}:${layer}`, cwd: r });
  }
  const out = [];
  for (const l of libs) {
    let names;
    try {
      names = fs.readdirSync(l.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of names) {
      if (!e.isFile() || !e.name.endsWith('.md') || SKIP_FILES.has(e.name)) continue;
      out.push({ file: path.join(l.dir, e.name), lib: l.lib, cwd: l.cwd });
    }
  }
  return out;
}

function shellPath(agentDir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    if (typeof s.shellPath === 'string' && s.shellPath) return s.shellPath;
  } catch {
    // 无 settings：用 PATH 上的 bash
  }
  return 'bash';
}

/** 执行一条：status = met / unmet / error */
export function runCheck(entry, fields, shell) {
  let re = null;
  if (fields.expect !== null) {
    try {
      re = new RegExp(fields.expect, 'm');
    } catch (err) {
      return { status: 'error', detail: `exit_expect 不是合法正则：${err.message}` };
    }
  }
  const r = spawnSync(shell, ['-c', fields.check], { cwd: entry.cwd, encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true });
  if (r.error) return { status: 'error', detail: r.error.code === 'ETIMEDOUT' ? `超时 ${TIMEOUT_MS / 1000}s` : r.error.message };
  const stdout = (r.stdout ?? '').trim();
  const met = re ? re.test(stdout) : r.status === 0;
  return { status: met ? 'met' : 'unmet', detail: `exit ${r.status}${stdout ? `，stdout: ${stdout.split('\n')[0].slice(0, 120)}` : ''}` };
}

export function main(argv) {
  const args = parseArgs(argv);
  const shell = shellPath(args.agentDir);
  const entries = collectEntries(args.agentDir, projectRoots(args.dataDir, args.roots));
  const results = [];
  for (const e of entries) {
    let text;
    try {
      text = fs.readFileSync(e.file, 'utf8');
    } catch {
      continue;
    }
    const fields = parseExitFields(text);
    if (!fields) continue;
    results.push({ file: e.file, lib: e.lib, check: fields.check, expect: fields.expect, ...runCheck(e, fields, shell) });
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  const summary = { scanned: entries.length, withExitCheck: results.length, met: count('met'), unmet: count('unmet'), error: count('error') };
  if (args.json) {
    process.stdout.write(JSON.stringify({ summary, results }, null, 2) + '\n');
  } else {
    const label = { met: '退出条件已满足', unmet: '未满足', error: '执行失败' };
    for (const s of ['met', 'error', 'unmet']) {
      for (const r of results.filter((x) => x.status === s)) console.log(`${label[s]}：${r.file}\n    ${r.detail}`);
    }
    console.log(
      `扫描 ${summary.scanned} 个条目，${summary.withExitCheck} 个写了 exit_check：已满足 ${summary.met} · 未满足 ${summary.unmet} · 执行失败 ${summary.error}` +
        (summary.met ? '\n已满足的按条目自带的退出动作处理（删除/退休/改写），并在对应库的 git 里提交。' : ''),
    );
  }
  return args.failOnMet && summary.met > 0 ? 1 : 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) process.exitCode = main(process.argv.slice(2));
