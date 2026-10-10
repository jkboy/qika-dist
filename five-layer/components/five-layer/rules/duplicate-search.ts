import type { ToolCallRule } from "../types";

/**
 * duplicate-search-gate —— 重复搜索一次性减速带。
 *
 * 防止的已观察失败：长调研会话对同一 query 反复 web_search，烧预算不产生新信息
 * （机制来源：开源项目 FrontierAgent 的 DuplicateQueryRollbackObserver 降级转化；
 * 准入依据自含于 ./admission-duplicate-search.md）。
 *
 * 机制（沿用 experience-retrieve 的"一次性减速带"哲学：只保证知情后行动，
 * 不替模型做决定）：
 * - 首次 query：记录，放行。
 * - 重复且减速带武装中：block 一次，reason 指导改写或复用上文结果；解除武装。
 * - 解除武装后原样重发：放行（知情选择，如上次抓取失败需重试），并重新武装
 *   ——第三次原样重复仍会被拦，循环搜索的模型每两次烧一次。
 * - 误伤上界 = 每个重复 query 一次额外往返（block reason 即说明书）。
 *
 * 为何 block 而非 warn：dispatcher 的 warn 只走 ctx.ui.notify（用户可见、
 * 模型不可见），防不了"模型重复搜索"这个失败模式；block 的 reason 会被 SDK
 * 合成为 isError 工具结果送达模型，等价于 FrontierAgent 的 skip_with_result。
 * 误判面被「字节级同 query（归一化后）+ 原样重发即放行」压到极低，符合
 * FIVE-LAYER 对 block 的"高损失、低误判、恢复路径清晰"要求。
 *
 * 已知限制：
 * - tool_call 钩子看不到结果成败，首搜失败后的原样重试也会被拦一次（reason
 *   已写明放行路径，代价一次往返）。
 * - 状态在模块级，由 dispatcher 在 session_start 调 reset() 清理；同进程并行
 *   会话共享状态的行为未验证（与规则注册表的模块单例模型一致）。
 */

const SEARCH_TOOLS = new Set(["web_search"]);

/** query 归一化：小写、trim、连续空白折叠为单空格 */
export function normalizeQuery(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const q = raw.trim().toLowerCase().replace(/\s+/g, " ");
	return q.length > 0 ? q : undefined;
}

interface GateState {
	count: number;
	armed: boolean;
}

/** query → 减速带状态；测试可经 duplicateSearchGate.reset() 清理 */
const seen = new Map<string, GateState>();

export const duplicateSearchGate: ToolCallRule = {
	id: "duplicate-search-gate",
	description: "同一 query 本会话重复 web_search 时拦一次并指导改写；原样重发即放行",
	// 2026-09-28 退役（保留注册与测试，改回 true 即恢复）：理由与恢复条件见 ./admission-duplicate-search.md「退役」节
	enabled: false,
	mode: "block",
	onError: "allow",
	reset() {
		seen.clear();
	},
	check({ toolName, input }) {
		try {
			const tool = toolName.split(".").at(-1) ?? toolName;
			if (!SEARCH_TOOLS.has(tool)) return undefined;
			const query = normalizeQuery((input as { query?: unknown })?.query);
			if (!query) return undefined;
			const state = seen.get(query);
			if (!state) {
				seen.set(query, { count: 1, armed: true });
				return undefined;
			}
			state.count += 1;
			if (!state.armed) {
				state.armed = true; // 知情重发放行；再次重复仍会拦
				return undefined;
			}
			state.armed = false;
			return (
				`该 query 本会话已搜索过 ${state.count - 1} 次（"${query.slice(0, 120)}"），本次调用未执行。` +
				"重复检索通常不产生新信息：优先复用上文已有结果；需要新信息就改写 query（加限定词、换角度、换语言）。" +
				"确需原样重搜（上次结果确实失败/需要刷新）→ 原样重发即放行。"
			);
		} catch {
			return undefined; // 规则自身异常绝不拦截正常调用
		}
	},
};
