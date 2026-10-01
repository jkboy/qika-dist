import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type KnowledgePage, parseKnowledgeIndex } from "./index-format.ts";

/**
 * knowledge-pointer —— KNOWLEDGE 层指针推送 + 埋点。
 *
 * 防止的已观察失败：KNOWLEDGE 层进入工作流全靠模型自觉读 index，而"模型不会
 * 主动查索引"已被 experience-retrieve 的埋点数据反复证实（claude 侧 hits.log
 * 715 条中主动 READ 仅 26 条）。经验层有 hook 推送兜底，知识层此前裸奔。
 *
 * 机制（刻意比 experience-retrieve 轻）：
 * - before_agent_start：用户 prompt 对 knowledge/index.md 的「触发词」列匹配，
 *   命中 → 注入指针行（路径 + 摘要），**不注全文**——读不读由模型判断，
 *   单次成本约百 token，注错的代价远低于经验库全文注入。
 * - 单触发词即命中。代价换约束：触发词列只收领域专名（compaction、rate limit、
 *   exit 49 这类），宽词（"文档""训练"）勿入——卫生规则写在 index.md 表头上方。
 * - 每会话每页面只注一次（session_start 清零）；主库 + 项目库（<cwd>/.pi/knowledge）
 *   都扫；无「触发词」列的旧表格行自然跳过，向后兼容。
 * - 埋点：knowledge/hits.log 的 POINTER 行；模型随后 Read 知识文件的 READ 行
 *   由 tool_result 钩子记录（`/knowledge/` 下的 .md + 索引登记在库外的页，extra 带 lib=）。
 *   两行相除即指针→阅读转化率——这是"知识库有没有真正进工作流"的直接观测。
 * - 校准参数：PI_KN_MAX_POINTERS（每次 prompt 最多指针数，默认 3）；准入卡见 README。
 * - 铁律同 experience-retrieve：handler 全程自兜底，绝不因自身异常影响会话。
 */

const extensionDir = dirname(fileURLToPath(import.meta.url));
const agentDir = resolve(extensionDir, "..", "..");
/** 主知识库目录：默认从扩展位置反推；PI_KN_DIR 可覆盖（测试 fixture 用） */
const PI_KN_DIR = process.env.PI_KN_DIR
	? resolve(process.env.PI_KN_DIR)
	: resolve(agentDir, "knowledge");
const HITS_LOG = resolve(PI_KN_DIR, "hits.log");

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 每次 prompt 最多注入的指针数（校准参数，PI_KN_MAX_POINTERS 可配；与 experience-retrieve 的 PI_EXP_* 同约定） */
const MAX_POINTERS = envInt("PI_KN_MAX_POINTERS", 3);
// 索引解析口径在 index-format.ts（doctor 与测试共用同一份）；这里 re-export 保持既有 import 面不变
export { type KnowledgePage, parseKnowledgeIndex, PUSHABLE_STATUS } from "./index-format.ts";

/** ASCII 触发词按词边界匹配（防 pi 命中 npm/pip）；含 CJK 的去空白后子串匹配 */
export function keywordMatches(kw: string, textLower: string, textNoSpace: string): boolean {
	const k = kw.toLowerCase();
	if (/[^\x00-\x7f]/.test(k)) return textNoSpace.includes(k.replace(/\s+/g, ""));
	const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(textLower);
}

export function matchPages(
	pages: KnowledgePage[],
	promptLower: string,
	promptNoSpace: string,
	excluded: ReadonlySet<string>,
): { page: KnowledgePage; matched: string[] }[] {
	const hits: { page: KnowledgePage; matched: string[] }[] = [];
	for (const page of pages) {
		if (excluded.has(page.file)) continue;
		const matched = page.keywords.filter((k) => keywordMatches(k, promptLower, promptNoSpace));
		if (matched.length > 0) hits.push({ page, matched });
	}
	return hits;
}

function logHit(kind: string, file: string, extra: string, sid = ""): void {
	// 评测态（skill-trigger-eval 等 pi -p --no-session 批跑）只静音埋点，指针注入行为不变
	// （与 Claude 侧 knowledge-pointer.py 同约定；2026-09-23 实证：6 行无 sid POINTER 全来自评测批跑）
	if (process.env.FIVE_LAYER_EVAL) return;
	try {
		const d = new Date();
		const p = (x: number) => String(x).padStart(2, "0");
		const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
		appendFileSync(HITS_LOG, `${ts}\t${kind}\t${file}\t${extra}\tsid=${sid}\n`, "utf8");
	} catch {
		// 埋点失败不影响主流程
	}
}

/** 会话标识:session 文件名去扩展名;拿不到时空串(统计脚本会跳过其配对) */
function sessionId(ctx: unknown): string {
	try {
		const f = (ctx as { sessionManager?: { getSessionFile?: () => string } })?.sessionManager?.getSessionFile?.();
		return f ? basename(f).replace(/\.[^.]+$/, "") : "";
	} catch {
		return "";
	}
}

const normPath = (p: string) => p.replace(/\\/g, "/").toLowerCase();

/**
 * 索引登记的全部页面路径（表格链接 / 反引号路径 / 列表式 `- \`文档/x.md\``），不论能否推送——READ 埋点用。
 * 项目库的登记路径可能相对项目根（如 `文档/*.md`、`.pi/knowledge/*.md`），故两个基准都收。
 */
export function registeredPaths(text: string, indexDir: string, projectRoot?: string): string[] {
	const out = new Set<string>();
	const bases = projectRoot ? [indexDir, projectRoot] : [indexDir];
	for (const line of text.split("\n")) {
		const s = line.trim();
		if (!s.startsWith("|") && !/^[-*]\s/.test(s)) continue;
		for (const m of s.matchAll(/\]\(([^)\s]+\.md)\)|`([^`\s]+\.md)`/g)) {
			const rel = m[1] ?? m[2];
			for (const base of bases) out.add(normPath(resolve(base, rel)));
		}
	}
	return [...out];
}

const registeredCache = new Map<string, { mtimeMs: number; paths: Set<string> }>();

/** read 目标所属知识库目录（规范化小写）：落在某 `/knowledge/` 目录下，或是主库/cwd 项目库索引登记的页；否则空串 */
export function readTargetLib(input: unknown, cwd: string | undefined): string {
	const p = (input as { path?: unknown } | null)?.path;
	if (typeof p !== "string" || !p) return "";
	const abs = normPath(isAbsolute(p) || !cwd ? p : resolve(cwd, p));
	if (!abs.endsWith(".md")) return "";
	const k = abs.lastIndexOf("/knowledge/");
	if (k >= 0) return abs.slice(0, k + "/knowledge".length);
	const libs: { dir: string; root?: string }[] = [{ dir: PI_KN_DIR }];
	if (cwd) libs.push({ dir: resolve(cwd, ".pi", "knowledge"), root: cwd });
	for (const lib of libs) {
		const indexFile = resolve(lib.dir, "index.md");
		try {
			const mtimeMs = statSync(indexFile).mtimeMs;
			let hit = registeredCache.get(indexFile);
			if (!hit || hit.mtimeMs !== mtimeMs) {
				hit = { mtimeMs, paths: new Set(registeredPaths(readFileSync(indexFile, "utf8"), lib.dir, lib.root)) };
				registeredCache.set(indexFile, hit);
			}
			if (hit.paths.has(abs)) return normPath(lib.dir);
		} catch {
			// 无索引：跳过该库
		}
	}
	return "";
}

function loadPages(cwd: string | undefined): KnowledgePage[] {
	const pages: KnowledgePage[] = [];
	const mainIndex = resolve(PI_KN_DIR, "index.md");
	if (existsSync(mainIndex)) {
		pages.push(...parseKnowledgeIndex(readFileSync(mainIndex, "utf8"), PI_KN_DIR));
	}
	if (cwd) {
		const projDir = resolve(cwd, ".pi", "knowledge");
		const projIndex = resolve(projDir, "index.md");
		if (projDir !== PI_KN_DIR && existsSync(projIndex)) {
			pages.push(...parseKnowledgeIndex(readFileSync(projIndex, "utf8"), projDir));
		}
	}
	return pages;
}

export default function knowledgePointer(pi: ExtensionAPI) {
	/** 本会话已注过指针的页面 */
	const pointed = new Set<string>();

	pi.on("session_start", () => {
		pointed.clear();
	});

	pi.on("before_agent_start", (event, ctx) => {
		try {
			const prompt = String(event.prompt ?? "");
			// 维护知识库自身的输入不做匹配，防自触发
			if (!prompt || prompt.replace(/\\/g, "/").includes("/knowledge")) return undefined;
			const pages = loadPages(ctx.cwd);
			if (pages.length === 0) return undefined;
			const lower = prompt.toLowerCase();
			const noSpace = lower.replace(/\s+/g, "");
			const sid = sessionId(ctx);

			const lines: string[] = [];
			for (const { page, matched } of matchPages(pages, lower, noSpace, pointed).slice(0, MAX_POINTERS)) {
				pointed.add(page.file);
				const rel = page.file.replace(/\\/g, "/");
				logHit("POINTER", rel, `kw=${matched.join(",")}`, sid);
				lines.push(`- ${rel} — ${page.summary} [kw: ${matched.join(",")}]`);
			}
			if (lines.length === 0) return undefined;

			return {
				message: {
					customType: "knowledge-pointer",
					content:
						"【知识库指针】本次请求命中以下知识页（仅指针，未注正文）。若与任务相关，动手前先 read 对应文件：\n" +
						lines.join("\n"),
					display: false,
				},
			};
		} catch {
			return undefined; // 绝不因自身异常影响会话启动
		}
	});

	// 模型主动读知识文件 → READ 埋点（与 POINTER 同库，可算指针→阅读转化率）。
	// 认两类：`/knowledge/` 目录下的 .md，以及索引登记在库外的页（2026-09-28 审计 M3：某项目库 15 条里 13 条指向
	// `文档/*.md`，10 个会话读了 30+ 次却零埋点，「READ≥2」的复审触发条件结构上永不可达）。
	// extra 带 lib=<库目录>：相对路径与库外页也能归到库（stats 可解析性表按它计主动 READ）。
	pi.on("tool_result", (event, ctx) => {
		try {
			if (event.toolName !== "read") return undefined;
			const inputText = JSON.stringify(event.input ?? {}).replace(/\\\\/g, "/").replace(/\\/g, "/");
			const inKnowledgeDir = /\/knowledge\/[^"]*\.md/.test(inputText) && !inputText.includes("/knowledge/hits.log");
			const lib = readTargetLib(event.input, ctx?.cwd);
			if (inKnowledgeDir || lib) {
				logHit("READ", inputText.slice(0, 200), lib ? `manual-read lib=${lib}` : "manual-read", sessionId(ctx));
			}
		} catch {
			// 埋点失败无影响
		}
		return undefined;
	});
}
