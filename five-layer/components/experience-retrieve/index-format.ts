import { resolve } from "node:path";

/**
 * EXPERIENCE 运行索引（INDEX.md）的解析口径——扩展运行时、qika doctor「五层组件」节、测试共用这一份
 * （2026-09-30 从 index.ts 抽出：doctor 若另抄一份规则，改格式时两边漂移就是 09-28 审计 M1 的原型）。
 * 只依赖 node:path，不 import 扩展其余部分，server 侧可直接 import 本文件。
 * 格式改动须向后兼容：同事机器上的 INDEX.md 永远不会随更新改写（docs/five-layer-starter-design.md §1 约束 3）。
 */

export interface IndexEntry {
	keywords: string[];
	/** 条目正文绝对路径 */
	file: string;
	/** 来源库标签（埋点用；2026-08-12 起仅 "pi"，历史 hits.log 中存在 "claude" 前缀行） */
	source: "pi";
}

/** 可注入状态：整词 active（inactive 不算——与 knowledge-pointer PUSHABLE_STATUS 同口径，2026-09-30 修复子串误收） */
export const ACTIVE_STATUS = /\bactive\b/;

/** pi 库 INDEX：markdown 表格行 `| 关键词 | [\`x.md\`](x.md) | 现象 | active | 日期 |`，只取 active 行 */
export function parsePiIndex(text: string, baseDir: string): IndexEntry[] {
	const entries: IndexEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trimStart().startsWith("|")) continue;
		const cells = line.split("|").slice(1, -1).map((c) => c.trim());
		if (cells.length < 4) continue;
		if (/^[-: ]+$/.test(cells[0]) || cells[0] === "关键词") continue;
		if (!ACTIVE_STATUS.test(cells[3])) continue;
		const link = /\(([^)]+)\)/.exec(cells[1])?.[1] ?? /`([^`]+)`/.exec(cells[1])?.[1];
		if (!link) continue;
		const keywords = cells[0].split(/[、,，]/).map((k) => k.trim()).filter(Boolean);
		if (keywords.length === 0) continue;
		entries.push({ keywords, file: resolve(baseDir, link), source: "pi" });
	}
	return entries;
}
