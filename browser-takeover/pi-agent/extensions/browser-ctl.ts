/**
 * browser-ctl —— 让 pi agent 能像 codex 一样操作浏览器
 *
 * 能力来源：`~/.pi/tools/browser-takeover/`（Chrome 扩展 + Native Messaging + CDP）。
 * 本 extension 只是把那条链路封装成一个 custom tool，供 LLM 调用：
 *
 *    LLM ── browser_ctl(action=...) ──▶ 本 tool ──TCP──▶ bridge:9204 ──▶ host ──▶ 扩展 ──CDP──▶ 页面
 *
 * 前置：bridge 常驻程序需在跑（`node native-host/bridge.js`），浏览器扩展需已加载。
 * 若 bridge 没起，工具会报"无法连接 bridge"，提示先启动。
 *
 * 用法（打开→快照→选目标→操作→验证 的 codex 式闭环）：
 *   browser_ctl(action=open, url=...)       → 复用已在该 URL 的标签页，否则新开；成为后续默认目标
 *   browser_ctl(action=snapshot)            → 拿可交互元素清单(e0/e1编号 + css选择器)
 *   browser_ctl(action=click, selector="e3")
 *   browser_ctl(action=fill, selector="e5", value="hello")
 *   browser_ctl(action=pressKey, key="Enter")
 *   browser_ctl(action=waitFor, options={selector:".result", state:"visible", timeout:8000})
 *   browser_ctl(action=getText, selector="#result")
 *   browser_ctl(action=screenshot)          → 返回图片给模型
 *
 * 后续步骤已知时一次发完（省掉每步一轮模型往返）：
 *   browser_ctl(action=steps, steps=[
 *     { action: "click", selector: "e3" },
 *     { action: "waitFor", options: { selector: ".result", timeout: 8000 } },
 *     { action: "getText", selector: "#result" },
 *   ])                                       → 顺序执行，任一步失败立即停，返回已完成步骤的结果 + 失败原因
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { connect } from "node:net";

const BRIDGE_HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 9204);

const SINGLE_ACTIONS = [
  // 观察
  "snapshot", "getText", "queryAll", "pageInfo", "listTabs", "active",
  // 导航/标签
  "open", "navigate", "newTab", "closeTab",
  // 受信任操作
  "click", "hover", "fill", "type", "pressKey", "scroll",
  // 等待
  "waitFor",
  // 截图
  "screenshot",
  // 底层
  "evaluate",
] as const;

const ACTIONS = [...SINGLE_ACTIONS, "steps"] as const;

const MAX_STEPS = 20;
/** 无条件 waitFor（只给 timeout）在工具侧当纯延时，不放行过长的等待 */
const MAX_PLAIN_WAIT_MS = 20000;

// 扩展侧只认 getActiveTab；工具面沿用更短的 active
const CMD_ALIAS: Record<string, string> = { active: "getActiveTab" };
// 这些 action 的目标元素扩展侧只从 options.selector 读，顶层 selector 要提升进去
const SELECTOR_IN_OPTIONS = new Set(["waitFor", "scroll", "screenshot"]);

const stepFields = {
  selector: Type.Optional(Type.String({ description: "css 选择器，或 snapshot 里的 e0/e1 编号（click/hover/fill/type/getText/queryAll/scroll/screenshot/waitFor 用）" })),
  url: Type.Optional(Type.String({ description: "目标 URL（open/navigate/newTab 用）" })),
  value: Type.Optional(Type.String({ description: "要输入的文本（fill/type 用）" })),
  key: Type.Optional(Type.String({ description: "按键名，如 Enter/Tab/Esc/ArrowUp/ArrowDown/Backspace/Delete（pressKey 用）" })),
  tabId: Type.Optional(Type.Number({ description: "目标标签页 id；缺省用受控标签页（最近 open/newTab 打开的那个），从未打开过时才用当前活动标签" })),
  expression: Type.Optional(Type.String({ description: "任意 JS 表达式（evaluate 用）" })),
  max: Type.Optional(Type.Number({ description: "queryAll 最大返回条数，默认 50" })),
  options: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "按 action 取用的选项，直接平铺（不要再包一层 action 名）：waitFor→{selector 或 fn, state:visible|hidden|removed, timeout}；scroll→{selector 或 direction:up|down, amount, to:top|bottom}；screenshot→{fullPage, selector}" })),
};

const stepSchema = Type.Object({
  action: StringEnum(SINGLE_ACTIONS as unknown as string[]),
  ...stepFields,
});
type Step = Static<typeof stepSchema>;

const browserCtlTool = defineTool({
  name: "browser_ctl",
  label: "Browser Control",
  description: "像 codex 一样操作本机浏览器：open 打开目标页（复用已在该 URL 的标签页，否则新开一个，并成为后续动作的默认目标），snapshot 读取页面可交互元素清单(e0/e1编号+css选择器)，然后 click/fill/pressKey/waitFor/screenshot 等受信任事件操作并验证。后续步骤已知时用 action=steps 一次顺序执行多步（首败即停，返回每步结果），省去逐步往返。用于需要驱动真实浏览器(如填表单、点按钮、抓页面数据、截图)的场景。",
  promptSnippet: "操作本机浏览器（open 打开目标页 / snapshot 看页面元素 / click / fill / pressKey / waitFor / screenshot；steps 一次顺序执行多步）",
  promptGuidelines: [
    "Use browser_ctl when the user asks to operate a real browser or automate a web page.",
    "To reach a page, call browser_ctl(action=open, url=...) — it reuses a tab already showing that URL, otherwise opens a new tab, and that tab becomes the default target of later actions. Do not use navigate or newTab to reach the first page.",
    "navigate only moves the tab you opened; it never touches the tab the user is looking at. To inspect the user's own tab, call action=active and pass its tabId explicitly.",
    "Always call browser_ctl(action=snapshot) first to get the interactive element list, then target elements by their e0/e1 id or css selector — do not guess selectors.",
    "When the next steps are already known (e.g. click → waitFor → getText/evaluate to verify), send them in ONE call: action=steps, steps=[{action, ...}, ...]. They run in order and stop at the first failure, returning every finished step's result and which step failed. Only split into separate calls when the next step depends on what the page shows.",
    "After an action, verify with getText/evaluate/screenshot before concluding — preferably as the last step of the same steps call.",
    "The browser window may stay minimized or behind other windows: snapshot/fill/evaluate work there, and screenshot briefly un-minimizes the window without stealing focus and re-minimizes it afterwards. Caveat: while the window is MINIMIZED the viewport is 0×0 and a trusted click lands nowhere (its result shows x/y ≤ 0) — verify the effect, and fall back to evaluate with element.click() if it did not fire. Never restore, activate, resize or focus the browser window yourself (no ShowWindow/SetForegroundWindow scripts) — if screenshot reports the page is not visible, verify with snapshot/getText instead or tell the user.",
  ],
  parameters: Type.Object({
    action: StringEnum(ACTIONS as unknown as string[]),
    ...stepFields,
    steps: Type.Optional(Type.Array(stepSchema, { description: `action=steps 时必填：按顺序执行的动作列表（每项参数与单动作相同，最多 ${MAX_STEPS} 步）。任一步失败立即停止，返回已完成步骤的结果与失败原因。` })),
  }),

  async execute(_toolCallId, params, signal) {
    if (params.action === "steps") return runSteps(params.steps, signal);
    if (!(SINGLE_ACTIONS as readonly string[]).includes(params.action)) throw new Error("未知 action: " + params.action);
    return runOne(params as Step, signal);
  },
});

type StepOutput = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; details: Record<string, unknown> };

/** 执行一个动作：参数归一 → bridge → 结果格式化。失败一律 throw（含扩展侧 ok:false）。 */
async function runOne(p: Step, signal?: AbortSignal): Promise<StepOutput> {
  const { cmd, body, options } = buildBody(p);

  // 只给 timeout 的 waitFor：模型要的是纯延时，扩展侧会报「需要 selector 或 fn」，在这里如实等一段
  if (p.action === "waitFor" && !options?.selector && !options?.fn) {
    const ms = Math.min(MAX_PLAIN_WAIT_MS, Math.max(0, Number(options?.timeout) || 1000));
    await sleep(ms, signal);
    return {
      content: [{ type: "text", text: `已纯延时 ${ms}ms（未给 selector/fn，没有等待任何页面条件）。要等元素出现请传 options={selector, state, timeout}。` }],
      details: { action: p.action, slept: ms },
    };
  }

  const msg = await bridgeRequest(cmd, body, signal);
  if (!msg.ok) throw new Error(`browser_ctl ${p.action} 失败：${msg.error || "扩展返回失败"}`);
  const r = msg.result as any;
  // 页内脚本用 {ok:false,error} 报错的形态（scroll 找不到元素等）
  if (r && typeof r === "object" && r.ok === false && typeof r.error === "string") throw new Error(`browser_ctl ${p.action} 失败：${r.error}`);

  // 截图：转成图片 content 给模型看
  if (p.action === "screenshot" && r?.dataUrl) {
    const base64 = String(r.dataUrl).replace(/^data:image\/png;base64,/, "");
    return {
      content: [
        { type: "text", text: "截图完成，见下方图片。" },
        { type: "image", data: base64, mimeType: "image/png" },
      ],
      details: { action: p.action },
    };
  }

  return {
    content: [{ type: "text", text: formatResult(p.action, r) }],
    details: { action: p.action, result: r },
  };
}

/** 顺序执行多步，首败即停；成功步骤的结果全部保留返回。 */
async function runSteps(steps: unknown, signal?: AbortSignal): Promise<StepOutput> {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error("action=steps 需要非空的 steps 数组");
  if (steps.length > MAX_STEPS) throw new Error(`steps 最多 ${MAX_STEPS} 步（收到 ${steps.length}）`);
  steps.forEach((s, i) => {
    const a = (s as Step | null)?.action;
    if (!a || !(SINGLE_ACTIONS as readonly string[]).includes(a)) throw new Error(`steps[${i}] 的 action 无效: ${String(a)}（不能嵌套 steps）`);
  });

  const list = steps as Step[];
  const content: StepOutput["content"] = [];
  const record: Array<{ action: string; ok: boolean; error?: string }> = [];
  let failedAt: number | null = null;

  for (let i = 0; i < list.length; i++) {
    if (signal?.aborted) throw new Error("browser_ctl 已取消");
    const step = list[i];
    try {
      const out = await runOne(step, signal);
      record.push({ action: step.action, ok: true });
      content.push({ type: "text", text: `#${i + 1} ${describeStep(step)} ✓` });
      content.push(...out.content);
    } catch (e) {
      if (signal?.aborted) throw e;
      const err = e instanceof Error ? e.message : String(e);
      record.push({ action: step.action, ok: false, error: err });
      failedAt = i;
      const rest = list.slice(i + 1).map((s, k) => `#${i + 2 + k} ${describeStep(s)}`);
      content.push({ type: "text", text: `#${i + 1} ${describeStep(step)} ✗ ${err}` + (rest.length ? `\n未执行：${rest.join("；")}` : "") });
      break;
    }
  }

  const done = failedAt === null ? list.length : failedAt;
  const header = failedAt === null
    ? `steps 共 ${list.length} 步，全部完成。`
    : `steps 共 ${list.length} 步，前 ${done} 步完成，第 ${failedAt + 1} 步失败已停止。`;
  return {
    content: [{ type: "text", text: header }, ...content],
    details: { action: "steps", total: list.length, executed: done, failedAt: failedAt === null ? null : failedAt + 1, steps: record },
  };
}

/** 单动作参数 → bridge 命令体。顺带纠正模型常见的两种写法偏差。 */
function buildBody(p: Step): { cmd: string; body: Record<string, unknown>; options: Record<string, any> | undefined } {
  const cmd = CMD_ALIAS[p.action] ?? p.action;
  const body: Record<string, unknown> = { cmd };
  if (p.selector !== undefined) body.selector = p.selector;
  if (p.url !== undefined) body.url = p.url;
  if (p.value !== undefined) body.value = p.value;
  if (p.key !== undefined) body.key = p.key;
  if (p.tabId !== undefined) body.tabId = p.tabId;
  if (p.expression !== undefined) body.expression = p.expression;
  if (p.max !== undefined) body.max = p.max;

  let options: Record<string, any> | undefined = p.options && typeof p.options === "object" ? { ...p.options } : undefined;
  // schema 描述被照抄成 options={waitFor:{...}} 的嵌套：拆出来
  if (options && options[p.action] && typeof options[p.action] === "object") {
    const { [p.action]: inner, ...rest } = options;
    options = { ...inner, ...rest };
  }
  if (SELECTOR_IN_OPTIONS.has(p.action) && p.selector !== undefined && options?.selector === undefined) {
    options = { ...(options ?? {}), selector: p.selector };
  }
  if (options) body.options = options;
  return { cmd, body, options };
}

function describeStep(s: Step): string {
  const arg = s.action === "open" || s.action === "navigate" || s.action === "newTab" ? s.url
    : s.action === "pressKey" ? s.key
    : s.action === "evaluate" ? (s.expression ?? "").slice(0, 60) + ((s.expression ?? "").length > 60 ? "…" : "")
    : s.selector ?? s.options?.selector ?? s.options?.fn ?? (s.options?.timeout != null ? `${s.options.timeout}ms` : undefined);
  return arg !== undefined ? `${s.action}(${arg})` : s.action;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("browser_ctl 已取消"));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error("browser_ctl 已取消")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// 通过 TCP 向 bridge 发一条命令，等待对应 id 的响应。
function bridgeRequest(cmd: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const id = Date.now() + Math.floor(Math.random() * 1e6);
    let sock: ReturnType<typeof connect> | null = null;
    let buf = "";
    let settled = false;
    // 截图多一段窗口可见性编排（bridge 侧不抢焦点地临时还原最小化窗口），超时给得更宽
    const timeoutMs = cmd === "screenshot" ? 30000 : 20000;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock?.destroy();
        // 截图超时几乎都是页面不可见（窗口最小化/被遮挡不渲染），别把锅推给 bridge，
        // 更别让模型去还原浏览器窗口（会抢走用户正在用的前台）。
        const hint = cmd === "screenshot"
          ? "页面可能不可见（浏览器窗口最小化/被遮挡时不渲染）。不要去还原或激活浏览器窗口，改用 snapshot/getText 验证结果，或告知用户"
          : "bridge/扩展可能未就绪，请确认 bridge 已启动、扩展已加载";
        reject(new Error(`browser_ctl ${cmd} 超时：${hint}`));
      }
    }, timeoutMs);

    const onAbort = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        sock?.destroy();
        reject(new Error("browser_ctl 已取消"));
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    sock = connect({ host: BRIDGE_HOST, port: BRIDGE_PORT }, () => {
      sock!.write(JSON.stringify({ ...body, id }) + "\n");
    });

    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let parsed: any;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed && parsed.id === id) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            sock!.end();
            resolve(parsed);
          }
          return;
        }
      }
    });
    sock.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`无法连接 bridge(${BRIDGE_HOST}:${BRIDGE_PORT}): ${e.message}。请先启动 bridge.js`));
      }
    });
  });
}

// 把结果格式化成文本。snapshot 精简成逐行元素清单。
function formatResult(cmd: string, r: unknown): string {
  if (r == null) return "(无返回值)";
  if ((cmd === "open" || cmd === "navigate" || cmd === "newTab") && r && typeof r === "object") {
    const t = r as { tabId?: number; url?: string; title?: string; reused?: boolean; loadStatus?: string };
    const how = cmd === "navigate" ? "已导航受控标签页" : t.reused ? "复用已打开的标签页" : "新开标签页";
    const load = t.loadStatus === "complete" ? "已加载完成" : `加载状态=${t.loadStatus ?? "unknown"}（元素未出现请用 waitFor）`;
    return `${how} tabId=${t.tabId}，${load}。\n页面: ${t.url}\n标题: ${t.title ?? ""}\n后续动作不传 tabId 即作用于该标签页。`;
  }
  if (cmd === "snapshot" && r && typeof r === "object") {
    const s = r as any;
    const lines = [
      `页面: ${s.url}`,
      `标题: ${s.title}（可交互元素 ${s.elementCount} 个）`,
    ];
    for (const e of s.elements || []) {
      const extra = [
        e.type && `type=${e.type}`,
        e.value != null && `value=${JSON.stringify(e.value)}`,
        e.placeholder && `ph=${JSON.stringify(e.placeholder)}`,
        e.disabled && "disabled",
        e.checked && "checked",
      ].filter(Boolean).join(" ");
      lines.push(`${e.id} [${e.role}] "${e.name}" ${e.tag}${extra ? ` (${extra})` : ""} css=${e.selector || "?"}`);
    }
    if (s.bodyText) lines.push(`\n正文:\n${String(s.bodyText).slice(0, 800)}${String(s.bodyText).length > 800 ? "\n..." : ""}`);
    return lines.join("\n");
  }
  try { return JSON.stringify(r, null, 2); } catch { return String(r); }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(browserCtlTool);
}
