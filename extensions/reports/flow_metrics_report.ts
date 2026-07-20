// MIT License
//
// Copyright (c) 2026 Mat Greten
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * Flow-metrics report for @swamp/software-factory.
 *
 * A quality / reliability / flow report over recorded factory run data —
 * NOT another harvester or lifecycle database. It fires after the factory's
 * `summary` method (scope: method), exactly like the run-audit report, and
 * reconstructs the learning metrics deterministically from the
 * same journal-replay spine run-audit uses:
 *
 *   - per-run time-to-terminal (start → terminal `run_terminal`);
 *   - per-stage durations and entry counts, aggregated across `eraStart`
 *     (reset) cycles;
 *   - dispatch attempts (the `dispatched` journal events);
 *   - failed / parked stage identification (terminal `*-blocked` /
 *     `cleanup-required` / `aborted` stages);
 *   - human-approval touch count (`approved` + `rejected` events);
 *   - patch-cycle count (`findings_resolved` events + patch-stage re-entries);
 *   - terminal outcome class (done | cleanup-required | parked | aborted |
 *     active | unknown).
 *
 * Every displayed number carries a source pointer back to the journal /
 * artifact record it came from, exactly like run-audit's flags. When more
 * than one run exists on the model instance, a cross-run aggregate section
 * summarizes accepted-first-pass rate, cycle time, attempts, human touches,
 * and cleanup health across all of them.
 *
 * No LLM is involved anywhere: the same run data always produces the same
 * metrics. This module is deliberately zero-dependency and zod-free — report
 * bundles are built WITHOUT the extension import map, so nothing here may
 * import a bare npm specifier. All run-name helpers are reimplemented inline
 * and all decoded content is shape-checked with hand-written structural
 * guards, so the report is fully self-contained and bundles cleanly. Its
 * output is JSON-serializable, and the failure path persists the reason.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Run-name helpers (reimplemented inline; see models/_lib/run_names.ts).
// Kept zero-dependency so this report bundles without the import map.
// ---------------------------------------------------------------------------

const STATE_PREFIX = "state-";
const JOURNAL_PREFIX = "journal-";
const ARTIFACT_PREFIX = "artifact-";
const EVIDENCE_PREFIX = "evidence-";

/**
 * Turn an arbitrary workItem ref into a deterministic, data-instance-safe
 * slug. Name-safe refs pass through unchanged; anything lossy gets a stable
 * FNV-1a suffix so distinct work items can never collide after sanitization.
 * Identical to run_audit_report.workItemSlug so both reports address the same
 * records.
 */
export function workItemSlug(workItem: string): string {
  const sanitized = workItem
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48);
  if (sanitized === workItem) return workItem;
  let hash = 0x811c9dc5;
  for (let i = 0; i < workItem.length; i++) {
    hash ^= workItem.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const suffix = hash.toString(16).padStart(8, "0");
  return sanitized.length > 0 ? `${sanitized}-${suffix}` : suffix;
}

function stateInstance(slug: string): string {
  return `${STATE_PREFIX}${slug}`;
}

function journalInstance(slug: string): string {
  return `${JOURNAL_PREFIX}${slug}`;
}

function artifactInstance(slug: string, name: string): string {
  return `${ARTIFACT_PREFIX}${slug}-${name}`;
}

function evidenceInstance(slug: string, name: string): string {
  return `${EVIDENCE_PREFIX}${slug}-${name}`;
}

// ---------------------------------------------------------------------------
// Envelope shapes (structural, local — see models/_lib/run_data.ts).
// Defined locally so the report is self-contained.
// ---------------------------------------------------------------------------

interface RunState {
  workItem: string;
  stageId: string;
  cycles: Record<string, number>;
  enteredAt: string;
  status: "active" | "terminal";
  definitionVersion: number;
  startedAt: string;
}

interface ArtifactEnvelope {
  name: string;
  workItem: string;
  stageId: string;
  cycle: number;
  payload: Record<string, unknown>;
  subjectVersion?: number;
  recordedAt: string;
  note?: string;
}

interface EvidenceEnvelope {
  name: string;
  workItem: string;
  stageId: string;
  cycle: number;
  payload: Record<string, unknown>;
  recordedAt: string;
}

interface JournalEntry {
  event: string;
  workItem: string;
  stageId?: string;
  summary: string;
  payload?: Record<string, unknown>;
  at: string;
}

// ---------------------------------------------------------------------------
// Data access: a minimal reader over swamp's data repository, exactly the
// interface the tests hand-implement over fixture data (mirrors run-audit).
// ---------------------------------------------------------------------------

/** Minimal read interface over a run's recorded data (state/journal/etc). */
export interface RunDataReader {
  /** Every stored version of a data name, ascending. */
  versionsOf(name: string): Promise<number[]>;
  /** Parsed JSON content of one version (latest when omitted). */
  read(
    name: string,
    version?: number,
  ): Promise<Record<string, unknown> | null>;
}

/** The content-fetch slice the repository-backed reader needs. */
interface ContentRepositoryLike {
  getContent(
    type: unknown,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
  listVersions?(
    type: unknown,
    modelId: string,
    dataName: string,
  ): Promise<number[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(
  repo: ContentRepositoryLike,
  modelType: unknown,
  modelId: string,
  name: string,
  version?: number,
): Promise<Record<string, unknown> | null> {
  const content = await repo.getContent(modelType, modelId, name, version);
  if (content === null) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(content));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reader backed directly by the data repository's `listVersions` /
 * `getContent`. Used in report contexts, where no query service is exposed.
 * Reimplemented inline (mirrors run_audit_report.repositoryRunDataReader) so
 * this report bundles zero-dependency.
 */
function repositoryRunDataReader(opts: {
  dataRepository: ContentRepositoryLike;
  modelType: unknown;
  modelId: string;
}): RunDataReader {
  return {
    versionsOf: (name) => {
      if (opts.dataRepository.listVersions === undefined) {
        return Promise.resolve([]);
      }
      return opts.dataRepository.listVersions(
        opts.modelType,
        opts.modelId,
        name,
      );
    },
    read: (name, version) =>
      readJson(
        opts.dataRepository,
        opts.modelType,
        opts.modelId,
        name,
        version,
      ),
  };
}

// ---------------------------------------------------------------------------
// Structural guards (zod-free shape checks for decoded run data).
// Tolerant by design: invalid records are skipped, never fatal.
// ---------------------------------------------------------------------------

function asRunState(value: Record<string, unknown> | null): RunState | null {
  if (value === null) return null;
  if (
    typeof value.workItem !== "string" ||
    typeof value.stageId !== "string" ||
    (value.status !== "active" && value.status !== "terminal") ||
    typeof value.definitionVersion !== "number" ||
    typeof value.enteredAt !== "string" ||
    typeof value.startedAt !== "string" ||
    !isRecord(value.cycles)
  ) {
    return null;
  }
  return value as unknown as RunState;
}

function asJournalEntry(
  value: Record<string, unknown> | null,
): JournalEntry | null {
  if (value === null) return null;
  if (
    typeof value.event !== "string" ||
    typeof value.workItem !== "string" ||
    typeof value.summary !== "string" ||
    typeof value.at !== "string"
  ) {
    return null;
  }
  if (value.stageId !== undefined && typeof value.stageId !== "string") {
    return null;
  }
  if (value.payload !== undefined && !isRecord(value.payload)) return null;
  return value as unknown as JournalEntry;
}

function asEnvelope(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (value === null) return null;
  if (
    typeof value.name !== "string" ||
    typeof value.workItem !== "string" ||
    typeof value.stageId !== "string" ||
    typeof value.cycle !== "number" ||
    typeof value.recordedAt !== "string" ||
    !isRecord(value.payload)
  ) {
    return null;
  }
  return value;
}

function asArtifactEnvelope(
  value: Record<string, unknown> | null,
): ArtifactEnvelope | null {
  const envelope = asEnvelope(value);
  if (envelope === null) return null;
  if (
    envelope.subjectVersion !== undefined &&
    typeof envelope.subjectVersion !== "number"
  ) {
    return null;
  }
  if (envelope.note !== undefined && typeof envelope.note !== "string") {
    return null;
  }
  return envelope as unknown as ArtifactEnvelope;
}

function asEvidenceEnvelope(
  value: Record<string, unknown> | null,
): EvidenceEnvelope | null {
  const envelope = asEnvelope(value);
  return envelope === null ? null : envelope as unknown as EvidenceEnvelope;
}

// ---------------------------------------------------------------------------
// Metrics data loading: journal-driven, mirroring run-audit's loadAuditData.
// The journal names every record the run ever touched, so loading reads
// state, all journal versions, then every version of each referenced
// artifact / evidence name.
// ---------------------------------------------------------------------------

/** All run data loaded for one work item: state, journal, and versioned records. */
export interface MetricsData {
  slug: string;
  state: RunState | null;
  /** Journal entries oldest-first, with their version numbers. */
  journal: { version: number; entry: JournalEntry }[];
  /** True when the journal's earliest versions were garbage-collected. */
  journalTruncated: boolean;
  /** Logical artifact name → version → envelope (missing = GC'd). */
  artifactVersions: Map<string, Map<number, ArtifactEnvelope>>;
  /** Logical evidence name → version → envelope (missing = GC'd). */
  evidenceVersions: Map<string, Map<number, EvidenceEnvelope>>;
}

export async function loadMetricsData(
  reader: RunDataReader,
  slug: string,
): Promise<MetricsData> {
  const data: MetricsData = {
    slug,
    state: null,
    journal: [],
    journalTruncated: false,
    artifactVersions: new Map(),
    evidenceVersions: new Map(),
  };

  data.state = asRunState(await reader.read(stateInstance(slug)));

  const journalName = journalInstance(slug);
  const journalVersions = await reader.versionsOf(journalName);
  data.journalTruncated = journalVersions.length > 0 && journalVersions[0] > 1;
  for (const version of journalVersions) {
    const entry = asJournalEntry(await reader.read(journalName, version));
    if (entry === null) {
      data.journalTruncated = true;
      continue;
    }
    data.journal.push({ version, entry });
  }

  // Names referenced by the surviving journal events.
  const artifactNames = new Set<string>();
  const evidenceNames = new Set<string>();
  for (const { entry } of data.journal) {
    const payload = entry.payload ?? {};
    if (
      entry.event === "artifact_recorded" && typeof payload.name === "string"
    ) {
      artifactNames.add(payload.name);
    }
    if (
      entry.event === "findings_resolved" &&
      typeof payload.artifact === "string"
    ) {
      artifactNames.add(payload.artifact);
    }
    if (
      entry.event === "evidence_recorded" && typeof payload.name === "string"
    ) {
      evidenceNames.add(payload.name);
    }
  }

  for (const name of artifactNames) {
    const instance = artifactInstance(slug, name);
    const perVersion = new Map<number, ArtifactEnvelope>();
    for (const version of await reader.versionsOf(instance)) {
      const envelope = asArtifactEnvelope(await reader.read(instance, version));
      if (envelope !== null) perVersion.set(version, envelope);
    }
    data.artifactVersions.set(name, perVersion);
  }

  for (const name of evidenceNames) {
    const instance = evidenceInstance(slug, name);
    const perVersion = new Map<number, EvidenceEnvelope>();
    for (const version of await reader.versionsOf(instance)) {
      const envelope = asEvidenceEnvelope(await reader.read(instance, version));
      if (envelope !== null) perVersion.set(version, envelope);
    }
    data.evidenceVersions.set(name, perVersion);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Metric shapes.
// ---------------------------------------------------------------------------

/** Where a displayed number came from, so every metric is traceable. */
export interface MetricSource {
  kind: "state" | "journal" | "artifact" | "evidence";
  name: string;
  version?: number;
}

/** A single value paired with the record(s) it was derived from. */
export interface TracedValue<T> {
  value: T;
  /** Source pointers back to the journal/artifact records. */
  sources: MetricSource[];
}

/** The class a run's terminal state falls into. */
export type TerminalOutcomeClass =
  | "done"
  | "cleanup-required"
  | "parked"
  | "aborted"
  | "active"
  | "unknown";

/** Per-stage durations and entry counts, aggregated across eras. */
export interface StageMetric {
  stageId: string;
  /** Number of distinct visits (entries) to this stage across all eras. */
  entries: number;
  /** Total wall-clock ms spent in this stage (sum over visits). */
  totalMs: number;
  /** Dispatch attempts recorded while in this stage (across eras). */
  dispatchAttempts: number;
  /** True when this stage is the run's terminal (failed/parked) landing. */
  terminal: boolean;
}

/** The full set of reconstructed flow metrics for a single run. */
export interface FlowMetrics {
  workItem: string;
  runStatus: "active" | "terminal" | "unknown";
  currentStageId?: string;
  /** start → terminal, in ms, when the run has terminated. */
  timeToTerminalMs: TracedValue<number | null>;
  /** Number of eras (start + resets). */
  eras: TracedValue<number>;
  /** Per-stage rollup, sorted by stageId for deterministic output. */
  stages: StageMetric[];
  /** Total dispatch attempts across every stage and era. */
  dispatchAttempts: TracedValue<number>;
  /** The stage the run failed / parked at, if terminal-and-not-done. */
  failedStage: TracedValue<string | null>;
  /** Human approvals + rejections (interventions on the run). */
  humanTouches: TracedValue<number>;
  /** Approvals granted and rejections issued, split out. */
  approvals: number;
  rejections: number;
  /** findings_resolved events + re-entries into a patch stage. */
  patchCycles: TracedValue<number>;
  /** Terminal outcome class. */
  outcome: TracedValue<TerminalOutcomeClass>;
  /** True when the run terminated at `done` with zero human rejections
   * and exactly one implementation era (no reset) — accepted first pass. */
  acceptedFirstPass: boolean;
  journalTruncated: boolean;
}

/** Cross-run aggregate, rendered only when >1 run exists on the model. */
export interface FlowAggregate {
  runs: number;
  terminalRuns: number;
  doneRuns: number;
  parkedRuns: number;
  cleanupRequiredRuns: number;
  abortedRuns: number;
  activeRuns: number;
  /** doneRuns / terminalRuns, or null when no terminal run exists. */
  acceptedFirstPassRate: number | null;
  /** Mean time-to-terminal ms over terminated runs, or null. */
  meanTimeToTerminalMs: number | null;
  totalDispatchAttempts: number;
  totalHumanTouches: number;
  totalPatchCycles: number;
  /** cleanupRequiredRuns / terminalRuns, or null. */
  cleanupFailureRate: number | null;
}

/** The rendered report: primary run metrics plus an optional cross-run aggregate. */
export interface FlowMetricsReport {
  /** The primary work item this report was built for. */
  workItem: string;
  metrics: FlowMetrics;
  /** Present only when more than one run exists on the model instance. */
  aggregate?: FlowAggregate;
  /** Per-run metrics for every run that fed the aggregate (primary first). */
  allRuns?: FlowMetrics[];
}

// ---------------------------------------------------------------------------
// Reconstruction helpers.
// ---------------------------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Terminal stage ids that mean the run failed or was parked. */
const PARKED_TERMINAL_STAGES = new Set([
  "chore-blocked",
  "test-blocked",
  "review-blocked",
  "browser-blocked",
  "reproduction-blocked",
  "hotfix-blocked",
  "qa-blocked",
  "stack-blocked",
]);
const CLEANUP_TERMINAL_STAGE = "cleanup-required";
const ABORTED_TERMINAL_STAGE = "aborted";
const DONE_TERMINAL_STAGE = "done";

/** A stage id reads as a patch stage when it names "patch". */
function isPatchStage(stageId: string): boolean {
  return stageId.toLowerCase().includes("patch");
}

function msBetween(fromIso: string, toIso: string): number | undefined {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return undefined;
  const ms = to - from;
  return ms < 0 ? 0 : ms;
}

/** One reconstructed stage visit (a contiguous occupancy of a stage). */
interface Visit {
  stageId: string;
  enteredAt: string;
  leftAt?: string;
  enteredVia: string;
  terminal: boolean;
  /** Journal version that opened this visit, for tracing. */
  openVersion: number;
}

/**
 * Classify a terminal run by its final stage id.
 * `done` → done; cleanup-required → cleanup-required; aborted → aborted; a
 * `*-blocked` stage → parked; anything else terminal → parked (conservative).
 */
function classifyTerminal(stageId: string): TerminalOutcomeClass {
  if (stageId === DONE_TERMINAL_STAGE) return "done";
  if (stageId === CLEANUP_TERMINAL_STAGE) return "cleanup-required";
  if (stageId === ABORTED_TERMINAL_STAGE) return "aborted";
  if (PARKED_TERMINAL_STAGES.has(stageId)) return "parked";
  return "parked";
}

// ---------------------------------------------------------------------------
// buildFlowMetrics: the pure reconstruction core over one run's MetricsData.
// ---------------------------------------------------------------------------

/** Options controlling `buildFlowMetrics` reconstruction. */
export interface BuildFlowMetricsOptions {
  /** "now" for open-visit duration; defaults to new Date().toISOString(). */
  now?: string;
}

/**
 * Reconstruct one run's flow metrics from its loaded data. Pure over
 * `MetricsData`: replays the journal into stage visits, eras, dispatches, and
 * human touches, then derives every headline metric with its source pointers.
 */
export function buildFlowMetrics(
  data: MetricsData,
  workItem: string,
  options: BuildFlowMetricsOptions = {},
): FlowMetrics {
  const now = options.now ?? new Date().toISOString();
  const state = data.state;
  const runStatus: "active" | "terminal" | "unknown" = state?.status ??
    "unknown";
  const currentStageId = state?.stageId;

  const journalSource = (version: number): MetricSource => ({
    kind: "journal",
    name: journalInstance(data.slug),
    version,
  });
  const stateSource: MetricSource = {
    kind: "state",
    name: stateInstance(data.slug),
  };

  // --- Journal replay into stage visits, era count, dispatches, touches ----
  const visits: Visit[] = [];
  let current: Visit | null = null;
  let eras = 0;
  let startedAt: string | undefined;
  let terminalAt: string | undefined;
  let terminalStageId: string | undefined;
  let terminalVersion: number | undefined;

  let dispatchAttempts = 0;
  const dispatchSources: MetricSource[] = [];
  let approvals = 0;
  let rejections = 0;
  const touchSources: MetricSource[] = [];
  let patchCycles = 0;
  const patchSources: MetricSource[] = [];

  // Per-stage rollup keyed by stageId.
  const stageEntries = new Map<string, number>();
  const stageMs = new Map<string, number>();
  const stageDispatches = new Map<string, number>();

  const closeVisit = (visit: Visit, at: string) => {
    if (visit.leftAt === undefined) visit.leftAt = at;
    const ms = msBetween(visit.enteredAt, at) ?? 0;
    stageMs.set(visit.stageId, (stageMs.get(visit.stageId) ?? 0) + ms);
  };

  const openVisit = (visit: Visit) => {
    if (current !== null) closeVisit(current, visit.enteredAt);
    visits.push(visit);
    stageEntries.set(visit.stageId, (stageEntries.get(visit.stageId) ?? 0) + 1);
    if (isPatchStage(visit.stageId)) {
      patchCycles += 1;
      patchSources.push(journalSource(visit.openVersion));
    }
    current = visit;
  };

  for (const { version, entry } of data.journal) {
    const payload = entry.payload ?? {};
    switch (entry.event) {
      case "started": {
        eras += 1;
        startedAt ??= str(payload.startedAt) ?? entry.at;
        openVisit({
          stageId: str(payload.stage) ?? entry.stageId ?? "(unknown)",
          enteredAt: entry.at,
          enteredVia: "start",
          terminal: false,
          openVersion: version,
        });
        break;
      }
      case "reset": {
        eras += 1;
        openVisit({
          stageId: entry.stageId ?? "(unknown)",
          enteredAt: entry.at,
          enteredVia: "reset",
          terminal: false,
          openVersion: version,
        });
        break;
      }
      case "advanced":
      case "run_terminal": {
        const to = str(payload.to) ?? entry.stageId ?? "(unknown)";
        const transition = str(payload.transition) ?? "(unknown)";
        const terminal = entry.event === "run_terminal";
        openVisit({
          stageId: to,
          enteredAt: entry.at,
          enteredVia: transition,
          terminal,
          openVersion: version,
        });
        if (terminal) {
          terminalAt = entry.at;
          terminalStageId = to;
          terminalVersion = version;
        }
        break;
      }
      case "dispatched": {
        const currentStage: string | undefined = current === null
          ? undefined
          : (current as Visit).stageId;
        const stageId = str(payload.stageId) ?? currentStage ?? "(unknown)";
        dispatchAttempts += 1;
        stageDispatches.set(stageId, (stageDispatches.get(stageId) ?? 0) + 1);
        dispatchSources.push(journalSource(version));
        break;
      }
      case "approved": {
        approvals += 1;
        touchSources.push(journalSource(version));
        break;
      }
      case "rejected": {
        rejections += 1;
        touchSources.push(journalSource(version));
        break;
      }
      case "findings_resolved": {
        patchCycles += 1;
        patchSources.push(journalSource(version));
        break;
      }
      default:
        break;
    }
  }

  // Close the final open visit: terminal stages have no duration; a still
  // active run's current visit runs to `now`.
  if (current !== null) {
    const visit: Visit = current;
    if (visit.terminal) {
      if (visit.leftAt === undefined) visit.leftAt = visit.enteredAt;
    } else {
      closeVisit(visit, now);
    }
  }

  // --- Per-stage rollup ----------------------------------------------------
  const stageIds = new Set<string>([
    ...stageEntries.keys(),
    ...stageMs.keys(),
    ...stageDispatches.keys(),
  ]);
  const stages: StageMetric[] = [...stageIds]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((stageId) => ({
      stageId,
      entries: stageEntries.get(stageId) ?? 0,
      totalMs: stageMs.get(stageId) ?? 0,
      dispatchAttempts: stageDispatches.get(stageId) ?? 0,
      terminal: terminalStageId === stageId && runStatus === "terminal",
    }));

  // --- Time to terminal ----------------------------------------------------
  let timeToTerminal: number | null = null;
  const ttSources: MetricSource[] = [];
  if (
    runStatus === "terminal" && startedAt !== undefined &&
    terminalAt !== undefined
  ) {
    timeToTerminal = msBetween(startedAt, terminalAt) ?? null;
    ttSources.push(stateSource);
    if (terminalVersion !== undefined) {
      ttSources.push(journalSource(terminalVersion));
    }
  }

  // --- Failed / parked stage identification --------------------------------
  let failedStage: string | null = null;
  const failedSources: MetricSource[] = [];
  if (
    runStatus === "terminal" && terminalStageId !== undefined &&
    terminalStageId !== DONE_TERMINAL_STAGE
  ) {
    failedStage = terminalStageId;
    failedSources.push(
      terminalVersion !== undefined
        ? journalSource(terminalVersion)
        : stateSource,
    );
  }

  // --- Terminal outcome class ----------------------------------------------
  let outcome: TerminalOutcomeClass;
  const outcomeSources: MetricSource[] = [];
  if (runStatus === "active") {
    outcome = "active";
    outcomeSources.push(stateSource);
  } else if (runStatus === "terminal" && terminalStageId !== undefined) {
    outcome = classifyTerminal(terminalStageId);
    outcomeSources.push(
      terminalVersion !== undefined
        ? journalSource(terminalVersion)
        : stateSource,
    );
  } else {
    outcome = "unknown";
  }

  // --- Accepted-first-pass -------------------------------------------------
  // A run accepted on the first pass reached terminal `done` with no
  // rejection and no reset (exactly one era).
  const acceptedFirstPass = runStatus === "terminal" &&
    terminalStageId === DONE_TERMINAL_STAGE &&
    rejections === 0 && eras <= 1;

  const humanTouches = approvals + rejections;

  return {
    workItem,
    runStatus,
    currentStageId,
    timeToTerminalMs: { value: timeToTerminal, sources: ttSources },
    eras: {
      value: eras,
      sources: eras > 0 ? [stateSource] : [],
    },
    stages,
    dispatchAttempts: {
      value: dispatchAttempts,
      sources: dispatchSources,
    },
    failedStage: { value: failedStage, sources: failedSources },
    humanTouches: { value: humanTouches, sources: touchSources },
    approvals,
    rejections,
    patchCycles: { value: patchCycles, sources: patchSources },
    outcome: { value: outcome, sources: outcomeSources },
    acceptedFirstPass,
    journalTruncated: data.journalTruncated,
  };
}

// ---------------------------------------------------------------------------
// aggregateFlowMetrics: fold many per-run metrics into a cross-run summary.
// ---------------------------------------------------------------------------

/** Fold many per-run metrics into a cross-run summary (rates, means, totals). */
export function aggregateFlowMetrics(runs: FlowMetrics[]): FlowAggregate {
  const terminal = runs.filter((r) => r.runStatus === "terminal");
  const doneRuns = terminal.filter((r) => r.outcome.value === "done").length;
  const parkedRuns =
    terminal.filter((r) => r.outcome.value === "parked").length;
  const cleanupRequiredRuns =
    terminal.filter((r) => r.outcome.value === "cleanup-required").length;
  const abortedRuns =
    terminal.filter((r) => r.outcome.value === "aborted").length;
  const activeRuns = runs.filter((r) => r.runStatus === "active").length;

  const terminalWithTime = terminal
    .map((r) => r.timeToTerminalMs.value)
    .filter((v): v is number => typeof v === "number");
  const meanTimeToTerminalMs = terminalWithTime.length > 0
    ? Math.round(
      terminalWithTime.reduce((a, b) => a + b, 0) / terminalWithTime.length,
    )
    : null;

  return {
    runs: runs.length,
    terminalRuns: terminal.length,
    doneRuns,
    parkedRuns,
    cleanupRequiredRuns,
    abortedRuns,
    activeRuns,
    acceptedFirstPassRate: terminal.length > 0
      ? doneRuns / terminal.length
      : null,
    meanTimeToTerminalMs,
    totalDispatchAttempts: runs.reduce(
      (a, r) => a + r.dispatchAttempts.value,
      0,
    ),
    totalHumanTouches: runs.reduce((a, r) => a + r.humanTouches.value, 0),
    totalPatchCycles: runs.reduce((a, r) => a + r.patchCycles.value, 0),
    cleanupFailureRate: terminal.length > 0
      ? cleanupRequiredRuns / terminal.length
      : null,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering — deterministic; same report always renders the same.
// ---------------------------------------------------------------------------

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, "<br>");
}

/** Whole seconds/minutes/hours from ms, for human-readable durations. */
export function fmtDuration(ms: number): string {
  if (ms < 0) return "0s";
  const seconds = Math.round(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function countDistinct(sources: MetricSource[]): number {
  const seen = new Set<string>();
  for (const s of sources) {
    seen.add(
      `${s.kind} ${s.name}${s.version !== undefined ? ` v${s.version}` : ""}`,
    );
  }
  return seen.size;
}

function sourcePointer(sources: MetricSource[]): string {
  if (sources.length === 0) return "source: (none)";
  // Collapse to distinct kind+name(+version) pointers, capped for readability.
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const s of sources) {
    const key = `${s.kind} ${s.name}${
      s.version !== undefined ? ` v${s.version}` : ""
    }`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(key);
    if (parts.length >= 4) break;
  }
  const suffix = seen.size < countDistinct(sources) ? " …" : "";
  return `source: ${parts.join(", ")}${suffix}`;
}

function fmtTtt(value: number | null): string {
  return value === null ? "—" : `${fmtDuration(value)} (${value} ms)`;
}

function renderRunMetrics(m: FlowMetrics): string[] {
  const lines: string[] = [];
  const statusBits: string[] = [`**Run status:** ${m.runStatus}`];
  if (m.currentStageId !== undefined) {
    statusBits.push(`**Current stage:** \`${m.currentStageId}\``);
  }
  statusBits.push(`**Outcome:** ${m.outcome.value}`);
  lines.push(statusBits.join(" · "), "");

  if (m.journalTruncated) {
    lines.push(
      "_The earliest journal entries were garbage-collected; these metrics" +
        " begin at the oldest surviving event._",
      "",
    );
  }

  // Headline metrics, each with a visible source pointer.
  lines.push("| Metric | Value | Traceability |", "| --- | --- | --- |");
  const row = (label: string, value: string, tv: TracedValue<unknown>) =>
    lines.push(
      `| ${escapeCell(label)} | ${escapeCell(value)} | _${
        escapeCell(sourcePointer(tv.sources))
      }_ |`,
    );
  row("Time to terminal", fmtTtt(m.timeToTerminalMs.value), m.timeToTerminalMs);
  row("Eras (start + resets)", String(m.eras.value), m.eras);
  row(
    "Dispatch attempts",
    String(m.dispatchAttempts.value),
    m.dispatchAttempts,
  );
  row(
    "Human touches",
    `${m.humanTouches.value} (${m.approvals} approved, ${m.rejections} rejected)`,
    m.humanTouches,
  );
  row("Patch cycles", String(m.patchCycles.value), m.patchCycles);
  row("Failed/parked stage", m.failedStage.value ?? "—", m.failedStage);
  row("Accepted first pass", m.acceptedFirstPass ? "yes" : "no", m.outcome);
  lines.push("");

  // Per-stage rollup.
  lines.push("### Per-stage rollup", "");
  if (m.stages.length === 0) {
    lines.push("_No stage visits reconstructed._", "");
  } else {
    lines.push(
      "| Stage | Entries | Total time | Dispatch attempts | Terminal |",
      "| --- | ---: | ---: | ---: | --- |",
    );
    for (const s of m.stages) {
      lines.push(
        "| " +
          [
            `\`${escapeCell(s.stageId)}\``,
            String(s.entries),
            fmtDuration(s.totalMs),
            String(s.dispatchAttempts),
            s.terminal ? "yes" : "no",
          ].join(" | ") +
          " |",
      );
    }
    lines.push("");
  }
  return lines;
}

/** Render a report to deterministic markdown (same report → same output). */
export function renderFlowMetricsMarkdown(report: FlowMetricsReport): string {
  const lines: string[] = [];
  lines.push(`# Flow Metrics: ${report.workItem}`, "");

  lines.push(...renderRunMetrics(report.metrics));

  // Cross-run aggregate, only when present.
  if (report.aggregate !== undefined) {
    const a = report.aggregate;
    lines.push("## Cross-run aggregate", "");
    lines.push(
      [
        `${a.runs} run${a.runs === 1 ? "" : "s"}`,
        `${a.terminalRuns} terminal`,
        `${a.activeRuns} active`,
      ].join(" · "),
      "",
    );
    lines.push("| Aggregate metric | Value |", "| --- | --- |");
    const arow = (label: string, value: string) =>
      lines.push(`| ${escapeCell(label)} | ${escapeCell(value)} |`);
    arow(
      "Accepted-first-pass rate (done / terminal)",
      a.acceptedFirstPassRate === null
        ? "—"
        : `${
          (a.acceptedFirstPassRate * 100).toFixed(0)
        }% (${a.doneRuns}/${a.terminalRuns})`,
    );
    arow(
      "Mean time to terminal",
      a.meanTimeToTerminalMs === null
        ? "—"
        : `${
          fmtDuration(a.meanTimeToTerminalMs)
        } (${a.meanTimeToTerminalMs} ms)`,
    );
    arow(
      "Cleanup-failure rate (cleanup-required / terminal)",
      a.cleanupFailureRate === null
        ? "—"
        : `${
          (a.cleanupFailureRate * 100).toFixed(0)
        }% (${a.cleanupRequiredRuns}/${a.terminalRuns})`,
    );
    arow("Parked runs", String(a.parkedRuns));
    arow("Aborted runs", String(a.abortedRuns));
    arow("Total dispatch attempts", String(a.totalDispatchAttempts));
    arow("Total human touches", String(a.totalHumanTouches));
    arow("Total patch cycles", String(a.totalPatchCycles));
    lines.push("");
  }

  return lines.join("\n").replaceAll(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------------------
// Cross-run discovery: enumerate the run states on this model instance so the
// aggregate can fold every run, not just the summarized one. State records are
// named `state-<slug>`; the report context lists versions per name but exposes
// no name enumeration, so callers/tests supply the slugs (or a listNames
// binding when the repository has one).
// ---------------------------------------------------------------------------

/** Extract run slugs from a flat list of data names (`state-<slug>`). */
export function runSlugsFromNames(names: string[]): string[] {
  const slugs: string[] = [];
  for (const name of names) {
    if (name.startsWith(STATE_PREFIX)) {
      slugs.push(name.slice(STATE_PREFIX.length));
    }
  }
  // Deterministic order.
  return [...new Set(slugs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Build the full report: primary run metrics, plus a cross-run aggregate when
 * more than one run is supplied. `primaryWorkItem` labels the report; `others`
 * carries every non-primary run's (workItem, MetricsData).
 */
export function buildFlowMetricsReport(
  primaryWorkItem: string,
  primary: MetricsData,
  others: { workItem: string; data: MetricsData }[] = [],
  options: BuildFlowMetricsOptions = {},
): FlowMetricsReport {
  const primaryMetrics = buildFlowMetrics(primary, primaryWorkItem, options);
  if (others.length === 0) {
    return { workItem: primaryWorkItem, metrics: primaryMetrics };
  }
  const otherMetrics = others.map((o) =>
    buildFlowMetrics(o.data, o.workItem, options)
  );
  const allRuns = [primaryMetrics, ...otherMetrics];
  return {
    workItem: primaryWorkItem,
    metrics: primaryMetrics,
    aggregate: aggregateFlowMetrics(allRuns),
    allRuns,
  };
}

// ---------------------------------------------------------------------------
// Report contract.
// ---------------------------------------------------------------------------

/** Structural slice of swamp's MethodReportContext. */
interface ReportContext {
  scope: string;
  modelType: unknown;
  modelId: string;
  methodName: string;
  executionStatus: "succeeded" | "failed";
  errorMessage?: string;
  methodArgs: Record<string, unknown>;
  definition?: { name?: string };
  dataRepository: {
    getContent(
      type: unknown,
      modelId: string,
      dataName: string,
      version?: number,
    ): Promise<Uint8Array | null>;
    listVersions?(
      type: unknown,
      modelId: string,
      dataName: string,
    ): Promise<number[]>;
    listNames?(type: unknown, modelId: string): Promise<string[]>;
  };
}

const FACTORY_TYPE = "@swamp/software-factory";

/** The report contract swamp invokes: method-scoped, gated to the factory type. */
export const report = {
  name: "@mgreten/software-factory-flow-metrics",
  description:
    "Deterministic quality/reliability/flow metrics for a factory work item — time-to-terminal, per-stage durations and entry counts, dispatch attempts, failed/parked stage, human touches, patch cycles, and terminal outcome — with a cross-run aggregate, every number traceable to a journal/artifact source, rendered statically from recorded run data",
  scope: "method",
  labels: ["software-factory"],
  execute: async (
    context: ReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (
      String(context.modelType) !== FACTORY_TYPE ||
      context.methodName !== "summary"
    ) {
      return { markdown: "", json: {} };
    }
    const workItem = context.methodArgs.workItem;
    if (typeof workItem !== "string" || workItem.length === 0) {
      return { markdown: "", json: {} };
    }
    // Reports also run on the failure path; persist the reason rather than an
    // empty placeholder version.
    if (context.executionStatus !== "succeeded") {
      const error = context.errorMessage ?? "unknown error";
      return {
        markdown: `# Flow Metrics: ${workItem}\n\n_Metrics failed: ${error}_\n`,
        json: { workItem, error },
      };
    }

    const reader = repositoryRunDataReader({
      dataRepository: context.dataRepository,
      modelType: context.modelType,
      modelId: context.modelId,
    });
    const primarySlug = workItemSlug(workItem);
    const primaryData = await loadMetricsData(reader, primarySlug);

    // Cross-run aggregate: enumerate every run state on the instance when the
    // repository exposes name listing. Absent that, the report is single-run.
    const others: { workItem: string; data: MetricsData }[] = [];
    if (context.dataRepository.listNames !== undefined) {
      let names: string[] = [];
      try {
        names = await context.dataRepository.listNames(
          context.modelType,
          context.modelId,
        );
      } catch {
        names = [];
      }
      for (const slug of runSlugsFromNames(names)) {
        if (slug === primarySlug) continue;
        const data = await loadMetricsData(reader, slug);
        const otherWorkItem = data.state?.workItem ?? slug;
        others.push({ workItem: otherWorkItem, data });
      }
    }

    const built = buildFlowMetricsReport(workItem, primaryData, others);
    return {
      markdown: renderFlowMetricsMarkdown(built),
      json: built as unknown as Record<string, unknown>,
    };
  },
};
