#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CLAIM_STATUSES = new Set([
  "verified",
  "supported",
  "unknown",
  "conflicted",
  "refuted",
]);
const CLAIM_KINDS = new Set([
  "positive",
  "negative",
  "comparison",
  "recommendation",
]);
const DECISION_STATUSES = new Set(["publishable", "provisional", "blocked"]);
const ENTITY_STATUSES = new Set(["verified", "unknown", "conflicted", "refuted"]);
const REVIEW_STATUSES = new Set(["pass", "fail"]);
const STANCES = new Set(["supports", "refutes", "context"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getPath(object, dottedPath) {
  return dottedPath.split(".").reduce((value, key) => {
    return isObject(value) ? value[key] : undefined;
  }, object);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validDate(value) {
  if (!nonEmptyString(value)) return false;
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function dateValue(value) {
  return validDate(value) ? Date.parse(value) : null;
}

function validHttpUrl(value) {
  if (!nonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function indexById(items, label, errors) {
  const index = new Map();
  if (!Array.isArray(items)) {
    errors.push(`${label} must be an array`);
    return index;
  }

  for (const [position, item] of items.entries()) {
    if (!isObject(item)) {
      errors.push(`${label}[${position}] must be an object`);
      continue;
    }
    if (!nonEmptyString(item.id)) {
      errors.push(`${label}[${position}].id must be a non-empty string`);
      continue;
    }
    if (index.has(item.id)) {
      errors.push(`${label} contains duplicate id ${item.id}`);
      continue;
    }
    index.set(item.id, item);
  }
  return index;
}

function dependencyClosure(rootIds, claims, errors) {
  const closure = new Set();
  const visiting = new Set();
  const visited = new Set();

  function visit(id, path) {
    if (visiting.has(id)) {
      errors.push(`claim dependency cycle: ${[...path, id].join(" -> ")}`);
      return;
    }
    if (visited.has(id)) return;

    const claim = claims.get(id);
    if (!claim) {
      errors.push(`decision or dependency references unknown claim ${id}`);
      return;
    }

    visiting.add(id);
    closure.add(id);
    for (const dependencyId of Array.isArray(claim.depends_on)
      ? claim.depends_on
      : []) {
      visit(dependencyId, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const rootId of rootIds) visit(rootId, []);
  return closure;
}

function supportingEvidence(claim, evidence) {
  const result = [];
  for (const evidenceId of Array.isArray(claim.evidence_ids)
    ? claim.evidence_ids
    : []) {
    const record = evidence.get(evidenceId);
    if (!record || !Array.isArray(record.claim_links)) continue;
    if (
      record.claim_links.some(
        (link) => link.claim_id === claim.id && link.stance === "supports",
      )
    ) {
      result.push(record);
    }
  }
  return result;
}

function validateManifest(manifest) {
  const errors = [];
  const warnings = [];

  if (!isObject(manifest)) {
    return { valid: false, errors: ["manifest must be an object"], warnings };
  }

  if (manifest.schema_version !== "1.0") {
    errors.push('schema_version must be "1.0"');
  }

  if (!isObject(manifest.task)) {
    errors.push("task must be an object");
  } else {
    if (!nonEmptyString(manifest.task.question)) {
      errors.push("task.question must be a non-empty string");
    }
    if (!validDate(manifest.task.as_of)) {
      errors.push("task.as_of must be an ISO date");
    }
    if (!new Set(["standard", "strict"]).has(manifest.task.risk)) {
      errors.push('task.risk must be "standard" or "strict"');
    }
  }

  const entities = indexById(manifest.entities, "entities", errors);
  const claims = indexById(manifest.claims, "claims", errors);
  const evidence = indexById(manifest.evidence, "evidence", errors);
  const relations = indexById(manifest.relations, "relations", errors);
  const reviews = indexById(manifest.reviews, "reviews", errors);

  if (entities.size === 0) errors.push("entities must not be empty");
  if (claims.size === 0) errors.push("claims must not be empty");
  if (evidence.size === 0) errors.push("evidence must not be empty");

  for (const entity of entities.values()) {
    if (!nonEmptyString(entity.name)) {
      errors.push(`entity ${entity.id} must have a name`);
    }
    if (!ENTITY_STATUSES.has(entity.status)) {
      errors.push(`entity ${entity.id} has invalid status ${entity.status}`);
    }
    if (!isObject(entity.identity)) {
      errors.push(`entity ${entity.id}.identity must be an object`);
    }
    if (!Array.isArray(entity.required_identity_fields)) {
      errors.push(`entity ${entity.id}.required_identity_fields must be an array`);
    } else {
      for (const field of entity.required_identity_fields) {
        if (!nonEmptyString(field)) {
          errors.push(`entity ${entity.id} has an invalid required identity field`);
        } else if (!nonEmptyString(getPath(entity.identity, field))) {
          errors.push(`entity ${entity.id} is missing identity.${field}`);
        }
      }
    }
    if (!Array.isArray(entity.evidence_ids)) {
      errors.push(`entity ${entity.id}.evidence_ids must be an array`);
    } else {
      if (entity.status === "verified" && entity.evidence_ids.length === 0) {
        errors.push(`verified entity ${entity.id} needs identity evidence`);
      }
      for (const evidenceId of entity.evidence_ids) {
        if (!evidence.has(evidenceId)) {
          errors.push(`entity ${entity.id} references unknown evidence ${evidenceId}`);
        }
      }
    }
    for (const field of ["release_date", "created_at"]) {
      const value = entity.identity?.[field];
      if (value !== undefined && !validDate(value)) {
        errors.push(`entity ${entity.id}.identity.${field} must be an ISO date`);
      }
    }
  }

  for (const record of evidence.values()) {
    // 三种合法取证形态：
    // 1. url                    —— 直接抓取的来源，必须是裸 URL（备注写 locator）
    // 2. url + retrieved_via    —— 内容经另一 URL 转运获得（如 codeload 拿 github 文件）
    // 3. local_command (+可选url) —— 本地执行取证（跑测试/读本地文件），url 仅作规范引用
    const hasLocalCommand = record.local_command !== undefined;
    if (hasLocalCommand && !nonEmptyString(record.local_command)) {
      errors.push(`evidence ${record.id}.local_command must be a non-empty string when set`);
    }
    // local_command 必须是逐字执行过的命令，不是概述。概述在收尾交叉核验时必然
    // 匹配失败（实测事故：登记"python -c json.load 解析 *.json 提取节点"）。
    // 确定性信号：按空白切 token 后出现"纯 CJK token"= 散文词（中文路径粘在
    // / 或引号里不会形成纯 CJK token；grep 中文 pattern 加引号即可通过）。
    if (hasLocalCommand && nonEmptyString(record.local_command)) {
      const proseTokens = record.local_command
        .split(/\s+/)
        .filter((token) => /^[㐀-鿿豈-﫿]+$/.test(token));
      if (proseTokens.length > 0) {
        errors.push(
          `evidence ${record.id}.local_command looks like prose, not a verbatim executed command ` +
            `(standalone CJK tokens: ${proseTokens.slice(0, 3).join(" ")}); ` +
            `paste the command exactly as executed (quote CJK patterns, e.g. grep '错误' file)`,
        );
      }
    }
    if (record.url === undefined) {
      if (!hasLocalCommand) {
        errors.push(`evidence ${record.id} needs a url or a local_command`);
      }
    } else if (!validHttpUrl(record.url)) {
      errors.push(`evidence ${record.id}.url must be an HTTP(S) URL`);
    } else if (/\s/.test(record.url)) {
      errors.push(
        `evidence ${record.id}.url must be a bare URL without spaces or notes (put notes in locator)`,
      );
    }
    if (record.retrieved_via !== undefined) {
      if (!validHttpUrl(record.retrieved_via) || /\s/.test(record.retrieved_via)) {
        errors.push(`evidence ${record.id}.retrieved_via must be a bare HTTP(S) URL`);
      }
    }
    // session_file：取证发生的会话 jsonl 路径（出处会话）。由收尾审计核验通过后
    // 盖章写入，不由作者手填；交叉核验对带此字段的条目改查其出处会话。
    if (record.session_file !== undefined && !nonEmptyString(record.session_file)) {
      errors.push(`evidence ${record.id}.session_file must be a non-empty string when set`);
    }
    if (!nonEmptyString(record.source_type)) {
      errors.push(`evidence ${record.id}.source_type must be non-empty`);
    }
    if (!nonEmptyString(record.lineage_group)) {
      errors.push(`evidence ${record.id}.lineage_group must be non-empty`);
    }
    if (!validDate(record.retrieved_at)) {
      errors.push(`evidence ${record.id}.retrieved_at must be an ISO date`);
    }
    if (!Array.isArray(record.claim_links) || record.claim_links.length === 0) {
      errors.push(`evidence ${record.id}.claim_links must not be empty`);
    } else {
      for (const link of record.claim_links) {
        if (!isObject(link)) {
          errors.push(`evidence ${record.id} has an invalid claim_link`);
          continue;
        }
        const linkedClaim = claims.get(link.claim_id);
        if (!linkedClaim) {
          errors.push(`evidence ${record.id} links to an unknown claim`);
          continue;
        }
        if (!STANCES.has(link.stance)) {
          errors.push(`evidence ${record.id} has invalid stance ${link.stance}`);
        }
        if (
          !Array.isArray(linkedClaim.evidence_ids) ||
          !linkedClaim.evidence_ids.includes(record.id)
        ) {
          errors.push(
            `evidence ${record.id} links to claim ${link.claim_id} without an evidence_id backlink`,
          );
        }
      }
    }
    if (!isObject(record.scope)) {
      errors.push(`evidence ${record.id}.scope must be an object`);
    }
    if (!nonEmptyString(record.locator)) {
      errors.push(`evidence ${record.id}.locator must be non-empty`);
    }
    if (!nonEmptyString(record.excerpt_or_digest)) {
      errors.push(`evidence ${record.id}.excerpt_or_digest must be non-empty`);
    }
    if (!nonEmptyString(record.immutable_ref)) {
      warnings.push(`evidence ${record.id} has no immutable_ref`);
    }
  }

  for (const claim of claims.values()) {
    if (!nonEmptyString(claim.text)) {
      errors.push(`claim ${claim.id}.text must be non-empty`);
    }
    if (!CLAIM_KINDS.has(claim.kind)) {
      errors.push(`claim ${claim.id} has invalid kind ${claim.kind}`);
    }
    if (!CLAIM_STATUSES.has(claim.status)) {
      errors.push(`claim ${claim.id} has invalid status ${claim.status}`);
    }
    if (typeof claim.critical !== "boolean") {
      errors.push(`claim ${claim.id}.critical must be boolean`);
    }
    if (!Array.isArray(claim.entity_ids) || claim.entity_ids.length === 0) {
      errors.push(`claim ${claim.id}.entity_ids must not be empty`);
    } else {
      for (const entityId of claim.entity_ids) {
        if (!entities.has(entityId)) {
          errors.push(`claim ${claim.id} references unknown entity ${entityId}`);
        }
      }
    }
    if (!Array.isArray(claim.depends_on)) {
      errors.push(`claim ${claim.id}.depends_on must be an array`);
    } else {
      for (const dependencyId of claim.depends_on) {
        if (!claims.has(dependencyId)) {
          errors.push(`claim ${claim.id} depends on unknown claim ${dependencyId}`);
        }
        if (dependencyId === claim.id) {
          errors.push(`claim ${claim.id} cannot depend on itself`);
        }
      }
    }
    if (!Array.isArray(claim.evidence_ids) || claim.evidence_ids.length === 0) {
      errors.push(`claim ${claim.id}.evidence_ids must not be empty`);
    } else {
      for (const evidenceId of claim.evidence_ids) {
        const record = evidence.get(evidenceId);
        if (!record) {
          errors.push(`claim ${claim.id} references unknown evidence ${evidenceId}`);
          continue;
        }
        const backLink = Array.isArray(record.claim_links)
          ? record.claim_links.some((link) => link.claim_id === claim.id)
          : false;
        if (!backLink) {
          errors.push(
            `claim ${claim.id} references evidence ${evidenceId} without a claim_link`,
          );
        }
      }
    }
    if (
      !Number.isInteger(claim.min_independent_lineages) ||
      claim.min_independent_lineages < 1
    ) {
      errors.push(`claim ${claim.id}.min_independent_lineages must be >= 1`);
    }

    if (claim.status === "verified" || claim.status === "supported") {
      const supporting = supportingEvidence(claim, evidence);
      if (supporting.length === 0) {
        errors.push(`claim ${claim.id} has no supporting evidence`);
      } else {
        const lineages = new Set(supporting.map((item) => item.lineage_group));
        if (lineages.size < claim.min_independent_lineages) {
          errors.push(
            `claim ${claim.id} needs ${claim.min_independent_lineages} independent lineages but has ${lineages.size}`,
          );
        }
      }
    }
  }

  dependencyClosure([...claims.keys()], claims, errors);

  for (const relation of relations.values()) {
    if (!nonEmptyString(relation.type)) {
      errors.push(`relation ${relation.id}.type must be non-empty`);
    }
    const from = entities.get(relation.from_entity_id);
    const to = entities.get(relation.to_entity_id);
    if (!from) errors.push(`relation ${relation.id} has unknown from_entity_id`);
    if (!to) errors.push(`relation ${relation.id} has unknown to_entity_id`);
    const temporalRelation = [
      "derived_from",
      "retargeted_from",
      "supersedes",
    ].includes(relation.type);
    if (temporalRelation) {
      if (!validDate(relation.effective_date)) {
        errors.push(`relation ${relation.id}.effective_date must be an ISO date`);
      }
    } else if (
      relation.effective_date !== undefined &&
      !validDate(relation.effective_date)
    ) {
      errors.push(`relation ${relation.id}.effective_date must be an ISO date when set`);
    }
    if (!Array.isArray(relation.evidence_ids) || relation.evidence_ids.length === 0) {
      errors.push(`relation ${relation.id}.evidence_ids must not be empty`);
    } else {
      for (const evidenceId of relation.evidence_ids) {
        if (!evidence.has(evidenceId)) {
          errors.push(`relation ${relation.id} references unknown evidence ${evidenceId}`);
        }
      }
    }

    if (from && to && temporalRelation) {
      const baseDate = dateValue(to.identity?.release_date);
      const effectiveDate = dateValue(relation.effective_date);
      if (baseDate !== null && effectiveDate !== null && effectiveDate < baseDate) {
        errors.push(
          `relation ${relation.id} is effective before target ${to.id} was released`,
        );
      }
      const createdDate = dateValue(from.identity?.created_at);
      if (
        createdDate !== null &&
        baseDate !== null &&
        createdDate < baseDate &&
        effectiveDate === null
      ) {
        errors.push(
          `relation ${relation.id} needs an evidenced effective_date because ${from.id} predates ${to.id}`,
        );
      }
    }
  }

  const negativeSearches = Array.isArray(manifest.negative_searches)
    ? manifest.negative_searches
    : [];
  if (!Array.isArray(manifest.negative_searches)) {
    errors.push("negative_searches must be an array");
  }
  const negativeSearchClaims = new Set();
  for (const [position, search] of negativeSearches.entries()) {
    if (!isObject(search) || !claims.has(search.claim_id)) {
      errors.push(`negative_searches[${position}] references an unknown claim`);
      continue;
    }
    if (claims.get(search.claim_id).kind !== "negative") {
      errors.push(`negative search for ${search.claim_id} targets a non-negative claim`);
    }
    negativeSearchClaims.add(search.claim_id);
    if (!nonEmptyString(search.scope)) {
      errors.push(`negative search for ${search.claim_id} needs a scope`);
    }
    if (!Array.isArray(search.queries) || search.queries.length === 0) {
      errors.push(`negative search for ${search.claim_id} needs queries`);
    }
    if (!Array.isArray(search.sources_checked) || search.sources_checked.length === 0) {
      errors.push(`negative search for ${search.claim_id} needs sources_checked`);
    }
    if (!nonEmptyString(search.limitations)) {
      errors.push(`negative search for ${search.claim_id} needs limitations`);
    }
  }

  for (const review of reviews.values()) {
    if (typeof review.independent !== "boolean") {
      errors.push(`review ${review.id}.independent must be boolean`);
    }
    if (!REVIEW_STATUSES.has(review.status)) {
      errors.push(`review ${review.id} has invalid status ${review.status}`);
    }
    if (!Array.isArray(review.claim_ids) || review.claim_ids.length === 0) {
      errors.push(`review ${review.id}.claim_ids must not be empty`);
    } else {
      for (const claimId of review.claim_ids) {
        if (!claims.has(claimId)) {
          errors.push(`review ${review.id} references unknown claim ${claimId}`);
        }
      }
    }
    if (!nonEmptyString(review.reviewer)) {
      errors.push(`review ${review.id}.reviewer must be non-empty`);
    }
    if (!nonEmptyString(review.notes)) {
      errors.push(`review ${review.id}.notes must be non-empty`);
    }
  }

  if (!isObject(manifest.decision)) {
    errors.push("decision must be an object");
  } else {
    const decision = manifest.decision;
    if (!DECISION_STATUSES.has(decision.status)) {
      errors.push(`decision has invalid status ${decision.status}`);
    }
    if (!Array.isArray(decision.critical_claim_ids) || decision.critical_claim_ids.length === 0) {
      errors.push("decision.critical_claim_ids must not be empty");
    }
    if (!nonEmptyString(decision.summary)) {
      errors.push("decision.summary must be non-empty");
    }

    const rootIds = Array.isArray(decision.critical_claim_ids)
      ? decision.critical_claim_ids
      : [];
    for (const claimId of rootIds) {
      const claim = claims.get(claimId);
      if (claim && claim.critical !== true) {
        errors.push(`decision root ${claimId} must be marked critical`);
      }
    }
    const closure = dependencyClosure(rootIds, claims, errors);

    if (decision.status === "publishable") {
      for (const claimId of closure) {
        const claim = claims.get(claimId);
        if (!claim) continue;
        if (!new Set(["verified", "supported"]).has(claim.status)) {
          errors.push(
            `publishable decision depends on ${claimId} with status ${claim.status}`,
          );
        }
        for (const entityId of Array.isArray(claim.entity_ids)
          ? claim.entity_ids
          : []) {
          const entity = entities.get(entityId);
          if (entity && entity.status !== "verified") {
            errors.push(
              `publishable decision depends on entity ${entityId} with status ${entity.status}`,
            );
          }
        }
        if (claim.kind === "negative" && !negativeSearchClaims.has(claimId)) {
          errors.push(`publishable negative claim ${claimId} needs a negative search`);
        }
      }

      if (manifest.task?.risk === "strict") {
        const reviewed = new Set();
        for (const review of reviews.values()) {
          if (review.independent === true && review.status === "pass") {
            for (const claimId of review.claim_ids ?? []) reviewed.add(claimId);
          }
        }
        for (const claimId of closure) {
          if (!reviewed.has(claimId)) {
            errors.push(
              `strict publishable decision lacks independent review for ${claimId}`,
            );
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      entities: entities.size,
      claims: claims.size,
      evidence: evidence.size,
      relations: relations.size,
      reviews: reviews.size,
    },
  };
}

// —— 会话交叉核验（--session）——
// 确定性检查：manifest 引用的来源 URL 是否在 pi 会话 jsonl 中被真实请求过
// （bash 命令含 URL 字面量，或 web_fetch 工具以该 URL 为参数），
// 且至少有一次请求的结果不是错误/失败样式。只验证"抓取行为发生过"，
// 不验证"来源是否蕴含主张"（语义审查仍属人工/模型职责）。
//
// 会话出处（session_file）：manifest 可跨会话续用（复核/追问/补充调研），历史条目
// 的取证发生在先前会话，对当前会话核验必然误报"从未抓取"（2026-08-10 实测事故：
// 续做会话点名 5 个 URL + 1 条逐字 grep，全部在上个会话真实取过证）。收尾审计把
// 本会话核验通过的条目盖章 session_file=会话 jsonl 路径；此处对带章条目改查其出处
// 会话文件——URL 必须真实出现在出处会话的 bash 命令里，伪造出处一样会被点名。
// 出处文件缺失/不可读时单列 unverifiable（无法核验），不与编造混为一谈。

// 404 只认行首状态样式或明确错误短语：裸 `404[:\s]` 会撞上正文内容
// （实测：issue 标题 "avoid 404 on vision-incapable providers" 让成功的搜索结果被误判失败）
const FETCH_FAILURE_PATTERN =
  /(rate limit exceeded|api (rate )?limit|"message"\s*:\s*"not found"|(^|\n)[^\n]{0,20}404[:\s]|404 not found|requested url returned error|"status"\s*:\s*"?404|could not resolve host|connection (refused|timed out)|operation timed out|empty reply from server)/i;
// 失败样式只在短响应上判定：限流/404 响应体都很短，长响应里出现这些词多半是正文内容。
const FAILURE_BODY_MAX_CHARS = 600;

// spawn_researcher 子代理取证（2026-08-19 实测误报：LICENSE/HF 页面由子代理真实
// 抓取，主会话却无记录被点名"从未抓取"）：子会话 inMemory 不落盘，pi-web 把其
// 每次 web_search/web_fetch 记进报告旁的同名 -sources.jsonl（harness 写入）。
// 锚点是 toolResult(toolName=spawn_researcher) 里的「完整报告已存盘: <路径>」——
// 该文案只由 harness 生成进 toolResult，assistant 消息伪造不了；日志文件也由
// harness 写入。路径派生约定与 pi-web researchSourceLog.ts 同步，勿单独改动。
const RESEARCHER_REPORT_ANCHOR = /完整报告已存盘:\s*([^\n（]+)/g;

function parseSessionCalls(sessionText) {
  const commands = new Map();
  const results = new Map();
  const researcherReports = [];
  for (const line of sessionText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry?.message;
    if (!message) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const item of message.content) {
        if (item?.type !== "toolCall" || typeof item.name !== "string" || typeof item.id !== "string") {
          continue;
        }
        const tool = item.name.split(".").at(-1);
        if (tool === "bash" && typeof item.arguments?.command === "string") {
          commands.set(item.id, item.arguments.command);
        } else if (tool === "web_fetch" && typeof item.arguments?.url === "string") {
          // web_fetch 的 url 参数就是完整字面抓取记录，与 bash curl 等价参与
          // URL 核验（2026-08-15 实测事故：12 个 web_fetch 成功抓取的来源被
          // 误报"从未抓取"）。URL 不会包含空白，不影响 local_command 子串匹配。
          commands.set(item.id, item.arguments.url);
        }
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const text = Array.isArray(message.content)
        ? message.content
            .filter((item) => item?.type === "text" && typeof item.text === "string")
            .map((item) => item.text)
            .join("\n")
        : "";
      results.set(message.toolCallId, { isError: message.isError === true, text });
      if (
        typeof message.toolName === "string" &&
        message.toolName.split(".").at(-1) === "spawn_researcher"
      ) {
        for (const match of text.matchAll(RESEARCHER_REPORT_ANCHOR)) {
          researcherReports.push(match[1].trim());
        }
      }
    }
  }
  return { commands, results, researcherReports };
}

/**
 * 子代理取证日志并入语料：web_fetch 记录等价于主会话的一次抓取（commands 收
 * 目标 URL，results 按 ok 合成短结果——成功文案固定，绝不含 URL/错误词，避免
 * 撞 FETCH_FAILURE_PATTERN）。日志缺失（旧版运行/已清理）静默降级为原行为。
 */
function mergeResearcherSourceLogs(researcherReports, commands, results) {
  let seq = 0;
  for (const reportPath of researcherReports) {
    let raw;
    try {
      raw = fs.readFileSync(reportPath.replace(/-report\.md$/, "-sources.jsonl"), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.tool !== "web_fetch" || typeof entry.target !== "string" || !entry.target) continue;
      const id = `researcher:${++seq}`;
      commands.set(id, entry.target);
      results.set(
        id,
        entry.ok === true
          ? { isError: false, text: "[researcher] fetch ok" }
          : { isError: true, text: String(entry.error ?? "fetch failed") },
      );
    }
  }
}

function looksLikeFailedFetch(result) {
  if (!result) return true;
  const text = result.text.trim();
  // isError 但正文可观：复合命令尾段（解析/统计脚本）退出非零而抓取本身成功的
  // 常见形态，抓到的内容仍在输出里（实测：PR 评论全文在场、尾部 node 脚本报错）
  if (result.isError) return text.length <= FAILURE_BODY_MAX_CHARS;
  if (text === "") return true;
  return text.length <= FAILURE_BODY_MAX_CHARS && FETCH_FAILURE_PATTERN.test(text);
}

function buildSessionCorpus(sessionText) {
  const { commands, results, researcherReports } = parseSessionCalls(sessionText);
  mergeResearcherSourceLogs(researcherReports, commands, results);
  const successCorpus = [...results.values()]
    .filter((result) => !looksLikeFailedFetch(result))
    .map((result) => result.text)
    .join("\n");
  return { commands, results, successCorpus };
}

/** 路径归一化（出处会话与当前会话的等值判断）；Windows 不区分大小写 */
function normalizedPath(value) {
  const resolved = path.resolve(String(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function checkSourcesAgainstSession(manifest, sessionText, currentSessionPath = null) {
  const current = buildSessionCorpus(sessionText);
  // 出处会话语料缓存：同一 session_file 的多条证据只解析一次；null = 读取失败
  const corpusByPath = new Map();
  if (currentSessionPath !== null) {
    corpusByPath.set(normalizedPath(currentSessionPath), current);
  }

  const unrequested = [];
  const failedFetch = [];
  const unexecuted = [];
  const unverifiable = [];
  // 对"当前会话"核验通过的证据 id：收尾审计据此盖章 session_file
  const verifiedHere = [];
  const evidence = Array.isArray(manifest?.evidence) ? manifest.evidence : [];
  for (const record of evidence) {
    if (!isObject(record)) continue;

    // 选定核验语料：带 session_file 章的历史条目查其出处会话，其余查当前会话
    let corpus = current;
    let checkedHere = true;
    if (nonEmptyString(record.session_file)) {
      const key = normalizedPath(record.session_file);
      if (currentSessionPath === null || key !== normalizedPath(currentSessionPath)) {
        if (!corpusByPath.has(key)) {
          let text = null;
          try {
            text = fs.readFileSync(record.session_file, "utf8");
          } catch {
            // 出处会话缺失/不可读 → 该条目无法核验
          }
          corpusByPath.set(key, text === null ? null : buildSessionCorpus(text));
        }
        const provenance = corpusByPath.get(key);
        if (provenance === null) {
          unverifiable.push({ id: record.id, session_file: record.session_file });
          continue;
        }
        corpus = provenance;
        checkedHere = false;
      }
    }
    const provenanceTag = checkedHere ? {} : { session_file: record.session_file };

    // 本地取证：核验命令确实在会话中执行过。执行结果可以是失败输出
    // （失败的测试运行本身就是合法证据），所以只查"执行过"，不查"成功"。
    if (nonEmptyString(record.local_command)) {
      const executed = [...corpus.commands.values()].some((command) =>
        command.includes(record.local_command),
      );
      if (!executed) {
        unexecuted.push({ id: record.id, local_command: record.local_command, ...provenanceTag });
      } else if (checkedHere) {
        verifiedHere.push(record.id);
      }
      continue;
    }

    if (!nonEmptyString(record.url)) continue;
    // retrieved_via（实际转运 URL）优先，其次 url 本身
    const cited = [record.retrieved_via, record.url].filter((value) => nonEmptyString(value));
    const variants = cited.flatMap((value) => [value, value.replace(/\/+$/, "")]);
    const containing = [...corpus.commands.entries()].filter(([, command]) =>
      variants.some((variant) => command.includes(variant)),
    );
    if (containing.length === 0) {
      unrequested.push({
        id: record.id,
        url: record.url,
        seen_in_results: variants.some((variant) => corpus.successCorpus.includes(variant)),
        ...provenanceTag,
      });
      continue;
    }
    const anySuccess = containing.some(
      ([callId]) => !looksLikeFailedFetch(corpus.results.get(callId)),
    );
    if (!anySuccess) {
      failedFetch.push({ id: record.id, url: record.url, ...provenanceTag });
    } else if (checkedHere) {
      verifiedHere.push(record.id);
    }
  }
  return {
    unrequested,
    failedFetch,
    unexecuted,
    unverifiable,
    verified_here: verifiedHere,
    bashCommands: current.commands.size,
  };
}

function runCli(argv) {
  const jsonOutput = argv.includes("--json");
  const args = [];
  let sessionPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") continue;
    if (argv[i] === "--session") {
      sessionPath = argv[++i];
      continue;
    }
    args.push(argv[i]);
  }
  if (args.length !== 1 || (sessionPath !== null && !nonEmptyString(sessionPath))) {
    console.error("Usage: validate-evidence.mjs [--json] <manifest.json> [--session <session.jsonl>]");
    return 2;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(args[0], "utf8"));
  } catch (error) {
    console.error(`Cannot read manifest: ${error.message}`);
    return 2;
  }

  const result = validateManifest(manifest);

  if (sessionPath !== null) {
    let sessionText;
    try {
      sessionText = fs.readFileSync(sessionPath, "utf8");
    } catch (error) {
      console.error(`Cannot read session: ${error.message}`);
      return 2;
    }
    result.sessionCheck = checkSourcesAgainstSession(manifest, sessionText, sessionPath);
  }

  const sessionProblems =
    (result.sessionCheck?.unrequested.length ?? 0) +
    (result.sessionCheck?.failedFetch.length ?? 0) +
    (result.sessionCheck?.unexecuted.length ?? 0) +
    (result.sessionCheck?.unverifiable.length ?? 0);

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.valid ? "Evidence manifest: PASS" : "Evidence manifest: FAIL");
    for (const error of result.errors) console.log(`ERROR: ${error}`);
    for (const warning of result.warnings) console.log(`WARN: ${warning}`);
    if (result.sessionCheck) {
      const where = (item) => (item.session_file ? "its provenance session" : "this session");
      for (const item of result.sessionCheck.unrequested) {
        console.log(
          `SESSION: evidence ${item.id ?? "?"} cites a source never requested in ${where(item)}: ${item.url}`,
        );
      }
      for (const item of result.sessionCheck.failedFetch) {
        console.log(`SESSION: evidence ${item.id ?? "?"} cites a source whose fetches all failed: ${item.url}`);
      }
      for (const item of result.sessionCheck.unexecuted) {
        console.log(
          `SESSION: evidence ${item.id ?? "?"} cites a local command never executed in ${where(item)}: ${item.local_command}`,
        );
      }
      for (const item of result.sessionCheck.unverifiable) {
        console.log(
          `SESSION: evidence ${item.id ?? "?"} cites a provenance session that cannot be read: ${item.session_file}`,
        );
      }
      if (sessionProblems === 0) console.log("Session cross-check: PASS");
    }
    console.log(
      `Checked ${result.stats.entities} entities, ${result.stats.claims} claims, ${result.stats.evidence} evidence records, ${result.stats.relations} relations, ${result.stats.reviews} reviews.`,
    );
  }
  return result.valid && sessionProblems === 0 ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  process.exitCode = runCli(process.argv.slice(2));
}

export { validateManifest, checkSourcesAgainstSession };
