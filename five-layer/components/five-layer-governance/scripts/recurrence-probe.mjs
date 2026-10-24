#!/usr/bin/env node
// 跨会话复发体检：从「失败」出发扫会话记录，找出以条目为锚的统计（注入/裁决/退出条件）看不见的三类问题。
// 来由：2026-10-04 评估 Anthropic「dreaming」演讲——带外、跨会话地审转录，附样本与频次交人判定。首跑实例：
// 一个环境坑从经验库升到知识库后，知识指针只匹配用户输入、该页触发词只出现在工具报错里，0 次推送、坑照踩 43 次，
// 每会话只撞 1~2 次，会话内沉淀与所有现有统计都看不见。
//
//   ① 新的反复报错：同一种工具报错在 ≥N 个会话出现，两侧经验库都没有关键词覆盖
//   ② 召回断开的知识页：页面触发词出现在工具报错里的会话数多于用户输入里的（知识指针只匹配用户输入）
//   ③ 只有另一边的库记过的坑：pi 会话的报错只被 Claude Code 经验库覆盖（或反之）——同一台机器两套库互不相通
// 只读会话与索引、只出清单，不改任何库。写库仍走 knowledge-sediment / five-layer-governance（Claude 侧 /sediment）。
//
// 不计入签名的报错（只在摘要里计数）：用户拒绝审批、宿主门禁的设计内拦截（经验减速带、压缩后恢复读门、
// automode 判定拒绝）、模型自身的操作失误（edit 文本不匹配、参数校验失败、未读先改）、中断。
// 覆盖判定与两侧注入钩子同口径：失败事件匹配「调用输入 + 报错文本」，≥2 个关键词或 1 个可单触发的长关键词。
// 关键词匹配规则抄自 pi-extensions/experience-retrieve/index.ts（keywordMatches / singleKeywordTriggerable），
// 一致性由 recurrence-probe.test.mjs 钉住；Claude 侧 experience-retrieve.py 是同一规则的 Python 版。
//
// 判定账本：<agentDir>/experience/recurrence-ledger.json（随 agent 目录的 git 走）
//   { "version": 1, "entries": { "<键>": { "verdict", "note", "at", "sessions" } } }
//   verdict：fixed 根因已修 · awaiting-release 已修但要发版/重启才生效 · recorded 已写进库 · tracked 已登记待办 · ignore 不用管
//   键：报告 --json 里的 key（① pi|<工具> <签名> ／ ② kn:<页> ／ ③ xh:<侧>:<条目>）；以 "re:" 开头的是正则，
//   匹配一族键（如同一工具超时文案的各个 action），按整族合计
//   重报：fixed → 判定时刻之后再出现一次即报「修复无效」；awaiting-release → 每次都列出，提示装上新版后改记 fixed
//   （判定时刻 = 生效时刻，否则发版前的事件会被误报成修复无效）；其余 → 会话数到判定时的 2 倍报「加剧」；
//   已判且没到重报条件的不显示（--all 显示）
//
// 用法：
//   node recurrence-probe.mjs [--days 30] [--min-sessions 3] [--until YYYY-MM-DD] [--all] [--json] [--fail-on-new]
//                             [--agent-dir <dir>] [--claude-dir <dir>] [--data-dir <dir>] [--ledger <file>]
//   node recurrence-probe.mjs --judge <id|键|re:正则> <fixed|awaiting-release|recorded|tracked|ignore> "<说明>"
//   id 是报告方括号里的 7 位短码；--judge 会按同样参数重扫一次，记下当前会话数作为「加剧」的基线。
// 退出码恒 0（结果是清单，不是门禁）；--fail-on-new 时有待判项即退出 1。
// 召回：pi-web README「发版」第 5 步（与 exit-check 并列）；/hits；five-layer-governance 审计。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERDICTS = ['fixed', 'awaiting-release', 'recorded', 'tracked', 'ignore'];

export function parseArgs(argv) {
  const a = {
    days: 30, minSessions: 3, until: null, all: false, json: false, failOnNew: false,
    agentDir: null, claudeDir: null, dataDir: null, ledger: null, judge: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--days') a.days = Number(argv[++i]);
    else if (x === '--min-sessions') a.minSessions = Number(argv[++i]);
    else if (x === '--until') a.until = argv[++i];
    else if (x === '--all') a.all = true;
    else if (x === '--json') a.json = true;
    else if (x === '--fail-on-new') a.failOnNew = true;
    else if (x === '--agent-dir') a.agentDir = argv[++i];
    else if (x === '--claude-dir') a.claudeDir = argv[++i];
    else if (x === '--data-dir') a.dataDir = argv[++i];
    else if (x === '--ledger') a.ledger = argv[++i];
    else if (x === '--judge') a.judge = { target: argv[++i], verdict: argv[++i], note: argv[++i] ?? '' };
  }
  a.agentDir ??= process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  a.claudeDir ??= process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  a.dataDir ??= process.env.PI_WEB_DATA_DIR || path.join(os.homedir(), '.pi-web');
  a.ledger ??= path.join(a.agentDir, 'experience', 'recurrence-ledger.json');
  return a;
}

// ───────────── 关键词匹配（与注入钩子同口径） ─────────────

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 经验库关键词：ASCII 按词边界（纯数字另排除 IP/版本号片段），含 CJK 按子串 */
function compileExpKw(kw) {
  const k = kw.toLowerCase();
  if (/[^\x00-\x7f]/.test(k)) return (t) => t.includes(k);
  const e = escapeRe(k);
  const re = /^\d+$/.test(k)
    ? new RegExp(`(?<![a-z0-9])(?<!\\d\\.)${e}(?![a-z0-9])(?!\\.\\d)`)
    : new RegExp(`(?<![a-z0-9])${e}(?![a-z0-9])`);
  return (t) => re.test(t);
}

export function keywordMatches(kw, textLower) {
  return compileExpKw(kw)(textLower);
}

/** 单个长关键词的独立触发资格：≥8 字符，且不是裸字母单词/全大写常量 */
export function singleKeywordTriggerable(kw) {
  if (kw.length < 8) return false;
  if (/^[A-Za-z]+$/.test(kw)) return false;
  if (/^[A-Z][A-Z0-9_]*$/.test(kw)) return false;
  return true;
}

/** 知识指针触发词：ASCII 按词边界，含 CJK 去空白后子串；单词即命中 */
function compileKnKw(kw) {
  const k = kw.toLowerCase();
  if (/[^\x00-\x7f]/.test(k)) {
    const n = k.replace(/\s+/g, '');
    return (_t, noSpace) => noSpace.includes(n);
  }
  const re = new RegExp(`(?<![a-z0-9])${escapeRe(k)}(?![a-z0-9])`);
  return (t) => re.test(t);
}

// ───────────── 索引解析（与各侧扩展/钩子同口径） ─────────────

const splitKws = (s, sep) => s.split(sep).map((k) => k.trim()).filter(Boolean);

/** pi 经验 INDEX：| 关键词 | [`x.md`](x.md) | 现象 | active | …，只取整词 active 行 */
export function parsePiExpIndex(text, baseDir) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4 || /^[-: ]+$/.test(cells[0]) || cells[0] === '关键词') continue;
    if (!/\bactive\b/.test(cells[3])) continue;
    const link = /\(([^)]+)\)/.exec(cells[1])?.[1] ?? /`([^`]+)`/.exec(cells[1])?.[1];
    const kws = splitKws(cells[0], /[、,，]/);
    if (link && kws.length) out.push({ file: path.resolve(baseDir, link), kws });
  }
  return out;
}

/** Claude 经验 INDEX：- `kw1, kw2`: 相对路径 */
export function parseClaudeExpIndex(text, baseDir) {
  const out = [];
  for (const m of text.matchAll(/^- `([^`]+)`:\s*(\S+)/gm)) {
    const kws = splitKws(m[1], ',');
    if (kws.length) out.push({ file: path.resolve(baseDir, m[2]), kws });
  }
  return out;
}

/** pi 知识 index：| 页面 | 摘要 | read_when | used_by | 状态 | 更新日期 | 触发词 |，状态整词 verified/active */
export function parsePiKnIndex(text, baseDir) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 7 || /^[-: ]+$/.test(cells[0]) || cells[0] === '页面') continue;
    if (!/\b(?:verified|active)\b/.test(cells[4])) continue;
    const link = /\(([^)]+)\)/.exec(cells[0])?.[1] ?? /`([^`]+)`/.exec(cells[0])?.[1];
    const kws = splitKws(cells[6], /[、,，]/);
    if (link && kws.length) out.push({ file: path.resolve(baseDir, link), kws });
  }
  return out;
}

/** Claude 知识 index：≥6 列表格，首列裸 x.md，末列逗号分隔 keywords */
export function parseClaudeKnIndex(text, baseDir) {
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('|')) continue;
    const cells = s.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.length < 6 || !cells[0].endsWith('.md')) continue;
    const kws = splitKws(cells[cells.length - 1], ',');
    if (kws.length) out.push({ file: path.resolve(baseDir, cells[0]), kws });
  }
  return out;
}

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// ───────────── 报错签名 ─────────────

const NOISE = [
  ['用户拒绝', /^User denied this action|The user doesn't want to proceed|用户拒绝/i],
  ['宿主门禁拦截', /^【经验减速带】|^⛔|^Context was compacted\. Read the active task|^\[pi-automode\](?![^\n]*classifier failed)/i],
  ['模型操作失误', /Could not find (?:edits\[\d+\]|the exact text)|Found \d+ occurrences|edits\[\d+\] and edits\[\d+\] overlap|String to replace not found|No changes to make|File has not been read yet|File has been modified since|InputValidationError|Validation failed for tool|Offset \d+ is beyond end of file/i],
  ['中断', /^(?:Operation )?aborted\b|^Cancelled by interrupt|Request was aborted|^\[Request interrupted/i],
];

export function noiseKind(text) {
  for (const [kind, re] of NOISE) if (re.test(text)) return kind;
  return null;
}

const EXIT_LINE = /^(?:Error: )?Exit code \d+$|^Command exited with code \d+$/i;
const ERR_LINE = /error|failed|failure|not found|denied|refused|timed? ?out|cannot|can't|unable|ENOENT|EACCES|EPERM|EADDRINUSE|ECONN|fatal|exception|无法|失败|错误|不存在|拒绝|超时/i;
const EXC_LINE = /^[A-Za-z_][\w.]*(?:Error|Exception)\b|^fatal:|^error:/i;
const GENERIC_HEAD = /^\(no output\)$|^command timed out|^$/i;
const SKIP_PROGRAMS = new Set(['cd', 'echo', 'export', 'set', 'sleep', 'true', 'printf', 'mkdir', 'pushd']);

/** bash 命令的主程序名（跳过 cd/echo 等前置段与 VAR=x、timeout N 前缀）——只在报错本身无信息时拼进签名 */
export function mainProgram(command) {
  for (const seg of String(command).split(/&&|\|\||;|\||\n/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    while (toks.length && (/^\w+=/.test(toks[0]) || toks[0] === 'sudo')) toks.shift();
    if (toks[0] === 'timeout') toks.splice(0, /^\d/.test(toks[1] ?? '') ? 2 : 1);
    const prog = toks[0]?.replace(/^["']|["']$/g, '');
    if (!prog) continue;
    const base = prog.split(/[\\/]/).pop().replace(/\.exe$/i, '');
    if (!SKIP_PROGRAMS.has(base)) return base;
  }
  return '';
}

export function normalizeLine(s) {
  return s
    .replace(/https?:\/\/\S+/g, '<U>')
    .replace(/[A-Za-z]:[\\/][^\s'"`:,)]*/g, '<P>')
    .replace(/(^|[\s(='"])\/[^\s'"`:,)]+/g, '$1<P>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<H>')
    .replace(/\d+/g, 'N')
    .replace(/(["'`])[^"'`]{1,80}\1/g, '<S>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

/** 签名 = 工具 [主程序:] 归一化的首条有信息报错行 [#exitN]。Python traceback 取最后一个异常行 */
export function errorSignature(tool, text, input) {
  const exit = /(?:Command exited with code|Exit code)\s+(\d+)/i.exec(text)?.[1];
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !EXIT_LINE.test(s));
  let head;
  if (lines.some((s) => s.startsWith('Traceback (most recent call last)'))) {
    head = [...lines].reverse().find((s) => EXC_LINE.test(s));
  }
  head ??= lines.find((s) => EXC_LINE.test(s)) ?? lines.find((s) => ERR_LINE.test(s)) ?? lines[0] ?? '(no output)';
  const norm = normalizeLine(head) || '(no output)';
  const command = input && typeof input.command === 'string' ? input.command : '';
  const prog = GENERIC_HEAD.test(norm) && command ? mainProgram(command) : '';
  return [tool, prog ? `${prog}:` : '', norm, exit !== undefined ? `#exit${exit}` : ''].filter(Boolean).join(' ');
}

// ───────────── 会话扫描 ─────────────

function walkJsonl(dir, sinceMs, out = []) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, sinceMs, out);
    else if (e.name.endsWith('.jsonl')) {
      try {
        if (fs.statSync(p).mtimeMs >= sinceMs) out.push(p);
      } catch {
        // 扫描期间被删
      }
    }
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (typeof c === 'string' ? c : c?.type === 'text' || c?.text ? (c.text ?? '') : '')).join('\n');
}

const inWindow = (ts, win) => typeof ts === 'string' && ts >= win.sinceIso && ts <= win.untilIso;

/** pi 会话：toolResult isError=true 为报错，toolCall 取调用参数，role=user 为用户输入 */
export function scanPiFile(file, win) {
  const calls = new Map();
  const errors = [];
  const prompts = [];
  let cwd = '';
  for (const line of (readText(file) ?? '').split('\n')) {
    const isErr = line.includes('"isError":true');
    const isCall = line.includes('"type":"toolCall"');
    const isUser = line.includes('"role":"user"');
    const isHead = !cwd && line.includes('"type":"session"');
    if (!isErr && !isCall && !isUser && !isHead) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'session') {
      cwd = String(o.cwd ?? '');
      continue;
    }
    const m = o.message;
    if (!m) continue;
    if (m.role === 'assistant') {
      for (const c of Array.isArray(m.content) ? m.content : []) if (c?.type === 'toolCall') calls.set(c.id, c);
      continue;
    }
    if (!inWindow(o.timestamp, win)) continue;
    if (m.role === 'user') prompts.push(textOf(m.content));
    else if (m.role === 'toolResult' && m.isError) {
      const c = calls.get(m.toolCallId);
      errors.push({ ts: o.timestamp, tool: m.toolName ?? c?.name ?? '?', text: textOf(m.content), input: c?.arguments ?? {} });
    }
  }
  return { cwd, errors, prompts };
}

/** Claude Code 转录：user 消息里的 tool_result is_error=true 为报错，assistant 的 tool_use 取调用输入 */
export function scanClaudeFile(file, win) {
  const calls = new Map();
  const errors = [];
  const prompts = [];
  let cwd = '';
  for (const line of (readText(file) ?? '').split('\n')) {
    const isErr = line.includes('"is_error":true');
    const isUse = line.includes('"type":"tool_use"');
    const isPrompt = line.includes('"type":"user"') && !line.includes('"tool_result"');
    if (!isErr && !isUse && !isPrompt) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!cwd && typeof o.cwd === 'string') cwd = o.cwd;
    const m = o.message;
    if (!m) continue;
    if (o.type === 'assistant') {
      for (const c of Array.isArray(m.content) ? m.content : []) if (c?.type === 'tool_use') calls.set(c.id, c);
      continue;
    }
    if (o.type !== 'user' || !inWindow(o.timestamp, win)) continue;
    if (isPrompt) {
      if (!o.isMeta) prompts.push(textOf(m.content));
      continue;
    }
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c?.type !== 'tool_result' || !c.is_error) continue;
      const call = calls.get(c.tool_use_id);
      errors.push({ ts: o.timestamp, tool: call?.name ?? '?', text: textOf(c.content), input: call?.input ?? {} });
    }
  }
  return { cwd, errors, prompts };
}

// ───────────── 库与覆盖 ─────────────

const normPath = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function projectRoots(dataDir) {
  try {
    const app = JSON.parse(fs.readFileSync(path.join(dataDir, 'app-data.json'), 'utf8'));
    return (Array.isArray(app.projects) ? app.projects : []).map((p) => p?.path).filter((p) => typeof p === 'string');
  } catch {
    return [];
  }
}

function compileEntries(entries, label, compile) {
  return entries.map((e) => ({ label: label(e.file), kws: e.kws.map((kw) => ({ kw, test: compile(kw) })) }));
}

function rel(base, file) {
  const r = path.relative(base, file).replace(/\\/g, '/');
  return r.startsWith('..') ? file.replace(/\\/g, '/') : r;
}

export function loadLibs(args, roots) {
  const piExpDir = path.join(args.agentDir, 'experience');
  const ccExpDir = path.join(args.claudeDir, 'experience');
  const piExp = compileEntries(
    parsePiExpIndex(readText(path.join(piExpDir, 'INDEX.md')) ?? '', piExpDir),
    (f) => `pi:${rel(piExpDir, f)}`,
    compileExpKw,
  );
  const ccExp = compileEntries(
    parseClaudeExpIndex(readText(path.join(ccExpDir, 'INDEX.md')) ?? '', ccExpDir),
    (f) => `claude:${rel(ccExpDir, f)}`,
    compileExpKw,
  );
  // 项目经验库不被注入，但写进了库就算有人记过（项目 AGENTS 路由召回）；解析不了的格式自然跳过
  const piProjExp = roots.map((r) => {
    const d = path.join(r, '.pi', 'experience');
    return { root: normPath(r), entries: compileEntries(parsePiExpIndex(readText(path.join(d, 'INDEX.md')) ?? '', d), (f) => `proj:${f.replace(/\\/g, '/')}`, compileExpKw) };
  });
  const kn = [];
  const piKnDir = path.join(args.agentDir, 'knowledge');
  for (const p of parsePiKnIndex(readText(path.join(piKnDir, 'index.md')) ?? '', piKnDir)) kn.push({ side: 'pi', root: null, label: `pi:knowledge/${rel(piKnDir, p.file)}`, kws: p.kws });
  for (const r of roots) {
    const d = path.join(r, '.pi', 'knowledge');
    for (const p of parsePiKnIndex(readText(path.join(d, 'index.md')) ?? '', d)) kn.push({ side: 'pi', root: normPath(r), label: `pi:${p.file.replace(/\\/g, '/')}`, kws: p.kws });
  }
  const ccKnDir = path.join(args.claudeDir, 'knowledge');
  for (const p of parseClaudeKnIndex(readText(path.join(ccKnDir, 'index.md')) ?? '', ccKnDir)) kn.push({ side: 'claude', root: null, label: `claude:knowledge/${rel(ccKnDir, p.file)}`, kws: p.kws });
  for (const r of args.claudeProjectRoots ?? []) {
    const d = path.join(r, '.claude', 'knowledge');
    for (const p of parseClaudeKnIndex(readText(path.join(d, 'index.md')) ?? '', d)) kn.push({ side: 'claude', root: normPath(r), label: `claude:${p.file.replace(/\\/g, '/')}`, kws: p.kws });
  }
  for (const page of kn) page.tests = page.kws.map(compileKnKw);
  return { piExp, ccExp, piProjExp, kn };
}

/**
 * 达到注入门槛（≥2 个命中词，或 1 个可单触发的长词）即返回条目标签。
 * errLower 非空时另要求至少一个命中词出现在报错文本里——用于判「本侧已覆盖、不必再报」：只在调用输入里命中，
 * 钩子会照注，但说明不了「这种报错有人记过」（首跑实测：grep 命令带 node_modules 被算成联接点条目覆盖，真报错被藏掉）。
 * 判「只有另一侧的库记过」时不加此要求（errLower=null）：语义就是「另一侧的钩子在这里会注入」，与钩子同口径；
 * 首跑实测加了要求会把 17 个会话的 bash→PowerShell `$` 展开坑（报错里只有 CommandNotFoundException）拆成碎片沉到门槛下。
 * 两处取舍同一原则：误报可见、判一次就安静，漏报不可见。
 */
export function firstCovering(entries, textLower, errLower = null) {
  for (const e of entries) {
    const matched = e.kws.filter((k) => k.test(textLower));
    const n = matched.length;
    if (!(n >= 2 || (n === 1 && singleKeywordTriggerable(matched[0].kw)))) continue;
    if (errLower === null || matched.some((k) => k.test(errLower))) return e.label;
  }
  return null;
}

const underRoot = (cwd, root) => root && (cwd === root || cwd.startsWith(`${root}/`));

// ───────────── 汇总 ─────────────

const shortId = (key) => createHash('sha1').update(key).digest('hex').slice(0, 7);

function newItem(section, key, extra = {}) {
  return { section, key, id: shortId(key), sessions: new Set(), events: [], ...extra };
}

function addEvent(item, ev) {
  item.sessions.add(ev.file);
  item.events.push({ ts: ev.ts, file: ev.file, text: ev.text });
}

/** 扫描 + 三节归并，不套门槛与账本（账本要看到门槛以下的事件才能判「修复无效」） */
export function analyze(args) {
  const untilMs = args.until ? Date.parse(`${args.until}T23:59:59.999Z`) : Date.now();
  const sinceMs = untilMs - args.days * 86_400_000;
  const win = { sinceIso: new Date(sinceMs).toISOString(), untilIso: new Date(untilMs).toISOString() };
  const roots = projectRoots(args.dataDir);
  const sides = [
    { side: 'pi', files: walkJsonl(path.join(args.agentDir, 'sessions'), sinceMs), scan: scanPiFile },
    { side: 'claude', files: walkJsonl(path.join(args.claudeDir, 'projects'), sinceMs), scan: scanClaudeFile },
  ];
  const sessions = [];
  const ccRoots = new Set();
  for (const s of sides) {
    for (const file of s.files) {
      const r = s.scan(file, win);
      if (r.errors.length === 0 && r.prompts.length === 0) continue;
      sessions.push({ side: s.side, file, cwd: normPath(r.cwd), errors: r.errors, prompts: r.prompts });
      if (s.side === 'claude' && r.cwd) ccRoots.add(r.cwd);
    }
  }
  const libs = loadLibs({ ...args, claudeProjectRoots: [...ccRoots] }, roots);

  const noise = {};
  let total = 0;
  const groups = new Map();
  const events = [];
  for (const sess of sessions) {
    const projLib = sess.side === 'pi' ? libs.piProjExp.find((p) => underRoot(sess.cwd, p.root))?.entries ?? [] : [];
    for (const e of sess.errors) {
      total++;
      const text = e.text.replace(/<\/?tool_use_error>/g, '').trim();
      const kind = noiseKind(text);
      if (kind) {
        noise[kind] = (noise[kind] ?? 0) + 1;
        continue;
      }
      const errLower = text.toLowerCase();
      const lower = `${JSON.stringify(e.input ?? {}).toLowerCase()}\n${errLower}`;
      const own = firstCovering(sess.side === 'pi' ? libs.piExp : libs.ccExp, lower, errLower) ?? firstCovering(projLib, lower, errLower);
      const other = own ? null : firstCovering(sess.side === 'pi' ? libs.ccExp : libs.piExp, lower);
      const sig = errorSignature(e.tool, text, e.input);
      const ev = { side: sess.side, file: sess.file, cwd: sess.cwd, ts: e.ts, text, sig, own, other };
      events.push(ev);
      const gk = `${sess.side}|${sig}`;
      let g = groups.get(gk);
      if (!g) groups.set(gk, (g = { key: gk, side: sess.side, sig, evs: [] }));
      g.evs.push(ev);
    }
  }

  const items = [];
  const xhost = new Map();
  let covered = 0;
  for (const g of groups.values()) {
    const ownN = g.evs.filter((e) => e.own).length;
    if (ownN * 2 >= g.evs.length) {
      covered++;
      continue;
    }
    const otherCounts = new Map();
    for (const e of g.evs) if (e.other) otherCounts.set(e.other, (otherCounts.get(e.other) ?? 0) + 1);
    const [topOther, topN] = [...otherCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    if (topOther && topN * 2 >= g.evs.length) {
      const k = `xh:${g.side}:${topOther}`;
      let it = xhost.get(k);
      if (!it) xhost.set(k, (it = newItem('xhost', k, { side: g.side, coveredBy: topOther, sigs: [] })));
      it.sigs.push(g.sig);
      for (const e of g.evs) addEvent(it, e);
      continue;
    }
    const it = newItem('uncovered', g.key, { side: g.side, sig: g.sig });
    for (const e of g.evs) addEvent(it, e);
    items.push(it);
  }
  items.push(...xhost.values());

  // ② 知识页：触发词在报错文本（不含调用输入——指针本来就看不到工具层）vs 用户输入里各出现在几个会话
  for (const page of libs.kn) {
    const it = newItem('knowledge', `kn:${page.label}`, { side: page.side, kws: page.kws, promptSessions: 0 });
    for (const sess of sessions) {
      if (sess.side !== page.side || (page.root && !underRoot(sess.cwd, page.root))) continue;
      const hit = (t) => {
        const lower = t.toLowerCase();
        const noSpace = lower.replace(/\s+/g, '');
        return page.tests.some((test) => test(lower, noSpace));
      };
      if (sess.prompts.some(hit)) it.promptSessions++;
      for (const e of sess.errors) {
        if (noiseKind(e.text)) continue;
        if (hit(e.text)) addEvent(it, { file: sess.file, ts: e.ts, text: e.text });
      }
    }
    if (it.sessions.size > it.promptSessions) items.push(it);
  }

  const summary = {
    window: { since: win.sinceIso.slice(0, 10), until: win.untilIso.slice(0, 10), days: args.days },
    sessions: { pi: sessions.filter((s) => s.side === 'pi').length, claude: sessions.filter((s) => s.side === 'claude').length },
    errors: total,
    noise,
    signatures: groups.size,
    coveredSignatures: covered,
    libs: { piExperience: libs.piExp.length, claudeExperience: libs.ccExp.length, knowledgePages: libs.kn.length },
  };
  return { summary, items };
}

// ───────────── 判定账本 ─────────────

export function loadLedger(file) {
  const raw = readText(file);
  if (raw === null) return { version: 1, entries: {} };
  const parsed = JSON.parse(raw); // 坏账本直接报错，不覆盖（覆盖 = 丢掉全部历史判定）
  parsed.entries ??= {};
  return parsed;
}

/** re: 键把匹配的一族项合成一项（未被精确键判过的才归入） */
function foldPatterns(items, ledger) {
  const out = [];
  const folded = new Map();
  const patterns = Object.keys(ledger.entries)
    .filter((k) => k.startsWith('re:'))
    .map((k) => {
      try {
        return { key: k, re: new RegExp(k.slice(3)) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  for (const it of items) {
    const p = ledger.entries[it.key] ? null : patterns.find((x) => x.re.test(it.key));
    if (!p) {
      out.push(it);
      continue;
    }
    let agg = folded.get(p.key);
    if (!agg) folded.set(p.key, (agg = newItem(it.section, p.key, { side: it.side, members: [] })));
    agg.members.push(it.key);
    for (const e of it.events) addEvent(agg, e);
  }
  return [...out, ...folded.values()];
}

export function applyLedger(items, ledger, minSessions) {
  const pending = [];
  const reopened = [];
  const awaiting = [];
  const quiet = [];
  for (const it of foldPatterns(items, ledger)) {
    const entry = ledger.entries[it.key];
    if (!entry) {
      if (it.sessions.size >= minSessions) pending.push(it);
      continue;
    }
    if (entry.verdict === 'awaiting-release') {
      awaiting.push({ ...it, entry });
      continue;
    }
    if (entry.verdict === 'fixed') {
      const after = it.events.filter((e) => e.ts > entry.at);
      if (after.length) {
        reopened.push({ ...it, why: 'fixed-recurred', entry, after: after.length, afterSessions: new Set(after.map((e) => e.file)).size });
        continue;
      }
    } else if (it.sessions.size >= Math.max(minSessions, 2 * (entry.sessions ?? 0))) {
      reopened.push({ ...it, why: 'worsened', entry });
      continue;
    }
    quiet.push({ ...it, entry });
  }
  const bySessions = (a, b) => b.sessions.size - a.sessions.size;
  return { pending: pending.sort(bySessions), reopened: reopened.sort(bySessions), awaiting: awaiting.sort(bySessions), quiet: quiet.sort(bySessions) };
}

export function findTarget(items, ledger, target) {
  if (target.startsWith('re:')) {
    const re = new RegExp(target.slice(3));
    const members = items.filter((it) => re.test(it.key));
    if (members.length === 0) return null;
    const agg = newItem(members[0].section, target, { members: members.map((m) => m.key) });
    for (const m of members) for (const e of m.events) addEvent(agg, e);
    return agg;
  }
  return foldPatterns(items, ledger).find((it) => it.id === target || it.key === target) ?? null;
}

// ───────────── 输出 ─────────────

const SECTION_TITLE = {
  uncovered: '① 新的反复报错（两侧经验库都没有记录）',
  knowledge: '② 召回断开的知识页（触发词在工具报错里比在用户输入里多；知识指针只看用户输入）',
  xhost: '③ 只有另一边的库记过的坑',
};

function latest(it) {
  return it.events.reduce((m, e) => (e.ts > m.ts ? e : m), it.events[0]);
}

function describe(it) {
  const last = latest(it);
  const lines = [`[${it.id}] ${it.sessions.size} 个会话 / ${it.events.length} 次 · ${it.side ?? ''} · 最近 ${last?.ts?.slice(0, 10) ?? '?'}`];
  if (it.key.startsWith('re:')) lines.push(`    整族：${it.key}（${it.members?.length ?? 0} 个签名）`);
  else if (it.section === 'uncovered') lines.push(`    ${it.sig}`);
  else if (it.section === 'xhost') lines.push(`    只被 ${it.coveredBy} 覆盖；签名：${it.sigs.slice(0, 3).join(' ／ ')}${it.sigs.length > 3 ? ` 等 ${it.sigs.length} 个` : ''}`);
  else if (it.section === 'knowledge') lines.push(`    ${it.key.slice(3)}\n    触发词 ${it.kws.join('、')}：工具报错 ${it.sessions.size} 个会话，用户输入 ${it.promptSessions} 个会话`);
  if (last) {
    lines.push(`    样本：${last.file}`);
    lines.push(`    原文：${last.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  return lines.join('\n');
}

function toJson(it) {
  const { sessions, events, ...rest } = it;
  const last = latest(it);
  return { ...rest, sessions: sessions.size, events: events.length, latest: last ? { ts: last.ts, file: last.file, text: last.text.slice(0, 300) } : null };
}

export function render(summary, result, args) {
  const out = [];
  const n = summary.noise;
  out.push(
    `跨会话复发体检：${summary.window.since} ~ ${summary.window.until}（${summary.window.days} 天），pi ${summary.sessions.pi} 个会话、Claude Code ${summary.sessions.claude} 个会话`,
    `工具报错 ${summary.errors} 次；不计入签名：${Object.entries(n).map(([k, v]) => `${k} ${v}`).join('、') || '无'}；签名 ${summary.signatures} 个，其中 ${summary.coveredSignatures} 个已被本侧经验库覆盖`,
    `判定账本：${args.ledger}`,
  );
  for (const section of ['uncovered', 'knowledge', 'xhost']) {
    const list = result.pending.filter((it) => it.section === section);
    out.push('', `## ${SECTION_TITLE[section]}：${list.length} 条待判`);
    for (const it of args.all ? list : list.slice(0, 15)) out.push(describe(it));
    if (!args.all && list.length > 15) out.push(`  …另 ${list.length - 15} 条（--all 全部显示）`);
  }
  out.push('', `## 账本里需要重看的：${result.reopened.length} 条`);
  for (const it of result.reopened) {
    const e = it.entry;
    const why = it.why === 'fixed-recurred'
      ? `修复无效：${e.at.slice(0, 10)} 判为已修（${e.note}），之后又出现 ${it.after} 次 / ${it.afterSessions} 个会话`
      : `加剧：${e.at.slice(0, 10)} 判为 ${e.verdict}（${e.note}）时 ${e.sessions} 个会话，现在 ${it.sessions.size} 个`;
    out.push(`${describe(it)}\n    ${why}`);
  }
  out.push('', `## 等发版/重启生效的修复：${result.awaiting.length} 条${result.awaiting.length ? '（装上含修复的新版、服务重启后，逐条改记 fixed——从那一刻起再出现才算修复无效）' : ''}`);
  for (const it of result.awaiting) out.push(`[${it.id}] ${it.key.slice(0, 120)}\n    ${it.entry.at.slice(0, 10)}：${it.entry.note}`);
  out.push('', `已判且未到重报条件：${result.quiet.length} 条${args.all ? '' : '（--all 显示）'}`);
  if (args.all) for (const it of result.quiet) out.push(`${describe(it)}\n    已判 ${it.entry.verdict}：${it.entry.note}`);
  const todo = result.pending.length + result.reopened.length;
  if (todo) {
    out.push(
      '',
      `处置：对每条三选一——修根因、写进库、判为不用管——然后记账（一族签名可用 re:正则 一次判）：`,
      `  node ${path.basename(fileURLToPath(import.meta.url))} --judge <id> ${VERDICTS.join('|')} "<说明>"`,
    );
  }
  return out.join('\n');
}

export function main(argv) {
  const args = parseArgs(argv);
  const ledger = loadLedger(args.ledger);
  const { summary, items } = analyze(args);

  if (args.judge) {
    const { target, verdict, note } = args.judge;
    if (!target || !VERDICTS.includes(verdict)) {
      console.error(`用法：--judge <id|键|re:正则> <${VERDICTS.join('|')}> "<说明>"`);
      return 2;
    }
    const it = findTarget(items, ledger, target);
    if (!it) {
      console.error(`本期扫描里找不到 ${target}（窗口 ${summary.window.since} ~ ${summary.window.until}）`);
      return 2;
    }
    ledger.entries[it.key] = { verdict, note, at: new Date().toISOString(), sessions: it.sessions.size };
    fs.mkdirSync(path.dirname(args.ledger), { recursive: true });
    fs.writeFileSync(args.ledger, `${JSON.stringify(ledger, null, 2)}\n`);
    console.log(`已记账：${it.key} → ${verdict}（当前 ${it.sessions.size} 个会话）${it.members ? `\n  覆盖 ${it.members.length} 个签名：${it.members.slice(0, 5).join(' ／ ')}` : ''}`);
    return 0;
  }

  const result = applyLedger(items, ledger, args.minSessions);
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ summary, ledger: args.ledger, pending: result.pending.map(toJson), reopened: result.reopened.map(toJson), awaiting: result.awaiting.map(toJson), quiet: result.quiet.length }, null, 2)}\n`,
    );
  } else {
    console.log(render(summary, result, args));
  }
  return args.failOnNew && result.pending.length + result.reopened.length > 0 ? 1 : 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) process.exitCode = main(process.argv.slice(2));
