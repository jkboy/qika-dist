import type { PromptContextRule } from "../types";

/**
 * 每轮以系统时钟为源注入真实当前日期时间。
 * 根因：Pi system prompt 不含当前时间，模型会用训练知识截止日期推断"现在"，
 * 导致任务规划/搜索时间窗锚定错误。准入卡见 ./admission-current-date.md。
 */
export const currentDateContext: PromptContextRule = {
	id: "current-date",
	description: "每轮注入本机真实当前日期时间，防止模型用训练知识推断当前时间",
	enabled: true,
	buildContext() {
		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, "0");
		const weekday = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
		const offsetMin = -now.getTimezoneOffset();
		const sign = offsetMin >= 0 ? "+" : "-";
		const absMin = Math.abs(offsetMin);
		const tz = `UTC${sign}${Math.floor(absMin / 60)}${absMin % 60 ? `:${pad(absMin % 60)}` : ""}`;
		const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
		const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
		// 只给数据不附指令：2026-09-28 探针（deepseek-v4.1-flash，3 个时间语义 prompt × 3 次）——不注入 5/6 答成 2025，
		// 只给数据与「数据 + 以此为准」指令都是 9/9，指令无可测增益（prompt-audit 20260925 B9）
		return `当前真实时间（本机系统时钟）：${date}（周${weekday}）${time} ${tz}。`;
	},
};
