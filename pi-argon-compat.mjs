#!/usr/bin/env node
// TEMPORARY: earendil-works/pi#10890. Remove this file + launcher call once
// BOTH resolved pi-ai copies pass --check as upstream-supported and the SDK smoke
// passes without this patch. Never infer upstream support from a missing anchor.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MARKER = '/* qika-temp-argon: upstream pi#10890 */';
const BACKUP_SUFFIX = '.qika-argon.bak';
const LEGACY = `export function usesGoogleThinkingLevel(model) {
    const id = model.id.toLowerCase();
    return (
    // Match Gemini 3 Pro/Flash IDs with or without a minor version, such as
    // gemini-3-flash-preview, gemini-3.1-pro-preview, and gemini-3.8-flash.
    /gemini-3(?:\\.\\d+)?-(?:pro|flash)/.test(id) ||
        id === "gemini-flash-latest" ||
        id === "gemini-flash-lite-latest" ||
        // Match both hosted Gemma 4 naming forms: gemma-4-* and gemma4-*.
        /gemma-?4/.test(id));
}`;
const PATCHED = LEGACY.replace('id === "gemini-flash-latest" ||', `${MARKER}\n        id === "gemini-4-argon" ||\n        id === "gemini-flash-latest" ||`);
// Some relays report finishReason "TOOL_USE" for function calls; neither pi-ai nor @google/genai
// knows it and mapStopReason throws. Treat it as STOP: the adapter already upgrades STOP+toolCall to toolUse.
const STOP_MARKER = '// qika-temp-argon: relay finishReason TOOL_USE';
const STOP_LEGACY = `        case FinishReason.STOP:
            return "stop";`;
const STOP_PATCHED = `        case FinishReason.STOP:
        ${STOP_MARKER}
        case "TOOL_USE":
            return "stop";`;
// Independent parts: upstream may fix one defect and not the other, so each retires on its own.
const PARTS = {
  thinking: { marker: MARKER, legacy: LEGACY, patched: PATCHED },
  stop: { marker: STOP_MARKER, legacy: STOP_LEGACY, patched: STOP_PATCHED },
};
const ALL_PARTS = { thinking: true, stop: true };
const UNRECOGNIZED = 'Unrecognized pi-ai thinking/stop-reason source; refusing to patch. Recheck upstream support and update/remove this temporary shim.';

// A narrow source transform, shared by file patching and isolated SDK regression tests.
export function patchArgonSource(source, parts = ALL_PARTS) {
  return Object.entries(PARTS).reduce((text, [name, part]) => {
    if (!parts[name]) return text;
    if (text.includes(part.marker)) throw new Error(UNRECOGNIZED);
    for (const newline of ['\n', '\r\n']) {
      const swap = value => value.replace(/\n/g, newline);
      if (text.split(swap(part.legacy)).length === 2) return text.replace(swap(part.legacy), () => swap(part.patched));
    }
    throw new Error(UNRECOGNIZED);
  }, source);
}
const appliedParts = source => ({ thinking: source.includes(MARKER), stop: source.includes(STOP_MARKER) });

function resolvePackage(from, name) {
  const req = createRequire(path.join(from, 'package.json'));
  for (const modulesDir of req.resolve.paths(name) ?? []) {
    const candidate = path.join(modulesDir, name);
    const pkgFile = path.join(candidate, 'package.json');
    if (fs.existsSync(pkgFile) && JSON.parse(fs.readFileSync(pkgFile, 'utf8')).name === name) {
      return fs.realpathSync(candidate);
    }
  }
  throw new Error(`Cannot resolve ${name} from ${from}`);
}

export function findArgonTargets(pkgRoot) {
  const codingAgent = resolvePackage(pkgRoot, '@earendil-works/pi-coding-agent');
  const roots = new Set([
    resolvePackage(pkgRoot, '@earendil-works/pi-ai'),
    resolvePackage(codingAgent, '@earendil-works/pi-ai'),
  ]);
  return [...roots].map(root => {
    const file = path.join(root, 'dist', 'api', 'google-shared.js');
    if (!fs.existsSync(file)) throw new Error(`pi-ai layout changed: missing ${file}; cannot establish upstream support`);
    return { root, file, version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version };
  });
}

function probeUpstream(file) {
  // Separate process: importing here would cache the old module before server import.
  const env = { ...process.env, PI_OFFLINE: '1' };
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_|AWS_|AZURE_|OPENROUTER_)/.test(key)) delete env[key];
  }
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    globalThis.fetch = async () => { throw Error('Network forbidden during compatibility probe'); };
    const mod = await import(process.argv[1]);
    if (typeof mod.usesGoogleThinkingLevel !== 'function') throw Error('Missing thinking predicate');
    const thinking = mod.usesGoogleThinkingLevel({id:'gemini-4-argon'});
    if (typeof thinking !== 'boolean') throw Error('Unexpected thinking predicate result');
    let stop = false;
    if (typeof mod.mapStopReason === 'function') {
      try { stop = mod.mapStopReason('TOOL_USE') === 'stop'; }
      catch (error) { if (!/Unhandled stop reason/.test(String(error?.message))) throw error; }
    }
    console.log('QIKA_ARGON_PROBE=' + JSON.stringify({thinking, stop}));
  `, pathToFileURL(file).href], { env, encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 256000 });
  if (r.error || r.status !== 0) throw new Error(`Cannot probe ${file}: ${r.error?.message ?? r.stderr?.trim() ?? r.status}`);
  try {
    const line = r.stdout.split(/\r?\n/).findLast(value => value.startsWith('QIKA_ARGON_PROBE='));
    const probe = JSON.parse(line.slice('QIKA_ARGON_PROBE='.length));
    if (typeof probe.thinking !== 'boolean' || typeof probe.stop !== 'boolean') throw Error('bad shape');
    return probe;
  }
  catch { throw new Error(`Unexpected probe output for ${file}; refusing to guess upstream support`); }
}

function atomicWrite(file, content, { createOnly = false, mode = 0o600 } = {}) {
  const temporary = `${file}.qika-argon-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: fs.existsSync(file) ? fs.statSync(file).mode : mode, flush: true });
    if (createOnly) {
      // Atomic, no-clobber backup creation; a concurrent identical backup is safe.
      try { fs.linkSync(temporary, file); }
      catch (error) {
        if (error.code !== 'EEXIST' || fs.readFileSync(file, 'utf8') !== content) throw error;
      }
    } else fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function ensureArgonCompat(pkgRoot, { mode = 'apply', log = console.log } = {}) {
  if (!['apply', 'check', 'revert'].includes(mode)) throw new Error(`Unknown compatibility mode: ${mode}`);
  // Preflight every actual resolution target before changing any file.
  const plans = findArgonTargets(pkgRoot).map(target => {
    const source = fs.readFileSync(target.file, 'utf8');
    const backup = target.file + BACKUP_SUFFIX;
    const applied = appliedParts(source);
    const marked = applied.thinking || applied.stop;
    let original;
    if (marked) {
      if (!fs.existsSync(backup)) throw new Error(`Temporary Argon patch has no backup: ${target.file}`);
      original = fs.readFileSync(backup, 'utf8');
      if (patchArgonSource(original, applied) !== source) throw new Error(`Patched file changed; refusing to overwrite or revert ${target.file}`);
      if (mode === 'revert') return { ...target, source, backup, base: original, status: 'reverted', next: original };
    }
    const base = marked ? original : source;
    // Fully patched files need no probe, so steady-state startup stays cheap.
    const probe = applied.thinking && applied.stop ? { thinking: true, stop: true } : probeUpstream(target.file);
    if (fs.readFileSync(target.file, 'utf8') !== source) throw new Error(`Concurrent change while probing ${target.file}; retry --check after the other startup finishes`);
    const want = { thinking: applied.thinking || !probe.thinking, stop: applied.stop || !probe.stop };
    if (!want.thinking && !want.stop) return { ...target, source, backup, base, status: 'upstream-supported' };
    if (mode === 'revert') return { ...target, source, backup, base, status: 'unpatched' };
    const next = patchArgonSource(base, want); // Unknown old layout is an error, even for --check.
    if (!marked && fs.existsSync(backup) && fs.readFileSync(backup, 'utf8') !== source) {
      throw new Error(`Backup belongs to a different pi-ai revision: ${backup}; review before applying`);
    }
    if (next === source) return { ...target, source, backup, base, status: 'temporary-active' };
    return { ...target, source, backup, base, next: mode === 'apply' ? next : undefined, status: mode === 'apply' ? 'patched' : 'needs-patch' };
  });
  const changed = [];
  try {
    for (const plan of plans) {
      if (plan.next === undefined) continue;
      const current = fs.readFileSync(plan.file, 'utf8');
      if (current === plan.next && mode === 'apply') {
        if (!fs.existsSync(plan.backup) || fs.readFileSync(plan.backup, 'utf8') !== plan.base) throw new Error(`Concurrent patch has no valid backup: ${plan.file}`);
        plan.status = 'temporary-active';
        continue;
      }
      if (current !== plan.source) throw new Error(`Concurrent change: ${plan.file}`);
      if (mode === 'apply') atomicWrite(plan.backup, plan.base, { createOnly: true });
      atomicWrite(plan.file, plan.next);
      changed.push(plan);
    }
  } catch (error) {
    for (const plan of changed.reverse()) {
      if (fs.readFileSync(plan.file, 'utf8') === plan.next) atomicWrite(plan.file, plan.source);
    }
    throw error;
  }
  const results = plans.map(({ file, version, status }) => ({ file, version, status }));
  for (const result of results) {
    if (mode !== 'apply' || result.status !== 'temporary-active') {
      log(`[argon-compat] ${result.status}: pi-ai ${result.version} (${result.file})`);
    }
  }
  if (results.every(r => r.status === 'upstream-supported')) {
    log('[argon-compat] RETIRE: upstream supports Argon thinking levels and relay finishReason TOOL_USE in all resolved copies; no patch applied. Remove the temporary shim after unpatched SDK regression passes.');
  }
  return results;
}

// This compatibility repair must never prevent unrelated models from starting.
// The CLI keeps a nonzero failure code; the host logs a visible diagnostic instead.
export function prepareArgonCompat(pkgRoot, { log = console.log, warn = console.warn } = {}) {
  try { return ensureArgonCompat(pkgRoot, { log }); }
  catch (error) {
    warn(`[argon-compat] Temporary Argon compatibility could not be applied: ${error.message}. QiKa will start; Argon effort controls are not verified. Run pi-argon-compat.mjs --check to diagnose.`);
    return undefined;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const mode = args.includes('--revert') ? 'revert' : args.includes('--check') ? 'check' : 'apply';
  const root = args.find(a => !a.startsWith('--')) ?? path.dirname(fileURLToPath(import.meta.url));
  try {
    const results = ensureArgonCompat(root, { mode });
    if (mode === 'check' && results.some(r => r.status === 'needs-patch')) process.exitCode = 2;
  } catch (error) {
    console.error(`[argon-compat] ${error.message}`);
    process.exitCode = 1;
  }
}
