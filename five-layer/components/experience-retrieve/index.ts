import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type IndexEntry, parsePiIndex } from "./index-format.ts";

/**
 * experience-retrieve —— EXPERIENCE 层检索推送 + 一次性减速带 + 复发升级 + 命中埋点。
 *
 * 防止的已观察失败：
 * 1. 经验条目沉淀后复发时模型不会主动查 INDEX（实证：USERPROFILE 幽灵路径坑
 *    已在库中，编写检索 hook 时仍原样踩中）。
 * 2. 注入了也不遵守（2026-08-11 H3 实证）：remote-long-task-polling 条目注入后，
 *    模型仍连续两次重走 ssh 内嵌轮询死路（exit 124 ×2）。被动注入时机在报错后，
 *    且旧版会话级去重导致"复发时刻恰好零强化"。
 *
 * 机制（三层递进）：
 * - tool_call（仅 bash）：命令输入命中未减速条目 → block 一次，reason 即条目全文
 *   （"一次性减速带"：注入时机从报错后提前到执行前）。原样重发即放行——只保证
 *   "知情后行动"，不替模型做决定，误伤代价上界 = 每条目每会话一次重发。
 *   SDK 对 blocked 调用直接合成 isError 工具结果且不再触发 tool_result 钩子
 *   （agent-loop prepareToolCall "immediate" 路径），故无自触发环；只读检索段（rg/grep/cat…）
 *   不参与匹配，见 intentInputText。但 emitToolCall
 *   不 catch 钩子异常（throw 会顶掉所有工具结果，见 v0.2.26 theme 桩事故），
 *   本 handler 必须全程自兜底。
 * - tool_result：输入/输出命中未注入条目 → 追加条目全文（原有机制）。成功结果只看输入，
 *   且撰写类输入（写文档、调研目标、向用户提问）不看，见 successInputIsIntent；
 *   已注入条目在报错结果中再命中 → 判定复发（RECUR），升级标头重新注入，
 *   并重新武装该条目的减速带（旧版此处被去重吞掉，复发时反而沉默）。
 *   重武装仅一次（n=1）：单会话每条目至多拦 2 次。2026-08-10 实测 evidence-contract
 *   条目关键词撞上同名业务功能的开发流量，90 秒内 BLOCK→RECUR→BLOCK 循环三连拦，
 *   无上限重武装会把"误伤上界=一次重发"的承诺打破。
 * - 复发判定带轮次门（turn_start 计数）：条目在第 N 轮送达（注入/block reason），
 *   只有第 N+1 轮起发出的调用报错才算复发。2026-08-10 实证：同一 assistant 消息
 *   并行两条 bash 都踩 /tmp 坑，第一条结果触发注入、第二条结果被判 RECUR——
 *   但第二条命令发出时模型根本没见过注入，"上一种做法已被证伪"完全不成立，
 *   还连带 settled 提醒误导用户升层评估无关条目。PASS 埋点同理按轮门控
 *   （同轮兄弟命令不算 resend，减速带记录保留给真正的下一轮重发）。
 *   宿主不发 turn_start 时轮次恒为 0：RECUR/PASS 静默失活，注入与减速带不受影响。
 * - agent_settled：报错热信号提醒沉淀；有复发条目时提醒按 five-layer-governance
 *   评估提升（AGENTS 层或 INDEX 加精确拦截模式）。
 *
 * 埋点：experience/hits.log（INJECT/BLOCK/RECUR/PASS/READ），时间戳为本地时间。
 * READ 另记项目库（<项目根>/.pi/experience/，条目列 proj:<项目根>/.pi/experience/<x>.md）：本扩展不向项目库
 * 推送（召回靠项目 AGENTS 路由），此前项目库零观测——2026-09-28 五层审计：hits.log 1101 条事件无一条项目路径，
 * 会话实测单个项目库被读 47 次/12 会话。
 * BLOCK 记命令指纹（cmd=），被拦条目的下一条命中命令放行时记 PASS（resend=verbatim
 * 原样重发 / rewritten 改写后重发）。由此可算：注入后复发率（RECUR/INJECT）、
 * 减速带改写率（rewritten/PASS）、疑似误伤（verbatim 重发且后续无 RECUR）。
 * 统计入口：experience/stats.mjs。
 *
 * 经验库来源：
 * - 仅主库 ~/.pi/agent/experience/（由本扩展位置反推，不依赖 HOME/USERPROFILE
 *   环境变量——本机 USERPROFILE 指向幽灵路径，见主库外部条目）
 * - 2026-08-12 起不再跨查 ~/.claude/experience/ 副库：两库各自维护各自调用
 *   （用户决策——跨库命中噪声实证：claude 库 websearch-webfetch 条目的模型名
 *   关键词被 scout 报告引用源码反复误触；且两套 INDEX 关键词卫生规则难同步）。
 */

const extensionDir = dirname(fileURLToPath(import.meta.url));
const agentDir = resolve(extensionDir, "..", "..");
/** 经验库目录：默认从扩展位置反推；PI_EXP_DIR 可覆盖（测试 fixture 库用，防依赖活数据） */
const PI_EXP_DIR = process.env.PI_EXP_DIR
	? resolve(process.env.PI_EXP_DIR)
	: resolve(agentDir, "experience");
const HITS_LOG = resolve(PI_EXP_DIR, "hits.log");

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 每次调用最多注入/拦截的条目数（2026-08-17 五层审计：校准参数环境变量化） */
const MAX_INJECT_PER_CALL = envInt("PI_EXP_MAX_INJECT_PER_CALL", 2);
/** 减速带重武装上限（RECUR 后再拦几次；0=复发不再重武装，纯注入） */
const REARM_LIMIT = envInt("PI_EXP_REARM_LIMIT", 1);
/** 单长关键词独立触发的最小长度 */
const SINGLE_KW_MIN_LEN = envInt("PI_EXP_SINGLE_KW_MIN_LEN", 8);
/** 减速带只拦即时执行且代价高的工具；edit/write 里出现关键词不等于要执行该模式 */
const BUMP_TOOLS = new Set(["bash"]);
/** 撰写类工具：输入是写给子代理/用户/视觉模型的正文，谈到关键词≠要执行该模式 */
const PROSE_INPUT_TOOLS = new Set([
	"spawn_scout",
	"spawn_researcher",
	"ask_question",
	"vision_analyze",
	"generate_image",
	"generate_video",
]);
/** write/edit 目标为文档/数据文件时按正文处理；脚本/配置仍匹配（写脚本≈即将执行） */
const PROSE_FILE_RE = /\.(md|markdown|mdx|txt|rst|adoc|html?|json|jsonl|csv)$/i;

/**
 * 成功结果的输入是否代表「要执行的操作」。报错结果不走这里（永远匹配）。
 * 2026-09-23 全量会话回放（现行 INDEX、会话去重）：非 bash/read 工具的成功输入通道共 42 次注入，
 * 写 .md/.json 文档 30、ask_question 4、spawn_researcher 3 —— 都是在写运维手册/任务记录/调研目标/提问
 * 时谈到该话题（含写经验条目自身）；写 .sh/.py 脚本 5 次，其中 2 次是写 HF 下载脚本（08-07、08-16，
 * 后者疑为 hf-download 条目的来源事故）。脚本随后以 `python x.py` 执行时命令串不含关键词、
 * 减速带拦不到，故脚本/配置保留匹配。
 */
export function successInputIsIntent(toolName: string, input: unknown): boolean {
	if (PROSE_INPUT_TOOLS.has(toolName)) return false;
	if (toolName === "write" || toolName === "edit") {
		const p = (input as { path?: unknown } | null)?.path;
		return !(typeof p === "string" && PROSE_FILE_RE.test(p));
	}
	return true;
}

/**
 * 只读检索/查看类命令：参数里出现关键词是「在找/在看这个词」，不是要执行该模式。
 * 实证 2026-09-23 巡检：`rg -n "hf_transfer|snapshot_download" skills/…`、
 * `rg -l "huggingface_hub|hf_transfer" sessions/` 两次被 hf-download 条目减速带拦下（均原样重发放行）；
 * 且 grep/rg 无匹配即 exit 1 → isError，搜过的词还会被判成 RECUR。
 */
const READONLY_CMDS = new Set([
	"rg", "grep", "egrep", "fgrep", "ag", "ls", "cat", "head", "tail", "less", "wc", "cut", "sort", "uniq",
	"tr", "column", "jq", "diff", "stat", "file", "du", "echo", "printf", "cd", "pushd", "popd", "sed", "awk",
	"test", "[", "[[", "true", "false", "read", "which", "type",
]);
const READONLY_GIT_SUBCMDS = new Set(["grep", "log", "show", "diff", "status", "blame"]);
/** 复合语句前缀词：剥掉后才是真正的命令名 */
const SHELL_PREFIX_WORDS = new Set(["while", "until", "if", "then", "do", "else", "elif", "!", "{", "time"]);

/** 按未加引号的 ; & | 换行 ( ) ` 切分 shell 命令（引号内原样保留） */
export function splitShellSegments(command: string): string[] {
	const segs: string[] = [];
	let cur = "";
	let quote: string | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			cur += ch;
			if (ch === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			cur += ch;
		} else if (ch === "\\" && i + 1 < command.length) {
			cur += ch + command[++i];
		} else if (ch === "&" && (command[i - 1] === ">" || command[i + 1] === ">")) {
			cur += ch; // 2>&1、&>/dev/null 是重定向，不是后台/与
		} else if (";&|\n()`".includes(ch)) {
			segs.push(cur);
			cur = "";
		} else {
			cur += ch;
		}
	}
	segs.push(cur);
	return segs.map((s) => s.trim()).filter(Boolean);
}

/**
 * 该段是否为只读检索/查看。保守判定，拿不准一律算执行：
 * 引号内有命令替换（`"$(…)"`、反引号）、重定向写文件（echo … > x.sh ≈ 写脚本）、find -exec/-delete、
 * sed -i 都不算只读；纯赋值段（可能随后 export）保留。
 */
export function isReadOnlySegment(seg: string): boolean {
	if (seg.includes("$(") || seg.includes("`")) return false;
	const unquoted = seg.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
	for (const m of unquoted.matchAll(/>>?\s*(\S+)/g)) {
		if (m[1] !== "/dev/null" && !m[1].startsWith("&")) return false;
	}
	const words = unquoted.split(/\s+/).filter(Boolean);
	let i = 0;
	while (i < words.length && (SHELL_PREFIX_WORDS.has(words[i]) || /^[A-Za-z_]\w*=/.test(words[i]))) i++;
	if (i >= words.length) return false; // 纯赋值（可能随后 export）/ 关键字残片：保守保留
	let name = words[i].replace(/^.*[/\\]/, "");
	if (name === "xargs") {
		i++;
		while (i < words.length && words[i].startsWith("-")) i++;
		if (i >= words.length) return false;
		name = words[i].replace(/^.*[/\\]/, "");
	}
	if (name === "git") {
		for (i++; i < words.length; i++) {
			if (words[i] === "-C" || words[i] === "-c") i++;
			else if (!words[i].startsWith("-")) return READONLY_GIT_SUBCMDS.has(words[i]);
		}
		return false;
	}
	if (name === "find") return !/(^|\s)-(exec|execdir|ok|okdir|delete)(\s|$)/.test(unquoted);
	if (name === "sed") return !/(^|\s)(-[a-zA-Z]*i|--in-place)/.test(unquoted); // sed -i 改文件≈写脚本
	return READONLY_CMDS.has(name);
}

/**
 * 匹配用的输入文本：bash 剔除只读检索段（关键词只出现在搜索模式/查看路径里不算意图），其余工具原样。
 * 含 heredoc 的命令不剔除：正文可能是远端 shell（ssh 'bash -s' <<EOF）或正在写的脚本，逐行按命令判不可靠
 * （回放实证：`for s in … Tailscale` 行被误当只读）。
 */
export function intentInputText(toolName: string, input: unknown): string {
	const command = (input as { command?: unknown } | null)?.command;
	if (toolName !== "bash" || typeof command !== "string" || command.includes("<<")) {
		return JSON.stringify(input ?? {});
	}
	const kept = splitShellSegments(command).filter((s) => !isReadOnlySegment(s));
	// 分隔用 " ; " 而非换行：JSON 把换行转义成字面 \n，其 n 会顶掉下一段首词的 ASCII 词边界
	return JSON.stringify({ ...(input as object), command: kept.join(" ; ") });
}

// INDEX 解析口径在 index-format.ts（doctor 与测试共用同一份）；这里 re-export 保持既有 import 面不变
export { ACTIVE_STATUS, type IndexEntry, parsePiIndex } from "./index-format.ts";

/** ASCII 关键词按词边界匹配（防 pi 命中 npm/pip），含 CJK 的按子串 */
export function keywordMatches(kw: string, textLower: string): boolean {
	const k = kw.toLowerCase();
	if (/[^\x00-\x7f]/.test(k)) return textLower.includes(k);
	const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (/^\d+$/.test(k)) {
		// 纯数字关键词排除 IP/版本号片段：127 不命中 127.0.0.1 / 0.127（实测 corepack
		// 条目的 kw=127 大量假命中 NO_PROXY=127.0.0.1 之类文本）
		return new RegExp(`(?<![a-z0-9])(?<!\\d\\.)${escaped}(?![a-z0-9])(?!\\.\\d)`).test(textLower);
	}
	return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(textLower);
}

/** 命令指纹（djb2 hex8）：BLOCK/PASS 埋点用，区分原样重发与改写重发 */
export function cmdFingerprint(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
	return h.toString(16).padStart(8, "0");
}

/**
 * 单长关键词的独立触发资格：≥8 字符，且不是裸字母单词/全大写常量。
 * MODULE_NOT_FOUND、ELIFECYCLE 这类通用错误码和 upstream、snapshot 这类常见
 * 英文单词会出现在大量不相关的输入/输出里（实证 2026-08-10：MODULE_NOT_FOUND
 * 单词命中把 node --test 条目注进 /tmp 路径报错，还连带假 RECUR），不具备
 * 单独注入的区分度；它们仍参与 ≥2 关键词的配对计数。带分隔符/数字/CJK 的
 * 复合关键词（rate limit、json.tool、run_in_background）才可单触发。
 */
export function singleKeywordTriggerable(kw: string): boolean {
	if (kw.length < SINGLE_KW_MIN_LEN) return false;
	if (/^[A-Za-z]+$/.test(kw)) return false; // 裸字母单词（含 CamelCase/全大写）
	if (/^[A-Z][A-Z0-9_]*$/.test(kw)) return false; // 全大写常量（错误码风格）
	return true;
}

/** 命中门槛：≥2 个关键词，或单个具备独立触发资格的长关键词 */
function meetsThreshold(matched: string[]): boolean {
	return matched.length >= 2 || (matched.length === 1 && singleKeywordTriggerable(matched[0]));
}

export function matchEntries(
	entries: IndexEntry[],
	textLower: string,
	excluded: ReadonlySet<string>,
): { entry: IndexEntry; matched: string[] }[] {
	const hits: { entry: IndexEntry; matched: string[] }[] = [];
	for (const entry of entries) {
		if (excluded.has(entry.file)) continue;
		const matched = entry.keywords.filter((k) => keywordMatches(k, textLower));
		if (meetsThreshold(matched)) {
			hits.push({ entry, matched });
		}
	}
	return hits;
}

/** 复发判定：只看"已注入"条目（matchEntries 的反面），门槛相同 */
export function matchRecurrences(
	entries: IndexEntry[],
	textLower: string,
	injected: ReadonlySet<string>,
): { entry: IndexEntry; matched: string[] }[] {
	const hits: { entry: IndexEntry; matched: string[] }[] = [];
	for (const entry of entries) {
		if (!injected.has(entry.file)) continue;
		const matched = entry.keywords.filter((k) => keywordMatches(k, textLower));
		if (meetsThreshold(matched)) {
			hits.push({ entry, matched });
		}
	}
	return hits;
}

function loadEntries(): IndexEntry[] {
	const entries: IndexEntry[] = [];
	const piIndex = resolve(PI_EXP_DIR, "INDEX.md");
	if (existsSync(piIndex)) {
		entries.push(...parsePiIndex(readFileSync(piIndex, "utf8"), PI_EXP_DIR));
	}
	return entries;
}

function logHit(kind: string, source: string, file: string, extra: string): void {
	// 评测态（skill-trigger-eval 等 pi -p 批跑）只静音埋点，注入/减速带行为不变——保真度靠行为一致，
	// /hits 靠日志干净（与 Claude 侧 experience-retrieve.py 同约定）
	if (process.env.FIVE_LAYER_EVAL) return;
	try {
		// 本地时间（旧版是 UTC，与 INDEX「最近命中」的本地日期对不上）
		const d = new Date();
		const p = (x: number) => String(x).padStart(2, "0");
		const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
		appendFileSync(HITS_LOG, `${ts}\t${kind}\t${source}:${file}\t${extra}\n`, "utf8");
	} catch {
		// 埋点失败不影响主流程
	}
}

function relEntry(entry: IndexEntry): string {
	return relative(PI_EXP_DIR, entry.file).replace(/\\/g, "/");
}

function readEntryBody(entry: IndexEntry): string | null {
	try {
		return readFileSync(entry.file, "utf8").trim();
	} catch {
		return null; // 索引指向的文件缺失（条目被移动/删除）：跳过不报错
	}
}

/**
 * 操作经验库自身（读 INDEX/条目/hits.log、审计检索）的调用不匹配，防自触发。
 * 第二支：`cd ~/.pi/agent && … experience/…` 这类相对路径写法里字面 `.pi/agent/experience`
 * 不出现（实证 2026-09-23 巡检：stat/rg experience/*.md、experience/hits.log 自触发 2 INJECT + 2 BLOCK）。
 * 要求 `experience/` 前是命令分隔符，`extensions/experience-retrieve/` 不算。
 * 第三支：实际库路径（PI_CODING_AGENT_DIR / PI_EXP_DIR 把库挪出 ~/.pi/agent 时字面串不再成立；
 * 2026-09-30 starter 随包分发前补齐）。libDir 省略时取本扩展实际使用的库目录。
 */
export function touchesExperienceLib(inputText: string, libDir: string = PI_EXP_DIR): boolean {
	const norm = inputText.replace(/\\\\/g, "/").replace(/\\/g, "/");
	if (norm.includes(".pi/agent/experience") || norm.includes(".claude/experience")) return true;
	const lib = libDir.replace(/\\/g, "/").replace(/\/+$/, "");
	if (lib && norm.toLowerCase().includes(lib.toLowerCase())) return true;
	return /\.pi\/agent(?![\w-])/.test(norm) && /(^|[\s"'`=(:;|&])experience\//.test(norm);
}

/**
 * read 目标落在某个项目经验库（<项目根>/.pi/experience/*.md）→ 返回项目根与库内相对路径，否则 null。
 * 相对路径按会话 cwd 解析；主库 ~/.pi/agent/experience 不在此列（路径段是 agent/experience）。
 */
export function projectExperienceRead(input: unknown, cwd: string | undefined): { root: string; rel: string } | null {
	const p = (input as { path?: unknown } | null)?.path;
	if (typeof p !== "string" || !p) return null;
	const abs = (isAbsolute(p) || !cwd ? p : resolve(cwd, p)).replace(/\\/g, "/");
	const marker = "/.pi/experience/";
	const i = abs.toLowerCase().lastIndexOf(marker);
	if (i <= 0) return null;
	const rel = abs.slice(i + marker.length);
	if (!/\.md$/i.test(rel)) return null;
	return { root: abs.slice(0, i), rel };
}

export default function experienceRetrieve(pi: ExtensionAPI) {
	let entries: IndexEntry[] | null = null;
	/** 条目全文已送达模型（tool_result 注入或 block reason） */
	const injected = new Set<string>();
	/** 减速带已消耗（本会话不再拦，复发时重新武装） */
	const acked = new Set<string>();
	/** 条目 → 本会话复发次数（升级标头编号 + settled 提醒依据） */
	const recurCounts = new Map<string, number>();
	/** 本轮新增复发条目（settled 提醒后清空） */
	const recentRecurs = new Set<string>();
	/** 条目 → 被减速带拦下的命令指纹与轮次（下一轮命中命令放行时打 PASS 点后清除） */
	const lastBlockedCmd = new Map<string, { fp: string; turn: number }>();
	/** 当前轮次（turn_start 递增）。同轮并行调用发出时看不到本轮才送达的条目，
	 * 复发/PASS 判定都要求"送达轮 < 当前轮"，避免把在飞调用记成复发或 resend */
	let turnCounter = 0;
	/** 条目 → 全文送达模型的轮次（注入或 block reason） */
	const deliveredTurn = new Map<string, number>();
	let errorCount = 0;

	const ensureEntries = (): IndexEntry[] => {
		if (entries === null) {
			try {
				entries = loadEntries();
			} catch {
				entries = [];
			}
		}
		return entries;
	};

	pi.on("session_start", () => {
		entries = null; // 下次使用时重读索引（新条目即时生效）
		injected.clear();
		acked.clear();
		recurCounts.clear();
		recentRecurs.clear();
		lastBlockedCmd.clear();
		turnCounter = 0;
		deliveredTurn.clear();
		errorCount = 0;
	});

	pi.on("turn_start", () => {
		turnCounter += 1;
	});

	// 一次性减速带：在执行前拦一次，把经验从"报错后的提示"变成"执行前的门"
	pi.on("tool_call", (event) => {
		try {
			if (!BUMP_TOOLS.has(event.toolName)) return undefined;
			const inputText = JSON.stringify(event.input ?? {});
			if (touchesExperienceLib(inputText)) return undefined; // 操作经验库自身不拦，防自触发
			const all = ensureEntries();
			if (all.length === 0) return undefined;
			const lower = intentInputText(event.toolName, event.input).toLowerCase();
			const fp = cmdFingerprint(inputText);

			// PASS 埋点：被拦条目的下一条命中命令即放行结果，记录重发形态（改写率/误伤率数据源）。
			// 只认 block 之后轮次发出的命令：同轮兄弟命令发出时还没见过 reason，不是 resend
			if (lastBlockedCmd.size > 0) {
				for (const { entry } of matchRecurrences(all, lower, new Set(lastBlockedCmd.keys()))) {
					const blocked = lastBlockedCmd.get(entry.file);
					if (!blocked || turnCounter <= blocked.turn) continue;
					lastBlockedCmd.delete(entry.file);
					logHit(
						"PASS",
						entry.source,
						relEntry(entry),
						`tool=${event.toolName} resend=${fp === blocked.fp ? "verbatim" : "rewritten"}`,
					);
				}
			}

			const hits = matchEntries(all, lower, acked);
			if (hits.length === 0) return undefined;

			const parts: string[] = [];
			for (const { entry, matched } of hits.slice(0, MAX_INJECT_PER_CALL)) {
				const body = readEntryBody(entry);
				if (body === null) continue;
				acked.add(entry.file);
				injected.add(entry.file); // 全文随 reason 送达，tool_result 不必重复注入
				deliveredTurn.set(entry.file, turnCounter);
				lastBlockedCmd.set(entry.file, { fp, turn: turnCounter });
				logHit("BLOCK", entry.source, relEntry(entry), `tool=${event.toolName} kw=${matched.join(",")} cmd=${fp}`);
				parts.push(`[${entry.source}:${relEntry(entry)}]（命中：${matched.join("、")}）\n${body}`);
			}
			if (parts.length === 0) return undefined;

			const reason =
				"【经验减速带】命令与已知踩坑模式吻合，本次调用未执行：\n\n" +
				parts.join("\n\n---\n\n") +
				"\n\n对照条目「结论」审视你的命令：确在重走死路 → 按结论改写后重发；确认经验不适用当前场景 → 原样重发即放行。";
			return { block: true, reason };
		} catch {
			return undefined; // 铁律：SDK 不 catch tool_call 钩子异常，throw 会顶掉所有工具结果
		}
	});

	pi.on("tool_result", (event, ctx) => {
		try {
			if (event.isError) errorCount += 1;
			const inputText = JSON.stringify(event.input ?? {});
			if (touchesExperienceLib(inputText)) {
				// 主动检索埋点；操作经验库自身的调用不做匹配，防自触发
				if (event.toolName === "read") {
					const norm = inputText.replace(/\\\\/g, "/").replace(/\\/g, "/");
					logHit("READ", "-", norm.slice(0, 200), "manual-read");
				}
				return undefined;
			}
			if (event.toolName === "read") {
				// 项目经验库：只记 READ，与主库同理不做匹配（读经验条目时文件名/正文里的词不是意图）
				const proj = projectExperienceRead(event.input, ctx?.cwd);
				if (proj) {
					logHit("READ", "proj", `${proj.root}/.pi/experience/${proj.rel}`, "manual-read");
					return undefined;
				}
			}
			// 撰写类输入（文档/调研目标/提问）成功时不匹配：它们不是即将执行的操作，见 successInputIsIntent
			if (!event.isError && !successInputIsIntent(event.toolName, event.input)) return undefined;
			const all = ensureEntries();
			if (all.length === 0) return undefined;
			// 成功结果只匹配输入：工具输出是「世界在说话」（文件内容 / 命令输出 / 子代理报告），里面的词
			// 不代表 agent 当下的意图；报错文本才是该匹配的输出。Claude 侧 387 条裁决回溯（2026-09-17）：
			// 只在输出命中的 194 次无关率 98%（USED 1），只在输入命中的 113 次无关率 77%（USED 10）。
			// pi 侧 INJECT 336/712 来自 read（正是文件内容撞词），RECUR 本就只看报错，不受影响。
			const resultText = event.isError
				? event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")
				: "";
			// 输入侧剔除只读检索段：rg/grep 无匹配 exit 1 也是 isError，搜过的词不算复发
			const textLower = `${intentInputText(event.toolName, event.input)}\n${resultText}`.toLowerCase();

			const parts: string[] = [];

			// 复发：已注入条目在报错结果中再命中 → 升级重注 + 重新武装减速带。
			// 轮次门：条目本轮才送达的不算——报错的调用发出时模型还没见过它
			// （同一 assistant 消息并行调用的后续结果），"已被证伪"不成立
			if (event.isError) {
				const recurring = matchRecurrences(all, textLower, injected).filter(
					({ entry }) => (deliveredTurn.get(entry.file) ?? turnCounter) < turnCounter,
				);
				for (const { entry, matched } of recurring.slice(0, MAX_INJECT_PER_CALL)) {
					const body = readEntryBody(entry);
					if (body === null) continue;
					const n = (recurCounts.get(entry.file) ?? 0) + 1;
					recurCounts.set(entry.file, n);
					recentRecurs.add(relEntry(entry));
					// 重新武装受 REARM_LIMIT 钳制（默认 1）：超限说明拦截+重注均未改变行为，
					// 继续拦只会与业务流量互锁（evidence-contract 误伤循环实证），
					// 交给 settled 提醒走升层评估
					if (n <= REARM_LIMIT) acked.delete(entry.file);
					deliveredTurn.set(entry.file, turnCounter); // 重注也是一次送达，下一轮起才可再判复发
					logHit("RECUR", entry.source, relEntry(entry), `tool=${event.toolName} kw=${matched.join(",")} n=${n}`);
					parts.push(
						`【复发警报 第${n}次】[${entry.source}:${relEntry(entry)}] 此条经验已注入过，本次报错仍命中它的关键词。若报错确属同一模式，说明上一种做法没有绕开它：下一步按「结论」改写，不要原样重试；若只是关键词碰巧出现、与本次报错无关，照常继续：\n${body}`,
					);
				}
			}

			// 新命中：未注入条目 → 追加全文（原有机制）
			for (const { entry, matched } of matchEntries(all, textLower, injected).slice(
				0,
				MAX_INJECT_PER_CALL,
			)) {
				const body = readEntryBody(entry);
				if (body === null) continue;
				injected.add(entry.file);
				deliveredTurn.set(entry.file, turnCounter);
				logHit("INJECT", entry.source, relEntry(entry), `tool=${event.toolName} kw=${matched.join(",")}`);
				parts.push(`[${entry.source}:${relEntry(entry)}]\n${body}`);
			}
			if (parts.length === 0) return undefined;

			const notice =
				"\n\n【经验库命中，自动注入】本次工具调用的输入/输出匹配到以往踩坑记录，先看结论再决定下一步，不要重走已知死路。条目记的是当时的环境：涉及渠道/版本/配置等环境事实的结论可能已过时，采纳前先当场复验：\n\n" +
				parts.join("\n\n---\n\n");
			return { content: [...event.content, { type: "text" as const, text: notice }] };
		} catch {
			return undefined; // 本扩展绝不因自身异常影响工具结果
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		try {
			const msgs: string[] = [];
			if (errorCount >= 2) {
				msgs.push(
					`本轮出现 ${errorCount} 次工具报错；若经试错后已跑通，考虑沉淀 EXPERIENCE（入口：five-layer-governance skill）`,
				);
			}
			if (recentRecurs.size > 0) {
				msgs.push(
					`条目注入后仍复发：${[...recentRecurs].join("、")}——按 five-layer-governance 评估提升（AGENTS 层或 INDEX 加拦截模式）`,
				);
			}
			if (msgs.length > 0 && ctx.hasUI) {
				ctx.ui.notify(msgs.join("；"), "info");
			}
			errorCount = 0;
			recentRecurs.clear();
		} catch {
			// 提醒失败无影响
		}
	});
}
