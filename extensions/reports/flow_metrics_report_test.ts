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

/**
 * One approval record as the factory writes it (models/_lib/run_data.ts).
 * `version` models the versioned `approval-<slug>-<gateId>` instance: the same
 * gate re-decided writes a new version of the same instance.
 */
interface ApprovalSpec {
  gateId: string;
  version: number;
  decision: "approved" | "rejected";
  stageId: string;
  cycle: number;
  decidedAt: string;
  actor?: string;
  note?: string;
}

function metricsData(opts: {
  workItem?: string;
  slug?: string;
  status?: "active" | "terminal";
  stageId?: string;
  journal: MetricsData["journal"];
  artifacts?: ArtifactSpec[];
  journalTruncated?: boolean;
  approvals?: ApprovalSpec[];
  approvalsTruncated?: boolean;
  cycles?: Record<string, number>;
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
  const approvalVersions = new Map<string, Map<number, unknown>>();
  for (const spec of opts.approvals ?? []) {
    const perVersion = approvalVersions.get(spec.gateId) ?? new Map();
    perVersion.set(spec.version, {
      gateId: spec.gateId,
      workItem,
      decision: spec.decision,
      actor: spec.actor ?? "human@example.com",
      note: spec.note,
      stageId: spec.stageId,
      cycle: spec.cycle,
      decidedAt: spec.decidedAt,
    });
    approvalVersions.set(spec.gateId, perVersion);
  }
  return {
    slug,
    state: {
      workItem,
      stageId: opts.stageId ?? "implementation",
      cycles: opts.cycles ?? {},
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
    // deno-lint-ignore no-explicit-any
    approvalVersions: approvalVersions as any,
    approvalsTruncated: opts.approvalsTruncated ?? false,
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

// ---------------------------------------------------------------------------
// Ceremony & approval-friction baseline (FRK-METRICS-002).
//
// Every case below is built from records the canonical @swamp/software-factory
// actually writes: journal entries with their real payload fields, and
// versioned `approval-<slug>-<gateId>` records carrying decision/stageId/
// cycle/decidedAt. Nothing here invents a timestamp or an identity.
// ---------------------------------------------------------------------------

/** A journal spine: started → review → done, with realistic timestamps. */
function reviewRunJournal(workItem: string) {
  return journal([
    {
      event: "started",
      payload: { workItem, stage: "implementation" },
      at: "2026-07-18T00:00:00.000Z",
      stageId: "implementation",
    },
    {
      event: "advanced",
      payload: {
        transition: "to-review",
        from: "implementation",
        to: "review",
        cycle: 1,
      },
      at: "2026-07-18T01:00:00.000Z",
      stageId: "review",
    },
    {
      event: "approved",
      payload: { gateId: "ship-it", actor: "human@example.com" },
      at: "2026-07-18T01:30:00.000Z",
      stageId: "review",
    },
    {
      event: "run_terminal",
      payload: { transition: "finish", from: "review", to: "done", cycle: 1 },
      at: "2026-07-18T02:00:00.000Z",
      stageId: "done",
    },
  ], workItem);
}

Deno.test("duplicate approval records for one decision count once as distinct, and the retry delta is preserved", () => {
  // The same gate re-recorded twice at the same stage+cycle+decision: one
  // logical decision, two raw records (a retry / replay).
  const data = metricsData({
    status: "terminal",
    stageId: "done",
    journal: reviewRunJournal("WI-700"),
    approvals: [
      {
        gateId: "ship-it",
        version: 1,
        decision: "approved",
        stageId: "review",
        cycle: 1,
        decidedAt: "2026-07-18T01:30:00.000Z",
      },
      {
        gateId: "ship-it",
        version: 2,
        decision: "approved",
        stageId: "review",
        cycle: 1,
        decidedAt: "2026-07-18T01:31:00.000Z",
      },
    ],
  });
  const c = buildFlowMetrics(data, "WI-700").ceremony;

  assertEquals(c.rawDecisionRecordCount, 2);
  assertEquals(c.humanTouches.value, 2);
  // Deduplicated by gateId+stageId+cycle+decision.
  assertEquals(c.distinctDecisionCount.value, 1);
  assertEquals(c.distinctDecisions.length, 1);
  assertEquals(c.distinctDecisions[0].recordCount, 2);
  // The EARLIEST decidedAt is kept as the moment the human decided.
  assertEquals(
    c.distinctDecisions[0].firstDecidedAt,
    "2026-07-18T01:30:00.000Z",
  );
  assertEquals(c.approvals.value, 1);
  assertEquals(c.rejections.value, 0);
});

Deno.test("the same gate decided on different cycles is two distinct decisions, not a duplicate", () => {
  // Rejected on cycle 1, approved on cycle 2 — two real decisions. Collapsing
  // them would erase the rejection entirely.
  const data = metricsData({
    status: "terminal",
    stageId: "done",
    journal: reviewRunJournal("WI-701"),
    approvals: [
      {
        gateId: "ship-it",
        version: 1,
        decision: "rejected",
        stageId: "review",
        cycle: 1,
        decidedAt: "2026-07-18T01:30:00.000Z",
      },
      {
        gateId: "ship-it",
        version: 2,
        decision: "approved",
        stageId: "review",
        cycle: 2,
        decidedAt: "2026-07-18T01:45:00.000Z",
      },
    ],
  });
  const c = buildFlowMetrics(data, "WI-701").ceremony;

  assertEquals(c.distinctDecisionCount.value, 2);
  // Approvals and rejections are tracked separately, per gate and in total.
  assertEquals(c.approvals.value, 1);
  assertEquals(c.rejections.value, 1);
  assertEquals(c.approvalsByGate["ship-it"], 1);
  assertEquals(c.rejectionsByGate["ship-it"], 1);
});

Deno.test("approvals and rejections separate per gate across multiple gates", () => {
  const data = metricsData({
    status: "terminal",
    stageId: "done",
    journal: reviewRunJournal("WI-702"),
    approvals: [
      {
        gateId: "ship-it",
        version: 1,
        decision: "approved",
        stageId: "review",
        cycle: 1,
        decidedAt: "2026-07-18T01:30:00.000Z",
      },
      {
        gateId: "security-sign-off",
        version: 1,
        decision: "rejected",
        stageId: "review",
        cycle: 1,
        decidedAt: "2026-07-18T01:20:00.000Z",
      },
      {
        gateId: "security-sign-off",
        version: 2,
        decision: "approved",
        stageId: "review",
        cycle: 1,
        decidedAt: "2026-07-18T01:40:00.000Z",
      },
    ],
  });
  const c = buildFlowMetrics(data, "WI-702").ceremony;

  assertEquals(c.approvals.value, 2);
  assertEquals(c.rejections.value, 1);
  assertEquals(c.approvalsByGate["ship-it"], 1);
  assertEquals(c.approvalsByGate["security-sign-off"], 1);
  assertEquals(c.rejectionsByGate["security-sign-off"], 1);
  // A gate never rejected does not appear as a zero entry.
  assertEquals(c.rejectionsByGate["ship-it"], undefined);
});

Deno.test("approval wait is unavailable when only stage entry and decision timestamps exist", () => {
  const data = metricsData({
    status: "terminal",
    stageId: "done",
    journal: reviewRunJournal("WI-703"),
    approvals: [
      {
        gateId: "ship-it",
        version: 1,
        decision: "approved",
        stageId: "review",
        cycle: 1,
        // Entered review at 01:00 and decided at 01:30, but stage entry does
        // not prove when this specific gate became pending.
        decidedAt: "2026-07-18T01:30:00.000Z",
      },
    ],
  });
  const c = buildFlowMetrics(data, "WI-703").ceremony;

  assertEquals(c.approvalWaits.length, 1);
  assertEquals(c.approvalWaits[0].waitMs, null);
  assertEquals(c.approvalWaits[0].availability, "unavailable");
  assertStringIncludes(c.approvalWaits[0].reason ?? "", "pendingSince");
  assertEquals(c.meanApprovalWaitMs.value, null);
  assertEquals(c.meanApprovalWaitMs.availability, "unavailable");
});

Deno.test("a decision with no surviving stage-cycle entry is unavailable, NOT a zero wait", () => {
  // The decision was recorded against review cycle 3, but the journal shows
  // no entry into review cycle 3 — the pending moment is unknowable.
  const data = metricsData({
    status: "terminal",
    stageId: "done",
    journal: reviewRunJournal("WI-704"),
    approvals: [
      {
        gateId: "ship-it",
        version: 1,
        decision: "approved",
        stageId: "review",
        cycle: 3,
        decidedAt: "2026-07-18T01:30:00.000Z",
      },
    ],
  });
  const c = buildFlowMetrics(data, "WI-704").ceremony;

  assertEquals(c.approvalWaits[0].waitMs, null);
  assertEquals(c.approvalWaits[0].availability, "unavailable");
  assert(c.approvalWaits[0].reason !== undefined);
  // The critical assertion: an unmeasurable wait must never surface as 0.
  assertEquals(c.meanApprovalWaitMs.value, null);
  assertEquals(c.meanApprovalWaitMs.availability, "unavailable");
  assertEquals(c.meanApprovalWaitMs.covered, 0);
  assertEquals(c.meanApprovalWaitMs.total, 1);
  // And it renders as "unavailable", not as "0s".
  const md = renderFlowMetricsMarkdown({
    workItem: "WI-704",
    metrics: buildFlowMetrics(data, "WI-704"),
  });
  assertStringIncludes(md, "unavailable");
});

Deno.test("multiple decisions remain unavailable without canonical pending timestamps", () => {
  const data = metricsData({
    status: "terminal",
    stageId: "done",
    journal: reviewRunJournal("WI-705"),
    approvals: [
      {
        gateId: "ship-it",
        version: 1,
        decision: "approved",
        stageId: "review",
        cycle: 1,
        decidedAt: "2026-07-18T01:30:00.000Z", // 30m wait
      },
      {
        gateId: "security-sign-off",
        version: 1,
        decision: "approved",
        stageId: "review",
        cycle: 9, // no journal entry into review cycle 9
        decidedAt: "2026-07-18T01:50:00.000Z",
      },
    ],
  });
  const c = buildFlowMetrics(data, "WI-705").ceremony;

  assertEquals(c.meanApprovalWaitMs.availability, "unavailable");
  assertEquals(c.meanApprovalWaitMs.value, null);
  assertEquals(c.meanApprovalWaitMs.covered, 0);
  assertEquals(c.meanApprovalWaitMs.total, 2);
  assert(c.meanApprovalWaitMs.reason !== undefined);
});

Deno.test("repeated stage visits and cycles are counted from journal and state facts", () => {
  const workItem = "WI-706";
  const data = metricsData({
    status: "terminal",
    stageId: "done",
    // implementation → review → implementation (rework) → review → done
    journal: journal([
      {
        event: "started",
        payload: { workItem, stage: "implementation" },
        at: "2026-07-18T00:00:00.000Z",
        stageId: "implementation",
      },
      {
        event: "advanced",
        payload: {
          transition: "to-review",
          from: "implementation",
          to: "review",
          cycle: 1,
        },
        at: "2026-07-18T01:00:00.000Z",
        stageId: "review",
      },
      {
        event: "advanced",
        payload: {
          transition: "rework",
          from: "review",
          to: "implementation",
          cycle: 2,
        },
        at: "2026-07-18T02:00:00.000Z",
        stageId: "implementation",
      },
      {
        event: "advanced",
        payload: {
          transition: "to-review",
          from: "implementation",
          to: "review",
          cycle: 2,
        },
        at: "2026-07-18T03:00:00.000Z",
        stageId: "review",
      },
      {
        event: "run_terminal",
        payload: { transition: "finish", from: "review", to: "done", cycle: 1 },
        at: "2026-07-18T04:00:00.000Z",
        stageId: "done",
      },
    ], workItem),
    // The factory's own cycle counter is authoritative when present.
    cycles: { implementation: 2, review: 2, done: 1 },
  });
  const c = buildFlowMetrics(data, workItem).ceremony;

  // 5 visits: implementation x2, review x2, done x1.
  assertEquals(c.stageVisitCount.value, 5);
  assertEquals(c.uniqueStageCount.value, 3);
  assertEquals(c.cycleCount.value, 5);
  assertEquals(c.cycleCount.availability, "available");
  // Review frequency = 2 review visits / 5 total visits.
  assertEquals(c.reviewFrequency.value, 2 / 5);
  assertEquals(c.reviewFrequency.covered, 2);
  assertEquals(c.reviewFrequency.total, 5);
  assertEquals(c.patchFrequency.value, 0);
});

Deno.test("cycleCount falls back to journal reconstruction and is labelled partial", () => {
  const data = metricsData({
    status: "terminal",
    stageId: "done",
    journal: reviewRunJournal("WI-707"),
    cycles: {}, // no state cycles map
  });
  const c = buildFlowMetrics(data, "WI-707").ceremony;
  assertEquals(c.cycleCount.availability, "partial");
  assert(c.cycleCount.reason !== undefined);
});

Deno.test("stage yield and park derive from explicit transition facts", () => {
  const workItem = "WI-708";
  const data = metricsData({
    status: "terminal",
    stageId: "review-blocked",
    journal: journal([
      {
        event: "started",
        payload: { workItem, stage: "implementation" },
        at: "2026-07-18T00:00:00.000Z",
        stageId: "implementation",
      },
      {
        event: "advanced",
        payload: {
          transition: "to-review",
          from: "implementation",
          to: "review",
          cycle: 1,
        },
        at: "2026-07-18T01:00:00.000Z",
        stageId: "review",
      },
      {
        event: "run_terminal",
        payload: {
          transition: "park",
          from: "review",
          to: "review-blocked",
          cycle: 1,
        },
        at: "2026-07-18T02:00:00.000Z",
        stageId: "review-blocked",
      },
    ], workItem),
  });
  const c = buildFlowMetrics(data, workItem).ceremony;

  const impl = c.stageFlow.find((s) => s.stageId === "implementation");
  assert(impl !== undefined);
  // implementation handed work onward once, never parked → 100% yield.
  assertEquals(impl.advancedOut, 1);
  assertEquals(impl.parkedAt, 0);
  assertEquals(impl.yieldRate, 1);
  assertEquals(impl.parkRate, 0);

  // review-blocked is a terminal, non-done landing → parked.
  const blocked = c.stageFlow.find((s) => s.stageId === "review-blocked");
  assert(blocked !== undefined);
  assertEquals(blocked.parkedAt, 1);
  assertEquals(blocked.parkRate, 1);
  assertEquals(blocked.yieldRate, 0);
  // Every stage-flow row carries its source pointers.
  assert(blocked.sources.length > 0);
});

Deno.test("a stage entered but never resolved has null yield/park, not zero", () => {
  const workItem = "WI-709";
  const data = metricsData({
    status: "active",
    stageId: "review",
    journal: journal([
      {
        event: "started",
        payload: { workItem, stage: "implementation" },
        at: "2026-07-18T00:00:00.000Z",
        stageId: "implementation",
      },
      {
        event: "advanced",
        payload: {
          transition: "to-review",
          from: "implementation",
          to: "review",
          cycle: 1,
        },
        at: "2026-07-18T01:00:00.000Z",
        stageId: "review",
      },
    ], workItem),
  });
  const c = buildFlowMetrics(data, workItem, {
    now: "2026-07-18T02:00:00.000Z",
  }).ceremony;
  // `review` never advanced out and never parked — it has no yield rate at
  // all, which must not be reported as a 0% yield.
  assertEquals(c.stageFlow.find((s) => s.stageId === "review"), undefined);
});

Deno.test("cycle override and bounded-loop exhaustion surface the stages actually unblocked", () => {
  const workItem = "WI-710";
  const data = metricsData({
    status: "terminal",
    stageId: "done",
    journal: journal([
      {
        event: "started",
        payload: { workItem, stage: "implementation" },
        at: "2026-07-18T00:00:00.000Z",
        stageId: "implementation",
      },
      // A human buys review one more entry past its maxCycles.
      {
        event: "approved",
        payload: {
          gateId: "cycle-override:review",
          actor: "human@example.com",
        },
        at: "2026-07-18T01:00:00.000Z",
        stageId: "implementation",
      },
      // The journal then shows review actually being entered afterwards.
      {
        event: "advanced",
        payload: {
          transition: "to-review",
          from: "implementation",
          to: "review",
          cycle: 3,
        },
        at: "2026-07-18T01:30:00.000Z",
        stageId: "review",
      },
      {
        event: "run_terminal",
        payload: { transition: "finish", from: "review", to: "done", cycle: 1 },
        at: "2026-07-18T02:00:00.000Z",
        stageId: "done",
      },
    ], workItem),
    approvals: [
      {
        gateId: "cycle-override:review",
        version: 1,
        decision: "approved",
        stageId: "implementation",
        cycle: 1,
        decidedAt: "2026-07-18T01:00:00.000Z",
      },
    ],
  });
  const c = buildFlowMetrics(data, workItem).ceremony;

  assertEquals(c.cycleOverrideCount.value, 1);
  // Keyed by the OVERRIDDEN stage (the gate id's suffix), not the stage the
  // grant was recorded in.
  assertEquals(c.boundedLoopExhaustions, [{ stage: "review", overrides: 1 }]);
  // The journal shows a later entry into review, so the override is recorded
  // as having actually unblocked it.
  assertEquals(c.stagesUnblocked, ["review"]);
  assertEquals(c.distinctDecisions[0].isCycleOverride, true);
});

Deno.test("an override with no subsequent stage entry is counted but not claimed to have unblocked", () => {
  const workItem = "WI-711";
  const data = metricsData({
    status: "active",
    stageId: "implementation",
    journal: journal([
      {
        event: "started",
        payload: { workItem, stage: "implementation" },
        at: "2026-07-18T00:00:00.000Z",
        stageId: "implementation",
      },
      {
        event: "approved",
        payload: {
          gateId: "cycle-override:review",
          actor: "human@example.com",
        },
        at: "2026-07-18T01:00:00.000Z",
        stageId: "implementation",
      },
    ], workItem),
    approvals: [
      {
        gateId: "cycle-override:review",
        version: 1,
        decision: "approved",
        stageId: "implementation",
        cycle: 1,
        decidedAt: "2026-07-18T01:00:00.000Z",
      },
    ],
  });
  const c = buildFlowMetrics(data, workItem, {
    now: "2026-07-18T02:00:00.000Z",
  }).ceremony;

  assertEquals(c.cycleOverrideCount.value, 1);
  assertEquals(c.boundedLoopExhaustions, [{ stage: "review", overrides: 1 }]);
  // No later entry into review → the records do not show it took effect.
  assertEquals(c.stagesUnblocked, []);
});

Deno.test("an absent risk profile stays unknown and is never inferred from names", () => {
  // The work item ref and stage ids both scream "security hotfix", and the
  // work order records a delivery mode but no risk/authority/work class.
  const workItem = "SEC-CRITICAL-hotfix-911";
  const data = metricsData({
    workItem,
    slug: workItem,
    status: "terminal",
    stageId: "done",
    journal: journal([
      {
        event: "started",
        payload: { workItem, stage: "hotfix" },
        at: "2026-07-18T00:00:00.000Z",
        stageId: "hotfix",
      },
      {
        event: "run_terminal",
        payload: { transition: "finish", from: "hotfix", to: "done", cycle: 1 },
        at: "2026-07-18T01:00:00.000Z",
        stageId: "done",
      },
    ], workItem),
    artifacts: [{
      name: "approved-work-order",
      version: 1,
      payload: { deliveryMode: "express" },
    }],
  });
  const c = buildFlowMetrics(data, workItem).ceremony;

  assertEquals(c.dimensions.riskProfile, null);
  assertEquals(c.dimensions.authorityProfile, null);
  assertEquals(c.dimensions.workClass, null);
  assertEquals(c.dimensions.factory, null);
});

Deno.test("recorded dimensions are read verbatim from the intake work order", () => {
  const workItem = "WI-712";
  const data = metricsData({
    workItem,
    slug: workItem,
    status: "terminal",
    stageId: "done",
    journal: reviewRunJournal(workItem),
    artifacts: [{
      name: "approved-work-order",
      version: 1,
      payload: {
        deliveryMode: "standard",
        workClass: "feature",
        riskProfile: "high",
        authorityProfile: "dual-control",
      },
    }],
  });
  const c = buildFlowMetrics(data, workItem, {
    factoryName: "my-factory",
  }).ceremony;

  assertEquals(c.dimensions.workClass, "feature");
  assertEquals(c.dimensions.riskProfile, "high");
  assertEquals(c.dimensions.authorityProfile, "dual-control");
  assertEquals(c.dimensions.factory, "my-factory");
  // Dimensions read off a record carry that record as their source.
  assert(c.dimensions.sources.length > 0);
  assertEquals(c.dimensions.sources[0].kind, "artifact");
});

Deno.test("generic evidence does not fabricate time to verified draft", () => {
  const workItem = "WI-713";
  const withEvidence = metricsData({
    workItem,
    slug: workItem,
    status: "terminal",
    stageId: "done",
    journal: journal([
      {
        event: "started",
        payload: { workItem, stage: "implementation" },
        at: "2026-07-18T00:00:00.000Z",
        stageId: "implementation",
      },
      {
        event: "evidence_recorded",
        payload: { name: "test-run" },
        at: "2026-07-18T00:45:00.000Z",
        stageId: "implementation",
      },
      {
        event: "run_terminal",
        payload: {
          transition: "finish",
          from: "implementation",
          to: "done",
          cycle: 1,
        },
        at: "2026-07-18T01:00:00.000Z",
        stageId: "done",
      },
    ], workItem),
  });
  const withEvidenceCeremony = buildFlowMetrics(withEvidence, workItem)
    .ceremony;
  assertEquals(withEvidenceCeremony.timeToVerifiedDraftMs.value, null);
  assertEquals(
    withEvidenceCeremony.timeToVerifiedDraftMs.availability,
    "unavailable",
  );
  assertStringIncludes(
    withEvidenceCeremony.timeToVerifiedDraftMs.reason ?? "",
    "explicit verified-draft",
  );

  // Without any verification lifecycle record, it is unavailable — not 0 and
  // not estimated from stage ordering.
  const withoutEvidence = metricsData({
    status: "terminal",
    stageId: "done",
    journal: reviewRunJournal("WI-714"),
  });
  const c = buildFlowMetrics(withoutEvidence, "WI-714").ceremony;
  assertEquals(c.timeToVerifiedDraftMs.value, null);
  assertEquals(c.timeToVerifiedDraftMs.availability, "unavailable");
  assert(c.timeToVerifiedDraftMs.reason !== undefined);
});

Deno.test("a run with no approval records reports decisions unavailable, not zero", () => {
  const data = metricsData({
    status: "terminal",
    stageId: "done",
    journal: reviewRunJournal("WI-715"),
    // The journal shows an `approved` event, but the approval record itself
    // was garbage-collected.
  });
  const c = buildFlowMetrics(data, "WI-715").ceremony;

  assertEquals(c.humanTouches.value, null);
  assertEquals(c.humanTouches.availability, "unavailable");
  assertEquals(c.distinctDecisionCount.value, null);
  assertEquals(c.approvals.value, null);
  assertEquals(c.rejections.value, null);
  assert(c.humanTouches.reason !== undefined);
});

Deno.test("truncated approval history is labelled partial as a lower bound", () => {
  const data = metricsData({
    status: "terminal",
    stageId: "done",
    journal: reviewRunJournal("WI-716"),
    approvals: [
      {
        gateId: "ship-it",
        version: 4,
        decision: "approved",
        stageId: "review",
        cycle: 1,
        decidedAt: "2026-07-18T01:30:00.000Z",
      },
    ],
    approvalsTruncated: true,
  });
  const c = buildFlowMetrics(data, "WI-716").ceremony;
  assertEquals(c.distinctDecisionCount.availability, "partial");
  assertEquals(c.approvalsTruncated, true);
  assert(c.distinctDecisionCount.reason !== undefined);
});

Deno.test("cross-run aggregation never averages unavailable durations into zero", () => {
  // Run A: a measurable 30-minute approval wait and a verified draft.
  const runA = buildFlowMetrics(
    metricsData({
      workItem: "WI-A",
      slug: "WI-A",
      status: "terminal",
      stageId: "done",
      journal: journal([
        {
          event: "started",
          payload: { workItem: "WI-A", stage: "implementation" },
          at: "2026-07-18T00:00:00.000Z",
          stageId: "implementation",
        },
        {
          event: "evidence_recorded",
          payload: { name: "test-run" },
          at: "2026-07-18T00:30:00.000Z",
          stageId: "implementation",
        },
        {
          event: "advanced",
          payload: {
            transition: "to-review",
            from: "implementation",
            to: "review",
            cycle: 1,
          },
          at: "2026-07-18T01:00:00.000Z",
          stageId: "review",
        },
        {
          event: "run_terminal",
          payload: {
            transition: "finish",
            from: "review",
            to: "done",
            cycle: 1,
          },
          at: "2026-07-18T02:00:00.000Z",
          stageId: "done",
        },
      ], "WI-A"),
      approvals: [{
        gateId: "ship-it",
        version: 1,
        decision: "approved",
        stageId: "review",
        cycle: 1,
        decidedAt: "2026-07-18T01:30:00.000Z",
      }],
    }),
    "WI-A",
  );

  // Run B: a decision whose pending moment is unknowable, and no verified
  // draft at all.
  const runB = buildFlowMetrics(
    metricsData({
      workItem: "WI-B",
      slug: "WI-B",
      status: "terminal",
      stageId: "done",
      journal: reviewRunJournal("WI-B"),
      approvals: [{
        gateId: "ship-it",
        version: 1,
        decision: "approved",
        stageId: "review",
        cycle: 7, // no journal entry into review cycle 7
        decidedAt: "2026-07-18T01:30:00.000Z",
      }],
    }),
    "WI-B",
  );

  const agg = aggregateFlowMetrics([runA, runB]).ceremony;

  // Neither stage entry nor generic evidence supplies either canonical
  // endpoint, and the aggregate never turns either missing duration into 0.
  assertEquals(agg.meanApprovalWaitMs.value, null);
  assertEquals(agg.meanApprovalWaitMs.availability, "unavailable");
  assertEquals(agg.approvalWaitCoverage, { covered: 0, total: 2 });

  assertEquals(agg.meanTimeToVerifiedDraftMs.value, null);
  assertEquals(agg.meanTimeToVerifiedDraftMs.availability, "unavailable");
  assertEquals(agg.meanTimeToVerifiedDraftMs.covered, 0);
  assertEquals(agg.meanTimeToVerifiedDraftMs.total, 2);

  // Counts still fold across both runs.
  assertEquals(agg.runs, 2);
  assertEquals(agg.runsWithDecisionRecords, 2);
  assertEquals(agg.totalApprovals.value, 2);
  assertEquals(agg.approvalsByGate["ship-it"], 2);
});

Deno.test("cross-run aggregation reports unavailable when no run had a measurable value", () => {
  const noRecords = () =>
    buildFlowMetrics(
      metricsData({
        status: "terminal",
        stageId: "done",
        journal: reviewRunJournal("WI-C"),
      }),
      "WI-C",
    );
  const agg = aggregateFlowMetrics([noRecords(), noRecords()]).ceremony;

  assertEquals(agg.totalApprovals.value, null);
  assertEquals(agg.totalApprovals.availability, "unavailable");
  assertEquals(agg.runsWithDecisionRecords, 0);
  assertEquals(agg.meanApprovalWaitMs.value, null);
  assertEquals(agg.meanApprovalWaitMs.availability, "unavailable");
  assertEquals(agg.meanTimeToVerifiedDraftMs.value, null);
});

Deno.test("cross-run dimension buckets keep absent dimensions as unknown", () => {
  const known = buildFlowMetrics(
    metricsData({
      workItem: "WI-D",
      slug: "WI-D",
      status: "terminal",
      stageId: "done",
      journal: reviewRunJournal("WI-D"),
      artifacts: [{
        name: "approved-work-order",
        version: 1,
        payload: { riskProfile: "high", workClass: "feature" },
      }],
    }),
    "WI-D",
  );
  const unknown = buildFlowMetrics(
    metricsData({
      workItem: "WI-E",
      slug: "WI-E",
      status: "terminal",
      stageId: "done",
      journal: reviewRunJournal("WI-E"),
    }),
    "WI-E",
  );
  const agg = aggregateFlowMetrics([known, unknown]).ceremony;

  assertEquals(agg.runsByRiskProfile["high"], 1);
  assertEquals(agg.runsByRiskProfile["unknown"], 1);
  assertEquals(agg.runsByWorkClass["feature"], 1);
  assertEquals(agg.runsByWorkClass["unknown"], 1);
  assertEquals(agg.runsByAuthorityProfile["unknown"], 2);
});

Deno.test("loadMetricsData reads approval records addressed by gate ids in the journal", async () => {
  const slug = workItemSlug("WI-F");
  const reads: string[] = [];
  const store: Record<string, Record<number, Record<string, unknown>>> = {
    [`state-${slug}`]: {
      1: {
        workItem: "WI-F",
        stageId: "done",
        cycles: { review: 1 },
        enteredAt: "2026-07-18T02:00:00.000Z",
        status: "terminal",
        definitionVersion: 1,
        startedAt: "2026-07-18T00:00:00.000Z",
      },
    },
    [`journal-${slug}`]: {
      1: {
        event: "started",
        workItem: "WI-F",
        stageId: "review",
        summary: "started",
        payload: { workItem: "WI-F", stage: "review" },
        at: "2026-07-18T00:00:00.000Z",
      },
      2: {
        event: "approved",
        workItem: "WI-F",
        stageId: "review",
        summary: "approved",
        payload: { gateId: "ship-it", actor: "human@example.com" },
        at: "2026-07-18T01:00:00.000Z",
      },
    },
    [`approval-${slug}-ship-it`]: {
      1: {
        gateId: "ship-it",
        workItem: "WI-F",
        decision: "approved",
        actor: "human@example.com",
        stageId: "review",
        cycle: 1,
        decidedAt: "2026-07-18T01:00:00.000Z",
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

  // The journal's decision event named the gate, which addressed the record.
  assertEquals(data.approvalVersions.get("ship-it")?.size, 1);
  assert(reads.includes(`read:approval-${slug}-ship-it`));

  const c = buildFlowMetrics(data, "WI-F").ceremony;
  assertEquals(c.distinctDecisionCount.value, 1);
  // Entered review at start and decided an hour later, but no canonical
  // pending timestamp exists, so that interval is not called approval wait.
  assertEquals(c.approvalWaits[0].waitMs, null);
  assertEquals(c.approvalWaits[0].availability, "unavailable");
  // The decision carries an approval-record source pointer.
  assert(c.humanTouches.sources.some((s) => s.kind === "approval"));
});
