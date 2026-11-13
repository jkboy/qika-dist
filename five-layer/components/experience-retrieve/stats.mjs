#!/usr/bin/env node
// EXPERIENCE 命中埋点统计：解析 hits.log（+ 同目录 verdicts.log），按条目聚合 INJECT/BLOCK/RECUR/PASS
// 与离线裁决 JUDGE/SKIP，输出治理信号（升层评估/关键词收紧/疑似误伤/无关率/冗余率/结论过时）。
// five-layer-governance（pi）与 compass（Claude Code）审计流程的数据入口。
//
// 用法（本文件随扩展安装在 ~/.pi/agent/extensions/experience-retrieve/；Claude 侧副本 ~/.claude/hooks/experience-stats.mjs）：
//   node ~/.pi/agent/extensions/experience-retrieve/stats.mjs   # pi 主库（2026-08-12 起两库隔离，不再自动合并 Claude 侧）
//   node ~/.claude/hooks/experience-stats.mjs                    # Claude 库（不依赖 pi 安装）
//   node stats.mjs <log路径>…                                    # 只统计指定日志（显式传参可合并分析）
//   node stats.mjs --since 2026-09-12 [<log路径>…]               # 只算该日起的注入与其裁决（INDEX 重写后看新口径）
//   传入的每个 hits.log 若同目录有 verdicts.log（judge.mjs 产物）会自动一并读取。
//
// 事件语义（写入方：extensions/experience-retrieve + ~/.claude/hooks/experience-retrieve.py + judge.mjs）：
//   INJECT 条目全文注入 / BLOCK 减速带执行前拦截（cmd=命令指纹）/
//   RECUR 注入后报错复发（n=第几次）/ PASS 被拦条目下一条命中命令放行
//   （resend=verbatim 原样重发 | rewritten 改写重发）/ READ 主动读库埋点（entry 为 proj:<项目根>/.pi/experience/<x>.md
//   时是读项目库，2026-09-28 起）/
//   JUDGE 离线裁决（verdict=IRRELEVANT|REDUNDANT|USED|RELEVANT_IGNORED|FOLLOWED_FAILED，kw=触发词）/
//   SKIP 不可裁（reason=subagent|no_anchor|no_transcript）。
//
// 裁决口径：有 ≥5 次裁决的条目用裁决信号，替代粗粒度的 INJECT≥10（后者分不清救场与噪声，仅对无裁决条目保留）。
//
// 现行关键词口径（2026-09-28 五层审计 M1）：治理信号与主表只算「kw= 全部仍在该条目现行 INDEX 关键词里」的事件；
// 关键词改过之后的旧词事件单列「历史（旧关键词）」、不出信号。此前从头累计：5 条信号 3 条是旧词残留
// （tailscale-ssh-browser-reauth 的 31 次 RECUR 全来自已删的 Tailscale,SSH），08-16 与 09-28 两轮审计都靠手工按 kw= 归因识破。
// PASS 不带 kw，随同条目前一条 BLOCK 归类。
//
// 疑似误伤两类，分开计数，都要求该次 PASS 之后该条目无复发：原样重发放行（关键词撞正常流量）/ 被拦后改写放行
// （可能是按结论改对了，也可能是误拦后绕开——09-25 derp、09-26 hf 两次误拦后模型都顺着改写了命令，旧口径只数原样重发，漏掉）。
//
// 「C-1 日落读数」每次必打：近 30 天与前 30 天的 BLOCK/RECUR 总量（08-17 审计 C-1：减速带触发趋零即可降级为纯注入）。
// 复审由读数召回，不靠人记得「模型换代」。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 与 index.ts 同法由自身位置反推库路径（不依赖 HOME/USERPROFILE，见 README 幽灵路径说明）。
// 两种部署布局：pi 侧 ~/.pi/agent/extensions/experience-retrieve/（库在 ../../experience），
// Claude 侧副本 ~/.claude/hooks/experience-stats.mjs（库在 ../experience）——Claude 侧不依赖 pi 安装。
const here = dirname(fileURLToPath(import.meta.url));
const defaults = [resolve(here, "..", "..", "experience", "hits.log"), resolve(here, "..", "experience", "hits.log")];
const rawArgs = process.argv.slice(2);
// --since YYYY-MM-DD：只统计该日起的注入（裁决按其 inj= 注入时刻过滤）。INDEX 关键词重写后，
// 全期口径会把重写前的无关裁决继续算在条目头上，信号指向早已删掉的关键词（2026-09-15 实证：
// 90.7% 无关率里 359/387 来自 09-12 重写前）。审计时传上次 INDEX 重写日期。
const sinceIdx = rawArgs.indexOf("--since");
const SINCE = sinceIdx >= 0 ? rawArgs[sinceIdx + 1] ?? "" : "";
const args = sinceIdx >= 0 ? rawArgs.filter((_, i) => i !== sinceIdx && i !== sinceIdx + 1) : rawArgs;
const hitsLogs = args.length > 0 ? args : defaults.filter((p) => existsSync(p)).slice(0, 1);
const logs = [];
for (const p of hitsLogs) {
	logs.push(p);
	const v = join(dirname(resolve(p)), "verdicts.log");
	if (existsSync(v) && !hitsLogs.includes(v)) logs.push(v);
}

const KINDS = new Set(["INJECT", "BLOCK", "RECUR", "PASS", "READ", "JUDGE", "SKIP"]);
const VERDICTS = ["IRRELEVANT", "REDUNDANT", "USED", "RELEVANT_IGNORED", "FOLLOWED_FAILED"];
const splitKw = (s) => s.split(/[、,，]/).map((k) => k.trim()).filter(Boolean);
/** 事件 extra 里的 kw=（关键词可含空格，如 `npm root -g`：截到下一个「空格+字段名=」或行尾） */
const kwOf = (extra) => /(?:^|\s)kw=(.*?)(?=\s[a-z_]+=|$)/.exec(extra)?.[1] ?? "";

// 现行 INDEX：每个 hits.log 同目录的 INDEX.md（pi 表格 `| kw | [`x.md`](x.md) | 现象 | active |`，
// Claude 列表 `- \`kw\`: cat/x.md`）。不在现行 INDEX 的条目 = 已退休/已改名/跨库历史（pi 日志 08-12 前的 claude:* 行），
// 其事件只作历史计数、不出治理信号——2026-09-23 实证：pi 侧全期 23 条信号里 15 条指向这类条目，
// 每次审计都要人工逐条排除。找不到任何 INDEX 时不做判定（全部按现行处理）。
// 先于事件读取：事件要按 kw 是否仍在现行关键词里分流。
const activeKeys = new Set();
/** 条目 → 现行关键词（小写） */
const indexKw = new Map();
let indexFound = false;
for (const p of hitsLogs) {
	const idx = join(dirname(resolve(p)), "INDEX.md");
	let text;
	try {
		text = readFileSync(idx, "utf8");
	} catch {
		continue;
	}
	indexFound = true;
	for (const line of text.split(/\r?\n/)) {
		const list = /^- `([^`]+)`:\s*(\S+\.md)/.exec(line);
		if (list) {
			const key = `claude:${list[2]}`;
			activeKeys.add(key);
			indexKw.set(key, new Set(splitKw(list[1]).map((k) => k.toLowerCase())));
			continue;
		}
		if (!line.trimStart().startsWith("|")) continue;
		const cells = line.split("|").slice(1, -1).map((c) => c.trim());
		// 状态判定与 index-format.ts ACTIVE_STATUS 同口径（整词 active，inactive 不算；一致性由 test-stats 钉住）
		if (cells.length < 4 || !/\bactive\b/.test(cells[3])) continue;
		const link = /\(([^)]+\.md)\)/.exec(cells[1])?.[1] ?? /`([^`]+\.md)`/.exec(cells[1])?.[1];
		if (!link) continue;
		const key = `pi:${link.replace(/\\/g, "/")}`;
		activeKeys.add(key);
		indexKw.set(key, new Set(splitKw(cells[0]).map((k) => k.toLowerCase())));
	}
}
const isRetired = (key) => indexFound && !activeKeys.has(key);

const byEntry = new Map();
/** 旧关键词事件：条目 → 计数 + 旧词组合 */
const oldByEntry = new Map();
/** 条目 → 最近一条 BLOCK 是否旧词（PASS 随之归类） */
const lastBlockStale = new Map();
/** 项目库 READ：项目根 → (库内相对路径 → 次数) */
const projReads = new Map();
let total = 0;
let skipped = 0;
let reads = 0;
let minTs = null;
let maxTs = null;
const skipReasons = { subagent: 0, no_anchor: 0, no_transcript: 0, other: 0 };

// C-1 日落读数窗口（本地时间，与 hits.log 时间戳同格式可直接字符串比较）
const DAY_MS = 86_400_000;
const fmtLocal = (ms) => {
	const d = new Date(ms);
	const p = (x) => String(x).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const c1Cut = fmtLocal(Date.now() - 30 * DAY_MS);
const c1PrevCut = fmtLocal(Date.now() - 60 * DAY_MS);
const c1 = { blk: 0, rec: 0, prevBlk: 0, prevRec: 0, seen: false };

function stat(key) {
	if (!byEntry.has(key)) {
		byEntry.set(key, {
			INJECT: 0, BLOCK: 0, RECUR: 0, PASS: 0, verbatim: 0, rewritten: 0, maxN: 0, last: "",
			judged: 0, SKIP: 0, errAfter: 0,
			v: Object.fromEntries(VERDICTS.map((x) => [x, 0])),
			irrKw: new Map(), // IRRELEVANT 裁决的触发词计数，用来点名撞正常流量的关键词
			passes: [], // { ts, resend, blockKw }：疑似误伤按「该次 PASS 之后无复发」判
			recurTs: [],
			lastBlockKw: "",
		});
	}
	return byEntry.get(key);
}

function oldStat(key) {
	if (!oldByEntry.has(key)) oldByEntry.set(key, { INJECT: 0, BLOCK: 0, RECUR: 0, PASS: 0, JUDGE: 0, combos: new Map(), last: "" });
	return oldByEntry.get(key);
}

for (const log of logs) {
	let text;
	try {
		text = readFileSync(log, "utf8");
	} catch {
		continue;
	}
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		total += 1;
		const cells = line.split("\t");
		// 容错：手工追加的破格式行（时间戳/kind 不在位）计 skipped，不中断
		if (cells.length < 3 || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cells[0]) || !KINDS.has(cells[1])) {
			skipped += 1;
			continue;
		}
		const [ts, kind, rawEntry, extra = ""] = cells;
		// C-1 读数看减速带机制本身还在不在触发：全部 pi 条目、不受 --since/退休/旧词分流影响
		if ((kind === "BLOCK" || kind === "RECUR") && rawEntry.startsWith("pi:")) {
			c1.seen = true;
			const f = kind === "BLOCK" ? ["blk", "prevBlk"] : ["rec", "prevRec"];
			if (ts >= c1Cut) c1[f[0]] += 1;
			else if (ts >= c1PrevCut) c1[f[1]] += 1;
		}
		if (SINCE) {
			// 裁决/跳过行按被裁的注入时刻归期，其余按自身时间戳
			const when = kind === "JUDGE" || kind === "SKIP" ? /\binj=(\d{4}-\d{2}-\d{2})/.exec(extra)?.[1] ?? ts : ts;
			if (when.slice(0, 10) < SINCE) continue;
		}
		if (!minTs || ts < minTs) minTs = ts;
		if (!maxTs || ts > maxTs) maxTs = ts;
		if (kind === "READ") {
			reads += 1;
			if (rawEntry.startsWith("proj:")) {
				const path = rawEntry.slice(5);
				const i = path.toLowerCase().lastIndexOf("/.pi/experience/");
				if (i > 0) {
					const root = path.slice(0, i);
					const rel = path.slice(i + "/.pi/experience/".length);
					if (!projReads.has(root)) projReads.set(root, new Map());
					const m = projReads.get(root);
					m.set(rel, (m.get(rel) ?? 0) + 1);
				}
			}
			continue;
		}
		// claude 侧日志的条目列不带来源前缀，统一补上，两份日志可合并统计
		const key = rawEntry.includes(":") ? rawEntry : `claude:${rawEntry}`;
		// 分流：触发词已不在该条目现行关键词里 → 旧词事件
		const curKw = indexKw.get(key);
		let stale = false;
		if (kind === "PASS") stale = lastBlockStale.get(key) ?? false;
		else if (curKw && kind !== "SKIP") {
			const kws = splitKw(kwOf(extra));
			stale = kws.length > 0 && kws.some((k) => !curKw.has(k.toLowerCase()));
		}
		if (kind === "BLOCK") lastBlockStale.set(key, stale);
		if (stale) {
			const o = oldStat(key);
			if (kind in o) o[kind] += 1;
			const kw = kwOf(extra);
			if (kw) o.combos.set(kw, (o.combos.get(kw) ?? 0) + 1);
			o.last = ts.slice(0, 10);
			continue;
		}
		const s = stat(key);
		if (kind === "JUDGE") {
			const verdict = /\bverdict=(\S+)/.exec(extra)?.[1] ?? "";
			if (!VERDICTS.includes(verdict)) {
				skipped += 1;
				continue;
			}
			s.judged += 1;
			s.v[verdict] += 1;
			if (/\berr_after=1\b/.test(extra)) s.errAfter += 1;
			if (verdict === "IRRELEVANT") {
				const kw = /\bkw=(.*?) reason=/.exec(extra)?.[1] ?? "";
				for (const k of kw.split(",").map((x) => x.trim()).filter(Boolean)) s.irrKw.set(k, (s.irrKw.get(k) ?? 0) + 1);
			}
			continue;
		}
		if (kind === "SKIP") {
			s.SKIP += 1;
			const r = /\breason=(\S+)/.exec(extra)?.[1] ?? "other";
			skipReasons[r in skipReasons ? r : "other"] += 1;
			continue;
		}
		s[kind] += 1;
		s.last = ts.slice(0, 10);
		if (kind === "BLOCK") s.lastBlockKw = kwOf(extra);
		if (kind === "PASS") {
			const resend = extra.includes("resend=verbatim") ? "verbatim" : extra.includes("resend=rewritten") ? "rewritten" : "";
			if (resend) s[resend] += 1;
			s.passes.push({ ts, resend, blockKw: s.lastBlockKw });
		}
		if (kind === "RECUR") {
			s.recurTs.push(ts);
			const n = Number(/\bn=(\d+)/.exec(extra)?.[1] ?? 0);
			if (n > s.maxN) s.maxN = n;
		}
	}
}

const evCount = (s) => s.INJECT + s.BLOCK + s.RECUR + s.PASS + s.judged + s.SKIP;
const rows = [...byEntry.entries()]
	.filter(([, s]) => evCount(s) > 0)
	.sort((a, b) => b[1].INJECT + b[1].BLOCK - (a[1].INJECT + a[1].BLOCK));

rows.sort((a, b) => Number(isRetired(a[0])) - Number(isRetired(b[0]))); // 稳定排序：现行在前，各组内保持频次序
const w = (s, n) => String(s).padEnd(n);
const hasVerdicts = rows.some(([, s]) => s.judged > 0 || s.SKIP > 0);
const vcell = (s) => (s.judged + s.SKIP === 0 ? "-" : `${s.judged}:${VERDICTS.map((x) => s.v[x]).join("/")}${s.SKIP ? `+${s.SKIP}跳` : ""}`);
const oldEvents = [...oldByEntry.values()].reduce((n, o) => n + o.INJECT + o.BLOCK + o.RECUR + o.PASS + o.JUDGE, 0);

console.log(`日志: ${logs.join(" + ") || "(无)"}${SINCE ? `  口径: 仅 ${SINCE} 起的注入（含其裁决）` : ""}`);
console.log(
	`事件=${total} 破格式跳过=${skipped} 主动READ=${reads} 时间跨度=${minTs ?? "-"} ~ ${maxTs ?? "-"}` +
		(oldEvents > 0 ? `  （主表与信号只算现行关键词事件；旧关键词 ${oldEvents} 个事件见末尾「历史」）` : "") +
		"\n",
);
console.log(
	w("条目", 66) + w("INJECT", 8) + w("BLOCK", 7) + w("RECUR", 7) + w("PASS(原样/改写)", 14) + (hasVerdicts ? w("裁决 n:无/冗/用/忽/败", 24) : "") + "最近",
);
for (const [key, s] of rows) {
	console.log(
		w(isRetired(key) ? `${key}（已退休）` : key, 66) + w(s.INJECT, 8) + w(s.BLOCK, 7) + w(s.RECUR, 7) + w(`${s.PASS}(${s.verbatim}/${s.rewritten})`, 14) + (hasVerdicts ? w(vcell(s), 24) : "") + s.last,
	);
}

const agg = rows.reduce(
	(a, [, s]) => ({
		inj: a.inj + s.INJECT,
		blk: a.blk + s.BLOCK,
		rec: a.rec + s.RECUR,
		pass: a.pass + s.PASS,
		vb: a.vb + s.verbatim,
		rw: a.rw + s.rewritten,
		judged: a.judged + s.judged,
		skip: a.skip + s.SKIP,
		v: Object.fromEntries(VERDICTS.map((x) => [x, a.v[x] + s.v[x]])),
	}),
	{ inj: 0, blk: 0, rec: 0, pass: 0, vb: 0, rw: 0, judged: 0, skip: 0, v: Object.fromEntries(VERDICTS.map((x) => [x, 0])) },
);
const pct = (num, den) => (den > 0 ? `${((num / den) * 100).toFixed(1)}%` : "-");
console.log(`\n总体：注入后复发率 RECUR/INJECT=${pct(agg.rec, agg.inj)}  减速带改写率 rewritten/PASS=${pct(agg.rw, agg.pass)}`);
if (hasVerdicts) {
	console.log(
		`裁决：n=${agg.judged} 无关率=${pct(agg.v.IRRELEVANT, agg.judged)} 冗余率=${pct(agg.v.REDUNDANT, agg.judged)} 救场率(USED)=${pct(agg.v.USED, agg.judged)} ` +
			`忽略=${agg.v.RELEVANT_IGNORED} 过时=${agg.v.FOLLOWED_FAILED}；不可裁=${agg.skip}（子代理=${skipReasons.subagent} 无锚点=${skipReasons.no_anchor} 无transcript=${skipReasons.no_transcript}）`,
	);
	console.log(`（裁决 n<5 的条目不出裁决信号；INJECT≥10 信号仅对无裁决条目保留。子代理内注入 transcript 不留痕，永久不可裁。）`);
}

const topOf = (counts, n = 3) =>
	[...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `${k}×${c}`).join(" ");

const signals = [];
const retired = rows.filter(([key]) => isRetired(key));
for (const [key, s] of rows) {
	if (isRetired(key)) continue;
	if (s.RECUR >= 2) signals.push(`RECUR≥2  ${key} — 注入后仍复发，评估精确拦截模式或升层（five-layer-governance/compass）`);
	// 疑似误伤：该次放行之后该条目再无复发（旧口径是全期 RECUR=0，一次早期真复发会永久遮住后来的误拦）
	const clean = s.passes.filter((p) => !s.recurTs.some((r) => r >= p.ts));
	const vb = clean.filter((p) => p.resend === "verbatim").length;
	const rw = clean.filter((p) => p.resend === "rewritten");
	if (vb >= 2) signals.push(`疑似误伤  ${key} — ${vb} 次原样重发放行且其后无复发，关键词撞正常流量（勿用业务功能名做单长关键词）`);
	if (rw.length >= 2) {
		const kwCounts = new Map();
		for (const p of rw) if (p.blockKw) kwCounts.set(p.blockKw, (kwCounts.get(p.blockKw) ?? 0) + 1);
		signals.push(
			`疑似误伤(改写)  ${key} — ${rw.length} 次被拦后改写放行且其后无复发：可能按结论改对了，也可能是误拦后绕开——` +
				`对照 hits.log 被拦命令人工核，误拦则关键词收到失败形态侧（被拦 kw：${topOf(kwCounts) || "-"}）`,
		);
	}
	if (s.judged >= 5) {
		const irr = s.v.IRRELEVANT / s.judged;
		const red = s.v.REDUNDANT / s.judged;
		if (irr >= 0.6) {
			signals.push(`无关率${pct(s.v.IRRELEVANT, s.judged)} ${key} — 关键词撞正常流量，收紧或降为不可单触发；无关裁决里最常见触发词：${topOf(s.irrKw) || "-"}`);
		}
		if (red >= 0.6) signals.push(`冗余率${pct(s.v.REDUNDANT, s.judged)} ${key} — 触发在 agent 已用上解法之后：关键词含解法侧词，改为现象侧词；若已是现象侧则知识已内化，考虑退休`);
		if (s.v.USED >= 5 && s.INJECT >= 20) signals.push(`高价值高频 ${key} — USED=${s.v.USED} INJECT=${s.INJECT}，升层常驻候选（CLAUDE/AGENTS）`);
		if (s.judged >= 10 && s.v.USED === 0 && s.v.RELEVANT_IGNORED === 0 && s.v.FOLLOWED_FAILED === 0) {
			signals.push(`纯噪声  ${key} — ${s.judged} 次裁决无一命中场景，关键词整体收紧或条目退休`);
		}
	} else if (s.INJECT >= 10) {
		signals.push(`INJECT≥10 ${key} — 跨会话高频命中，评估升层常驻（AGENTS/CLAUDE）或关键词过宽需收紧${hasVerdicts ? "（裁决不足 5 次，先跑 judge）" : ""}`);
	}
	if (s.v.FOLLOWED_FAILED >= 2) signals.push(`结论过时 ${key} — 按结论做仍复发 ${s.v.FOLLOWED_FAILED} 次，回 /sediment 改写`);
	if (s.v.RELEVANT_IGNORED >= 3) signals.push(`注入未采纳 ${key} — 场景相符却 ${s.v.RELEVANT_IGNORED} 次未按结论做，是 harness 问题（注入位置/措辞），不是条目问题`);
}
console.log(`\n治理信号：${signals.length === 0 ? "（无）" : ""}`);
for (const sig of signals) console.log(`- ${sig}`);
if (c1.seen) {
	console.log(
		`C-1 日落读数：近 30 天 BLOCK=${c1.blk} RECUR=${c1.rec}（前 30 天 BLOCK=${c1.prevBlk} RECUR=${c1.prevRec}；` +
			"C-1 日落条件：减速带触发趋零即可降级为纯注入——PI_EXP_REARM_LIMIT=0 关复发重武装）",
	);
}
if (retired.length > 0) {
	const ev = retired.reduce((n, [, s]) => n + s.INJECT + s.BLOCK + s.RECUR + s.PASS, 0);
	console.log(`（${retired.length} 个条目不在现行 INDEX——已退休/改名/跨库历史，共 ${ev} 个事件，只作历史计数、不出信号）`);
} else if (!indexFound) {
	console.log("（日志同目录无 INDEX.md，未判定条目是否已退休，信号按全部条目给出）");
}

if (oldByEntry.size > 0) {
	console.log(`\n历史（旧关键词，不出信号——触发词已不在该条目现行 INDEX 关键词里）：`);
	const olds = [...oldByEntry.entries()].sort((a, b) => b[1].INJECT + b[1].BLOCK + b[1].RECUR - (a[1].INJECT + a[1].BLOCK + a[1].RECUR));
	for (const [key, o] of olds) {
		console.log(
			`- ${key} — INJECT ${o.INJECT} BLOCK ${o.BLOCK} RECUR ${o.RECUR} PASS ${o.PASS}${o.JUDGE ? ` 裁决 ${o.JUDGE}` : ""}，最近 ${o.last}；旧词组合：${topOf(o.combos)}`,
		);
	}
}

if (projReads.size > 0) {
	console.log(`\n项目库主动 READ（proj:，本扩展不向项目库推送，召回靠项目 AGENTS 路由；按该项目 INDEX.md 判现行）：`);
	for (const [root, m] of [...projReads.entries()].sort((a, b) => sumOf(b[1]) - sumOf(a[1]))) {
		let indexText = null;
		try {
			indexText = readFileSync(join(root, ".pi", "experience", "INDEX.md"), "utf8");
		} catch {
			// 项目库无 INDEX：不判现行
		}
		const entries = [...m.entries()].filter(([rel]) => !/^index\.md$/i.test(rel));
		const idxReads = sumOf(m) - entries.reduce((n, [, c]) => n + c, 0);
		const gone = indexText === null ? [] : entries.filter(([rel]) => !indexText.includes(rel.split("/").pop()));
		console.log(
			`- ${root} — READ ${sumOf(m)}（INDEX ${idxReads}，条目 ${entries.length} 个：${topOf(new Map(entries)) || "-"}）` +
				(indexText === null ? "；⚠ 无 INDEX.md" : gone.length > 0 ? `；不在该项目 INDEX（已退休/改名）：${gone.map(([r]) => r).join("、")}` : ""),
		);
	}
}

function sumOf(m) {
	let n = 0;
	for (const c of m.values()) n += c;
	return n;
}
