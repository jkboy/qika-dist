import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptContextRule, SettledReminderRule } from "../types";

const rulesDir = dirname(fileURLToPath(import.meta.url));
const agentDir = resolve(rulesDir, "..", "..", "..");
const validatorPath = join(agentDir, "skills", "evidence-contract", "scripts", "validate-evidence.mjs");
const manifestExamplePath = join(agentDir, "skills", "evidence-contract", "references", "manifest.example.json");

// manifest 规范保存位置：<项目根>/.pi/tasks/evidence-<任务slug>-manifest.json。
// 写侧（evidence-research-context 注入 + SKILL.md）与读侧（收尾审计回退查找）共用此约定。
const MANIFEST_DIR_SEGMENTS = [".pi", "tasks"] as const;
const MANIFEST_FILE_PATTERN = /^evidence-.*\.json$/;

// —— 确定性信号 ——
// A：强调研关键词，单独命中即触发；B：URL + 评估类弱关键词，两者同时出现才触发。
// "评估"单独出现不触发（会误伤"评估这段代码"类本地任务）。
const STRONG_RESEARCH = /(调研|选型|是否值得|值不值得|最佳实践|技术评估|对比评估)/;
const URL_PATTERN = /https?:\/\/[^\s)"'<>]+/;
const WEAK_EVAL = /(评估|引入|采用|对比|比较|推荐|靠谱|可靠|evaluate|assess|review|recommend|adopt|worth)/i;

/**
 * 附件块剥离：<attachment name="...">…</attachment> 是随消息内联的文件内容，
 * 不代表用户的任务意图——2026-08-18 实测误伤：handoff 文档更新任务因附件里
 * 一个 URL + "引入"一词被误判成调研，收尾被点名"未运行校验器"。
 * 匹配只看剥离后的用户正文（样式与 pi-web normalizer 的拆解正则同族）。
 */
const ATTACHMENT_BLOCK_PATTERN = /<attachment name="[^"]*">[\s\S]*?<\/attachment>/g;

export function stripAttachments(prompt: string): string {
	return prompt.replace(ATTACHMENT_BLOCK_PATTERN, "");
}

export function isResearchPrompt(prompt: string): boolean {
	const text = stripAttachments(prompt);
	if (STRONG_RESEARCH.test(text)) return true;
	return URL_PATTERN.test(text) && WEAK_EVAL.test(text);
}

// —— 外部性判定（收尾审计的"未跑校验器"分支用）——
// "调研"一词也覆盖本地诊断类任务（如"调研主机为什么黑屏"），这类会话全程
// 不触网、无外部来源可登记，点名"未运行校验器"必然是噪声。判定外部性：
// assistant 产出（命令/正文/写入内容）出现非内网 URL，或调用过 web_search。

/** 文本中提取 http(s) URL 的宽松样式（与 URL_PATTERN 同族，多排除转义/右括号） */
const URL_IN_TEXT_PATTERN = /https?:\/\/[^\s)"'<>\\\]]+/g;
/** 回环/内网/链路本地/CGNAT（Tailscale 100.64/10）/IPv6 本地主机不算外部来源 */
const PRIVATE_HOST_PATTERN =
	/^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|::1$|fe80:|f[cd][0-9a-f]{2}:)/i;

export function isExternalHttpUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		const host = url.hostname.replace(/^\[|\]$/g, "");
		return !PRIVATE_HOST_PATTERN.test(host);
	} catch {
		return false;
	}
}

/**
 * 会话中 assistant 是否触及外部来源：任一 assistant 消息（文本、toolCall 参数
 * ——覆盖 bash 命令、web_fetch url、write/edit 写入内容）含外部 URL，或调用过
 * web_search（查询天然面向外部）。toolResult / hook 注入不算：读到的本地文档
 * 里出现引用 URL 不构成"本会话引用了外部来源"。
 */
export function sessionCitesExternalSources(sessionText: string): boolean {
	for (const line of sessionText.split(/\r?\n/)) {
		if (!line.includes('"assistant"')) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = (entry as { message?: { role?: string; content?: unknown[] } })?.message;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const item of message.content) {
			const call = item as { type?: string; name?: string };
			if (call?.type === "toolCall" && call.name?.split(".").at(-1) === "web_search") return true;
			const blob = JSON.stringify(item);
			for (const url of blob.match(URL_IN_TEXT_PATTERN) ?? []) {
				if (isExternalHttpUrl(url)) return true;
			}
		}
	}
	return false;
}

export const evidenceResearchContext: PromptContextRule = {
	id: "evidence-research-context",
	description: "调研/选型类 prompt 注入证据契约的发布纪律",
	enabled: true,
	buildContext({ prompt, cwd }) {
		if (!isResearchPrompt(prompt)) return undefined;
		const canonicalManifest = join(cwd, ...MANIFEST_DIR_SEGMENTS, "evidence-<任务slug>-manifest.json");
		return [
			"本任务命中 evidence-contract（证据契约）。发布纪律：",
			"1. 每条事实性断言必须有实际取证成功的来源；引用存在不等于引用支持。",
			"2. 取证失败（限流/404/超时/空响应）的信息只能标 unknown 或 provisional，不得写成确定事实；先换替代取证路径（装了 web-fetch skill 时按其中的 GitHub 限流应对），仍失败就在报告中明示未能核验。",
			`3. strict 级任务（选型/引入/否定结论）发布前必须生成 evidence manifest 并通过校验：node "${validatorPath}" <manifest.json>；未通过校验的结论封顶 provisional。**manifest 结构勿凭记忆手写**：从示例 ${manifestExamplePath} 拷贝骨架改内容（自造简化 schema 必然过不了校验，实测一次性产生 128 项结构错误）；校验器报 FAIL 须修到 PASS 再发布。`,
			`4. manifest 统一保存为 ${canonicalManifest}（固定目录与命名，收尾审计按此回读）；运行校验器时 manifest 传绝对路径。新调研题用新的任务 slug，勿与 .pi/tasks 里既有 manifest 重名（同题续做才复用原文件）；同一话题不要并行开多个会话同时写一份 manifest。`,
			"5. manifest 来源写法：url 必须是实际请求过的裸 URL（备注写 locator）；经转运获得的内容加 retrieved_via 记实际请求的 URL；spawn_researcher 子代理抓取的来源可直接登记（其取证日志随报告落盘，收尾核验会读取）；本地取证（跑测试/读本地文件）用 local_command 记录执行过的命令——**逐字粘贴会话中真实执行过的命令**（选最有代表性的一条即可），禁止概述/翻译/伪命令，否则结构校验与收尾交叉核验都会拒绝；本地文件取证一律用 bash（cat/grep/sed/python -c）执行，read 等结构化工具的取证不参与交叉核验。",
			"6. manifest 里的每个来源都须对应本会话真实发生过的抓取或执行；会话收尾时核验通过的条目会自动写入 session_file（出处会话）。",
			"7. 沿用先前调研的证据：同题续做直接复用原 manifest 文件；新任务（如对同一对象换角度审计）需要新 manifest 时，从旧 manifest **原样拷贝带 session_file 章的条目**（连同 session_file 字段一起）——带章条目按出处会话回溯核验，重新登记成无章条目会被误判从未取证。本会话新增/复核的来源正常登记（不带 session_file，收尾自动盖章）。**不要手写或改动 session_file 的值**：它只由收尾核验写入，核验按它回溯出处会话。",
		].join("\n");
	},
};

// —— 会话收尾审计 ——

/** 从包含 validate-evidence.mjs 的 bash 命令中取 manifest 位置参数 */
export function extractManifestArg(command: string): string | undefined {
	const marker = "validate-evidence.mjs";
	const index = command.indexOf(marker);
	if (index < 0) return undefined;
	// 脚本路径本身可能被引号包裹，去掉紧随 marker 的闭引号再切 token
	const rest = command.slice(index + marker.length).replace(/^["']/, "");
	const tokens = rest.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i].replace(/^["']|["']$/g, "");
		if (/^(&&|\|\||;|\|)/.test(token)) break;
		if (token === "--session") {
			i++;
			continue;
		}
		if (token.startsWith("-")) continue;
		return token;
	}
	return undefined;
}

/**
 * 解析校验命令里的 manifest 绝对路径。相对路径不能直接按会话 cwd 拼：
 * 实测事故是 `cd <dir> && … && node validate-evidence.mjs <裸文件名>` 形态，
 * 审计按项目根拼出不存在的路径。这里跟踪校验器调用之前的 cd 目标。
 */
export function resolveManifestPath(command: string, cwd: string): string | undefined {
	const arg = extractManifestArg(command);
	if (!arg) return undefined;
	if (isAbsolute(arg)) return arg;
	let base = cwd;
	const beforeValidator = command.slice(0, command.indexOf("validate-evidence.mjs"));
	const cdPattern = /(?:^|&&|\|\||;)\s*cd\s+("([^"]*)"|'([^']*)'|[^\s&|;]+)/g;
	for (const match of beforeValidator.matchAll(cdPattern)) {
		base = resolve(base, match[2] ?? match[3] ?? match[1]);
	}
	return resolve(base, arg);
}

/**
 * 规范位置回退：<cwd>/.pi/tasks/（兼容历史上落在项目根的）取 evidence-*.json。
 * 传入 sessionText 时优先取"本会话文本里出现过文件名"的候选（写入/校验命令都会
 * 留下文件名）——同项目并行多个调研会话时，"最新文件"可能属于另一个话题，
 * 直接取最新会把别人的 manifest 拿来对本会话交叉核验（必然误报）。
 * 会话内一个名字都没提过才退回最新文件（兼容旧行为）。
 */
export function findCanonicalManifest(cwd: string, sessionText?: string): string | undefined {
	const candidates: Array<{ path: string; mtime: number }> = [];
	for (const dir of [join(cwd, ...MANIFEST_DIR_SEGMENTS), cwd]) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			if (!MANIFEST_FILE_PATTERN.test(name)) continue;
			const path = join(dir, name);
			try {
				candidates.push({ path, mtime: statSync(path).mtimeMs });
			} catch {
				// 枚举与 stat 之间文件被移走：跳过该候选
			}
		}
	}
	candidates.sort((a, b) => b.mtime - a.mtime);
	if (sessionText) {
		const mentioned = candidates.find((c) => sessionText.includes(basename(c.path)));
		if (mentioned) return mentioned.path;
	}
	return candidates[0]?.path;
}

interface AuditOutcome {
	valid: boolean;
	errors: string[];
	sessionCheck?: {
		unrequested: Array<{ id?: string; url: string; session_file?: string }>;
		failedFetch: Array<{ id?: string; url: string; session_file?: string }>;
		unexecuted?: Array<{ id?: string; local_command: string; session_file?: string }>;
		unverifiable?: Array<{ id?: string; session_file: string }>;
		verified_here?: string[];
	};
}

/**
 * 出处盖章：把"本会话核验通过"的证据条目打上 session_file=当前会话 jsonl 路径。
 * manifest 由此可跨会话续用——续做会话的收尾审计对带章条目改查其出处会话，
 * 不再把先前会话的真实取证误报成"从未抓取"（2026-08-10 实测事故）。
 * agent 不知道自己的会话文件路径，该字段只能由本审计写入；伪造出处也无济于事，
 * 校验器会去出处会话文件里找真实的抓取命令。
 * 写回用 JSON.stringify 两空格缩进（格式会被归一化）；失败静默——盖章是增强，
 * 不能反过来弄坏审计提醒。
 */
export function stampSessionProvenance(
	manifestPath: string,
	verifiedIds: readonly string[],
	sessionFile: string,
): boolean {
	if (verifiedIds.length === 0) return false;
	try {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			evidence?: Array<Record<string, unknown>>;
		};
		if (!Array.isArray(manifest?.evidence)) return false;
		let changed = false;
		for (const record of manifest.evidence) {
			if (record === null || typeof record !== "object") continue;
			if (typeof record.id !== "string" || !verifiedIds.includes(record.id)) continue;
			if (typeof record.session_file === "string" && record.session_file.length > 0) continue;
			record.session_file = sessionFile;
			changed = true;
		}
		if (changed) {
			// 原子写（临时文件 + rename）：同项目并行会话可能同时 settle 触发盖章，
			// 直接 writeFileSync 被并发读到半截会拿到坏 JSON；rename 在 Windows 上
			// 也是替换语义。并发丢章无害（下次 settle 会重新盖）。
			const tmpPath = `${manifestPath}.stamp-tmp`;
			writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
			renameSync(tmpPath, manifestPath);
		}
		return changed;
	} catch {
		return false;
	}
}

export interface SettledAuditDiagnostics {
	/** 审计走到的分支 */
	reason:
		| "no-session-file"
		| "no-marker"
		| "local-exempt"
		| "no-validator"
		| "manifest-not-found"
		| "validator-error"
		| "audited";
	/** 用户会看到的提醒文本；undefined = 静默 */
	reminder?: string;
	/** 会话内出现过的校验器 bash 命令 */
	validatorCommands: string[];
	/** 未跑校验器分支的豁免判定输入 */
	mentionsManifest?: boolean;
	citesExternal?: boolean;
	/** 从校验命令解析出的最后一个候选路径（可能不存在） */
	lastResolved?: string;
	/** 实际交给校验器的 manifest */
	manifestPath?: string;
	/** 校验器完整输出（含全部结构错误，提醒文本里只有条数） */
	outcome?: AuditOutcome;
	/** 本会话核验通过的证据 id（stamp=false 时为"应盖未盖"名单） */
	verifiedHere: string[];
	/** 是否实际执行了盖章写回 */
	stamped: boolean;
}

export interface SettledAuditOptions {
	cwd: string;
	sessionFile?: string;
	/** false = 只读重放（不写 session_file 章），供 replay-settled-audit.mjs 事后诊断用 */
	stamp?: boolean;
}

/**
 * 收尾审计核心。evidenceSettledAudit.check 以 stamp=true 调用并只取 reminder；
 * 重放工具以 stamp=false 调用拿完整诊断（提醒文本只含错误条数与前 5 个 URL，
 * 事后排查需要全部错误与分支信息，而 ui.notify 的提醒不落盘、无法回查）。
 */
export function auditSettledSession({ cwd, sessionFile, stamp = true }: SettledAuditOptions): SettledAuditDiagnostics {
	const diag: SettledAuditDiagnostics = {
		reason: "no-session-file",
		validatorCommands: [],
		verifiedHere: [],
		stamped: false,
	};
	if (!sessionFile || !existsSync(sessionFile)) return diag;
	const sessionText = readFileSync(sessionFile, "utf8");
	// 只审计本会话确实注入过调研纪律的情况
	if (!sessionText.includes("[evidence-research-context]")) {
		diag.reason = "no-marker";
		return diag;
	}

	for (const line of sessionText.split(/\r?\n/)) {
		if (!line.includes("validate-evidence.mjs")) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = (entry as { message?: { role?: string; content?: unknown[] } })?.message;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const item of message.content) {
			const call = item as { type?: string; name?: string; arguments?: { command?: unknown } };
			if (call?.type !== "toolCall" || call.name?.split(".").at(-1) !== "bash") continue;
			const command = call.arguments?.command;
			if (typeof command === "string" && command.includes("validate-evidence.mjs")) {
				diag.validatorCommands.push(command);
			}
		}
	}

	if (diag.validatorCommands.length === 0) {
		// 纯本地会话豁免（2026-08-15 实测：主机黑屏诊断会话被点名"未运行校验器"）：
		// 无外部来源引用、没搜过网、也没建过 manifest 的会话，校验器无对象可校，
		// 警告必然是噪声。提过 manifest 文件名的仍要警（本地取证型 strict 任务
		// 同样必须过校验器）。
		diag.mentionsManifest = /evidence-[A-Za-z0-9._-]+-manifest\.json/.test(sessionText);
		diag.citesExternal = sessionCitesExternalSources(sessionText);
		if (!diag.mentionsManifest && !diag.citesExternal) {
			diag.reason = "local-exempt";
			return diag;
		}
		diag.reason = "no-validator";
		diag.reminder =
			"调研会话未运行 evidence 校验器（validate-evidence.mjs）。报告中的动态事实断言（维护状态、作者信誉、测试/CI、兼容性）可能未经取证，按契约只能视为 provisional，请人工复查。";
		return diag;
	}

	// 从最后一次校验命令往前找第一个解析后确实存在的 manifest；全部落空再回退规范位置
	for (let i = diag.validatorCommands.length - 1; i >= 0; i--) {
		const candidate = resolveManifestPath(diag.validatorCommands[i], cwd);
		if (!candidate) continue;
		diag.lastResolved ??= candidate;
		if (existsSync(candidate)) {
			diag.manifestPath = candidate;
			break;
		}
	}
	if (!diag.manifestPath) diag.manifestPath = findCanonicalManifest(cwd, sessionText);
	if (!diag.manifestPath) {
		const canonicalDir = join(cwd, ...MANIFEST_DIR_SEGMENTS);
		diag.reason = "manifest-not-found";
		diag.reminder = diag.lastResolved
			? `evidence manifest 未找到（校验命令解析到 ${diag.lastResolved}，规范位置 ${canonicalDir} 下也无 evidence-*.json）。manifest 应保存为 ${join(canonicalDir, "evidence-<任务slug>-manifest.json")}，无法交叉核验来源。`
			: `检测到 evidence 校验器调用，但无法解析 manifest 路径，规范位置 ${canonicalDir} 下也无 evidence-*.json，无法交叉核验来源。`;
		return diag;
	}

	const proc = spawnSync(
		process.execPath,
		[validatorPath, "--json", diag.manifestPath, "--session", sessionFile],
		{ encoding: "utf8", timeout: 15_000, windowsHide: true },
	);
	if (proc.error) {
		diag.reason = "validator-error";
		diag.reminder = `evidence 交叉核验无法运行：${proc.error.message}`;
		return diag;
	}

	let outcome: AuditOutcome;
	try {
		outcome = JSON.parse(proc.stdout) as AuditOutcome;
	} catch {
		diag.reason = "validator-error";
		diag.reminder = `evidence 交叉核验输出无法解析（exit ${proc.status}）：${(proc.stderr || proc.stdout).slice(0, 200)}`;
		return diag;
	}
	diag.reason = "audited";
	diag.outcome = outcome;
	diag.verifiedHere = outcome.sessionCheck?.verified_here ?? [];

	// 出处盖章：本会话核验通过的条目记下出处会话，供后续续做会话回溯核验
	if (stamp) {
		diag.stamped = stampSessionProvenance(diag.manifestPath, diag.verifiedHere, sessionFile);
	}

	const problems: string[] = [];
	if (!outcome.valid) {
		// 带前几条错误明细：只报条数的警告无法行动（人工/下一轮 agent 都得重跑校验器才知道错在哪）
		const preview = outcome.errors.slice(0, 3).join("；");
		problems.push(
			`manifest 结构校验未通过（${outcome.errors.length} 项错误，如：${preview}${outcome.errors.length > 3 ? " …" : ""}。完整清单重跑校验器可见）`,
		);
	}
	const unrequested = outcome.sessionCheck?.unrequested ?? [];
	const failedFetch = outcome.sessionCheck?.failedFetch ?? [];
	if (unrequested.length > 0) {
		problems.push(`引用了会话中从未抓取的来源：${unrequested.slice(0, 5).map((item) => item.url).join("、")}`);
	}
	if (failedFetch.length > 0) {
		problems.push(`引用了抓取失败的来源：${failedFetch.slice(0, 5).map((item) => item.url).join("、")}`);
	}
	const unexecuted = outcome.sessionCheck?.unexecuted ?? [];
	if (unexecuted.length > 0) {
		problems.push(
			`引用了从未执行的本地取证命令：${unexecuted.slice(0, 5).map((item) => item.local_command).join("、")}（常见原因：登记了概述而非逐字命令——local_command 必须逐字粘贴会话中执行过的命令）`,
		);
	}
	const unverifiable = outcome.sessionCheck?.unverifiable ?? [];
	if (unverifiable.length > 0) {
		problems.push(
			`历史来源的出处会话文件已不可读，无法回溯核验：${unverifiable.slice(0, 5).map((item) => `${item.id ?? "?"}（${item.session_file}）`).join("、")}（这不是编造指控——出处会话被清理/移动时会出现；相关断言降为 provisional，或在本会话重新取证）`,
		);
	}
	if (problems.length > 0) {
		diag.reminder = `evidence 交叉核验发现问题：${problems.join("；")}。相关断言只能视为 unknown/provisional。`;
	}
	return diag;
}

export const evidenceSettledAudit: SettledReminderRule = {
	id: "evidence-settled-audit",
	description: "调研会话收尾时核验校验器已运行且 manifest 来源真实抓取过",
	enabled: true,
	check({ cwd, sessionFile }) {
		return auditSettledSession({ cwd, sessionFile }).reminder;
	},
};
