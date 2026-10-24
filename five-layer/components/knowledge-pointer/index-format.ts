import { resolve } from "node:path";

/**
 * KNOWLEDGE 索引（knowledge/index.md）的解析口径——扩展运行时、qika doctor「五层组件」节、测试共用这一份
 * （2026-09-30 从 index.ts 抽出，理由同 experience-retrieve/index-format.ts）。只依赖 node:path。
 * 格式改动须向后兼容：同事机器上的索引永远不会随更新改写（docs/five-layer-starter-design.md §1 约束 3）。
 */

/** 可推送状态：整词 verified / active（inactive 不算——2026-09-28 审计：旧正则会误收 inactive） */
export const PUSHABLE_STATUS = /\b(?:verified|active)\b/;

export interface KnowledgePage {
	keywords: string[];
	/** 页面绝对路径 */
	file: string;
	/** 摘要列（指针正文） */
	summary: string;
}

/**
 * 解析 knowledge/index.md 表格行。列序：
 * | 页面 | 摘要 | read_when | used_by | 状态 | 更新日期 | 触发词 |
 * 只取末列为触发词的 ≥7 列行 + 状态含 verified/active 的行；
 * 旧 6 列行（无触发词）自然跳过。
 */
export function parseKnowledgeIndex(text: string, baseDir: string): KnowledgePage[] {
	const pages: KnowledgePage[] = [];
	for (const line of text.split("\n")) {
		if (!line.trimStart().startsWith("|")) continue;
		const cells = line.split("|").slice(1, -1).map((c) => c.trim());
		if (cells.length < 7) continue;
		if (/^[-: ]+$/.test(cells[0]) || cells[0] === "页面") continue;
		if (!PUSHABLE_STATUS.test(cells[4])) continue;
		const link = /\(([^)]+)\)/.exec(cells[0])?.[1] ?? /`([^`]+)`/.exec(cells[0])?.[1];
		if (!link) continue;
		const keywords = cells[6].split(/[、,，]/).map((k) => k.trim()).filter(Boolean);
		if (keywords.length === 0) continue;
		pages.push({ keywords, file: resolve(baseDir, link), summary: cells[1] });
	}
	return pages;
}
