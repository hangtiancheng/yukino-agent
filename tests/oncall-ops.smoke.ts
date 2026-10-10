import assert from "node:assert/strict";

import {
  aggregateAlerts,
  dedupeAlerts,
  normalizeAlert,
  parseAlertSources,
  parseAlertmanagerAlerts,
  parsePrometheusAlerts,
  runReadinessChecks,
  type Alert,
  type AlertSourceConfig,
} from "@/lib/ai/alerts";
import { buildAiOpsQuery } from "@/lib/ai/pipelines/plan-execute-replan";
import {
  AIOPS_REPORT_REQUIRED_MARKERS,
  cleanMarkdownReport,
  fallbackReportContent,
} from "@/lib/ai/pipelines/plan-execute-replan/graph";
import { findUnknownToolReferences } from "@/lib/ai/pipelines/plan-execute-replan/executor";
import {
  isValidSkillName,
  validateChatPrompt,
  validateSkillMarkdown,
} from "@/lib/ai/prompts-skills";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const alertmanagerPayload = [
  {
    labels: {
      alertname: "HighErrorRate",
      service: "checkout",
      severity: "critical",
    },
    annotations: {
      summary: "checkout error ratio above 5%",
      context_url: "https://dash.example/high-error-rate",
      value: 42,
    },
    startsAt: "2026-10-06T08:00:00Z",
    fingerprint: "aaa111",
    status: { state: "active" },
  },
  {
    labels: { alertname: "DiskWillFillIn4Hours", severity: "warning" },
    annotations: { description: "node disk filling" },
    startsAt: "2026-10-06T07:30:00Z",
    fingerprint: "bbb222",
    status: { state: "suppressed" },
  },
  {
    labels: { severity: "info" },
    annotations: {},
    startsAt: "2026-10-06T07:00:00Z",
    status: { state: "active" },
  },
];

{
  const alerts = parseAlertmanagerAlerts(alertmanagerPayload, "am-main");
  assert.equal(alerts.length, 1, "only the active alert survives the filter");
  const a = alerts[0] as Alert;
  assert.equal(a.alert_name, "HighErrorRate");
  assert.equal(a.service, "checkout");
  assert.equal(a.severity, "critical");
  assert.equal(a.state, "active");
  assert.equal(a.active_at, "2026-10-06T08:00:00Z");
  assert.equal(a.fingerprint, "aaa111");
  assert.equal(a.source, "am-main");
  assert.equal(a.description, "checkout error ratio above 5%");
  assert.equal(a.context_url, "https://dash.example/high-error-rate");
  assert.equal(a.annotations["value"], undefined);
}

{
  assert.equal(
    normalizeAlert(
      {
        labels: { alertname: "X" },
        state: "pending",
        activeAt: "2026-10-06T08:00:00Z",
      },
      "p",
    ),
    null,
  );
  const derived = normalizeAlert(
    { labels: { alertname: "X", job: "node" }, state: "firing", activeAt: "" },
    "p",
  );
  assert.ok(derived !== null);
  assert.equal(derived.service, "node", "service falls back to job");
  assert.equal(
    derived.fingerprint,
    "p:X:node:",
    "fingerprint-or-derived id (alerts.py:244-245)",
  );
  assert.equal(normalizeAlert({ labels: {}, state: "firing" }, "p"), null);
}

{
  const prom = parsePrometheusAlerts(
    {
      status: "success",
      data: {
        alerts: [
          {
            labels: { alertname: "HighErrorRate", severity: "critical" },
            annotations: { description: "5xx ratio" },
            state: "firing",
            activeAt: "2026-10-06T09:00:00Z",
          },
        ],
      },
    },
    "prom-src",
  );
  assert.equal(prom.length, 1);
  assert.equal(prom[0]?.source, "prom-src", "source name preserved");
  assert.throws(() =>
    parsePrometheusAlerts({ status: "error", data: {} }, "prom-src"),
  );
}

{
  const amSource: AlertSourceConfig = {
    name: "am-main",
    type: "alertmanager",
    baseUrl: "http://alertmanager:9093/",
    username: "user",
    password: "pass",
  };
  const promSource: AlertSourceConfig = {
    name: "prom-legacy",
    type: "prometheus",
    baseUrl: "http://127.0.0.1:9090",
  };
  const deadSource: AlertSourceConfig = {
    name: "am-down",
    type: "alertmanager",
    baseUrl: "http://down.example",
  };
  const seen: { url: string; headers?: Record<string, string> }[] = [];
  const stub: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers =
      typeof init?.headers === "object" && init.headers !== null
        ? (init.headers as Record<string, string>)
        : undefined;
    seen.push({ url, headers });
    if (url.includes("down.example")) {
      throw new Error("connect ECONNREFUSED down.example");
    }
    if (url.endsWith("/api/v2/alerts")) {
      return jsonResponse(alertmanagerPayload);
    }
    if (url.endsWith("/api/v1/alerts")) {
      return jsonResponse({
        status: "success",
        data: {
          alerts: [
            {
              labels: { alertname: "HighErrorRate", severity: "critical" },
              annotations: { description: "from prometheus" },
              state: "firing",
              activeAt: "2026-10-06T08:00:00Z",
            },
            {
              labels: { alertname: "CertExpiring", severity: "warning" },
              state: "firing",
              activeAt: "2026-10-06T06:00:00Z",
            },
          ],
        },
      });
    }
    return jsonResponse({}, 500);
  };

  const out = await aggregateAlerts({
    sources: [amSource, promSource, deadSource],
    fetch: stub,
  });
  assert.equal(out.anySourceOk, true);
  assert.deepEqual(
    out.sourceErrors.map((e) => e.source),
    ["am-down"],
    "single-source failure is recorded, not fatal",
  );
  const names = out.alerts.map((a) => a.alert_name).sort();
  assert.deepEqual(names, ["CertExpiring", "HighErrorRate"]);
  const high = out.alerts.find((a) => a.alert_name === "HighErrorRate");
  assert.equal(high?.source, "am-main", "cross-source dedup keeps the first");
  assert.equal(
    high?.description,
    "checkout error ratio above 5%",
    "first occurrence = alertmanager copy",
  );
  const amSeen = seen.find((s) => s.url.includes("alertmanager"));
  assert.equal(
    amSeen?.headers?.["Authorization"],
    `Basic ${Buffer.from("user:pass").toString("base64")}`,
    "basic auth header (alerts.py:189-193)",
  );
  assert.equal(amSeen?.url, "http://alertmanager:9093/api/v2/alerts");
  assert.equal(
    seen.find((s) => s.url.includes("9090"))?.url,
    "http://127.0.0.1:9090/api/v1/alerts",
  );

  const halfCreds = await aggregateAlerts({
    sources: [{ ...amSource, password: undefined }],
    fetch: stub,
  });
  assert.equal(halfCreds.anySourceOk, false);
  assert.match(halfCreds.sourceErrors[0]?.error ?? "", /username and password/);

  const allDead = await aggregateAlerts({
    sources: [deadSource],
    fetch: stub,
  });
  assert.equal(allDead.anySourceOk, false);
  assert.equal(allDead.alerts.length, 0);
}

{
  const parsed = parseAlertSources(
    '[{"name":"a","type":"alertmanager","baseUrl":"http://a:9093"}]',
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.type, "alertmanager");
  assert.equal(parseAlertSources("not json").length, 1);
  assert.equal(parseAlertSources("not json")[0]?.type, "prometheus");
  assert.equal(parseAlertSources("").length, 1);
  assert.equal(parseAlertSources("[]")[0]?.type, "prometheus");
  assert.deepEqual(dedupeAlerts([]), []);
}

{
  const sweep = buildAiOpsQuery({});
  assert.equal(sweep.alert, null);
  assert.match(sweep.query, /query_prometheus_alerts/);

  const passthrough = buildAiOpsQuery({ query: "  custom prompt  " });
  assert.equal(passthrough.query, "  custom prompt  ", "query verbatim");

  const targeted = buildAiOpsQuery({
    alert: {
      alert_name: "HighErrorRate",
      severity: "critical",
      service: "checkout",
      active_at: "2026-10-06T08:00:00Z",
    },
  });
  assert.ok(targeted.alert !== null);
  assert.match(targeted.query, /ONE specific active alert/);
  assert.match(targeted.query, /- alert_name: HighErrorRate/);
  assert.match(targeted.query, /- service: checkout/);
  assert.match(
    targeted.query,
    /## 活跃告警列表/,
    "targeted query keeps the report template",
  );

  const combined = buildAiOpsQuery({
    alert: { alert_name: "X" },
    query: "focus on the payment shard",
  });
  assert.match(combined.query, /Additional operator instructions/);
  assert.match(combined.query, /payment shard/);
}

{
  const good = [
    "# 告警分析报告",
    "## 活跃告警列表",
    "| HighErrorRate | critical |",
    "## 告警归因 1 (第 1 个告警)",
    "## 处理流程 1 (第 1 个告警)",
    "## 结论",
  ].join("\n");
  assert.equal(cleanMarkdownReport(good), good);
  assert.equal(
    cleanMarkdownReport("```markdown\n" + good + "\n```"),
    good,
    "whole-response fence unwrapped (legacy parity)",
  );
  assert.equal(cleanMarkdownReport('{"report": "done"}'), null);
  assert.equal(
    cleanMarkdownReport("# 告警分析报告\n## 活跃告警列表"),
    null,
    "missing 结论 heading fails",
  );
  assert.equal(cleanMarkdownReport(""), null);

  const fallback = fallbackReportContent({
    alert: {
      alert_name: "High|Error",
      severity: "critical",
      service: "checkout",
      active_at: "2026-10-06T08:00:00Z",
      duration: "1h0m0s",
      state: "firing",
    },
    detail: ["step one output", "step two output"],
  });
  assert.match(
    fallback,
    /High\\\|Error/,
    "table pipes escaped (legacy parity)",
  );
  assert.match(fallback, /1\. step one output/);
  assert.match(fallback, /## 活跃告警列表/);
  assert.ok(
    AIOPS_REPORT_REQUIRED_MARKERS.every((marker) => fallback.includes(marker)),
  );
  assert.notEqual(cleanMarkdownReport(fallback), null);

  const emptyRun = fallbackReportContent({ alert: null, detail: [] });
  assert.match(emptyRun, /通用巡检诊断/);
  assert.match(emptyRun, /未获取工具证据/);
  assert.notEqual(cleanMarkdownReport(emptyRun), null);
}

{
  const known = ["query_prometheus_alerts", "query_internal_docs"];
  assert.deepEqual(
    findUnknownToolReferences(
      "call the tool query_internal_docs for the runbook",
      known,
    ),
    [],
  );
  assert.deepEqual(
    findUnknownToolReferences(
      "Call the tool search_cls_logs with Region set",
      known,
    ),
    ["search_cls_logs"],
  );
  assert.deepEqual(
    findUnknownToolReferences(
      "Take the tool time into account; this tool helps",
      known,
    ),
    [],
    "prose without snake_case identifiers is never a tool reference",
  );
  assert.deepEqual(
    findUnknownToolReferences("use `search_cls_logs` now", known),
    [],
    "only explicit tool mentions count (conservative)",
  );
}

{
  const skill = validateSkillMarkdown(
    [
      "---",
      "name: k8s-pod-diagnosis",
      "description: Diagnose crashing Kubernetes pods; use when the alert mentions pods.",
      "---",
      "",
      "# Steps",
      "1. kubectl get pods",
    ].join("\n"),
    "SKILL.md",
  );
  assert.equal(skill.ok, true);
  if (skill.ok) {
    assert.equal(skill.skill.name, "k8s-pod-diagnosis");
    assert.match(skill.skill.description, /Kubernetes/);
  }

  const failures: string[] = [];
  const expectFail = (content: string, fileName?: string, why = "?") => {
    const r = validateSkillMarkdown(content, fileName);
    if (r.ok) failures.push(why);
    else assert.ok(r.error.length > 0, why);
  };
  expectFail("no frontmatter here", undefined, "missing frontmatter");
  expectFail("---\nname: ok-name\n---\nbody", undefined, "missing description");
  expectFail(
    "---\nname: Bad_Name\ndescription: d\n---\nbody",
    undefined,
    "uppercase/underscore name",
  );
  expectFail(
    "---\nname: -lead\ndescription: d\n---\nbody",
    undefined,
    "leading hyphen",
  );
  expectFail(
    "---\nname: a--b\ndescription: d\n---\nbody",
    undefined,
    "double hyphen",
  );
  expectFail(
    '---\nname: n\ndescription: ""\n---\nbody',
    undefined,
    "empty description",
  );
  expectFail(
    "---\n[name, not, a, mapping]\n---\nbody",
    undefined,
    "non-mapping frontmatter",
  );
  expectFail("", undefined, "empty file");
  expectFail(
    "---\nname: n\ndescription: d\n---\nbody",
    "SKILL.txt",
    "file name must be SKILL.md",
  );
  assert.deepEqual(failures, []);

  assert.equal(isValidSkillName("a".repeat(64)), true);
  assert.equal(isValidSkillName("a".repeat(65)), false);
  assert.equal(isValidSkillName("mix3d-1"), true);

  const prompt = validateChatPrompt("  oncall-style ", " keep answers terse ");
  assert.equal(prompt.ok, true);
  if (prompt.ok) {
    assert.equal(prompt.name, "oncall-style");
    assert.equal(prompt.content, "keep answers terse");
  }
  assert.equal(validateChatPrompt("", "x").ok, false);
  assert.equal(validateChatPrompt("x", " ").ok, false);
  assert.equal(validateChatPrompt("x", "y".repeat(12001)).ok, false);
  assert.equal(validateChatPrompt("n".repeat(161), "y").ok, false);
}

{
  const ready = await runReadinessChecks({
    postgres: async () => ({ ok: true, detail: "up" }),
    milvus: async () => ({ ok: true, latencyMs: 7, detail: "counted" }),
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.checks.length, 2);
  assert.deepEqual(ready.checks.map((c) => c.name).sort(), [
    "milvus",
    "postgres",
  ]);
  assert.equal(
    ready.checks.find((c) => c.name === "milvus")?.latencyMs,
    7,
    "explicit latency preserved",
  );

  const degraded = await runReadinessChecks({
    postgres: async () => ({ ok: true }),
    milvus: async () => {
      throw new Error("gRPC unavailable");
    },
    llm: async () => ({ ok: false, detail: "apiKey missing" }),
  });
  assert.equal(degraded.status, "degraded");
  assert.equal(
    degraded.checks.find((c) => c.name === "milvus")?.detail,
    "gRPC unavailable",
    "throwing checker degrades to ok:false, never crashes the probe",
  );
}

console.log("oncall-ops smoke: all checks passed");
