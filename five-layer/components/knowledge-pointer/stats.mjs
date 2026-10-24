#!/usr/bin/env node
// knowledge 层健康度统计:指针→阅读转化率 + 召回缺口 + 噪声候选 + 索引可解析性。
// 用法:
//   node stats.mjs                        # 默认按自身位置找库:pi 侧 ~/.pi/agent/extensions/knowledge-pointer/ → ../../knowledge/hits.log,
//                                         # Claude 侧副本 ~/.claude/hooks/knowledge-stats.mjs → ../knowledge/hits.log(不依赖 pi 安装)
//   node stats.mjs <hits.log 路径>        # 显式传参,两侧同格式可直接用:
//   node stats.mjs ~/.claude/knowledge/hits.log
// 日志行格式(两侧一致): ts \t KIND \t entry \t extra \t sid=<session>
// 配对口径:同 sid 内 POINTER→READ 才算转化;无 sid 行(--no-session 批跑 / sid 埋点上线前的旧行)
// 只计数、不参与配对与转化分母。
// 索引可解析性(2026-09-23 起):项目库根从 hits.log 里的绝对路径 + 会话记录的 cwd 收集,逐库按该侧
// 指针扩展的解析规则数「可推送行」。0 行 = 整库零推送,补触发词无用、先改表格——此前只能从召回缺口
// 人工倒推(实证:两个项目库用 6 列表格,8 次主动 READ、0 次推送,无任何信号)。
// 2026-09-28 五层审计 M1/M3:
// - 召回缺口排除「被入口文件字面点名的页」(pi:全局 AGENTS.md + 全局 skills/*/SKILL.md + 该会话项目/该库项目的
//   AGENTS.md 与 .pi/skills/*/SKILL.md;claude 侧对应 CLAUDE.md 与 .claude/skills),单列「经 AGENTS/skill 引用召回」
//   ——那是设计好的召回路径,不该补触发词(实证:两个部署页被项目 AGENTS 点名,governance-decisions
//   被 five-layer-governance 点名,三处「缺口」全是假阳性)。
// - 库枚举加 Qika 项目列表(~/.pi-web/app-data.json 的 projects[].path,只取路径):零会话的库此前不在视野里。
// - 可推送状态按整词 verified/active(inactive 不算),与扩展同口径;主动 READ 按 extra 的 lib= 归库(库外登记页也算)。
// 本文件无仓库源(knowledge-pointer 扩展不在 pi-web 仓库),两处部署位互为备份,改动请两处同步。
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaults = [resolve(here, "..", "..", "knowledge", "hits.log"), resolve(here, "..", "knowledge", "hits.log")];
const logPath = process.argv[2]
	? resolve(process.argv[2])
	: (defaults.find((p) => existsSync(p)) ?? defaults[0]);

let raw;
try {
	raw = readFileSync(logPath, "utf8");
} catch {
	console.log(`no hits.log at ${logPath} — 尚无数据`);
	process.exit(0);
}

const norm = (s) => s.replace(/\\\\/g, "/").replace(/\\/g, "/");

/** entry 字段(全路径 / JSON 片段)统一归一为 md 文件名 */
function pageKey(entry) {
	const m = /([^/\\"]+\.md)/.exec(norm(entry));
	return m ? m[1] : entry.slice(0, 60);
}

const rows = [];
for (const line of raw.split("\n")) {
	if (!line.trim()) continue;
	const cells = line.split("\t");
	if (cells.length < 3) continue;
	const sidCell = cells.find((c) => c.startsWith("sid="));
	rows.push({
		ts: cells[0],
		kind: cells[1],
		entry: norm(cells[2]),
		page: pageKey(cells[2]),
		extra: cells[3] ?? "",
		sid: sidCell ? sidCell.slice(4) : "",
	});
}
if (rows.length === 0) {
	console.log("hits.log 为空 — 尚无数据");
	process.exit(0);
}

// 页面 × 会话聚合(无 sid 的 POINTER 单独计数,不进转化分母)
const pages = new Map();
const ensure = (p) => {
	if (!pages.has(p)) pages.set(p, { pointers: 0, noSidPointers: 0, reads: 0, ptrSids: new Set(), readSids: new Set() });
	return pages.get(p);
};
for (const r of rows) {
	const s = ensure(r.page);
	if (r.kind === "POINTER") {
		if (r.sid) {
			s.pointers++;
			s.ptrSids.add(r.sid);
		} else s.noSidPointers++;
	} else if (r.kind === "READ") {
		s.reads++;
		if (r.sid) s.readSids.add(r.sid);
	}
}

const fmtPct = (n, d) => (d === 0 ? "  n/a" : `${String(Math.round((n / d) * 100)).padStart(4)}%`);

console.log(`# knowledge 健康度 — ${logPath}`);
console.log(`行数 ${rows.length},页面 ${pages.size},时间跨度 ${rows[0].ts} ~ ${rows[rows.length - 1].ts}\n`);

// 1) 指针→阅读转化率(按会话配对:POINTER 会话中出现 READ 的比例)
console.log("## 指针→阅读转化率(同会话配对)");
console.log("页面 | POINTER | 其中被READ的会话 | 转化率");
const sorted = [...pages.entries()].sort((a, b) => b[1].pointers - a[1].pointers);
for (const [page, s] of sorted) {
	if (s.pointers === 0 && s.noSidPointers === 0) continue;
	const converted = [...s.ptrSids].filter((sid) => s.readSids.has(sid)).length;
	const ptr = `${s.pointers}${s.noSidPointers ? ` (+${s.noSidPointers} 无sid)` : ""}`;
	console.log(`${page} | ${ptr} | ${converted}/${s.ptrSids.size} | ${fmtPct(converted, s.ptrSids.size)}`);
}

// 侧别与路径口径(召回缺口的引用排除、可解析性都要用)
const side = norm(logPath).includes("/.claude/") ? "claude" : "pi";
const mainDir = dirname(logPath);
const projSub = side === "claude" ? ".claude/knowledge" : ".pi/knowledge";
const sessionsDir = side === "claude" ? resolve(mainDir, "..", "projects") : resolve(mainDir, "..", "sessions");
const agentHome = dirname(mainDir); // ~/.pi/agent 或 ~/.claude
const userHome = side === "claude" ? dirname(agentHome) : resolve(agentHome, "..", ".."); // 由库位置反推,不依赖 HOME(幽灵路径)
const ctxFile = side === "claude" ? "CLAUDE.md" : "AGENTS.md";
const projSkillsSub = side === "claude" ? ".claude/skills" : ".pi/skills";
const projRe = new RegExp(`([A-Za-z]:/[^"\\t]*?|/[^"\\t]*?)/${projSub.replace(".", "\\.")}/`);

function readText(file) {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/** 入口文件(AGENTS/CLAUDE.md + skills/*\/SKILL.md)里字面出现的 .md 文件名 → 来源标签 */
function refsOf(ctxPath, skillsDir, label) {
	const out = new Map();
	const add = (text, src) => {
		for (const m of text.matchAll(/([^\s/\\`'"()[\]|<>:*?]+\.md)\b/g)) if (!out.has(m[1])) out.set(m[1], src);
	};
	add(readText(ctxPath), `${label}${ctxFile}`);
	let subs = [];
	try {
		subs = readdirSync(skillsDir, { withFileTypes: true });
	} catch {
		// 无 skills 目录
	}
	for (const d of subs) {
		if (d.isDirectory() || d.isSymbolicLink()) add(readText(join(skillsDir, d.name, "SKILL.md")), `skill:${d.name}`);
	}
	return out;
}
const globalRefs = refsOf(join(agentHome, ctxFile), join(agentHome, "skills"), "全局 ");
const projRefsCache = new Map();
const projRefs = (root) => {
	const k = root.toLowerCase();
	if (!projRefsCache.has(k)) projRefsCache.set(k, refsOf(join(root, ctxFile), join(root, projSkillsSub), `${basename(root)}/`));
	return projRefsCache.get(k);
};

function readHead(file, bytes) {
	try {
		const fd = openSync(file, "r");
		const buf = Buffer.alloc(bytes);
		const n = readSync(fd, buf, 0, bytes, 0);
		closeSync(fd);
		return buf.subarray(0, n).toString("utf8");
	} catch {
		return "";
	}
}

/** 每个会话目录取一个会话文件从开头找 cwd(pi 首行 session 头;claude 前几行即有);同目录会话同 cwd → sid→cwd */
function sessionCwds(dir) {
	const cwds = [];
	const bySid = new Map();
	let subs;
	try {
		subs = readdirSync(dir, { withFileTypes: true });
	} catch {
		return { cwds, bySid };
	}
	for (const d of subs) {
		if (!d.isDirectory()) continue;
		let files;
		try {
			files = readdirSync(join(dir, d.name)).filter((x) => x.endsWith(".jsonl")).sort();
		} catch {
			continue;
		}
		const f = files.at(-1);
		if (!f) continue;
		const m = /"cwd":"((?:\\.|[^"\\])*)"/.exec(readHead(join(dir, d.name, f), 65536));
		if (!m) continue;
		let cwd;
		try {
			cwd = norm(JSON.parse(`"${m[1]}"`));
		} catch {
			continue; // 残缺 cwd 跳过
		}
		cwds.push(cwd);
		for (const x of files) bySid.set(x.replace(/\.jsonl$/, ""), cwd);
	}
	return { cwds, bySid };
}
const sessions = sessionCwds(sessionsDir);

/** READ 行所属项目根:路径里的 <root>/.pi/knowledge/,或 extra 的 lib=<root>/.pi/knowledge */
function rowProjectRoot(r) {
	const m = projRe.exec(r.entry);
	if (m) return m[1];
	const lib = /\blib=(\S+)/.exec(r.extra)?.[1];
	if (lib && lib.toLowerCase().endsWith(`/${projSub}`)) return lib.slice(0, -projSub.length - 1);
	return "";
}

const mainNorm = norm(mainDir).toLowerCase();
const relProjRe = new RegExp(`"path":"(?:\\./)?${projSub.replace(".", "\\.")}/`);
/** READ 行所属库根(原样大小写):项目根 / "(main)" / "?";相对路径按该会话 cwd 归库 */
function rowLibRoot(r) {
	const root = rowProjectRoot(r);
	if (root) return root;
	if (r.entry.toLowerCase().includes(`${mainNorm}/`) || /\blib=(\S+)/.exec(r.extra)?.[1] === mainNorm) return "(main)";
	return (relProjRe.test(r.entry) && sessions.bySid.get(r.sid)) || "?";
}
const rowLibKey = (r) => rowLibRoot(r).toLowerCase();
/** 同会话 index.md 读取:sid → [{ lib, ts }] */
const indexReads = new Map();
for (const r of rows) {
	if (r.kind !== "READ" || !r.sid || r.page !== "index.md") continue;
	if (!indexReads.has(r.sid)) indexReads.set(r.sid, []);
	indexReads.get(r.sid).push({ lib: rowLibKey(r), ts: r.ts });
}

/**
 * 该 READ 是否走的是设计好的入口:①被入口文件字面点名(全局入口 + 该会话 cwd 的项目入口 + 该库所在项目的入口);
 * ②同会话先读了同库 index.md(FIVE-LAYER §2「先查索引再按需读取」,项目 AGENTS 多为路由到 index 而非点名页面)。
 */
function referencedVia(r) {
	const hit = globalRefs.get(r.page);
	if (hit) return hit;
	for (const root of [sessions.bySid.get(r.sid), rowProjectRoot(r)]) {
		if (!root) continue;
		const src = projRefs(root).get(r.page);
		if (src) return src;
	}
	const lib = rowLibKey(r);
	if (lib !== "?" && (indexReads.get(r.sid) ?? []).some((x) => x.lib === lib && x.ts <= r.ts)) return "同会话先读 index.md";
	return "";
}
const libLabel = (r) => {
	const root = rowLibRoot(r);
	return root === "(main)" ? "主库" : root === "?" ? "?" : basename(root);
};

// 2) 召回缺口:READ 发生的会话里该页面没被 POINTER 过(模型自己找到的 → 触发词漏了)。
// index.md 是路由入口(AGENTS 要求先读索引),读它≠某页漏推,不计缺口;被入口文件点名的页单列(设计好的召回)
const gapMap = new Map(); // page -> { sids:Set, libs:Set }
const refMap = new Map(); // page -> { sids:Set, via:Set }
for (const r of rows) {
	if (r.kind !== "READ" || !r.sid || r.page === "index.md") continue;
	if (pages.get(r.page)?.ptrSids.has(r.sid)) continue;
	const via = referencedVia(r);
	const bucket = via ? refMap : gapMap;
	if (!bucket.has(r.page)) bucket.set(r.page, { sids: new Set(), libs: new Set(), via: new Set() });
	const b = bucket.get(r.page);
	b.sids.add(r.sid);
	b.libs.add(libLabel(r));
	if (via) b.via.add(via);
}
const bySessions = (m) => [...m.entries()].sort((a, b) => b[1].sids.size - a[1].sids.size);
console.log("\n## 召回缺口(READ-without-POINTER 且入口文件未点名:真实需求但指针没推,该补触发词)");
for (const [page, b] of bySessions(gapMap)) {
	const sids = [...b.sids];
	console.log(`${page}(${[...b.libs].join("/")}):${sids.length} 个会话主动读了但未被推送(sid: ${sids.slice(0, 3).join(", ")}${sids.length > 3 ? "…" : ""})`);
}
if (gapMap.size === 0) console.log("(无)");
const idx = pages.get("index.md");
if (idx?.reads) console.log(`(index.md 被主动读 ${idx.reads} 次/${idx.readSids.size} 个会话:路由入口,不计缺口)`);

console.log(`\n## 经入口召回(READ-without-POINTER 但走了设计好的入口:${ctxFile}/skill 字面点名,或同会话先读了同库 index.md;不补触发词)`);
for (const [page, b] of bySessions(refMap)) {
	console.log(`${page}(${[...b.libs].join("/")}):${b.sids.size} 个会话,经 ${[...b.via].join("、")}`);
}
if (refMap.size === 0) console.log("(无)");

// 3) 噪声候选:推了从没被读过
console.log("\n## 噪声候选(POINTER≥3 且同会话零 READ,考虑收紧触发词或下架)");
let noise = 0;
for (const [page, s] of sorted) {
	const converted = [...s.ptrSids].filter((sid) => s.readSids.has(sid)).length;
	if (s.pointers >= 3 && converted === 0) {
		noise++;
		console.log(`${page}:推了 ${s.pointers} 次,零转化`);
	}
}
if (noise === 0) console.log("(无)");

// 4) 索引可解析性:两侧指针扩展只解析特定表格形态,其余行永不推送

/** 与该侧指针扩展同口径:pi = knowledge-pointer/index.ts parseKnowledgeIndex;claude = knowledge-pointer.py parse_index */
function auditIndex(text) {
	const out = { rows: 0, pushable: 0, narrow: 0, badStatus: 0, noKw: 0, listItems: 0 };
	for (const line of text.split("\n")) {
		const s = line.trim();
		if (/^[-*]\s+\S*?[^\s`]*\.md\b/.test(s)) out.listItems++; // 列表式登记(`- \`x.md\``):扩展不解析
		if (!s.startsWith("|")) continue;
		const cells = (side === "claude" ? s.replace(/^\|+|\|+$/g, "") : s.split("|").slice(1, -1).join("|"))
			.split("|")
			.map((c) => c.trim());
		if (!/\.md\b/.test(cells[0] ?? "")) continue; // 表头/分隔行/非页面行
		out.rows++;
		if (side === "claude") {
			if (cells.length < 6 || !cells[0].endsWith(".md")) out.narrow++;
			else if (!cells.at(-1).split(",").some((k) => k.trim())) out.noKw++;
			else out.pushable++;
		} else if (cells.length < 7) out.narrow++;
		else if (!/\b(?:verified|active)\b/.test(cells[4])) out.badStatus++; // 整词:inactive 不算(与扩展 PUSHABLE_STATUS 同口径)
		else if (!cells[6].split(/[、,，]/).some((k) => k.trim())) out.noKw++;
		else out.pushable++;
	}
	return out;
}

/** Qika 项目列表(只取路径):零会话的项目库也进视野。PI_WEB_DATA_DIR 覆盖默认 ~/.pi-web */
function qikaProjectRoots() {
	const dataDir = process.env.PI_WEB_DATA_DIR ? resolve(process.env.PI_WEB_DATA_DIR) : join(userHome, ".pi-web");
	try {
		const projects = JSON.parse(readFileSync(join(dataDir, "app-data.json"), "utf8")).projects;
		const list = Array.isArray(projects) ? projects : Object.values(projects ?? {});
		return list.map((p) => (typeof p?.path === "string" ? norm(p.path) : "")).filter(Boolean);
	} catch {
		return [];
	}
}

const roots = new Map(); // lower -> 展示路径(lib= 归库得到的是小写路径,遇到原样大小写的来源时替换展示)
const addRoot = (p) => {
	const k = p.replace(/\/+$/, "");
	if (!k) return;
	const prev = roots.get(k.toLowerCase());
	if (!prev || (prev === prev.toLowerCase() && k !== k.toLowerCase())) roots.set(k.toLowerCase(), k);
};
for (const r of rows) {
	const root = rowProjectRoot(r);
	if (root) addRoot(root);
}
for (const c of sessions.cwds) addRoot(c);
for (const p of qikaProjectRoots()) addRoot(p);
// 项目父目录(已知 ≥2 个项目根的目录)下的兄弟项目:既无会话、也不在 Qika 列表的库也要进视野。
// 临时目录根不扫(隔离实例/测试 fixture 的会话 cwd 都是 TEMP 的直接子目录,扫出来全是测试残留)
const isTempPath = (p) => /\/appdata\/local\/temp$|^\/tmp$/i.test(p);
const parentCount = new Map();
for (const root of roots.values()) {
	const parent = norm(dirname(root));
	if (isTempPath(parent)) continue;
	parentCount.set(parent, (parentCount.get(parent) ?? 0) + 1);
}
for (const [parent, n] of parentCount) {
	if (n < 2) continue;
	let subs = [];
	try {
		subs = readdirSync(parent, { withFileTypes: true });
	} catch {
		continue;
	}
	for (const d of subs) if (d.isDirectory() && existsSync(join(parent, d.name, projSub, "index.md"))) addRoot(`${parent}/${d.name}`);
}

const libs = [{ label: "(主库)", dir: mainDir }];
for (const root of roots.values()) libs.push({ label: root, dir: resolve(root, projSub) });

console.log(`\n## 索引可解析性(${side} 侧口径;项目库来自 hits.log 路径 + 会话 cwd + Qika 项目列表;可推送 = 指针扩展能解析出触发词的行)`);
console.log("库 | 登记页 | 可推送 | 主动 READ(非索引) | 说明");
let zeroLibs = 0;
for (const lib of libs) {
	const indexFile = join(lib.dir, "index.md");
	if (!existsSync(indexFile)) continue;
	let a;
	try {
		a = auditIndex(readFileSync(indexFile, "utf8"));
	} catch {
		continue;
	}
	const libNorm = norm(lib.dir).toLowerCase() + "/";
	const libTag = `lib=${libNorm.slice(0, -1)}`;
	const reads = rows.filter(
		(r) =>
			r.kind === "READ" &&
			r.page !== "index.md" &&
			(r.entry.toLowerCase().includes(libNorm) || r.extra.toLowerCase().split(/\s+/).includes(libTag)),
	).length;
	const notes = [];
	if (a.narrow) {
		notes.push(
			side === "claude"
				? `${a.narrow} 行不合解析形态(需 ≥6 列、首列为裸文件名 x.md、末列 keywords)`
				: `${a.narrow} 行不足 7 列(缺末列触发词)`,
		);
	}
	if (a.badStatus) notes.push(`${a.badStatus} 行状态非 verified/active(按设计不推)`);
	if (a.noKw) notes.push(`${a.noKw} 行触发词为空`);
	if (a.listItems && a.rows === 0) notes.push(`列表式索引 ${a.listItems} 条(扩展只解析表格)`);
	const listed = a.rows || a.listItems;
	if (listed > 0 && a.pushable === 0) {
		zeroLibs++;
		notes.unshift("⚠ 整库零推送——先改表格,补词无用");
	}
	console.log(`${lib.label} | ${listed} | ${a.pushable} | ${reads} | ${notes.join(";") || "-"}`);
}
if (zeroLibs === 0) console.log("(无零推送库)");

const noSid = rows.filter((r) => !r.sid).length;
if (noSid > 0) {
	console.log(
		`\n注:${noSid} 行无 sid(--no-session / 评测批跑,或 sid 埋点上线前的旧行),未参与会话配对与转化分母;` +
			"评测批跑(FIVE_LAYER_EVAL=1)自 2026-09-23 起不再落盘。",
	);
}
