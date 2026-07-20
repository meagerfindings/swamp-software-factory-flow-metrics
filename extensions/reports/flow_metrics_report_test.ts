import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.14";
import {
  aggregateFlowMetrics,
  buildFlowMetrics,
  buildFlowMetricsReport,
  type FlowMetrics,
  loadMetricsData,
  type MetricsData,
  renderFlowMetricsMarkdown,
  type RunDataReader,
  runSlugsFromNames,
  workItemSlug,
} from "./flow_metrics_report.ts";

// ---------------------------------------------------------------------------
// Hand-built fixture run data. buildFlowMetrics is pure over a MetricsData, so
// the tests construct the state / journal / artifact maps directly — no live
// datastore, no chat/transcript input. Mirrors run_audit_report_test.ts.
// ---------------------------------------------------------------------------

const SHA_A = "a".repeat(40);

interface ArtifactSpec {
  name: string;
  version: number;
  payload: Record<string, unknown>;
  stageId?: string;
  cycle?: number;
}

function artifactEnvelope(spec: ArtifactSpec, workItem: string) {
  return {
    name: spec.name,
    workItem,
    stageId: spec.stageId ?? "implementation",
    cycle: spec.cycle ?? 1,
    payload: spec.payload,
    recordedAt: "2026-07-18T00:00:00.000Z",
  };
}

function journal(
  events: Array<
    {
      event: string;
      payload?: Record<string, unknown>;
      at: string;
      stageId?: string;
    }
  >,
  workItem: string,
): MetricsData["journal"] {
  return events.map((e, index) => ({
    version: index + 1,
    entry: {
      event: e.event,
      workItem,
      stageId: e.stageId,
      summary: `${e.event}`,
      payload: e.payload,
      at: e.at,
    },
  }));
}

function metricsData(opts: {
  workItem?: string;
  slug?: string;
  status?: "active" | "terminal";
  stageId?: string;
  journal: MetricsData["journal"];
  artifacts?: ArtifactSpec[];
  journalTruncated?: boolean;
}): MetricsData {
  const workItem = opts.workItem ?? "WI-700";
  const slug = opts.slug ?? workItem;
  const artifactVersions = new Map<
    string,
    Map<number, ReturnType<typeof artifactEnvelope>>
  >();
  for (const spec of opts.artifacts ?? []) {
    const perVersion = artifactVersions.get(spec.name) ?? new Map();
    perVersion.set(spec.version, artifactEnvelope(spec, workItem));
    artifactVersions.set(spec.name, perVersion);
  }
  return {
    slug,
    state: {
      workItem,
      stageId: opts.stageId ?? "implementation",
      cycles: {},
      enteredAt: "2026-07-18T00:00:00.000Z",
      status: opts.status ?? "active",
      definitionVersion: 1,
      startedAt: "2026-07-18T00:00:00.000Z",
    },
    journal: opts.journal,
    journalTruncated: opts.journalTruncated ?? false,
    // deno-lint-ignore no-explicit-any
    artifactVersions: artifactVersions as any,
    evidenceVersions: new Map(),
  };
}

/** Every traced value on a FlowMetrics must carry a source when non-empty. */
function assertTraceable(m: FlowMetrics) {
  const traced = [
    m.timeToTerminalMs,
    m.eras,
    m.dispatchAttempts,
    m.failedStage,
    m.humanTouches,
    m.patchCycles,
    m.outcome,
  ];
  for (const tv of traced) {
    for (const src of tv.sources) {
      assert(typeof src.kind === "string" && src.kind.length > 0);
      assert(typeof src.name === "string" && src.name.length > 0);
    }
  }
}

// ---------------------------------------------------------------------------
// Clean run: one dispatch, one approval, terminal done. No parks, no patches.
// ---------------------------------------------------------------------------

Deno.test("a clean terminal run computes time-to-terminal, dispatches, one human touch, and done outcome", () => {
  const data = metricsData({
    status: "terminal",
    stageId: "done",
    journal: journal([
      {
        event: "started",
        payload: {
          stage: "implementation",
          startedAt: "2026-07-18T00:00:00.000Z",
        },
        at: "2026-07-18T00:00:00.000Z",
      },
      {
        event: "dispatched",
        payload: { stageId: "implementation", cycle: 1, attempt: 1 },
        at: "2026-07-18T00:01:00.000Z",
      },
      {
        event: "advanced",
        payload: {
          transition: "run-tests",
          from: "implementation",
          to: "testing",
          cycle: 1,
        },
        at: "2026-07-18T00:05:00.000Z",
      },
      {
        event: "approved",
        payload: { gateId: "submit-approval", actor: "mat" },
        at: "2026-07-18T00:06:00.000Z",
      },
      {
        event: "run_terminal",
        payload: { transition: "complete", from: "submit", to: "done" },
        at: "2026-07-18T00:10:00.000Z",
      },
    ], "WI-700"),
  });
  const m = buildFlowMetrics(data, "WI-700");
  assertEquals(m.runStatus, "terminal");
  assertEquals(m.outcome.value, "done");
  assertEquals(m.timeToTerminalMs.value, 10 * 60 * 1000);
  assertEquals(m.dispatchAttempts.value, 1);
  assertEquals(m.humanTouches.value, 1);
  assertEquals(m.approvals, 1);
  assertEquals(m.rejections, 0);
  assertEquals(m.patchCycles.value, 0);
  assertEquals(m.failedStage.value, null);
  assertEquals(m.eras.value, 1);
  assert(m.acceptedFirstPass);
  assertTraceable(m);
  // Every displayed number traces to a source pointer.
  assert(m.timeToTerminalMs.sources.length >= 1);
  assert(m.dispatchAttempts.sources.length === 1);
  assert(m.humanTouches.sources.length === 1);
});

// ---------------------------------------------------------------------------
// Multi-cycle run with a patch: reset era, a patch stage re-entry, a
// findings_resolved event. Exercises eraStart aggregation + patch counting.
// ---------------------------------------------------------------------------

Deno.test("a multi-cycle run with a patch aggregates stage entries across eras and counts patch cycles", () => {
  const data = metricsData({
    status: "terminal",
    stageId: "done",
    journal: journal([
      {
        event: "started",
        payload: { stage: "implementation" },
        at: "2026-07-18T00:00:00.000Z",
      },
      {
        event: "dispatched",
        payload: { stageId: "implementation" },
        at: "2026-07-18T00:01:00.000Z",
      },
      {
        event: "advanced",
        payload: {
          transition: "to-review",
          from: "implementation",
          to: "review",
          cycle: 1,
        },
        at: "2026-07-18T00:02:00.000Z",
      },
      {
        event: "advanced",
        payload: {
          transition: "patch-blockers",
          from: "review",
          to: "patch",
          cycle: 1,
        },
        at: "2026-07-18T00:03:00.000Z",
      },
      {
        event: "dispatched",
        payload: { stageId: "patch" },
        at: "2026-07-18T00:04:00.000Z",
      },
      {
        event: "findings_resolved",
        payload: {
          artifact: "verified-findings",
          resolutions: [{ findingId: "f1", note: "fixed" }],
        },
        at: "2026-07-18T00:05:00.000Z",
      },
      // A reset opens a new era; implementation is entered again.
      {
        event: "reset",
        stageId: "implementation",
        at: "2026-07-18T00:06:00.000Z",
      },
      {
        event: "dispatched",
        payload: { stageId: "implementation" },
        at: "2026-07-18T00:07:00.000Z",
      },
      {
        event: "run_terminal",
        payload: { transition: "complete", from: "submit", to: "done" },
        at: "2026-07-18T00:10:00.000Z",
      },
    ], "WI-701"),
    workItem: "WI-701",
  });
  const m = buildFlowMetrics(data, "WI-701");
  assertEquals(m.eras.value, 2);
  // implementation was entered twice (start + reset).
  const impl = m.stages.find((s) => s.stageId === "implementation");
  assert(impl !== undefined);
  assertEquals(impl.entries, 2);
  assertEquals(impl.dispatchAttempts, 2);
  // patch cycles: the patch stage entry AND the findings_resolved event.
  assertEquals(m.patchCycles.value, 2);
  assertEquals(m.dispatchAttempts.value, 3);
  // A reset means this was NOT an accepted-first-pass, even though done.
  assert(!m.acceptedFirstPass);
  assertTraceable(m);
});

// ---------------------------------------------------------------------------
// Parked run: terminal at a *-blocked stage. Failed-stage + parked outcome.
// ---------------------------------------------------------------------------

Deno.test("a run parked at a blocked stage identifies the failed stage and the parked outcome", () => {
  const data = metricsData({
    status: "terminal",
    stageId: "review-blocked",
    journal: journal([
      {
        event: "started",
        payload: { stage: "implementation" },
        at: "2026-07-18T00:00:00.000Z",
      },
      {
        event: "dispatched",
        payload: { stageId: "implementation" },
        at: "2026-07-18T00:01:00.000Z",
      },
      {
        event: "advanced",
        payload: {
          transition: "to-review",
          from: "implementation",
          to: "review",
          cycle: 1,
        },
        at: "2026-07-18T00:02:00.000Z",
      },
      {
        event: "run_terminal",
        payload: { transition: "park", from: "review", to: "review-blocked" },
        at: "2026-07-18T00:03:00.000Z",
      },
    ], "WI-702"),
    workItem: "WI-702",
  });
  const m = buildFlowMetrics(data, "WI-702");
  assertEquals(m.outcome.value, "parked");
  assertEquals(m.failedStage.value, "review-blocked");
  assert(m.failedStage.sources.length >= 1);
  assertEquals(m.failedStage.sources[0].kind, "journal");
  assert(!m.acceptedFirstPass);
  // The terminal stage is flagged in the per-stage rollup.
  const blocked = m.stages.find((s) => s.stageId === "review-blocked");
  assert(blocked !== undefined && blocked.terminal);
  assertTraceable(m);
  const md = renderFlowMetricsMarkdown({ workItem: "WI-702", metrics: m });
  assertStringIncludes(md, "review-blocked");
});

// ---------------------------------------------------------------------------
// Terminal cleanup-required run: outcome + cleanup health.
// ---------------------------------------------------------------------------

Deno.test("a cleanup-required run reports the cleanup-required outcome and failed stage", () => {
  const data = metricsData({
    status: "terminal",
    stageId: "cleanup-required",
    journal: journal([
      {
        event: "started",
        payload: { stage: "teardown" },
        at: "2026-07-18T00:00:00.000Z",
      },
      {
        event: "run_terminal",
        payload: {
          transition: "retain",
          from: "teardown",
          to: "cleanup-required",
        },
        at: "2026-07-18T00:02:00.000Z",
      },
    ], "WI-703"),
    workItem: "WI-703",
  });
  const m = buildFlowMetrics(data, "WI-703");
  assertEquals(m.outcome.value, "cleanup-required");
  assertEquals(m.failedStage.value, "cleanup-required");
  assert(!m.acceptedFirstPass);
  assertTraceable(m);
});

// ---------------------------------------------------------------------------
// Zero-flag / minimal case: an active run with no dispatches or touches.
// ---------------------------------------------------------------------------

Deno.test("an active run with no dispatches or human touches yields empty traced sources and active outcome", () => {
  const data = metricsData({
    status: "active",
    stageId: "implementation",
    journal: journal([
      {
        event: "started",
        payload: { stage: "implementation" },
        at: "2026-07-18T00:00:00.000Z",
      },
    ], "WI-704"),
    workItem: "WI-704",
  });
  const m = buildFlowMetrics(data, "WI-704", {
    now: "2026-07-18T00:30:00.000Z",
  });
  assertEquals(m.outcome.value, "active");
  assertEquals(m.timeToTerminalMs.value, null);
  assertEquals(m.dispatchAttempts.value, 0);
  assertEquals(m.dispatchAttempts.sources, []);
  assertEquals(m.humanTouches.value, 0);
  assertEquals(m.humanTouches.sources, []);
  assertEquals(m.patchCycles.value, 0);
  assertEquals(m.failedStage.value, null);
  assert(!m.acceptedFirstPass);
  // The active current stage accrues wall-clock against `now`.
  const impl = m.stages.find((s) => s.stageId === "implementation");
  assert(impl !== undefined);
  assertEquals(impl.totalMs, 30 * 60 * 1000);
  assertTraceable(m);
});

// ---------------------------------------------------------------------------
// A rejection is a human touch and disqualifies accepted-first-pass.
// ---------------------------------------------------------------------------

Deno.test("a rejection counts as a human touch and blocks accepted-first-pass even when done", () => {
  const data = metricsData({
    status: "terminal",
    stageId: "done",
    journal: journal([
      {
        event: "started",
        payload: { stage: "implementation" },
        at: "2026-07-18T00:00:00.000Z",
      },
      {
        event: "rejected",
        payload: { gateId: "plan-approval", actor: "mat" },
        at: "2026-07-18T00:01:00.000Z",
      },
      {
        event: "approved",
        payload: { gateId: "plan-approval", actor: "mat" },
        at: "2026-07-18T00:02:00.000Z",
      },
      {
        event: "run_terminal",
        payload: { transition: "complete", from: "submit", to: "done" },
        at: "2026-07-18T00:10:00.000Z",
      },
    ], "WI-705"),
    workItem: "WI-705",
  });
  const m = buildFlowMetrics(data, "WI-705");
  assertEquals(m.humanTouches.value, 2);
  assertEquals(m.approvals, 1);
  assertEquals(m.rejections, 1);
  assert(!m.acceptedFirstPass);
});

// ---------------------------------------------------------------------------
// Cross-run aggregate: multiple runs on a model instance.
// ---------------------------------------------------------------------------

Deno.test("the cross-run aggregate folds accepted-first-pass rate, cleanup health, and totals", () => {
  const clean = buildFlowMetrics(
    metricsData({
      status: "terminal",
      stageId: "done",
      workItem: "WI-A",
      journal: journal([
        {
          event: "started",
          payload: { stage: "impl" },
          at: "2026-07-18T00:00:00.000Z",
        },
        {
          event: "dispatched",
          payload: { stageId: "impl" },
          at: "2026-07-18T00:01:00.000Z",
        },
        {
          event: "approved",
          payload: { gateId: "g", actor: "mat" },
          at: "2026-07-18T00:02:00.000Z",
        },
        {
          event: "run_terminal",
          payload: { transition: "complete", to: "done" },
          at: "2026-07-18T00:04:00.000Z",
        },
      ], "WI-A"),
    }),
    "WI-A",
  );
  const parked = buildFlowMetrics(
    metricsData({
      status: "terminal",
      stageId: "review-blocked",
      workItem: "WI-B",
      journal: journal([
        {
          event: "started",
          payload: { stage: "impl" },
          at: "2026-07-18T00:00:00.000Z",
        },
        {
          event: "run_terminal",
          payload: { transition: "park", to: "review-blocked" },
          at: "2026-07-18T00:06:00.000Z",
        },
      ], "WI-B"),
    }),
    "WI-B",
  );
  const cleanup = buildFlowMetrics(
    metricsData({
      status: "terminal",
      stageId: "cleanup-required",
      workItem: "WI-C",
      journal: journal([
        {
          event: "started",
          payload: { stage: "teardown" },
          at: "2026-07-18T00:00:00.000Z",
        },
        {
          event: "run_terminal",
          payload: { transition: "retain", to: "cleanup-required" },
          at: "2026-07-18T00:02:00.000Z",
        },
      ], "WI-C"),
    }),
    "WI-C",
  );
  const agg = aggregateFlowMetrics([clean, parked, cleanup]);
  assertEquals(agg.runs, 3);
  assertEquals(agg.terminalRuns, 3);
  assertEquals(agg.doneRuns, 1);
  assertEquals(agg.parkedRuns, 1);
  assertEquals(agg.cleanupRequiredRuns, 1);
  assertEquals(agg.acceptedFirstPassRate, 1 / 3);
  assertEquals(agg.cleanupFailureRate, 1 / 3);
  assertEquals(agg.totalHumanTouches, 1);
  assertEquals(agg.totalDispatchAttempts, 1);
  // mean of 4m, 6m, 2m = 4m in ms.
  assertEquals(agg.meanTimeToTerminalMs, 4 * 60 * 1000);
});

Deno.test("buildFlowMetricsReport attaches the aggregate only when other runs exist", () => {
  const primary = metricsData({
    status: "terminal",
    stageId: "done",
    workItem: "WI-A",
    journal: journal([
      {
        event: "started",
        payload: { stage: "impl" },
        at: "2026-07-18T00:00:00.000Z",
      },
      {
        event: "run_terminal",
        payload: { transition: "complete", to: "done" },
        at: "2026-07-18T00:04:00.000Z",
      },
    ], "WI-A"),
  });
  const single = buildFlowMetricsReport("WI-A", primary);
  assertEquals(single.aggregate, undefined);

  const other = metricsData({
    status: "terminal",
    stageId: "review-blocked",
    workItem: "WI-B",
    journal: journal([
      {
        event: "started",
        payload: { stage: "impl" },
        at: "2026-07-18T00:00:00.000Z",
      },
      {
        event: "run_terminal",
        payload: { transition: "park", to: "review-blocked" },
        at: "2026-07-18T00:02:00.000Z",
      },
    ], "WI-B"),
  });
  const multi = buildFlowMetricsReport("WI-A", primary, [
    { workItem: "WI-B", data: other },
  ]);
  assert(multi.aggregate !== undefined);
  assertEquals(multi.aggregate.runs, 2);
  const md = renderFlowMetricsMarkdown(multi);
  assertStringIncludes(md, "## Cross-run aggregate");
  assertStringIncludes(md, "Accepted-first-pass rate");
});

// ---------------------------------------------------------------------------
// The report output is JSON-serializable (binding trap: no BigInt / no cycle).
// ---------------------------------------------------------------------------

Deno.test("the report json is fully JSON-serializable", () => {
  const primary = metricsData({
    status: "terminal",
    stageId: "done",
    workItem: "WI-A",
    journal: journal([
      {
        event: "started",
        payload: { stage: "impl" },
        at: "2026-07-18T00:00:00.000Z",
      },
      {
        event: "dispatched",
        payload: { stageId: "impl" },
        at: "2026-07-18T00:01:00.000Z",
      },
      {
        event: "run_terminal",
        payload: { transition: "complete", to: "done" },
        at: "2026-07-18T00:04:00.000Z",
      },
    ], "WI-A"),
    artifacts: [
      { name: "draft-pull-request", version: 1, payload: { commitSha: SHA_A } },
    ],
  });
  const built = buildFlowMetricsReport("WI-A", primary);
  // Round-trips without throwing (no BigInt, no circular reference).
  const json = JSON.stringify(built);
  assert(json.length > 0);
  const round = JSON.parse(json);
  assertEquals(round.metrics.outcome.value, "done");
});

// ---------------------------------------------------------------------------
// runSlugsFromNames: cross-run discovery from a flat name list.
// ---------------------------------------------------------------------------

Deno.test("runSlugsFromNames extracts and de-duplicates state slugs deterministically", () => {
  const names = [
    "state-WI-B",
    "journal-WI-B",
    "state-WI-A",
    "artifact-WI-A-draft-pull-request",
    "state-WI-A",
    "status",
  ];
  assertEquals(runSlugsFromNames(names), ["WI-A", "WI-B"]);
});

// ---------------------------------------------------------------------------
// loadMetricsData over a hand-implemented RunDataReader — the journal-driven
// load itself, proving no transcript/chat input is consulted.
// ---------------------------------------------------------------------------

Deno.test("loadMetricsData reads only state/journal/artifact records addressed by run-name instances", async () => {
  const slug = workItemSlug("WI-800");
  const reads: string[] = [];
  const store: Record<string, Record<number, Record<string, unknown>>> = {
    [`state-${slug}`]: {
      1: {
        workItem: "WI-800",
        stageId: "done",
        cycles: {},
        enteredAt: "2026-07-18T00:00:00.000Z",
        status: "terminal",
        definitionVersion: 1,
        startedAt: "2026-07-18T00:00:00.000Z",
      },
    },
    [`journal-${slug}`]: {
      1: {
        event: "started",
        workItem: "WI-800",
        summary: "started",
        payload: { stage: "implementation" },
        at: "2026-07-18T00:00:00.000Z",
      },
      2: {
        event: "run_terminal",
        workItem: "WI-800",
        summary: "terminal",
        payload: { transition: "complete", to: "done" },
        at: "2026-07-18T00:05:00.000Z",
      },
    },
  };
  const reader: RunDataReader = {
    versionsOf: (name) => {
      reads.push(`versions:${name}`);
      return Promise.resolve(Object.keys(store[name] ?? {}).map(Number));
    },
    read: (name, version) => {
      reads.push(`read:${name}`);
      const versions = store[name];
      if (versions === undefined) return Promise.resolve(null);
      const v = version ?? Math.max(...Object.keys(versions).map(Number));
      return Promise.resolve(versions[v] ?? null);
    },
  };
  const data = await loadMetricsData(reader, slug);
  assertEquals(data.state?.workItem, "WI-800");
  assertEquals(data.journal.length, 2);
  const m = buildFlowMetrics(data, "WI-800");
  assertEquals(m.outcome.value, "done");
  assertEquals(m.timeToTerminalMs.value, 5 * 60 * 1000);
  // Only run-name-addressed instances were read — never a "transcript"/"chat".
  assert(
    reads.every((r) =>
      r.includes("state-") || r.includes("journal-") ||
      r.includes("artifact-") ||
      r.includes("evidence-")
    ),
  );
  assert(!reads.some((r) => r.includes("transcript") || r.includes("chat")));
});
