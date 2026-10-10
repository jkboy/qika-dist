#!/usr/bin/env node
// pi 侧 skill 触发回归：对 <skill>/evals/trigger.json 每行 query 起一个真实 `pi -p --mode json --no-session`（空目录 cwd），
// 看第一条 assistant 消息路由到了哪个 skill（pi 的 skill 加载 = read <skills>/<name>/SKILL.md），与 should_trigger 比对。
// 与 Claude 侧 ~/.claude/skills/compass/scripts/skill-trigger-eval.mjs 同一套样本格式与判定口径，两侧结论可互相对照。
//
// 用法：node skill-trigger-eval.mjs <skill名|skill目录> [--runs N] [--model 模式] [--provider 名] [--concurrency N]
//                                   [--filter 子串] [--timeout 秒] [--only pos|neg] [--no-retry] [--cwd 目录] [--exclude-tools 工具,…]
// 结果写回 <skill>/evals/trigger-results.json，任一行不过关 exit 1。
// --cwd：项目级 skill（<project>/.pi/skills/）要在项目目录下才加载，默认空目录不变。
// --exclude-tools：透传 pi --exclude-tools。评会动真实业务的 skill（如经浏览器审批）时去掉执行型工具，只测描述路由——
//   脚本在第一条 assistant 消息后才 kill，工具调用可能已开始执行。
//
// 注意：会剔除继承来的 ANTHROPIC_* 环境变量（宿主 Claude Code 会话带着 CC 渠道的 BASE_URL/AUTH_TOKEN，pi 拿去打 anthropic 直连必 401），
// 让 pi 走 settings.json 的默认 provider/model；要换模型用 --model/--provider。
// 声明模型 vs 实际模型核对（2026-09-28）：settings 的 defaultProvider 在 models.json 改名后悬空时 pi 静默回落到第一个 provider，
// 基线就换了模型、费用 ×12 而无人察觉（五层审计 H1）。声明值取 --provider/--model，否则 <cwd>/.pi/settings.json 覆盖 → 全局 settings；
// 实际值取每条 assistant 消息的 provider/model，不一致时醒目告警并写进 trigger-results.json 的 model_check。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
  console.log('用法: node skill-trigger-eval.mjs <skill名|skill目录> [--runs N] [--model M] [--provider P] [--concurrency N] [--filter 子串] [--timeout 秒] [--only pos|neg] [--no-retry] [--cwd 目录] [--exclude-tools 工具,…]');
  process.exit(argv.length ? 0 : 2);
}
const opt = { runs: 1, model: null, provider: null, concurrency: 2, filter: null, timeout: 120, only: null, retry: true, cwd: null, excludeTools: null };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const take = () => argv[++i];
  if (a === '--runs') opt.runs = Math.max(1, parseInt(take(), 10) || 1);
  else if (a === '--model') opt.model = take();
  else if (a === '--provider') opt.provider = take();
  else if (a === '--concurrency') opt.concurrency = Math.max(1, parseInt(take(), 10) || 1);
  else if (a === '--filter') opt.filter = take();
  else if (a === '--timeout') opt.timeout = Math.max(10, parseInt(take(), 10) || 120);
  else if (a === '--only') opt.only = take();
  else if (a === '--no-retry') opt.retry = false;
  else if (a === '--cwd') opt.cwd = take();
  else if (a === '--exclude-tools') opt.excludeTools = take();
  else positional.push(a);
}

// USERPROFILE 幽灵路径：占位拼法对 Node fs 可能 ENOENT，逐候选以 .pi/agent/skills 真实可读为准
function resolveHome() {
  const cands = [];
  for (const v of [process.env.HOME, process.env.USERPROFILE]) {
    if (!v) continue;
    cands.push(v);
    const m = /^\/([a-zA-Z])\/(.*)$/.exec(v);
    if (m) cands.push(`${m[1].toUpperCase()}:/${m[2]}`);
  }
  cands.push(os.homedir());
  for (const c of cands) {
    try { if (fs.existsSync(path.join(c, '.pi', 'agent', 'skills'))) return c; } catch {}
  }
  try {
    for (const u of fs.readdirSync('C:/Users')) {
      const p = `C:/Users/${u}`;
      if (fs.existsSync(path.join(p, '.pi', 'agent', 'skills'))) return p;
    }
  } catch {}
  return os.homedir();
}
const HOME = resolveHome();
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(HOME, '.pi', 'agent');

function resolveSkillDir(arg) {
  if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) return path.resolve(arg);
  const p = path.join(AGENT_DIR, 'skills', arg);
  if (fs.existsSync(p)) return p;
  throw new Error(`找不到 skill 目录：${arg}（试过 ${p}）`);
}
const skillDir = resolveSkillDir(positional[0]);
const skillName = (() => {
  const md = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  const m = /^name:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(md);
  return m ? m[1].trim() : path.basename(skillDir);
})();
const evalFile = path.join(skillDir, 'evals', 'trigger.json');
if (!fs.existsSync(evalFile)) {
  console.error(`没有 ${evalFile}。格式：[{"query": "...", "should_trigger": true|false, "route": "期望改由哪个 skill 接（可选）"}]`);
  process.exit(2);
}
let rows = JSON.parse(fs.readFileSync(evalFile, 'utf8'));
if (!Array.isArray(rows)) throw new Error('trigger.json 顶层必须是数组');
rows = rows.map((r, i) => ({ ...r, idx: i }));
if (opt.filter) rows = rows.filter((r) => r.query.includes(opt.filter));
if (opt.only === 'pos') rows = rows.filter((r) => r.should_trigger);
if (opt.only === 'neg') rows = rows.filter((r) => !r.should_trigger);
if (!rows.length) { console.error('过滤后没有样本'); process.exit(2); }

function resolveTmpCwd() {
  for (const base of [os.tmpdir(), path.join(HOME, 'skill-trigger-eval-tmp')]) {
    try {
      const d = path.join(base, 'pi-skill-trigger-eval');
      fs.mkdirSync(d, { recursive: true });
      const probe = path.join(d, `.probe-${process.pid}`); // 带 pid：两路并行评测共用目录时不互删探针（否则第二路回落到家目录）
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      return d;
    } catch {}
  }
  throw new Error('找不到可写的临时目录');
}
let tmpCwd;
if (opt.cwd) {
  if (!fs.existsSync(opt.cwd) || !fs.statSync(opt.cwd).isDirectory()) { console.error(`--cwd 不是目录：${opt.cwd}`); process.exit(2); }
  tmpCwd = path.resolve(opt.cwd);
} else tmpCwd = resolveTmpCwd();

// 不在 pi 自动发现范围内的 skill（如 Qika server 注入的 server/skills/media-gen）：显式 --skill 加载，
// 让它的描述进技能目录参与路由（工具面仍是 CLI 的，只测描述路由）。已安装的同名 skill 不重复加载（重名冲突）。
const explicitSkill = !fs.existsSync(path.join(AGENT_DIR, 'skills', skillName)) && !fs.existsSync(path.join(tmpCwd, '.pi', 'skills', skillName));
if (explicitSkill) console.log(`（${skillName} 不在自动发现范围，按 --skill ${skillDir} 显式加载）`);

// 声明模型：--provider/--model > <cwd>/.pi/settings.json > 全局 settings.json（pi 的 settings 合并同序）
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
const declared = (() => {
  const g = readJson(path.join(AGENT_DIR, 'settings.json')) || {};
  const pj = readJson(path.join(tmpCwd, '.pi', 'settings.json')) || {};
  // 只给 --model 时 pi 跨全部 provider 解析模式，此时不声明 provider
  const provider = opt.provider ?? (opt.model ? null : pj.defaultProvider ?? g.defaultProvider ?? null);
  const model = opt.model ?? pj.defaultModel ?? g.defaultModel ?? null;
  const source = opt.provider || opt.model ? '命令行参数' : (pj.defaultProvider || pj.defaultModel) ? '项目 settings' : '全局 settings';
  const providers = Object.keys(readJson(path.join(AGENT_DIR, 'models.json'))?.providers || {});
  const dangling = provider && providers.length && !providers.includes(provider) ? provider : null;
  return { provider, model, source, dangling, providers };
})();
if (declared.dangling) {
  console.log(`⚠⚠ 声明的 provider「${declared.dangling}」不在 models.json（现有：${declared.providers.join(', ')}）——pi 会静默回落到别的模型，本次结果不能当基线`);
}

// pi 的 npm shim 是 sh 脚本 / .cmd，直接 spawn 拿不到可 kill 的 PID；解析到 dist/cli.js 用 node 起
function resolvePi() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    if (!fs.existsSync(path.join(dir, 'pi')) && !fs.existsSync(path.join(dir, 'pi.cmd'))) continue;
    for (const pkg of ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent']) {
      const cli = path.join(dir, 'node_modules', pkg, 'dist', 'cli.js');
      if (fs.existsSync(cli)) return { cmd: process.execPath, prefix: [cli], shell: false };
    }
  }
  return { cmd: 'pi', prefix: [], shell: process.platform === 'win32' };
}
const PI = resolvePi();

function skillFromToolCall(block) {
  if (block.type !== 'toolCall') return null;
  const args = block.arguments || {};
  if (block.name === 'read') {
    const m = /[\\/]skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i.exec(String(args.path ?? ''));
    if (m) return m[1];
  }
  if (block.name === 'bash') {
    const m = /[\\/]skills[\\/]([^\\/"'\s]+)[\\/]/i.exec(String(args.command ?? ''));
    if (m) return m[1]; // 有的模型不读 SKILL.md 直接跑 skill 脚本，也算路由到了该 skill
  }
  return null;
}

function runOnce(query) {
  return new Promise((resolve) => {
    // query 走 stdin：命令行位置参数里 `@karpathy …` 会被 pi 当 @文件引用报 File not found
    const args = [...PI.prefix, '-p', '--mode', 'json', '--no-session'];
    if (opt.provider) args.push('--provider', opt.provider);
    if (opt.model) args.push('--model', opt.model);
    if (explicitSkill) args.push('--skill', skillDir);
    if (opt.excludeTools) args.push('--exclude-tools', opt.excludeTools);
    const env = { ...process.env, FIVE_LAYER_EVAL: '1' };
    for (const k of Object.keys(env)) if (/^ANTHROPIC_/.test(k) || k === 'CLAUDECODE') delete env[k];
    const proc = spawn(PI.cmd, args, { cwd: tmpCwd, env, shell: PI.shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdin.on('error', () => {});
    proc.stdin.end(query, 'utf8');

    const out = { skill: null, tools: [], first_input: null, text: '', model: null, provider: null, usage: null, duration_ms: null, ended: 'unknown', error: null, responded: false };
    const t0 = Date.now();
    let buf = '';
    let done = false;
    let stderr = '';
    const timer = setTimeout(() => finish('timeout'), opt.timeout * 1000);

    function finish(how) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      out.ended = how;
      out.duration_ms = Date.now() - t0;
      if (proc.exitCode === null) { try { proc.kill(); } catch {} }
      if (!out.tools.length && !out.text && stderr.trim()) out.error = (out.error ? out.error + ' | ' : '') + stderr.trim().slice(-300);
      resolve(out);
    }

    function handleEvent(ev) {
      if (ev.type === 'message_start' && ev.message?.role === 'assistant') out.responded = true;
      if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
        const m = ev.message;
        out.model = m.model || out.model;
        out.provider = m.provider || out.provider;
        if (m.usage) out.usage = m.usage;
        if (m.stopReason === 'error') { out.error = String(m.errorMessage || 'error').slice(0, 200); return; } // pi 会自动重试，等下一条
        for (const b of m.content || []) {
          if (b.type === 'text') out.text += b.text || '';
          if (b.type === 'toolCall') {
            out.tools.push(b.name);
            if (!out.first_input) out.first_input = JSON.stringify(b.arguments ?? {}).slice(0, 200);
            const s = skillFromToolCall(b);
            if (s && !out.skill) out.skill = s;
          }
        }
        // 第一条有效 assistant 消息即定路由；有工具调用就 kill（不让它真去执行任务）
        if (out.tools.length || out.text) finish('first-message');
        return;
      }
      if (ev.type === 'agent_end') finish('agent-end');
    }

    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        handleEvent(ev);
        if (done) break;
      }
    });
    proc.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    proc.on('error', (e) => { out.error = e.message; finish('spawn-error'); });
    proc.on('close', () => finish(out.tools.length || out.text ? 'exit' : 'exit-early'));
  });
}

const isValid = (x) => x.tools.length > 0 || x.text.length > 0;
const results = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runJobs(jobs, concurrency) {
  let cursor = 0;
  let launched = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      if (launched++ > 0) await sleep(1500);
      const res = await runOnce(job.row.query);
      if (!results.has(job.row.idx)) results.set(job.row.idx, []);
      results.get(job.row.idx).push(res);
      const trig = res.skill === skillName;
      const ok = job.row.should_trigger ? trig : !trig;
      const tag = !isValid(res) ? '?' : ok ? '✓' : '✗';
      process.stdout.write(`${tag} [${job.row.should_trigger ? '应触发' : '不触发'}] ${describe(res).padEnd(28)} ${(res.duration_ms / 1000).toFixed(1)}s  ${short(job.row.query)}\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
}
function describe(res) {
  if (res.skill) return `skill:${res.skill}`;
  if (res.tools.length) return `tool:${res.tools[0]}${res.first_input ? ' ' + res.first_input.slice(0, 60) : ''}`;
  if (res.text) return '直接作答';
  const why = !res.responded ? '上游无响应' : '无内容';
  return `无效(${res.ended}/${why}${res.error ? ': ' + res.error.slice(0, 50) : ''})`;
}
function short(q) { return q.length > 56 ? q.slice(0, 55) + '…' : q; }

console.log(`skill=${skillName}  样本=${rows.length}  runs=${opt.runs}  并发=${opt.concurrency}  cwd=${tmpCwd}  pi=${PI.prefix[0] || PI.cmd}  声明模型=${declared.provider ?? '?'}/${declared.model ?? '?'}（${declared.source}）`);
const jobs = [];
for (const r of rows) for (let k = 0; k < opt.runs; k++) jobs.push({ row: r, k });
await runJobs(jobs, opt.concurrency);

if (opt.retry) {
  const redo = [];
  for (const r of rows) {
    const invalid = (results.get(r.idx) || []).filter((x) => !isValid(x)).length;
    for (let k = 0; k < invalid; k++) redo.push({ row: r, k });
  }
  if (redo.length) {
    console.log(`\n${redo.length} 次无效运行，15s 后串行重试一次…`);
    await sleep(15000);
    for (const [idx, runs] of results) results.set(idx, runs.filter(isValid));
    await runJobs(redo, 1);
  }
}

const report = [];
let missed = 0, misfired = 0, posN = 0, negN = 0, unknown = 0, inTok = 0, cacheTok = 0, outTok = 0, cost = 0, model = null;
const actualSet = new Map(); // "provider/model" → 次数
for (const r of rows) {
  const runs = results.get(r.idx) || [];
  const valid = runs.filter(isValid);
  const trigs = valid.filter((x) => x.skill === skillName).length;
  const rate = valid.length ? trigs / valid.length : null;
  const pass = rate === null ? null : r.should_trigger ? rate >= 0.5 : rate < 0.5;
  if (r.should_trigger) posN++; else negN++;
  if (pass === null) unknown++;
  else if (!pass) { if (r.should_trigger) missed++; else misfired++; }
  const observed = [...new Set(runs.map(describe))];
  const routeOk = r.route && !r.should_trigger ? runs.some((x) => x.skill === r.route) : undefined;
  for (const x of runs) {
    if (x.usage) { inTok += x.usage.input || 0; cacheTok += (x.usage.cacheRead || 0) + (x.usage.cacheWrite || 0); outTok += x.usage.output || 0; cost += x.usage.cost?.total || 0; }
    if (x.model && !model) model = x.model;
    if (x.model) { const k = `${x.provider ?? '?'}/${x.model}`; actualSet.set(k, (actualSet.get(k) || 0) + 1); }
  }
  report.push({ idx: r.idx, query: r.query, should_trigger: r.should_trigger, route: r.route ?? null, trigger_rate: rate, runs: runs.length, pass, observed, route_matched: routeOk, errors: runs.filter((x) => x.error).map((x) => x.error) });
}

// 声明 vs 实际：provider 精确比；model 精确或（--model 给的是模式时）包含即算一致
const actual = [...actualSet.entries()].map(([k, n]) => ({ key: k, runs: n }));
const mismatched = actual.filter(({ key }) => {
  const slash = key.indexOf('/');
  const p = key.slice(0, slash), m = key.slice(slash + 1);
  if (declared.provider && p !== '?' && p !== declared.provider) return true;
  if (declared.model && m !== declared.model && !(opt.model && m.includes(opt.model))) return true;
  return false;
});
const modelCheck = {
  declared: { provider: declared.provider, model: declared.model, source: declared.source },
  declared_provider_missing_in_models_json: declared.dangling,
  actual,
  ok: !declared.dangling && mismatched.length === 0,
};

console.log('');
console.log(`漏触发 ${missed}/${posN} 正样本  ·  误触发 ${misfired}/${negN} 负样本  ·  无效运行 ${unknown}` + (model ? `  ·  model=${model}` : ''));
if (!modelCheck.ok) {
  console.log(`⚠⚠ 模型不一致：声明 ${declared.provider ?? '?'}/${declared.model ?? '?'}（${declared.source}）· 实际 ${actual.map((a) => `${a.key}×${a.runs}`).join(', ') || '无'}——本次结果不能当基线`);
} else if (actual.length) {
  console.log(`模型核对 ✓ 声明=实际 ${actual.map((a) => a.key).join(', ')}（${declared.source}）`);
}
console.log(`token 合计（仅第一条消息）：输入 ${inTok}  缓存 ${cacheTok}  输出 ${outTok}  ·  pi 估算费用 $${cost.toFixed(4)}`);
const bad = report.filter((x) => x.pass === false);
if (bad.length) {
  console.log('\n不过关：');
  for (const b of bad) console.log(`  #${b.idx} [${b.should_trigger ? '应触发' : '不触发'}${b.route ? '→' + b.route : ''}] 观察到 ${b.observed.join(' | ')}\n      ${b.query}`);
}
const misrouted = report.filter((x) => x.pass && x.route && x.route_matched === false);
if (misrouted.length) {
  console.log('\n负样本没误触发、但也没走到期望的相邻 skill（仅供参考，不计失败）：');
  for (const m of misrouted) console.log(`  #${m.idx} 期望→${m.route}  观察到 ${m.observed.join(' | ')}`);
}

const outFile = path.join(skillDir, 'evals', 'trigger-results.json');
fs.writeFileSync(outFile, JSON.stringify({
  skill: skillName, ran_at: new Date().toISOString(), model, model_check: modelCheck, cwd: opt.cwd ? tmpCwd : null, explicit_skill_load: explicitSkill, exclude_tools: opt.excludeTools, runs_per_query: opt.runs, filter: opt.filter, only: opt.only,
  summary: { positives: posN, negatives: negN, missed, misfired, unknown, tokens: { input: inTok, cache: cacheTok, output: outTok }, cost_usd: cost },
  rows: report,
}, null, 2));
console.log(`\n结果已写入 ${outFile}`);
process.exit(missed + misfired > 0 ? 1 : 0);
