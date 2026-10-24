import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

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

export async function findActiveTask(cwd: string): Promise<TaskInfo | undefined> {
	return (await findActiveTasks(cwd))[0];
}

export function resolveToolPath(cwd: string, inputPath: unknown): string | undefined {
	if (typeof inputPath !== "string" || !inputPath.trim()) return undefined;
	const cleaned = inputPath.trim().replace(/^@/, "");
	return resolve(isAbsolute(cleaned) ? cleaned : join(cwd, cleaned));
}
