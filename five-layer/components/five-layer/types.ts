export type HookMode = "warn" | "block";
export type HookErrorPolicy = "allow" | "block";

export interface ToolCallSignal {
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
}

export interface ToolCallRule {
	id: string;
	description: string;
	enabled?: boolean;
	mode: HookMode;
	onError?: HookErrorPolicy;
	check(signal: ToolCallSignal): string | undefined | Promise<string | undefined>;
	/** 有状态规则必须实现：dispatcher 在 session_start 调用，清理跨会话状态 */
	reset?(): void;
}

export interface PromptSignal {
	prompt: string;
	cwd: string;
}

export interface PromptContextRule {
	id: string;
	description: string;
	enabled?: boolean;
	buildContext(signal: PromptSignal): string | undefined | Promise<string | undefined>;
}

export interface SettledSignal {
	cwd: string;
	sessionFile?: string;
}

export interface SettledReminderRule {
	id: string;
	description: string;
	enabled?: boolean;
	check(signal: SettledSignal): string | undefined | Promise<string | undefined>;
}
