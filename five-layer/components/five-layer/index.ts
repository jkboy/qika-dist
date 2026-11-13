import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { promptContextRules, settledReminderRules, toolCallRules } from "./rules";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const agentDir = resolve(extensionDir, "..", "..");

/**
 * PI_FIVE_LAYER_DISABLE=规则id,…：不改机制文件就能关掉某条规则（2026-09-30 starter：同事改 rules/ 会让整个
 * five-layer 组件被判「改过」、从此收不到上游修复，关规则必须有文件之外的开关）。每个事件现读，改了新会话生效。
 */
function disabledIds(): Set<string> {
	return new Set((process.env.PI_FIVE_LAYER_DISABLE ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

function enabled<T extends { id: string; enabled?: boolean }>(rules: T[]): T[] {
	const off = disabledIds();
	return rules.filter((rule) => rule.enabled !== false && !off.has(rule.id));
}

function duplicateIds(): string[] {
	const ids = [...toolCallRules, ...promptContextRules, ...settledReminderRules].map((rule) => rule.id);
	return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
}

export default function fiveLayerHooks(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		// 有状态规则清理跨会话状态（如 duplicate-search-gate 的已见 query 集）
		for (const rule of toolCallRules) {
			try {
				rule.reset?.();
			} catch {
				// reset 失败不阻断会话；规则自身按 onError 策略兜底
			}
		}
		const duplicates = duplicateIds();
		if (duplicates.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`Five-layer hook IDs duplicated: ${duplicates.join(", ")}`, "error");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const additions: string[] = [];
		for (const rule of enabled(promptContextRules)) {
			try {
				const addition = await rule.buildContext({ prompt: event.prompt, cwd: ctx.cwd });
				if (addition) additions.push(`[${rule.id}] ${addition}`);
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`Five-layer prompt rule ${rule.id} failed: ${String(error)}`, "warning");
			}
		}
		if (additions.length === 0) return undefined;
		return {
			message: {
				customType: "five-layer-hook-context",
				content: additions.join("\n"),
				display: false,
			},
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		for (const rule of enabled(toolCallRules)) {
			try {
				const reason = await rule.check({
					toolName: event.toolName,
					input: event.input as Record<string, unknown>,
					cwd: ctx.cwd,
				});
				if (!reason) continue;
				if (rule.mode === "block") return { block: true, reason: `[${rule.id}] ${reason}` };
				if (ctx.hasUI) ctx.ui.notify(`[${rule.id}] ${reason}`, "warning");
			} catch (error) {
				const reason = `[${rule.id}] hook failed: ${String(error)}`;
				if (rule.onError === "block") return { block: true, reason };
				if (ctx.hasUI) ctx.ui.notify(reason, "warning");
			}
		}
		return undefined;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		for (const rule of enabled(settledReminderRules)) {
			try {
				const reminder = await rule.check({
					cwd: ctx.cwd,
					sessionFile: ctx.sessionManager.getSessionFile(),
				});
				if (reminder && ctx.hasUI) ctx.ui.notify(`[${rule.id}] ${reminder}`, "warning");
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`Five-layer reminder ${rule.id} failed: ${String(error)}`, "warning");
			}
		}
	});

	pi.registerCommand("five-layer", {
		description: "Show Pi five-layer framework status and entry paths",
		handler: async (_args, ctx) => {
			const agentsPath = resolve(agentDir, "AGENTS.md");
			const governanceSkillPath = resolve(agentDir, "skills/five-layer-governance/SKILL.md");
			const promptOptions = ctx.getSystemPromptOptions();
			const contextPaths = promptOptions.contextFiles?.map((file) => resolve(file.path)) ?? [];
			const skillPaths = promptOptions.skills?.map((skill) => resolve(skill.filePath)) ?? [];
			const taskContinuityLoaded = pi.getCommands().some(
				(command) => command.name === "task-continuity" && command.source === "extension",
			);
			const status = [
				`AGENTS: ${contextPaths.includes(agentsPath) ? "loaded" : "not loaded"} (${agentsPath})`,
				`Architecture: ${resolve(agentDir, "FIVE-LAYER.md")}`,
				`SKILL: ${skillPaths.includes(governanceSkillPath) ? "loaded" : "not loaded"} (${governanceSkillPath})`,
				`KNOWLEDGE: ${resolve(agentDir, "knowledge/index.md")}`,
				`EXPERIENCE: ${resolve(agentDir, "experience/INDEX.md")}`,
				`Five-layer registry rules: tool=${enabled(toolCallRules).length}, prompt=${enabled(promptContextRules).length}, settled=${enabled(settledReminderRules).length}`,
				`Disabled by PI_FIVE_LAYER_DISABLE: ${[...disabledIds()].join(", ") || "none"}`,
				`Task continuity hook: ${taskContinuityLoaded ? "loaded" : "not loaded"}`,
				`HOOK duplicate IDs: ${duplicateIds().length}`,
			].join("\n");
			if (ctx.hasUI) ctx.ui.notify(status, "info");
			else console.error(status);
		},
	});
}
