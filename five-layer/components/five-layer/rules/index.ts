import type { PromptContextRule, SettledReminderRule, ToolCallRule } from "../types";
import { currentDateContext } from "./current-date.ts";
import { duplicateSearchGate } from "./duplicate-search.ts";
import { evidenceResearchContext, evidenceSettledAudit } from "./evidence-honesty.ts";

// 显式 registry；新规则必须先完成 README.md 中的准入卡与正反例验证。
// evidence-honesty 准入卡见 ./admission-evidence-honesty.md；current-date 见 ./admission-current-date.md；
// duplicate-search 见 ./admission-duplicate-search.md（2026-09-28 退役：enabled:false，保留注册便于恢复）。
export const toolCallRules: ToolCallRule[] = [duplicateSearchGate];
export const promptContextRules: PromptContextRule[] = [evidenceResearchContext, currentDateContext];
export const settledReminderRules: SettledReminderRule[] = [evidenceSettledAudit];
