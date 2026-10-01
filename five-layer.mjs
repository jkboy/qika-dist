#!/usr/bin/env node
// five-layer.mjs —— 五层体系 starter：opt-in 安装（`qika five-layer init`）与更新时同步（post-install 调 sync）。
// 设计：docs/five-layer-starter-design.md。核心约束：机制组件归上游（同事没改过的才升级），内容归同事（任何路径都不碰）。
//
// 「改没改过」按归一化内容哈希判定：
// - sync 每次写入都把文件哈希记进 <agentDir>/.five-layer/state.json，下次以它为基准（精确，不依赖 git）；
// - 没有写入记录时（首次 init 接管已有副本 / state 损坏重建）比对包内 manifest 的历史版本集（legacy）。
// 只操作 manifest 列出的文件，从不枚举目录：组件目录里同事自加的文件、内容目录里的条目天然不受影响。
// 改过的组件整体跳过，新版放 .five-layer/upstream/<id>/ 供对比合并；组件目录不存在就不装（sync 不恢复被删的，
// 也不自动装上游新增的——显式 `qika five-layer add <id>`）。
//
// 本文件同时是可 import 的模块：post-install.mjs 调 sync，doctor 与测试复用 hashContent 口径（唯一一份）。
// 只用 node 内置模块：随包拷到包根直接跑，不经构建。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATE_DIR = '.five-layer';
export const STATE_FILE = 'state.json';
export const MAINTAINER_MARK = 'maintainer';
const TMP_SUFFIX = '.five-layer-tmp';
// 与 server/src/sessions/skillsService.ts setSkillDisabled 同口径（首个 frontmatter 块内、行首匹配）——两处改动要同步
const DISABLE_RE = /^disable-model-invocation\s*:/;

const here = path.dirname(fileURLToPath(import.meta.url));

export function defaultAgentDir() {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env) return env === '~' || env.startsWith('~/') ? path.join(os.homedir(), env.slice(1)) : env;
  return path.join(os.homedir(), '.pi', 'agent');
}

// ---------- 哈希口径 ----------

function frontmatterEnd(lines) {
  if (lines[0]?.trim() !== '---') return -1;
  return lines.findIndex((l, i) => i > 0 && l.trim() === '---');
}

/** SKILL.md 首个 frontmatter 块里的 disable-model-invocation 行原文；没有返回 null */
export function readDisableLine(text) {
  const lines = text.split(/\r?\n/);
  const end = frontmatterEnd(lines);
  if (end < 0) return null;
  return lines.slice(1, end).find((l) => DISABLE_RE.test(l)) ?? null;
}

/** 把 disable 行设为 line（null = 删除）；写法同 setSkillDisabled：追加在 frontmatter 末尾、保留换行风格 */
export function applyDisableLine(text, line) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const end = frontmatterEnd(lines);
  if (end < 0) return text;
  const inner = lines.slice(1, end).filter((l) => !DISABLE_RE.test(l));
  if (line) inner.push(line);
  return ['---', ...inner, '---', ...lines.slice(end + 1)].join(nl);
}

/**
 * 归一化：去 BOM、CRLF→LF；SKILL.md 剔除 disable 行（Qika 技能面板的启停开关写的就是这一行，不算改动）。
 * 在 Windows 上用记事本另存、git autocrlf 检出都不该让组件被判「改过」。
 */
export function normalizeText(rel, text) {
  let s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  s = s.replace(/\r\n/g, '\n');
  if (path.posix.basename(rel) === 'SKILL.md') s = applyDisableLine(s, null);
  return s;
}

export function hashContent(rel, buf) {
  return crypto.createHash('sha256').update(normalizeText(rel, Buffer.from(buf).toString('utf8'))).digest('hex');
}

export function hashFileOrNull(abs, rel) {
  try {
    return hashContent(rel, fs.readFileSync(abs));
  } catch {
    return null;
  }
}

// ---------- 文件操作 ----------

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 写临时文件再 rename：新会话读到的要么是旧版要么是新版，崩在中途下次按哈希自愈 */
function atomicWrite(abs, data) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + TMP_SUFFIX;
  fs.writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, abs);
      return;
    } catch (e) {
      // Windows：目标被杀毒/索引/编辑器短暂占用时 rename 报 EPERM/EBUSY，退避重试
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      sleepMs(100 * (i + 1));
    }
  }
}

/** agentDir 之下（不含 agentDir 自身）的路径链上有 junction/symlink：真身可能被别的宿主共享，不能改 */
function linkedWithin(agentDir, rel) {
  let p = agentDir;
  for (const part of rel.split('/').filter(Boolean)) {
    p = path.join(p, part);
    try {
      if (fs.lstatSync(p).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

// ---------- manifest / state ----------

export function readManifest(pkgRoot) {
  return JSON.parse(fs.readFileSync(path.join(pkgRoot, 'five-layer', 'manifest.json'), 'utf8'));
}

const destOf = (agentDir, comp) => path.join(agentDir, ...comp.dest.split('/').filter(Boolean));
const srcOf = (pkgRoot, comp, rel) => path.join(pkgRoot, 'five-layer', 'components', comp.id, ...rel.split('/'));

/** 读 state；不存在返回 null；损坏返回 { corrupt: true } */
export function readState(agentDir) {
  const file = path.join(agentDir, STATE_DIR, STATE_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!s || typeof s !== 'object' || typeof s.components !== 'object' || !s.components) throw new Error('结构不对');
    return s;
  } catch {
    return { corrupt: true };
  }
}

function writeState(ctx) {
  if (ctx.dryRun) return;
  atomicWrite(path.join(ctx.agentDir, STATE_DIR, STATE_FILE), `${JSON.stringify(ctx.state, null, 2)}\n`);
}

// ---------- 单组件 ----------

/**
 * mode：init / add（目录不存在就装）、sync（不存在就不装）、force（add --force：已备份，按全新装）。
 * 返回该组件的 state 记录。
 */
function processComponent(ctx, comp, mode) {
  const { agentDir, pkgRoot, manifest, log, dryRun } = ctx;
  const prev = ctx.state.components[comp.id];
  const destAbs = destOf(agentDir, comp);
  const rels = Object.keys(comp.files);
  const base = { version: prev?.version ?? null, files: prev?.files ?? null, pendingVersion: null, modifiedFiles: [], missingRequires: [], error: null };
  const record = (patch) => (ctx.state.components[comp.id] = { ...base, ...patch, updatedAt: new Date().toISOString() });

  // 上一轮崩溃留下的临时文件
  if (!dryRun) for (const rel of rels) fs.rmSync(path.join(destAbs, ...rel.split('/')) + TMP_SUFFIX, { force: true });

  const destRel = comp.dest.split('/').filter(Boolean).join('/');
  const linked = (destRel && linkedWithin(agentDir, destRel)) || rels.some((r) => linkedWithin(agentDir, [destRel, r].filter(Boolean).join('/')));
  if (linked) {
    log(`${comp.id}：路径经 junction/symlink 指向别处（可能与其他宿主共享），不动它`);
    return record({ status: 'linked' });
  }

  const present = comp.kind === 'dir' ? fs.existsSync(destAbs) : rels.some((r) => fs.existsSync(path.join(destAbs, ...r.split('/'))));
  if (!present && mode === 'sync') {
    if (prev && ['installed', 'modified'].includes(prev.status)) log(`${comp.id}：已被删除，不再同步（要装回：qika five-layer add ${comp.id}）`);
    else if (!prev) log(`${comp.id}：上游新增的组件，未自动安装（需要时：qika five-layer add ${comp.id}）`);
    return record({ status: 'not-installed', files: null, version: null });
  }

  const baseline = present && mode !== 'force' ? (prev?.files ?? null) : null;
  const localHash = (rel) => (present ? hashFileOrNull(path.join(destAbs, ...rel.split('/')), rel) : null);

  // 判「改过」（只看上游现行文件；上游已移除的文件只决定删不删，见下方遗留清理）
  const modified = [];
  if (present && mode !== 'force') {
    for (const rel of rels) {
      const local = localHash(rel);
      if (baseline) {
        if (!(rel in baseline)) {
          // 上游新增的文件；同名文件已存在且内容不同 = 同事自己的文件，不覆盖
          if (local !== null && local !== comp.files[rel]) modified.push(rel);
        } else if (local === null) {
          modified.push(rel); // 我们写过、同事删了
        } else if (local !== baseline[rel] && local !== comp.files[rel]) {
          modified.push(rel);
        }
      } else if (local !== null) {
        // 接管：没有写入记录，拿历史版本集比对；缺的文件（旧版还没有它）直接补
        const known = new Set([...(comp.legacy?.[rel] ?? []), comp.files[rel]]);
        if (!known.has(local)) modified.push(rel);
      }
    }
  }

  const upstreamDir = path.join(agentDir, STATE_DIR, 'upstream', comp.id);
  if (modified.length > 0) {
    if (!dryRun && !(prev?.status === 'modified' && prev.pendingVersion === manifest.version && fs.existsSync(upstreamDir))) {
      fs.rmSync(upstreamDir, { recursive: true, force: true });
      for (const rel of rels) {
        const to = path.join(upstreamDir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(srcOf(pkgRoot, comp, rel), to);
      }
    }
    log(`${comp.id}：你改过 ${modified.join('、')}，保留不动；上游 v${manifest.version} 放在 ${upstreamDir}（对比：diff -ru "${destAbs}" "${upstreamDir}"）`);
    return record({ status: 'modified', pendingVersion: manifest.version, modifiedFiles: modified });
  }

  // 升级 / 安装
  const written = [];
  for (const rel of rels) {
    const abs = path.join(destAbs, ...rel.split('/'));
    const local = localHash(rel);
    if (local === comp.files[rel]) continue; // 已是新版（含只差启停行/换行符的情况——不写，启停状态天然保留）
    let data = fs.readFileSync(srcOf(pkgRoot, comp, rel));
    if (local !== null && path.posix.basename(rel) === 'SKILL.md') {
      // 同事的启停状态原样写回（有没有这一行、值是什么都保留；上游自带的启停行不覆盖同事的选择）
      data = Buffer.from(applyDisableLine(data.toString('utf8'), readDisableLine(fs.readFileSync(abs, 'utf8'))));
    }
    if (!dryRun) atomicWrite(abs, data);
    written.push(rel);
  }

  // 上游遗留文件：只删哈希等于「我们写过的 / 历史上游版本」的，同事改过的留着
  const removed = [];
  const oldPaths = baseline ? Object.keys(baseline) : Object.keys(comp.legacy ?? {});
  for (const rel of oldPaths) {
    if (rel in comp.files) continue;
    const local = localHash(rel);
    if (local === null) continue;
    const ours = baseline ? local === baseline[rel] : (comp.legacy[rel] ?? []).includes(local);
    if (!ours) continue;
    if (!dryRun) fs.rmSync(path.join(destAbs, ...rel.split('/')), { force: true });
    removed.push(rel);
  }

  if (!dryRun) fs.rmSync(upstreamDir, { recursive: true, force: true });
  const fresh = !present || mode === 'force';
  if (written.length || removed.length) {
    const what = [written.length ? `写入 ${written.length} 个文件` : '', removed.length ? `删除上游遗留 ${removed.join('、')}` : ''].filter(Boolean).join('，');
    log(`${comp.id}：${fresh ? '已安装' : `已升级到 v${manifest.version}`}（${what}）`);
  }
  return record({ status: 'installed', version: manifest.version, files: { ...comp.files } });
}

function checkRequires(ctx) {
  const on = (id) => ['installed', 'modified', 'linked'].includes(ctx.state.components[id]?.status);
  for (const comp of ctx.manifest.components) {
    const rec = ctx.state.components[comp.id];
    if (!rec || !on(comp.id)) continue;
    rec.missingRequires = (comp.requires ?? []).filter((r) => !on(r));
    if (rec.missingRequires.length) ctx.log(`${comp.id}：依赖 ${rec.missingRequires.join('、')} 未安装，部分功能不可用（qika five-layer add ${rec.missingRequires[0]}）`);
  }
}

function runComponents(ctx, mode, only) {
  for (const comp of ctx.manifest.components) {
    if (only && comp.id !== only) continue;
    try {
      processComponent(ctx, comp, mode);
    } catch (e) {
      // 已写的文件等于新版哈希、未写的等于基准，下次运行按哈希自愈；基准保持上次的
      const prev = ctx.state.components[comp.id];
      ctx.state.components[comp.id] = { ...(prev ?? { version: null, files: null }), status: 'failed', error: e.message, updatedAt: new Date().toISOString() };
      ctx.errors.push(`${comp.id}: ${e.message}`);
      ctx.log(`${comp.id}：同步失败（${e.message}），下次更新会重试`);
    }
  }
  checkRequires(ctx);
}

function makeCtx({ agentDir = defaultAgentDir(), pkgRoot = here, log = (m) => console.log(`[five-layer] ${m}`), dryRun = false } = {}) {
  return { agentDir, pkgRoot, log, dryRun, manifest: readManifest(pkgRoot), state: null, errors: [] };
}

const isMaintainer = (agentDir) => fs.existsSync(path.join(agentDir, STATE_DIR, MAINTAINER_MARK));

/** 读 state 供写入：损坏时备份并返回空 state（按接管逻辑重建，缺失组件照旧不装）——不能当作「未 opt-in」静默停更 */
function loadStateForWrite(ctx, existing) {
  if (existing && !existing.corrupt) return existing;
  if (existing?.corrupt) {
    const bak = path.join(ctx.agentDir, STATE_DIR, `state.corrupt-${stamp()}.json`);
    if (!ctx.dryRun) fs.renameSync(path.join(ctx.agentDir, STATE_DIR, STATE_FILE), bak);
    ctx.log(`state.json 损坏，已备份为 ${bak}，按已安装文件重建`);
  }
  return { components: {} };
}

function finishState(ctx, kind) {
  ctx.state.schema = 1;
  ctx.state.lastSync = { at: new Date().toISOString(), kind, packageVersion: ctx.manifest.version, ok: ctx.errors.length === 0, errors: ctx.errors };
  writeState(ctx);
}

// ---------- 对外入口 ----------

/** post-install 每次更新调用。未 opt-in 零动作（只打一行提示）；维护者机器跳过 */
export function sync(opts = {}) {
  const agentDir = opts.agentDir ?? defaultAgentDir();
  const log = opts.log ?? ((m) => console.log(`[five-layer] ${m}`));
  if (isMaintainer(agentDir)) return { ok: true, skipped: 'maintainer' };
  const existing = readState(agentDir);
  if (!existing) {
    log('五层体系 starter 未启用（可选）：qika five-layer init，说明见包内 five-layer/README.md');
    return { ok: true, skipped: 'not-opted-in' };
  }
  const ctx = makeCtx({ ...opts, agentDir, log });
  ctx.state = loadStateForWrite(ctx, existing);
  runComponents(ctx, 'sync');
  finishState(ctx, 'sync');
  const count = (st) => Object.values(ctx.state.components).filter((c) => c.status === st).length;
  log(`组件：最新/已升级 ${count('installed')}，你改过跳过 ${count('modified')}，未安装 ${count('not-installed')}${count('failed') ? `，失败 ${count('failed')}` : ''}（详情：qika doctor 第 12 节）`);
  return { ok: ctx.errors.length === 0, state: ctx.state };
}

/** 首次启用：装全部组件（已有副本走接管判定）+ 写种子（已存在不覆盖）+ 写 state */
export function init(opts = {}) {
  const agentDir = opts.agentDir ?? defaultAgentDir();
  const log = opts.log ?? ((m) => console.log(`[five-layer] ${m}`));
  if (isMaintainer(agentDir)) {
    log(`${agentDir} 由源码仓库的 install.sh 维护（有 ${STATE_DIR}/${MAINTAINER_MARK} 标记），拒绝 init：同一台机器不能有两个写入方`);
    return { ok: false, refused: 'maintainer' };
  }
  const ctx = makeCtx({ ...opts, agentDir, log });
  ctx.state = loadStateForWrite(ctx, readState(agentDir));
  ctx.state.initAt ??= new Date().toISOString();
  if (ctx.dryRun) log('（--dry-run：只打印，不写任何文件）');

  runComponents(ctx, 'init');

  // 种子：同事所有，目标已存在就不写；起步版放 .five-layer/seed/ 供对照
  for (const seed of ctx.manifest.seeds ?? []) {
    const to = path.join(agentDir, ...seed.dest.split('/'));
    const from = path.join(ctx.pkgRoot, 'five-layer', ...seed.src.split('/'));
    if (fs.existsSync(to)) {
      const ref = path.join(agentDir, STATE_DIR, 'seed', ...seed.dest.split('/'));
      if (!ctx.dryRun) {
        fs.mkdirSync(path.dirname(ref), { recursive: true });
        fs.copyFileSync(from, ref);
      }
      log(`${seed.dest} 已存在，保留你的；起步版放在 ${ref}，需要时手工合并`);
      continue;
    }
    if (!ctx.dryRun) atomicWrite(to, fs.readFileSync(from));
    log(`写入起步内容 ${seed.dest}`);
  }
  for (const opt of ctx.manifest.optional ?? []) {
    const to = path.join(agentDir, ...opt.dest.split('/'));
    if (!ctx.dryRun) atomicWrite(to, fs.readFileSync(path.join(ctx.pkgRoot, 'five-layer', ...opt.src.split('/'))));
  }

  // 同名技能也在 ~/.agents/skills：pi 两处都加载
  const shared = path.join(os.homedir(), '.agents', 'skills');
  for (const comp of ctx.manifest.components) {
    if (comp.dest.startsWith('skills/') && fs.existsSync(path.join(shared, comp.dest.slice('skills/'.length)))) {
      log(`注意：~/.agents/skills 下也有同名技能 ${comp.id}，pi 两处都会加载，保留一份即可`);
    }
  }

  finishState(ctx, 'init');
  log('完成。重启 Qika 后新会话生效（命令行 pi 同样加载这些扩展与技能）；每次 qika-update 会自动升级你没改过的组件。');
  log(`怎么迭代、怎么关某道门禁、怎么合并上游新版：${path.join(ctx.pkgRoot, 'five-layer', 'README.md')}`);
  if (ctx.manifest.optional?.length) log(`可选规则放在 ${path.join(agentDir, STATE_DIR, 'optional')}，想用就粘进 AGENTS.md`);
  if (!fs.existsSync(path.join(agentDir, '.git'))) {
    log(`建议把 agent 目录纳入 git（五层的「退休即删」靠 git 保留历史）：cd "${agentDir}" && git init && git add AGENTS.md FIVE-LAYER.md experience knowledge extensions skills .gitignore && git commit -m "五层起步"`);
  }
  return { ok: ctx.errors.length === 0, state: ctx.state };
}

/** 装单个组件；--force：先把现有副本备份到 .five-layer/backup/ 再按全新装（放弃本地改动时用） */
export function add(id, opts = {}) {
  if (typeof id !== 'string' || !id) throw new TypeError('add(id, opts)：id 必须是组件名字符串');
  const agentDir = opts.agentDir ?? defaultAgentDir();
  const log = opts.log ?? ((m) => console.log(`[five-layer] ${m}`));
  if (isMaintainer(agentDir)) {
    log(`${agentDir} 由源码仓库的 install.sh 维护，拒绝 add`);
    return { ok: false, refused: 'maintainer' };
  }
  const ctx = makeCtx({ ...opts, agentDir, log });
  const comp = ctx.manifest.components.find((c) => c.id === id);
  if (!comp) {
    log(`没有组件 ${id}；可选：${ctx.manifest.components.map((c) => c.id).join('、')}`);
    return { ok: false };
  }
  const existing = readState(agentDir);
  ctx.state = loadStateForWrite(ctx, existing);
  if (opts.force) {
    const destAbs = destOf(agentDir, comp);
    const bak = path.join(agentDir, STATE_DIR, 'backup', `${id}-${stamp()}`);
    const items = comp.kind === 'dir' ? (fs.existsSync(destAbs) ? [''] : []) : Object.keys(comp.files).filter((r) => fs.existsSync(path.join(destAbs, ...r.split('/'))));
    if (!ctx.dryRun) for (const rel of items) fs.cpSync(path.join(destAbs, ...rel.split('/')), path.join(bak, ...rel.split('/')), { recursive: true });
    if (items.length) log(`原副本已备份到 ${bak}`);
  }
  runComponents(ctx, opts.force ? 'force' : 'add', id);
  finishState(ctx, `add ${id}`);
  return { ok: ctx.errors.length === 0, state: ctx.state };
}

const USAGE = `用法: qika five-layer <命令>
  init [--dry-run]     启用五层体系 starter：安装机制组件 + 写入起步内容（已存在的不覆盖）
  add <组件> [--force]  安装单个组件；--force 先备份现有副本再按上游版本重装（放弃本地改动）
  sync                 按 qika-update 的规则同步一次（通常不用手动跑）
状态与待合并的上游新版：qika doctor 第 12 节。说明：包内 five-layer/README.md`;

export async function runCli(argv) {
  const [cmd, ...rest] = argv;
  const dryRun = rest.includes('--dry-run');
  if (cmd === 'init') return init({ dryRun }).ok ? 0 : 1;
  if (cmd === 'sync') return sync({ dryRun }).ok ? 0 : 1;
  if (cmd === 'add') {
    const id = rest.find((a) => !a.startsWith('--'));
    if (!id) {
      console.log(USAGE);
      return 2;
    }
    return add(id, { force: rest.includes('--force'), dryRun }).ok ? 0 : 1;
  }
  console.log(USAGE);
  return cmd && cmd !== '--help' && cmd !== '-h' ? 2 : 0;
}

// 直接执行（node five-layer.mjs …）时跑；被 post-install / bin / doctor / 测试 import 时不跑
if (/[\\/]five-layer\.mjs$/.test(process.argv[1] ?? '')) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
