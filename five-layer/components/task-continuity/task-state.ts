import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type TaskStatus = "in_progress" | "blocked" | "done";

export interface TaskInfo {
	path: string;
	status: TaskStatus;
	mtimeMs: number;
	signature: string;
	recoverySnapshot: string;
	recoveryReady: boolean;
}

const ACTIVE_STATUSES = new Set<TaskStatus>(["in_progress", "blocked"]);
export const MAX_SNAPSHOT_CHARS = 6_000;
/**
 * 恢复入口是恢复契约本体，先保它；当前状态吃剩余预算、从头截（约定新事实写在最前）。
 * 曾整体 slice(0, 6000)：长期运营 task 的「当前状态」退化成倒序日志后独占预算，恢复入口
 * 整节被挤出摘要（2026-09-28 实测 116KB、33KB 两个长期 task 都是如此）
 */
export const ENTRY_BUDGET_CHARS = 3_000;
const CLIPPED_MARK = "\n…（已截断，完整内容读 task 文件）";

export const RECOVERY_SECTIONS = ["当前状态", "恢复入口"] as const;
export type RecoverySection = (typeof RECOVERY_SECTIONS)[number];

export function parseTaskStatus(text: string): TaskStatus | undefined {
	const match = text.match(/^(?:状态|Status)\s*[:：]\s*(in_progress|blocked|done)\b/im);
	return match?.[1]?.toLowerCase() as TaskStatus | undefined;
}

function extractSection(text: string, heading: string): string | undefined {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\s*$`, "i").test(line.trim()));
	if (start < 0) return undefined;
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index++) {
		if (/^##\s+/.test(lines[index])) {
			end = index;
			break;
		}
	}
	return lines.slice(start, end).join("\n").trim();
}

function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, Math.max(0, max - CLIPPED_MARK.length)) + CLIPPED_MARK;
}

export function extractRecoverySnapshot(text: string): string {
	const state = extractSection(text, "当前状态");
	const entry = extractSection(text, "恢复入口");
	if (!state && !entry) return text.slice(0, 2_000).trim();
	const entryPart = entry ? clip(entry, ENTRY_BUDGET_CHARS) : "";
	const stateBudget = MAX_SNAPSHOT_CHARS - entryPart.length - (entryPart ? 2 : 0);
	const statePart = state ? clip(state, stateBudget) : "";
	return [statePart, entryPart].filter(Boolean).join("\n\n");
}

/** 两个恢复节的起始行号（1 起，与 read 的 offset 同口径）与文件总行数；缺节为 undefined */
export function recoverySectionLines(text: string): { total: number } & Partial<Record<RecoverySection, number>> {
	const lines = text.split(/\r?\n/);
	const out: { total: number } & Partial<Record<RecoverySection, number>> = { total: lines.length };
	for (const heading of RECOVERY_SECTIONS) {
		const index = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\s*$`, "i").test(line.trim()));
		if (index >= 0) out[heading] = index + 1;
	}
	return out;
}

export function hasRecoveryContract(text: string): boolean {
	return Boolean(extractSection(text, "当前状态") && extractSection(text, "恢复入口"));
}

export function taskSignature(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

export async function findTaskDirectory(cwd: string): Promise<string | undefined> {
	let current = resolve(cwd);
	const home = resolve(homedir());
	while (current !== home && current !== dirname(current)) {
		const candidate = join(current, ".pi", "tasks");
		if (await isDirectory(candidate)) return candidate;
		current = dirname(current);
	}
	return undefined;
}

export async function loadTask(path: string): Promise<TaskInfo | undefined> {
	try {
		const [text, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
		const status = parseTaskStatus(text);
		if (!status) return undefined;
		return {
			path: resolve(path),
			status,
			mtimeMs: metadata.mtimeMs,
			signature: taskSignature(text),
			recoverySnapshot: extractRecoverySnapshot(text),
			recoveryReady: hasRecoveryContract(text),
		};
	} catch {
		return undefined;
	}
}

/**
 * 项目内全部活动 task（mtime 新→旧）。**只用于展示**（/task-continuity 命令的“项目里还有哪些”）：
 * 压缩时选 task 一律走 findBoundActiveTask——项目级 task 目录是同项目多会话共享的，
 * 「最新 mtime 的活动 task」在多会话/长期 blocked 的 task 面前必然选到别人的
 * （2026-10-28 实测：调研 Strata 的会话压缩时被塞进 18 小时前 blocked 的「复审ETN三季报」，
 * 摘要被污染且被强制 read 该文件；pi-web 的 todo 镜像早在 09-13 因同一原因废弃了这个启发式）
 */
export async function findActiveTasks(cwd: string): Promise<TaskInfo[]> {
	const taskDirectory = await findTaskDirectory(cwd);
	if (!taskDirectory) return [];
	const names = await readdir(taskDirectory);
	const tasks = (
		await Promise.all(
			names
				.filter((name) => name.endsWith(".md"))
				.map((name) => loadTask(join(taskDirectory, name))),
		)
	).filter((task): task is TaskInfo => Boolean(task && ACTIVE_STATUSES.has(task.status) && task.recoveryReady));
	return tasks.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

/**
 * edit/write 工具调用 → 命中 `<项目>/.pi/tasks/` 直下 `.md` 时返回其绝对路径，否则 undefined。
 * 与 pi-web 服务端 todoTaskMirror.taskFileFromToolCall 同口径（todo 镜像与压缩恢复门必须对
 * 「哪个 task 是本会话的」给出同一答案）：只认 tasks 直下一层——伴生目录、evidence manifest
 * 等非 .md 文件不算；不要求落在 cwd 之下（task 可写在别的项目）。
 */
export function taskFileFromToolCall(cwd: string, toolName: unknown, input: unknown): string | undefined {
	if (toolName !== "edit" && toolName !== "write") return undefined;
	const args = (input ?? {}) as { path?: unknown; file_path?: unknown };
	const abs = resolveToolPath(cwd, args.path ?? args.file_path);
	if (!abs || !abs.toLowerCase().endsWith(".md")) return undefined;
	const tasksDir = dirname(abs);
	if (basename(tasksDir) !== "tasks" || basename(dirname(tasksDir)) !== ".pi") return undefined;
	return abs;
}

/**
 * 本会话（分支 entries）edit/write 过的 task 文件，最近的在前、去重。
 * 绑定是内存态，靠会话文件自身还原，不新增持久化状态。取 toolCall 块（模型意图），不苛求
 * toolResult 成功。刻意**不把 read 算作绑定**：恢复门自己会强制 read task，若 read 也算绑定，
 * 一次误选会被门的强制读固化成永久绑定（自我强化）；edit/write 是“这是本会话的活”最强且
 * 不会被门自己制造的证据。代价：只 read 过、从没写过的接手型会话不被覆盖——由
 * task-continuity-state 的 recovery-skipped 条目留痕（见 index.ts）。
 */
export function sessionTaskFiles(entries: readonly unknown[], cwd: string): string[] {
	const seen = new Set<string>();
	const files: string[] = [];
	for (const call of toolCallsNewestFirst(entries)) {
		const file = taskFileFromToolCall(cwd, call.name, call.arguments);
		if (!file || seen.has(file.toLowerCase())) continue;
		seen.add(file.toLowerCase());
		files.push(file);
	}
	return files;
}

/**
 * candidates 里本会话 read 过的那些（原样返回 candidates 的写法）。用途只有一个：给“压缩时没介入”的
 * 留痕加判别字段——项目里躺着别的会话的活动 task 是常态（正常跳过），只有“跳过 + 本会话读过它”
 * 才是疑似接手型会话漏报（用户说“继续”→ 读了旧 task → 一直没 checkpoint 写它）。
 */
export function sessionReadAmong(entries: readonly unknown[], cwd: string, candidates: readonly string[]): string[] {
	const read = new Set<string>();
	for (const call of toolCallsNewestFirst(entries)) {
		if (call.name !== "read") continue;
		const args = (call.arguments ?? {}) as { path?: unknown; file_path?: unknown };
		const abs = resolveToolPath(cwd, args.path ?? args.file_path);
		if (abs) read.add(abs.toLowerCase());
	}
	return candidates.filter((candidate) => read.has(resolve(candidate).toLowerCase()));
}

function* toolCallsNewestFirst(entries: readonly unknown[]): Generator<{ name?: unknown; arguments?: unknown }> {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown } } | undefined;
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = Array.isArray(entry.message.content) ? entry.message.content : [];
		for (let j = content.length - 1; j >= 0; j--) {
			const block = content[j] as { type?: string; name?: unknown; arguments?: unknown } | undefined;
			if (block?.type === "toolCall") yield block;
		}
	}
}

/**
 * 压缩时要锚定的 task：本会话 edit/write 过、且仍是活动状态（in_progress/blocked）并带恢复契约的
 * 最近一个。本会话绑定过的最近一个已 done 时顺延到更早绑定的活动 task；没有任何绑定 → undefined，
 * 即不注入、不拦截（宁可不介入，也不把别的会话的 task 当本会话的恢复主源）。
 */
export async function findBoundActiveTask(entries: readonly unknown[], cwd: string): Promise<TaskInfo | undefined> {
	for (const file of sessionTaskFiles(entries, cwd)) {
		const task = await loadTask(file);
		if (task && ACTIVE_STATUSES.has(task.status) && task.recoveryReady) return task;
	}
	return undefined;
}

export function resolveToolPath(cwd: string, inputPath: unknown): string | undefined {
	if (typeof inputPath !== "string" || !inputPath.trim()) return undefined;
	const cleaned = inputPath.trim().replace(/^@/, "");
	return resolve(isAbsolute(cleaned) ? cleaned : join(cwd, cleaned));
}
