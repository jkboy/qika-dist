import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	findActiveTask,
	findActiveTasks,
	loadTask,
	RECOVERY_SECTIONS,
	recoverySectionLines,
	resolveToolPath,
	type RecoverySection,
	type TaskInfo,
} from "./task-state.ts";

const STATE_TYPE = "task-continuity-state";
const CONTEXT_TYPE = "task-continuity-recovery";
const STALE_CHECKPOINT_MS = envInt("PI_TASK_CONTINUITY_STALE_MIN", 10) * 60 * 1_000;
/**
 * 读门宽限（2026-08-17 五层审计整改）：block 达到此次数仍未成功读取 task 文件
 * （文件损坏/缺节/read 反复失败）则自动降级为建议式注入——门是补下限机制
 * （防摘要漂移），但 task 文件坏掉时模型自己解不了门，用户不在场即准死端。
 * 降级后 before_agent_start 继续注入恢复消息（含降级警示），不再拦截工具。
 */
const READ_GATE_MAX_BLOCKS = envInt("PI_TASK_CONTINUITY_MAX_BLOCKS", 3);

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

type RecoveryState = {
	taskPath: string;
	compactionId?: string;
	reason: "manual" | "threshold" | "overflow";
};

type PersistedState =
	| ({ version: 1; state: "recovery-required" } & RecoveryState)
	| { version: 1; state: "recovery-cleared"; taskPath?: string; reason: string };

function normalizeToolName(name: string): string {
	return name.split(".").at(-1)?.toLowerCase() ?? name.toLowerCase();
}

type SectionLayout = Awaited<ReturnType<typeof readLayout>>;

/**
 * 恢复节在文件里的位置。大 task 文件一次 read 读不全（pi 单次 50KB/2000 行），模型会分页读；
 * 曾要求「单次读回同时含两节」，模型从头小页翻、始终够不到恢复入口，门连拦 3 次后降级
 * （2026-09-28 实测一个长期运营 task 21 次压缩里降级 3 次）——现在按并集判定，并把行号告诉模型
 */
async function readLayout(taskPath: string) {
	try {
		return recoverySectionLines(await readFile(taskPath, "utf8"));
	} catch {
		return undefined;
	}
}

function layoutLineZh(layout: SectionLayout): string | undefined {
	if (!layout || !layout["当前状态"] || !layout["恢复入口"]) return undefined;
	return `文件共 ${layout.total} 行：“当前状态”在第 ${layout["当前状态"]} 行，“恢复入口”在第 ${layout["恢复入口"]} 行；分页读取时两节都读到即可（多次 read 合并计算）。`;
}

function layoutHintEn(taskPath: string, layout: SectionLayout, seen: ReadonlySet<RecoverySection>): string {
	const missing = RECOVERY_SECTIONS.filter((section) => !seen.has(section));
	if (!layout || missing.some((section) => !layout[section])) return "";
	const first = missing[0]!;
	const parts = [
		` The file has ${layout.total} lines: "## 当前状态" starts at line ${layout["当前状态"]}, "## 恢复入口" at line ${layout["恢复入口"]}; paged reads add up.`,
	];
	if (seen.size > 0) parts.push(` Already read: ${[...seen].join(", ")}; still missing: ${missing.join(", ")} — e.g. read(path=${JSON.stringify(taskPath)}, offset=${layout[first]}, limit=40).`);
	return parts.join("");
}

function recoveryMessage(state: RecoveryState, degraded: boolean, layout?: SectionLayout): string {
	const lines = [
		"【task-continuity 压缩恢复门禁】",
		`上下文刚因 ${state.reason} 完成压缩。压缩摘要只能作线索，活动 task 才是恢复主源。`,
		`在调用任何其他工具前，必须先用 read 读取：${state.taskPath}`,
		"重点核对“当前状态”和“恢复入口”，再用文件/代码/验证事实校准下一步。",
		"如果用户明确放弃该任务，可由用户运行 /task-continuity skip。",
	];
	const where = layoutLineZh(layout);
	if (where) lines.splice(3, 0, where);
	if (degraded) {
		lines.push(
			`⚠ 门禁已降级为提醒（多次拦截后仍未成功读取该文件——可能已损坏或缺少恢复两节）。` +
				"工具不再被拦截，但请自行核实任务状态后再继续，并把文件异常告知用户。",
		);
	}
	return lines.join("\n");
}

function snapshotForSummarizer(task: TaskInfo): string {
	return [
		"[TASK CONTINUITY ANCHOR — authoritative recovery source]",
		`Task file: ${task.path}`,
		`Task status: ${task.status}`,
		"The task file outranks this summary after compaction. Preserve this path and recovery information:",
		task.recoverySnapshot,
	].join("\n");
}

function toolResultText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type: "text"; text: string } =>
			Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string"),
		)
		.map((item) => item.text)
		.join("\n");
}

function restorePersistedState(entries: readonly unknown[]): RecoveryState | undefined {
	let state: RecoveryState | undefined;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { type?: string; customType?: string; data?: PersistedState };
		if (candidate.type !== "custom" || candidate.customType !== STATE_TYPE || !candidate.data) continue;
		if (candidate.data.state === "recovery-required") {
			state = {
				taskPath: candidate.data.taskPath,
				compactionId: candidate.data.compactionId,
				reason: candidate.data.reason,
			};
		} else if (candidate.data.state === "recovery-cleared") {
			state = undefined;
		}
	}
	return state;
}

export default function taskContinuity(pi: ExtensionAPI) {
	let compactionTask: TaskInfo | undefined;
	let recovery: RecoveryState | undefined;
	/** 在途的 task read（并行多次分页读都要认） */
	const recoveryReadCallIds = new Set<string>();
	/** 本次恢复以来读回内容里已出现过的恢复节（多次分页 read 取并集） */
	const seenSections = new Set<RecoverySection>();
	/** 本次恢复门已拦截次数；达到 READ_GATE_MAX_BLOCKS 即降级（gateDegraded），纯内存不持久 */
	let blockCount = 0;
	let gateDegraded = false;

	const resetGate = () => {
		recoveryReadCallIds.clear();
		seenSections.clear();
		blockCount = 0;
		gateDegraded = false;
	};

	const persistRequired = (state: RecoveryState) => {
		pi.appendEntry<PersistedState>(STATE_TYPE, { version: 1, state: "recovery-required", ...state });
	};

	const clearRecovery = (reason: string) => {
		const taskPath = recovery?.taskPath;
		recovery = undefined;
		resetGate();
		pi.appendEntry<PersistedState>(STATE_TYPE, {
			version: 1,
			state: "recovery-cleared",
			taskPath,
			reason,
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		compactionTask = undefined;
		resetGate();
		recovery = restorePersistedState(ctx.sessionManager.getBranch());
		if (!ctx.isProjectTrusted()) {
			recovery = undefined;
			return;
		}
		if (!recovery) return;
		const task = await loadTask(recovery.taskPath);
		if (!task || task.status === "done" || !task.recoveryReady) {
			clearRecovery("task missing, done, or lacks recovery contract during session restore");
			return;
		}
		if (ctx.hasUI) ctx.ui.notify(`Task recovery pending: ${recovery.taskPath}`, "warning");
	});

	pi.on("session_before_compact", async (event, ctx) => {
		compactionTask = undefined;
		if (!ctx.isProjectTrusted()) return;
		const task = await findActiveTask(ctx.cwd);
		if (!task) return;
		compactionTask = task;

		// Pi 0.82.1 passes this same preparation object to its default summarizer.
		// The post-compaction read gate remains the authoritative fallback if a
		// future Pi version stops honoring this additional summarizer message.
		event.preparation.messagesToSummarize.push({
			role: "custom",
			customType: "task-continuity-snapshot",
			content: snapshotForSummarizer(task),
			display: false,
			timestamp: Date.now(),
		});

		const checkpointAge = Date.now() - task.mtimeMs;
		if (checkpointAge >= STALE_CHECKPOINT_MS && ctx.hasUI) {
			ctx.ui.notify(
				`Compacting with a ${Math.floor(checkpointAge / 60_000)}m-old task checkpoint: ${task.path}`,
				"warning",
			);
		}
	});

	pi.on("session_compact", async (event, ctx) => {
		if (!ctx.isProjectTrusted()) return;
		const current = compactionTask ? await loadTask(compactionTask.path) : await findActiveTask(ctx.cwd);
		compactionTask = undefined;
		if (!current || current.status === "done" || !current.recoveryReady) return;

		recovery = {
			taskPath: current.path,
			compactionId: event.compactionEntry.id,
			reason: event.reason,
		};
		resetGate();
		persistRequired(recovery);
		pi.sendMessage({
			customType: CONTEXT_TYPE,
			content: recoveryMessage(recovery, false, await readLayout(recovery.taskPath)),
			display: false,
			details: recovery,
		});
		if (ctx.hasUI) ctx.ui.notify(`Compaction complete; restore from ${current.path}`, "warning");
	});

	pi.on("before_agent_start", async () => {
		if (!recovery) return undefined;
		return {
			message: {
				customType: CONTEXT_TYPE,
				content: recoveryMessage(recovery, gateDegraded, await readLayout(recovery.taskPath)),
				display: false,
				details: recovery,
			},
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!recovery) return undefined;
		const toolName = normalizeToolName(event.toolName);
		const input = event.input as { path?: unknown };
		const path = resolveToolPath(ctx.cwd, input.path);
		if (toolName === "read" && path === recovery.taskPath) {
			recoveryReadCallIds.add(event.toolCallId);
			return undefined;
		}
		// 已降级：不再拦截，但继续追踪 read（读成功照常解门、停掉降级警示注入）
		if (gateDegraded) return undefined;
		blockCount += 1;
		const hint = layoutHintEn(recovery.taskPath, await readLayout(recovery.taskPath), seenSections);
		// 宽限降级：多次拦截仍未读成功 = 门自身可能是死端（task 文件损坏/缺节），
		// 拦下去只会与模型互锁——转建议式，恢复消息继续注入但不再拦工具
		if (blockCount >= READ_GATE_MAX_BLOCKS) {
			gateDegraded = true;
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Task recovery gate degraded to advisory after ${blockCount} blocks (task file unreadable or missing recovery sections?): ${recovery.taskPath}`,
					"warning",
				);
			}
			return {
				block: true,
				reason:
					`Context was compacted. This was the final gate block (${blockCount}/${READ_GATE_MAX_BLOCKS}) — the gate is now advisory. ` +
					`The active task file may be damaged: read(path=${JSON.stringify(recovery.taskPath)}) did not succeed with the expected sections.${hint} ` +
					"Proceed carefully, verify task state from files/code, and tell the user the task file needs repair.",
			};
		}
		return {
			block: true,
			reason: `Context was compacted. Read the active task first with read(path=${JSON.stringify(recovery.taskPath)}); then retry this tool.${hint}`,
		};
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!recovery || !recoveryReadCallIds.has(event.toolCallId)) return undefined;
		recoveryReadCallIds.delete(event.toolCallId);
		if (event.isError) {
			if (ctx.hasUI) ctx.ui.notify(`Task recovery read failed: ${recovery.taskPath}`, "error");
			return undefined;
		}
		const content = toolResultText(event.content);
		for (const section of RECOVERY_SECTIONS) if (content.includes(`## ${section}`)) seenSections.add(section);
		const missing = RECOVERY_SECTIONS.filter((section) => !seenSections.has(section));
		if (missing.length > 0) {
			if (ctx.hasUI) ctx.ui.notify(`Task recovery still needs ${missing.join(", ")} from: ${recovery.taskPath}`, "warning");
			return undefined;
		}
		const restoredPath = recovery.taskPath;
		clearRecovery("active task read successfully");
		if (ctx.hasUI) ctx.ui.notify(`Task continuity restored from ${restoredPath}`, "info");
		return undefined;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (recovery && ctx.hasUI) {
			ctx.ui.notify(`Task recovery still pending: read ${recovery.taskPath}`, "warning");
		}
	});

	pi.registerCommand("task-continuity", {
		description: "Show or explicitly clear compaction task recovery state",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "skip") {
				clearRecovery("user explicitly skipped recovery");
				if (ctx.hasUI) ctx.ui.notify("Task recovery gate cleared by user", "warning");
				return;
			}
			const activeTasks = ctx.isProjectTrusted() ? await findActiveTasks(ctx.cwd) : [];
			const message = [
				`Project trusted: ${ctx.isProjectTrusted() ? "yes" : "no"}`,
				`Active tasks: ${activeTasks.length}`,
				`Selected task: ${activeTasks[0]?.path ?? "none"}`,
				`Recovery gate: ${recovery?.taskPath ?? "clear"}`,
			].join("\n");
			if (ctx.hasUI) ctx.ui.notify(message, "info");
			else console.error(message);
		},
	});
}
