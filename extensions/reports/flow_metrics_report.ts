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
 *     (reset) cycles, plus each stage's time-to-gate (start → first entry);
 *   - dispatch attempts (the `dispatched` journal events);
 *   - failed / parked stage identification (terminal `*-blocked` /
 *     `cleanup-required` / `aborted` stages);
 *   - human-approval touch count (`approved` + `rejected` events), with
 *     rejections differentiated per gate id and human cycle-limit overrides
 *     (`cycle-override:<stage>` approvals) surfaced separately;
 *   - patch-cycle count (`findings_resolved` events + patch-stage re-entries);
 *   - terminal outcome class (done | cleanup-required | parked | aborted |
 *     active | unknown);
 *   - the run's recorded delivery mode, read verbatim from its
 *     `approved-work-order` intake artifact (never defaulted);
 *   - a ceremony / approval-friction baseline (see `CeremonyMetrics`):
 *     deduplicated human decisions keyed by gate+stage+cycle+decision, per-gate
 *     approvals and rejections, approval wait durations, stage visit / unique
 *     stage / cycle counts, review and patch frequency, per-stage yield and
 *     park rates from explicit transition facts, time to verified draft,
 *     bounded-loop exhaustion, and the stages an override actually unblocked.
 *
 * Every displayed number carries a source pointer back to the journal /
 * approval / artifact record it came from, exactly like run-audit's flags.
 * Every ceremony metric additionally carries a trust/availability label: a
 * value that recorded data cannot support is reported as `unavailable` with a
 * reason, never as a zero, and cross-run aggregates divide only by the
 * denominator of runs that actually produced a value. When more than one run
 * exists on the model instance, a cross-run aggregate section summarizes
 * accepted-first-pass rate, cycle time, attempts, human touches, cleanup
 * health, and the ceremony rollup across all of them.
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
const APPROVAL_PREFIX = "approval-";

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

function approvalInstance(slug: string, gateId: string): string {
  return `${APPROVAL_PREFIX}${slug}-${gateId}`;
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

/**
 * One recorded human gate decision, mirroring the factory's ApprovalRecord
 * (models/_lib/run_data.ts). This is the ONLY canonical record that carries a
 * decision's `cycle` and its exact `decidedAt` timestamp: the journal's
 * `approved` / `rejected` payload carries just `gateId`, `actor`, and `note`.
 * Ceremony metrics that must key on cycle therefore read these records, not
 * the journal.
 */
interface ApprovalRecord {
  gateId: string;
  workItem: string;
  decision: "approved" | "rejected";
  actor: string;
  note?: string;
  stageId: string;
  cycle: number;
  decidedAt: string;
}

// ---------------------------------------------------------------------------
// Data access: a minimal reader over swamp's data repository, exactly the
// interface the tests hand-implement over fixture data (mirrors run-audit).
// ---------------------------------------------------------------------------

/** Minimal read interface over a run's recorded data (state/journal/etc). */
export interface RunDataReader {
  /** Canonical repository enumeration result for this model. */
  findAllForModel?(): Promise<unknown[]>;
  /** All data instance names, when the backing repository can enumerate. */
  listNames?(): Promise<string[]>;
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
  findAllForModel?(
    type: unknown,
    modelId: string,
  ): Promise<unknown[]>;
  listNames?(type: unknown, modelId: string): Promise<string[]>;
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
    findAllForModel: opts.dataRepository.findAllForModel === undefined
      ? undefined
      : () =>
        opts.dataRepository.findAllForModel!(opts.modelType, opts.modelId),
    listNames: opts.dataRepository.listNames === undefined
      ? undefined
      : () => opts.dataRepository.listNames!(opts.modelType, opts.modelId),
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

/** Normalize canonical Data entries (and tolerated adapter wrappers) to names. */
function namesFromRepositoryEntries(entries: unknown[]): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (typeof entry.name === "string") {
      names.push(entry.name);
      continue;
    }
    // Some repository adapters wrap a canonical Data entry for global-style
    // enumeration. Accept that shape without making it the primary contract.
    if (isRecord(entry.data) && typeof entry.data.name === "string") {
      names.push(entry.data.name);
    }
  }
  return names;
}

/** Prefer swamp's canonical enumeration API; retain listNames compatibility. */
async function enumerateReaderNames(
  reader: RunDataReader,
): Promise<{ names: string[]; complete: boolean }> {
  if (reader.findAllForModel !== undefined) {
    try {
      return {
        names: namesFromRepositoryEntries(await reader.findAllForModel()),
        complete: true,
      };
    } catch {
      // A supported secondary adapter may still be usable.
    }
  }
  if (reader.listNames !== undefined) {
    try {
      return { names: await reader.listNames(), complete: true };
    } catch {
      // Journal-addressed names remain the final fallback.
    }
  }
  return { names: [], complete: false };
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

/**
 * Shape-check a decoded approval record. `cycle` must be a positive integer to
 * match the factory's own schema — a malformed cycle would silently corrupt
 * the `gateId+stageId+cycle+decision` dedup key, so such a record is skipped
 * rather than counted under a wrong key.
 */
function asApprovalRecord(
  value: Record<string, unknown> | null,
): ApprovalRecord | null {
  if (value === null) return null;
  if (
    typeof value.gateId !== "string" ||
    typeof value.workItem !== "string" ||
    (value.decision !== "approved" && value.decision !== "rejected") ||
    typeof value.actor !== "string" ||
    typeof value.stageId !== "string" ||
    typeof value.cycle !== "number" ||
    !Number.isInteger(value.cycle) || value.cycle <= 0 ||
    typeof value.decidedAt !== "string"
  ) {
    return null;
  }
  if (value.note !== undefined && typeof value.note !== "string") return null;
  return value as unknown as ApprovalRecord;
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
  /**
   * Gate id → version → approval record. The `approval-<slug>-<gateId>`
   * instance is last-write-wins per gate, so only the full version history
   * recovers every decision a human made on that gate.
   */
  approvalVersions: Map<string, Map<number, ApprovalRecord>>;
  /**
   * True when at least one approval instance's earliest version was
   * garbage-collected, so decision counts derived from these records are a
   * lower bound rather than a complete history.
   */
  approvalsTruncated: boolean;
  /** True when every approval instance for this run could be enumerated. */
  approvalDiscoveryComplete?: boolean;
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
    approvalVersions: new Map(),
    approvalsTruncated: false,
    approvalDiscoveryComplete: false,
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
  const gateIds = new Set<string>();
  for (const { entry } of data.journal) {
    const payload = entry.payload ?? {};
    // Every decision event names its gate, which is exactly the approval
    // instance suffix — so the journal alone addresses every approval record
    // without needing repository name enumeration.
    if (
      (entry.event === "approved" || entry.event === "rejected") &&
      typeof payload.gateId === "string" && payload.gateId.length > 0
    ) {
      gateIds.add(payload.gateId);
    }
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

  // Canonical approval records are independent data instances. Enumerate
  // approval-<slug>-* when the repository supports it so a collected journal
  // decision event cannot hide an otherwise surviving decision record.
  const enumeration = await enumerateReaderNames(reader);
  if (enumeration.complete) {
    const prefix = `${APPROVAL_PREFIX}${slug}-`;
    for (const name of enumeration.names) {
      if (name.startsWith(prefix) && name.length > prefix.length) {
        gateIds.add(name.slice(prefix.length));
      }
    }
    data.approvalDiscoveryComplete = true;
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

  for (const gateId of gateIds) {
    const instance = approvalInstance(slug, gateId);
    const perVersion = new Map<number, ApprovalRecord>();
    const versions = await reader.versionsOf(instance);
    // A surviving first version above 1 means earlier decisions on this gate
    // were collected; the decision history is then a lower bound.
    if (versions.length > 0 && versions[0] > 1) data.approvalsTruncated = true;
    for (const version of versions) {
      const record = asApprovalRecord(await reader.read(instance, version));
      if (record === null) {
        data.approvalsTruncated = true;
        continue;
      }
      perVersion.set(version, record);
    }
    data.approvalVersions.set(gateId, perVersion);
  }

  // Without name enumeration, a truncated journal may have lost gate ids and
  // therefore approval instance addresses. Surviving records remain useful,
  // but the discovered set is only a lower bound.
  if (data.journalTruncated && !data.approvalDiscoveryComplete) {
    data.approvalsTruncated = true;
  }

  return data;
}

// ---------------------------------------------------------------------------
// Metric shapes.
// ---------------------------------------------------------------------------

/** Where a displayed number came from, so every metric is traceable. */
export interface MetricSource {
  kind: "state" | "journal" | "artifact" | "evidence" | "approval";
  name: string;
  version?: number;
}

/** A single value paired with the record(s) it was derived from. */
export interface TracedValue<T> {
  value: T;
  /** Source pointers back to the journal/artifact records. */
  sources: MetricSource[];
}

// ---------------------------------------------------------------------------
// Ceremony / approval-friction baseline (FRK-METRICS-002).
//
// Availability is a first-class part of every ceremony metric. The canonical
// factory records are incomplete by design in specific, knowable ways (see
// `ApprovalWait` and `CeremonyDimensions`), and the honest response to a
// missing input is to say so — never to substitute a zero, a default, or an
// inference drawn from a name. The rules this section holds to:
//
//   1. A duration with no trustworthy pair of endpoints is `unavailable`
//      with a reason, and its `ms` stays `null`. It is never 0.
//   2. An aggregate divides by the count of AVAILABLE contributors, so an
//      unavailable measurement can never be averaged in as a zero and drag a
//      mean toward false speed.
//   3. A dimension the records do not expose is `unknown`, not guessed from a
//      stage id, a work-item ref, or free prose.
// ---------------------------------------------------------------------------

/**
 * Whether a metric could be computed from canonical records.
 *
 * - `available` — every input the formula needs was present and trustworthy.
 * - `partial` — computed from a real but incomplete input set (e.g. some
 *   decisions had a usable pending timestamp and others did not). The value is
 *   meaningful for the covered subset only, and the covered/total counts say
 *   how much of the population it speaks for.
 * - `unavailable` — a required input is absent from the recorded data. The
 *   numeric value is `null`; callers must not read it as zero.
 */
export type Availability = "available" | "partial" | "unavailable";

/**
 * A value that may legitimately be uncomputable, carrying why.
 *
 * The `reason` is required whenever availability is not `available`, so a
 * missing number always arrives with its explanation attached rather than as a
 * bare null the reader has to interpret.
 */
export interface TrustedValue<T> {
  value: T | null;
  availability: Availability;
  /** Why the value is partial/unavailable. Empty when fully available. */
  reason?: string;
  sources: MetricSource[];
  /** How many population members this value actually covers. */
  covered?: number;
  /** The full population size the value was sought over. */
  total?: number;
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
  /** Total wall-clock ms over visits with valid endpoints, else null. */
  totalMs: number | null;
  /** Whether totalMs covers every visit, some visits, or none. */
  durationAvailability: Availability;
  /** Why duration is partial/unavailable. */
  durationReason?: string;
  /**
   * Wall-clock ms from the run's start to this stage's FIRST entry — the
   * run's time-to-this-gate. Measured between two journal timestamps, so it
   * deliberately *includes* parked and idle waiting: a stage that a human sat
   * in front of for a day is a stage that took a day to reach. `null` when the
   * stage was never entered or the run's start time is unknown.
   */
  firstEnteredMs: number | null;
  /** Dispatch attempts recorded while in this stage (across eras). */
  dispatchAttempts: number;
  /** True when this stage is the run's terminal (failed/parked) landing. */
  terminal: boolean;
}

/** One human-granted cycle-limit override, as recorded in the journal. */
export interface CycleOverrideGrant {
  /**
   * The stage the run was occupying when the override was granted — the
   * journal entry's own `stageId`. Note this is NOT always the overridden
   * stage: a grant for `cycle-override:review` is commonly recorded while the
   * run sits in a preparation stage. Read `gateId` for the override target.
   */
  stage: string;
  /** The full reserved gate id, `cycle-override:<targetStage>`. */
  gateId: string;
}

/** Human-granted cycle-limit overrides on a run. */
export interface CycleOverrides {
  count: number;
  /** Each grant in journal order. */
  grants: CycleOverrideGrant[];
}

/**
 * A stage observed to have been driven past its ordinary cycle limit, as
 * inferred from a granted cycle-override. See `FlowMetrics.cycleExhaustions`
 * for why this is an inference and not a directly recorded signal.
 */
export interface CycleExhaustion {
  /** The stage whose limit was exhausted (the override gate's target). */
  stage: string;
  /** How many overrides were granted for that stage. */
  overrides: number;
}

/**
 * One human decision, deduplicated to its logical identity.
 *
 * DEDUP KEY: `gateId + "\0" + stageId + "\0" + cycle + "\0" +
 * decision`. Two approval records sharing that key are the SAME decision
 * re-recorded — a retry, a replay, or a re-write of the same last-write-wins
 * instance — and count once. The NUL separator is used because gate ids and
 * stage ids are free-form recorded strings: a printable delimiter could be
 * forged inside a gate id to collide two genuinely distinct decisions.
 *
 * `cycle` is why these come from approval records rather than the journal —
 * the journal's decision payload carries no cycle, so a human who rejects the
 * same gate on cycle 1 and again on cycle 2 is indistinguishable there. Those
 * are two real decisions and must not collapse into one.
 */
export interface DistinctDecision {
  gateId: string;
  stageId: string;
  cycle: number;
  decision: "approved" | "rejected";
  /** Earliest `decidedAt` seen for this key — the decision's first record. */
  firstDecidedAt: string;
  /** How many raw records carried this same key (1 = no duplication). */
  recordCount: number;
  /** True when this gate id is a reserved `cycle-override:` grant. */
  isCycleOverride: boolean;
}

/**
 * How long a human gate sat pending before someone decided it.
 *
 * FORMULA: `decidedAt - pendingSince`, but only when both timestamps are
 * canonical records of those exact lifecycle facts.
 *
 * The current factory records `decidedAt`, but NO `requestedAt` /
 * `pendingSince` field. A stage-entry timestamp is not equivalent: a human
 * gate can become pending after entry, or multiple transitions can expose
 * different gates from the same stage. Approval wait is therefore currently
 * `unavailable` for every decision — NOT estimated from stage entry and never
 * reported as zero.
 */
export interface ApprovalWait {
  gateId: string;
  stageId: string;
  cycle: number;
  decision: "approved" | "rejected";
  /** Wall-clock ms pending → decided, or `null` when not derivable. */
  waitMs: number | null;
  availability: Availability;
  /** Why the wait could not be measured. Absent when available. */
  reason?: string;
  sources: MetricSource[];
}

/**
 * Stage flow outcomes derived from explicit transition/terminal journal facts.
 *
 * FORMULAS (all over `advanced` / `run_terminal` events, which carry an
 * explicit `from` / `to` / `transition` payload — never inferred from a stage
 * name):
 *
 *   yieldRate = advancedOut / (advancedOut + parkedAt)
 *   parkRate  = parkedAt   / (advancedOut + parkedAt)
 *
 * where `advancedOut` counts non-terminal `advanced` events whose `from` is
 * this stage (the stage handed work onward), and `parkedAt` counts terminal
 * `run_terminal` landings on this stage that are not `done`.
 *
 * Both rates are `null` when the denominator is 0 — a stage the run entered
 * but never left has no yield rate, and reporting 0% would falsely claim it
 * failed to yield when in truth it was never asked to.
 */
export interface StageFlow {
  stageId: string;
  /** Non-terminal `advanced` events whose payload `from` is this stage. */
  advancedOut: number;
  /** Terminal, non-`done` landings on this stage. */
  parkedAt: number;
  /** advancedOut / (advancedOut + parkedAt), or null when never resolved. */
  yieldRate: number | null;
  /** parkedAt / (advancedOut + parkedAt), or null when never resolved. */
  parkRate: number | null;
  sources: MetricSource[];
  availability?: Availability;
  reason?: string;
}

/**
 * Breakdown dimensions, read verbatim from canonical records or left unknown.
 *
 * Every field here is `null` unless a canonical record literally carries it.
 * The factory's definition schema has no `riskProfile` / `authority` /
 * `workClass` field of its own, so these are read from the intake
 * `approved-work-order` artifact payload when a factory definition chose to
 * record them there. A factory that records none leaves all of these null and
 * the report says `unknown` — it does NOT read risk from a stage id containing
 * "hotfix", from a work-item ref containing "SEC", or from any prose. Those
 * would be invented causality dressed as data.
 */
export interface CeremonyDimensions {
  /** The factory definition's own name, when the report context exposes it. */
  factory: string | null;
  /** `workClass` recorded on the intake work order, else null. */
  workClass: string | null;
  /** `riskProfile` recorded on the intake work order, else null. */
  riskProfile: string | null;
  /** `authorityProfile` recorded on the intake work order, else null. */
  authorityProfile: string | null;
  sources: MetricSource[];
}

/**
 * The ceremony and approval-friction baseline for one run.
 *
 * Every field is derived only from canonical `@swamp/software-factory` state,
 * journal, artifact, and approval records. Nothing here consults an LLM,
 * invents a timestamp, infers a human's identity, or asserts causality the
 * records do not state.
 */
export interface CeremonyMetrics {
  /**
   * Human touches counted from EXACT human decision records only: approval
   * records (ordinary gates) plus cycle-override grants. This deliberately
   * counts raw records, so it answers "how many times did a human act on this
   * run" including retries. For the deduplicated logical count, read
   * `distinctDecisionCount`.
   */
  humanTouches: TrustedValue<number>;
  /**
   * Count of DISTINCT decisions after applying the `DistinctDecision` dedup
   * key. Always ≤ the raw record count; the gap is retries/replays.
   */
  distinctDecisionCount: TrustedValue<number>;
  /** Raw approval-record count before dedup, for the retry delta. */
  rawDecisionRecordCount: number;
  /** Every distinct decision, in first-decided order. */
  distinctDecisions: DistinctDecision[];
  /** Approval sources for raw records collapsed by the distinct-decision key. */
  duplicateDecisionSources: MetricSource[];
  /** Distinct approvals, total and per gate id. */
  approvals: TrustedValue<number>;
  approvalsByGate: Record<string, number>;
  approvalsByGateSources: Record<string, MetricSource[]>;
  /** Distinct rejections, total and per gate id. */
  rejections: TrustedValue<number>;
  rejectionsByGate: Record<string, number>;
  rejectionsByGateSources: Record<string, MetricSource[]>;
  /** Per-decision approval waits, including the unavailable ones. */
  approvalWaits: ApprovalWait[];
  /**
   * Mean approval wait over decisions with a derivable wait ONLY. Marked
   * `partial` when some decisions lacked a pending timestamp, and
   * `unavailable` when none did — never 0.
   */
  meanApprovalWaitMs: TrustedValue<number>;
  /** Total stage visits (entries) across every stage and era. */
  stageVisitCount: TrustedValue<number>;
  /** How many distinct stage ids the run ever occupied. */
  uniqueStageCount: TrustedValue<number>;
  /**
   * Total cycles across all stages, read from the state record's `cycles` map
   * when present (the factory's own counter), else reconstructed from journal
   * entries. The source pointer says which.
   */
  cycleCount: TrustedValue<number>;
  /**
   * FORMULA: distinct review-stage visits / total stage visits. A "review
   * stage" is one the run actually entered whose id contains "review" — a
   * naming convention, and labelled as such in the report rather than
   * presented as a definition-declared fact.
   */
  reviewFrequency: TrustedValue<number>;
  /** FORMULA: patch-stage visits / total stage visits. Same naming caveat. */
  patchFrequency: TrustedValue<number>;
  /** Per-stage yield / park derived from explicit transition facts. */
  stageFlow: StageFlow[];
  /**
   * FORMULA: time from the run's `started` fact to an exact canonical
   * `verified draft` fact. The current factory has no generic record with that
   * meaning: `evidence_recorded` can be arbitrary evidence and
   * `findings_resolved` records review bookkeeping, not draft verification.
   * This is therefore unavailable until the canonical schema records it.
   */
  timeToVerifiedDraftMs: TrustedValue<number>;
  /**
   * Bounded-loop exhaustion: stages driven past their ordinary cycle limit.
   * Only recoverable where a human override was recorded — see
   * `FlowMetrics.cycleExhaustions` for why an un-overridden limit leaves no
   * trace in recorded data at all.
   */
  boundedLoopExhaustions: CycleExhaustion[];
  boundedLoopExhaustionsAvailability: Availability;
  boundedLoopExhaustionsReason?: string;
  /** Human cycle-limit overrides granted, from exact override records. */
  cycleOverrideCount: TrustedValue<number>;
  /**
   * Stages an override actually unblocked: an override grant for stage S
   * counts as unblocking S only when the journal shows a LATER entry into S.
   * A grant with no subsequent entry is recorded but not claimed as
   * unblocking, because the records do not show it took effect.
   */
  stagesUnblocked: string[];
  stagesUnblockedAvailability: Availability;
  stagesUnblockedReason?: string;
  stagesUnblockedSources: MetricSource[];
  boundedLoopExhaustionSources: MetricSource[];
  /** Breakdown dimensions, verbatim or unknown. */
  dimensions: CeremonyDimensions;
  /** True when approval history may be incomplete (GC'd versions). */
  approvalsTruncated: boolean;
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
  /**
   * Rejections counted per human-approval gate, keyed by the `gateId` the
   * `rejected` journal event carried. A gate that was never rejected does not
   * appear at all (no zero entries), so `Object.keys` is exactly the set of
   * gates a human ever pushed back on.
   *
   * Read from the JOURNAL, deliberately — not from the `approval-<slug>-<gate>`
   * records. Those are written once per gate id and are last-write-wins, so a
   * rejection later followed by an approval on the same gate leaves no trace in
   * the approval record. The journal appends every decision as its own version
   * and is therefore the only complete source for rejection history.
   *
   * A `rejected` event with no usable `gateId` counts under `"(unknown)"`
   * rather than being silently dropped, so the per-gate counts always sum to
   * `rejections`.
   */
  rejectionsByGate: Record<string, number>;
  /**
   * Human cycle-limit overrides granted on this run: `approved` events whose
   * gate id carries the engine's reserved `cycle-override:` prefix. Each grant
   * buys the named stage exactly one additional entry past its `maxCycles`.
   */
  cycleOverrides: CycleOverrides;
  /**
   * Stages driven past their ordinary cycle limit, inferred from the override
   * grants above and keyed by the OVERRIDDEN stage (the gate id's suffix), not
   * by the stage the grant was recorded in.
   *
   * This is an inference, and the honest limit of what recorded data supports.
   * The engine evaluates cycle exhaustion at advance/dispatch time and, when a
   * stage is at its limit, it *refuses the transition and throws* — it writes
   * no journal event and no state field. A run currently blocked at a cycle
   * limit that nobody has overridden yet is therefore invisible to any reader
   * of recorded data, including this report. What IS recoverable is the
   * converse: every limit that was actually hit AND then overridden leaves a
   * durable `approved` event for `cycle-override:<stage>`. That is what this
   * field reports.
   */
  cycleExhaustions: CycleExhaustion[];
  /** findings_resolved events + re-entries into a patch stage. */
  patchCycles: TracedValue<number>;
  /** Terminal outcome class. */
  outcome: TracedValue<TerminalOutcomeClass>;
  /**
   * The delivery mode this run was commissioned under, read from the
   * `deliveryMode` field of the LATEST version of the run's
   * `approved-work-order` intake artifact.
   *
   * This is reported exactly as recorded: `null` when no
   * `approved-work-order` artifact exists, when its payload carries no
   * `deliveryMode`, or when the recorded value is not a string. The report
   * deliberately applies **no default** — what counts as "the usual delivery
   * mode" is a property of the consuming factory definition, not of this
   * generic report, so an absent value is surfaced as absent rather than
   * silently backfilled.
   */
  deliveryMode: TracedValue<string | null>;
  /**
   * Proven-positive only: true when a complete, non-truncated journal proves
   * terminal `done`, zero human rejections, and exactly one era. False also
   * represents unknown/incomplete history; it is not a complete classifier.
   */
  acceptedFirstPass: boolean;
  journalTruncated: boolean;
  /**
   * The ceremony / approval-friction baseline. Added alongside the existing
   * fields above rather than replacing any of them: `humanTouches`,
   * `approvals`, `rejections`, and `rejectionsByGate` keep their original
   * journal-derived meaning and value so existing consumers are unaffected.
   * The ceremony block's counterparts are approval-RECORD derived and
   * deduplicated, which is why both can legitimately differ.
   */
  ceremony: CeremonyMetrics;
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
  /**
   * Runs bucketed by their recorded `deliveryMode`. Runs with no recorded
   * mode are counted under the `"unset"` key rather than assigned a default.
   */
  runsByDeliveryMode: Record<string, number>;
  /** Every run's `rejectionsByGate` merged, so one gate's total spans runs. */
  totalRejectionsByGate: Record<string, number>;
  /** Cycle-override grants summed across every run. */
  totalCycleOverrides: number;
  /** The cross-run ceremony / approval-friction rollup. */
  ceremony: CeremonyAggregate;
}

/**
 * Cross-run ceremony rollup.
 *
 * The governing rule: an unavailable measurement is EXCLUDED from its
 * aggregate, never coerced to zero. Each aggregate therefore carries the
 * denominator it actually divided by (`covered`) alongside the population it
 * was sought over (`total`), so a mean over 2 of 9 runs can never be misread
 * as a mean over all 9.
 */
export interface CeremonyAggregate {
  /** Runs whose decision counts came from surviving approval records. */
  runsWithDecisionRecords: number;
  /** Total runs folded, regardless of availability. */
  runs: number;
  /** Distinct decisions summed over runs that had records. */
  totalDistinctDecisions: TrustedValue<number>;
  /** Raw approval records summed over runs that had records. */
  totalRawDecisionRecords: TrustedValue<number>;
  totalApprovals: TrustedValue<number>;
  totalRejections: TrustedValue<number>;
  approvalsByGate: Record<string, number>;
  rejectionsByGate: Record<string, number>;
  /**
   * Mean approval wait across every MEASURED decision on every run — a
   * decision-weighted mean over available waits only. `partial` when any
   * decision anywhere lacked a pending timestamp.
   */
  meanApprovalWaitMs: TrustedValue<number>;
  /** Decisions with a derivable wait / all recorded decisions. */
  approvalWaitCoverage: { covered: number; total: number };
  /** Mean stage visits per run, over runs with a visit count. */
  meanStageVisits: TrustedValue<number>;
  /** Mean review frequency, over runs where the rate was defined. */
  meanReviewFrequency: TrustedValue<number>;
  /** Mean patch frequency, over runs where the rate was defined. */
  meanPatchFrequency: TrustedValue<number>;
  /**
   * Mean time-to-verified-draft over runs where exact lifecycle records
   * permitted it. Runs without it are excluded, not counted as zero.
   */
  meanTimeToVerifiedDraftMs: TrustedValue<number>;
  /** Cycle-override grants summed across runs. */
  totalCycleOverrides: number;
  /** Every stage any run recorded an override as having unblocked. */
  stagesUnblocked: string[];
  /** Runs bucketed by each recorded dimension; absent → "unknown". */
  runsByWorkClass: Record<string, number>;
  runsByRiskProfile: Record<string, number>;
  runsByAuthorityProfile: Record<string, number>;
  runsByFactory: Record<string, number>;
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
/**
 * The intake artifact a factory records at commissioning time. Its latest
 * version is the source for the run's `deliveryMode`.
 */
const WORK_ORDER_ARTIFACT = "approved-work-order";
/**
 * The engine's reserved approval-id prefix for cycle-limit overrides. An
 * `approve` call whose gateId starts with this does not clear a definition
 * gate — it grants the named stage one entry beyond its `maxCycles`.
 * Mirrors CYCLE_OVERRIDE_PREFIX in the factory's definition schema.
 */
const CYCLE_OVERRIDE_PREFIX = "cycle-override:";
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
  return ms < 0 ? undefined : ms;
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
// Ceremony reconstruction (FRK-METRICS-002).
// ---------------------------------------------------------------------------

/** A recorded-key accumulator; null-prototyped so a gate named "__proto__"
 * counts as an ordinary key instead of colliding with an inherited member. */
function countMap(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

/**
 * The dedup key identifying one logical human decision. NUL-separated because
 * every component is a free-form recorded string: a printable separator could
 * be embedded in a gate id to forge a collision between distinct decisions.
 */
export function decisionKey(
  d: { gateId: string; stageId: string; cycle: number; decision: string },
): string {
  return `${d.gateId}\0${d.stageId}\0${d.cycle}\0${d.decision}`;
}

/**
 * The lookup key pairing a stage with one of its cycles. Shared by the journal
 * replay that records stage entries and the approval-wait lookup that reads
 * them, so the two can never drift apart on separator choice.
 */
function stageCycleKey(stageId: string, cycle: number): string {
  return `${stageId}\0${cycle}`;
}

/** A stage id reads as a review stage when it names "review" (a convention). */
function isReviewStage(stageId: string): boolean {
  return stageId.toLowerCase().includes("review");
}

/** Inputs the ceremony builder needs from the journal replay. */
interface CeremonyReplay {
  /** `stageId\0cycle` → ISO timestamp the run entered that stage-cycle. */
  stageCycleEnteredAt: Map<string, { at: string; version: number }>;
  /** Every stage entry in journal order, for override-unblock checks. */
  entries: { stageId: string; at: string; version: number }[];
  /** Non-terminal `advanced` events keyed by their payload `from` stage. */
  advancedOutOf: Map<string, MetricSource[]>;
  /** Terminal non-`done` landings keyed by stage. */
  parkedAtStage: Map<string, MetricSource[]>;
  stageEntries: Map<string, number>;
  startedAt?: string;
  /** Exact lifecycle records that evidence a verified draft. */
  verifiedDraftAt?: { at: string; source: MetricSource };
  totalVisits: number;
}

/**
 * Build the ceremony / approval-friction baseline for one run.
 *
 * Pure over the run's loaded data plus the journal replay facts. Every metric
 * either carries a real value with its source pointers, or an explicit
 * unavailable/partial label with the reason — never a substituted zero.
 */
function buildCeremonyMetrics(
  data: MetricsData,
  replay: CeremonyReplay,
  ctx: {
    journalSource: (version: number) => MetricSource;
    stateSource: MetricSource;
    workOrderSource: MetricSource | null;
    workOrderPayload: Record<string, unknown> | null;
    factoryName: string | null;
    cycleOverrideGrants: CycleOverrideGrant[];
    cycleExhaustions: CycleExhaustion[];
  },
): CeremonyMetrics {
  // --- Distinct decisions from EXACT approval records ----------------------
  // Approval records are the only canonical source carrying a decision's
  // cycle, which the dedup key requires.
  const byKey = new Map<string, {
    decision: DistinctDecision;
    sources: MetricSource[];
    records: ApprovalRecord[];
  }>();
  let rawDecisionRecordCount = 0;
  const decisionSources: MetricSource[] = [];

  for (
    const [gateId, versions] of [...data.approvalVersions].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
    )
  ) {
    for (const version of [...versions.keys()].sort((a, b) => a - b)) {
      const record = versions.get(version);
      if (record === undefined) continue;
      rawDecisionRecordCount += 1;
      const source: MetricSource = {
        kind: "approval",
        name: approvalInstance(data.slug, gateId),
        version,
      };
      decisionSources.push(source);
      const key = decisionKey(record);
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, {
          decision: {
            gateId: record.gateId,
            stageId: record.stageId,
            cycle: record.cycle,
            decision: record.decision,
            firstDecidedAt: record.decidedAt,
            recordCount: 1,
            isCycleOverride: record.gateId.startsWith(CYCLE_OVERRIDE_PREFIX),
          },
          sources: [source],
          records: [record],
        });
      } else {
        // Same logical decision re-recorded: count the retry, and keep the
        // EARLIEST decidedAt as the moment the human actually decided.
        existing.decision.recordCount += 1;
        existing.sources.push(source);
        existing.records.push(record);
        if (record.decidedAt < existing.decision.firstDecidedAt) {
          existing.decision.firstDecidedAt = record.decidedAt;
        }
      }
    }
  }

  const entriesSorted = [...byKey.values()].sort((a, b) => {
    const at = a.decision.firstDecidedAt;
    const bt = b.decision.firstDecidedAt;
    if (at !== bt) return at < bt ? -1 : 1;
    // Stable, deterministic tiebreak on the full key.
    const ak = decisionKey(a.decision);
    const bk = decisionKey(b.decision);
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  const distinctDecisions = entriesSorted.map((e) => e.decision);

  const approvalsByGate = countMap();
  const rejectionsByGate = countMap();
  const approvalsByGateSources: Record<string, MetricSource[]> = {};
  const rejectionsByGateSources: Record<string, MetricSource[]> = {};
  let approvals = 0;
  let rejections = 0;
  for (const entry of entriesSorted) {
    const d = entry.decision;
    if (d.decision === "approved") {
      approvals += 1;
      approvalsByGate[d.gateId] = (approvalsByGate[d.gateId] ?? 0) + 1;
      approvalsByGateSources[d.gateId] = [
        ...(approvalsByGateSources[d.gateId] ?? []),
        ...entry.sources,
      ];
    } else {
      rejections += 1;
      rejectionsByGate[d.gateId] = (rejectionsByGate[d.gateId] ?? 0) + 1;
      rejectionsByGateSources[d.gateId] = [
        ...(rejectionsByGateSources[d.gateId] ?? []),
        ...entry.sources,
      ];
    }
  }
  const duplicateDecisionSources = entriesSorted.flatMap((entry) =>
    entry.sources.slice(1)
  );

  // When no approval record survives, decision counts are unavailable rather
  // than 0 — "no records" and "no decisions" are different claims, and the
  // journal may still show decisions whose records were collected.
  const hasDecisionRecords = rawDecisionRecordCount > 0;
  const trustworthyZero = !hasDecisionRecords && data.state !== null &&
    !data.journalTruncated &&
    !data.approvalsTruncated && data.approvalVersions.size === 0 &&
    !data.journal.some(({ entry }) =>
      entry.event === "approved" || entry.event === "rejected"
    );
  const decisionKnown = hasDecisionRecords || trustworthyZero;
  const decisionAvailability: Availability = hasDecisionRecords
    ? (data.approvalsTruncated ? "partial" : "available")
    : trustworthyZero
    ? "available"
    : "unavailable";
  const decisionReason = hasDecisionRecords
    ? (data.approvalsTruncated
      ? "some approval record versions were garbage-collected; counts are a lower bound"
      : undefined)
    : trustworthyZero
    ? undefined
    : "no approval records survive and the journal is missing, malformed, partial, or still references decisions; exact human decision counts cannot be derived";

  const trustedCount = (value: number): TrustedValue<number> => ({
    value: decisionKnown ? value : null,
    availability: decisionAvailability,
    reason: decisionReason,
    sources: decisionSources,
  });

  // --- Approval waits ------------------------------------------------------
  // The approval record has decidedAt but the canonical factory schema has no
  // request/pending timestamp. Stage entry is deliberately not used as a
  // proxy: it does not prove when this specific gate became pending.
  const approvalWaits: ApprovalWait[] = [];
  for (const entry of entriesSorted) {
    const d = entry.decision;
    approvalWaits.push({
      gateId: d.gateId,
      stageId: d.stageId,
      cycle: d.cycle,
      decision: d.decision,
      waitMs: null,
      availability: "unavailable",
      reason:
        "canonical approval records have no requestedAt/pendingSince timestamp; stage entry is not a trustworthy proxy",
      sources: entry.sources,
    });
  }

  const measured = approvalWaits.filter((w) => w.waitMs !== null);
  const meanApprovalWaitMs: TrustedValue<number> = measured.length === 0
    ? {
      value: null,
      availability: "unavailable",
      reason: approvalWaits.length === 0
        ? "no human decisions were recorded on this run"
        : "no recorded decision had both a trustworthy pending timestamp and a decision timestamp",
      sources: [],
      covered: 0,
      total: approvalWaits.length,
    }
    : {
      // Denominator is the count of MEASURED waits — unavailable waits are
      // excluded entirely rather than averaged in as zero.
      value: Math.round(
        measured.reduce((a, w) => a + (w.waitMs ?? 0), 0) / measured.length,
      ),
      availability: measured.length === approvalWaits.length
        ? "available"
        : "partial",
      reason: measured.length === approvalWaits.length
        ? undefined
        : `${
          approvalWaits.length - measured.length
        } of ${approvalWaits.length} decisions had no derivable pending timestamp and are excluded from the mean`,
      sources: measured.flatMap((w) => w.sources),
      covered: measured.length,
      total: approvalWaits.length,
    };

  // --- Stage visits, unique stages, cycles ---------------------------------
  const journalHasStages = replay.totalVisits > 0;
  const visitSources = replay.entries.map((entry) =>
    ctx.journalSource(entry.version)
  );
  const journalLowerBound = data.journalTruncated && journalHasStages;
  const stageVisitCount: TrustedValue<number> = {
    value: journalHasStages ? replay.totalVisits : null,
    availability: journalHasStages
      ? (journalLowerBound ? "partial" : "available")
      : "unavailable",
    reason: journalHasStages
      ? (journalLowerBound
        ? "journal history is truncated; surviving stage visits are a lower bound"
        : undefined)
      : data.journalTruncated
      ? "journal history is truncated and no stage entry survives; zero cannot be established"
      : "no stage entry survives in the journal",
    sources: visitSources,
  };
  const uniqueStageCount: TrustedValue<number> = {
    value: journalHasStages ? replay.stageEntries.size : null,
    availability: journalHasStages
      ? (journalLowerBound ? "partial" : "available")
      : "unavailable",
    reason: journalHasStages
      ? (journalLowerBound
        ? "journal history is truncated; surviving unique stages are a lower bound"
        : undefined)
      : data.journalTruncated
      ? "journal history is truncated and no stage entry survives; zero cannot be established"
      : "no stage entry survives in the journal",
    sources: visitSources,
  };

  // Cycles: prefer the factory's own `cycles` counter on the state record —
  // it is authoritative and survives journal truncation.
  const stateCycles = data.state?.cycles;
  let cycleCount: TrustedValue<number>;
  if (stateCycles !== undefined && Object.keys(stateCycles).length > 0) {
    let total = 0;
    for (const key of Object.keys(stateCycles)) {
      const n = stateCycles[key];
      if (typeof n === "number" && Number.isFinite(n)) total += n;
    }
    cycleCount = {
      value: total,
      availability: "available",
      sources: [ctx.stateSource],
    };
  } else if (journalHasStages) {
    cycleCount = {
      value: replay.totalVisits,
      availability: "partial",
      reason:
        "state record carries no cycles map; reconstructed from surviving journal stage entries",
      sources: visitSources,
    };
  } else {
    cycleCount = {
      value: null,
      availability: "unavailable",
      reason: "neither a state cycles map nor journal stage entries survive",
      sources: [],
    };
  }

  // --- Review / patch frequency -------------------------------------------
  // Denominator is total stage visits; null when there are none, because a
  // rate over zero visits is undefined, not 0.
  const frequency = (
    predicate: (stageId: string) => boolean,
    label: string,
  ): TrustedValue<number> => {
    if (!journalHasStages) {
      return {
        value: null,
        availability: "unavailable",
        reason:
          `no stage visits survive, so ${label} frequency has no denominator`,
        sources: [],
        covered: 0,
        total: 0,
      };
    }
    let matched = 0;
    for (const [stageId, count] of replay.stageEntries) {
      if (predicate(stageId)) matched += count;
    }
    return {
      value: matched / replay.totalVisits,
      availability: data.journalTruncated ? "partial" : "available",
      reason: data.journalTruncated
        ? `journal history is truncated; surviving ${label} frequency uses only the ${replay.totalVisits} observed visits`
        : undefined,
      sources: visitSources,
      covered: matched,
      total: replay.totalVisits,
    };
  };
  const reviewFrequency = frequency(isReviewStage, "review");
  const patchFrequency = frequency(isPatchStage, "patch");

  // --- Stage yield / park from explicit transition facts -------------------
  const flowStageIds = new Set<string>([
    ...replay.advancedOutOf.keys(),
    ...replay.parkedAtStage.keys(),
  ]);
  const stageFlow: StageFlow[] = [...flowStageIds]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((stageId) => {
      const outSources = replay.advancedOutOf.get(stageId) ?? [];
      const parkSources = replay.parkedAtStage.get(stageId) ?? [];
      const advancedOut = outSources.length;
      const parkedAt = parkSources.length;
      const denominator = advancedOut + parkedAt;
      return {
        stageId,
        advancedOut,
        parkedAt,
        // Undefined rather than 0 when the stage was never resolved either
        // way — see the StageFlow doc comment.
        yieldRate: denominator === 0 ? null : advancedOut / denominator,
        parkRate: denominator === 0 ? null : parkedAt / denominator,
        sources: [...outSources, ...parkSources],
        availability: data.journalTruncated ? "partial" : "available",
        reason: data.journalTruncated
          ? "journal history is truncated; transition counts and rates are lower-bound observations"
          : undefined,
      };
    });

  // --- Time to verified draft ----------------------------------------------
  // Generic evidence and findings events do not assert that a draft exists or
  // is verified. The canonical schema currently has no exact endpoint.
  const timeToVerifiedDraftMs: TrustedValue<number> = {
    value: null,
    availability: "unavailable",
    reason:
      "canonical factory records have no explicit verified-draft lifecycle fact",
    sources: [],
  };

  // --- Overrides and the stages they actually unblocked --------------------
  const overrideEntries = entriesSorted.filter((entry) =>
    entry.decision.isCycleOverride && entry.decision.decision === "approved"
  );
  const overrideSources = overrideEntries.flatMap((entry) => entry.sources);
  const exhaustionCounts = new Map<string, number>();
  for (const entry of overrideEntries) {
    const target = entry.decision.gateId.slice(CYCLE_OVERRIDE_PREFIX.length);
    if (target.length > 0) {
      exhaustionCounts.set(target, (exhaustionCounts.get(target) ?? 0) + 1);
    }
  }
  const boundedLoopExhaustions = [...exhaustionCounts]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([stage, overrides]) => ({ stage, overrides }));
  const cycleOverrideCount: TrustedValue<number> = {
    value: decisionKnown ? overrideEntries.length : null,
    availability: decisionAvailability,
    reason: decisionReason,
    sources: overrideSources,
  };
  // An override counts as unblocking stage S only when the journal shows an
  // entry into S at or after the grant. Without that, the records do not show
  // the grant took effect, and claiming otherwise would fabricate causality.
  const unblocked = new Set<string>();
  for (const d of distinctDecisions) {
    if (!d.isCycleOverride || d.decision !== "approved") continue;
    const target = d.gateId.slice(CYCLE_OVERRIDE_PREFIX.length);
    if (target.length === 0) continue;
    for (const entry of replay.entries) {
      if (entry.stageId === target && entry.at >= d.firstDecidedAt) {
        unblocked.add(target);
        break;
      }
    }
  }
  const stagesUnblocked = [...unblocked].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  const stagesUnblockedSources = [
    ...overrideSources,
    ...replay.entries.filter((entry) => unblocked.has(entry.stageId)).map(
      (entry) => ctx.journalSource(entry.version),
    ),
  ];

  // --- Breakdown dimensions, verbatim or unknown ---------------------------
  const payload = ctx.workOrderPayload;
  const dimensionSources: MetricSource[] = [];
  const readDimension = (field: string): string | null => {
    if (payload === null) return null;
    const value = str(payload[field]);
    if (value === undefined) return null;
    if (
      ctx.workOrderSource !== null &&
      !dimensionSources.includes(ctx.workOrderSource)
    ) {
      dimensionSources.push(ctx.workOrderSource);
    }
    return value;
  };
  const workClass = readDimension("workClass");
  const riskProfile = readDimension("riskProfile");
  const authorityProfile = readDimension("authorityProfile");

  return {
    humanTouches: trustedCount(rawDecisionRecordCount),
    distinctDecisionCount: trustedCount(distinctDecisions.length),
    rawDecisionRecordCount,
    distinctDecisions,
    duplicateDecisionSources,
    approvals: trustedCount(approvals),
    approvalsByGate,
    approvalsByGateSources,
    rejections: trustedCount(rejections),
    rejectionsByGate,
    rejectionsByGateSources,
    approvalWaits,
    meanApprovalWaitMs,
    stageVisitCount,
    uniqueStageCount,
    cycleCount,
    reviewFrequency,
    patchFrequency,
    stageFlow,
    timeToVerifiedDraftMs,
    boundedLoopExhaustions,
    boundedLoopExhaustionsAvailability: decisionAvailability,
    boundedLoopExhaustionsReason: decisionReason,
    cycleOverrideCount,
    stagesUnblocked,
    stagesUnblockedAvailability: data.journalTruncated
      ? (stagesUnblocked.length > 0 ? "partial" : "unavailable")
      : decisionAvailability,
    stagesUnblockedReason: data.journalTruncated
      ? (stagesUnblocked.length > 0
        ? "journal history is truncated; listed stages are proven examples but may be incomplete"
        : "journal history is truncated; absence of a surviving later stage entry cannot establish that no override unblocked a stage")
      : decisionReason,
    stagesUnblockedSources,
    boundedLoopExhaustionSources: overrideSources,
    dimensions: {
      factory: ctx.factoryName,
      workClass,
      riskProfile,
      authorityProfile,
      sources: dimensionSources,
    },
    approvalsTruncated: data.approvalsTruncated,
  };
}

// ---------------------------------------------------------------------------
// buildFlowMetrics: the pure reconstruction core over one run's MetricsData.
// ---------------------------------------------------------------------------

/** Options controlling `buildFlowMetrics` reconstruction. */
export interface BuildFlowMetricsOptions {
  /** "now" for open-visit duration; defaults to new Date().toISOString(). */
  now?: string;
  /**
   * The factory definition's own name, used only as the `factory` breakdown
   * dimension. Passed in from the report context because it is a property of
   * the model instance, not of the run's recorded data. Absent → `unknown`.
   */
  factoryName?: string;
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
  // Gate ids come from recorded run data, so the accumulator is null-prototyped
  // for the same reason runsByDeliveryMode is: a gate literally named
  // "__proto__" or "toString" must count as an ordinary key rather than
  // colliding with an inherited Object member.
  const rejectionsByGate: Record<string, number> = Object.create(
    null,
  ) as Record<string, number>;
  const overrideGrants: CycleOverrideGrant[] = [];
  const touchSources: MetricSource[] = [];
  let patchCycles = 0;
  const patchSources: MetricSource[] = [];

  // Per-stage rollup keyed by stageId.
  const stageEntries = new Map<string, number>();
  const stageMs = new Map<string, number>();
  const stageValidDurationVisits = new Map<string, number>();
  const stageInvalidDurationVisits = new Map<string, number>();
  const stageDispatches = new Map<string, number>();
  /** stageId → ISO timestamp of its first entry, for time-to-gate. */
  const stageFirstEnteredAt = new Map<string, string>();

  // --- Ceremony replay accumulators (FRK-METRICS-002) ----------------------
  // Collected from the same single journal pass, so ceremony metrics rest on
  // exactly the same facts as the existing flow metrics.
  const ceremonyReplay: CeremonyReplay = {
    stageCycleEnteredAt: new Map(),
    entries: [],
    advancedOutOf: new Map(),
    parkedAtStage: new Map(),
    stageEntries,
    verifiedDraftAt: undefined,
    totalVisits: 0,
  };
  /** Record a stage entry, keyed by stage+cycle for approval-wait lookup. */
  const noteEntry = (
    stageId: string,
    at: string,
    version: number,
    cycle: number | undefined,
  ) => {
    ceremonyReplay.entries.push({ stageId, at, version });
    if (cycle !== undefined) {
      const key = stageCycleKey(stageId, cycle);
      // First entry into a stage-cycle is when the gate became pending;
      // later re-records must not overwrite it.
      if (!ceremonyReplay.stageCycleEnteredAt.has(key)) {
        ceremonyReplay.stageCycleEnteredAt.set(key, { at, version });
      }
    }
  };

  const closeVisit = (visit: Visit, at: string) => {
    if (visit.leftAt === undefined) visit.leftAt = at;
    const ms = msBetween(visit.enteredAt, at);
    if (ms === undefined) {
      stageInvalidDurationVisits.set(
        visit.stageId,
        (stageInvalidDurationVisits.get(visit.stageId) ?? 0) + 1,
      );
      return;
    }
    stageValidDurationVisits.set(
      visit.stageId,
      (stageValidDurationVisits.get(visit.stageId) ?? 0) + 1,
    );
    stageMs.set(visit.stageId, (stageMs.get(visit.stageId) ?? 0) + ms);
  };

  const openVisit = (visit: Visit) => {
    if (current !== null) closeVisit(current, visit.enteredAt);
    visits.push(visit);
    stageEntries.set(visit.stageId, (stageEntries.get(visit.stageId) ?? 0) + 1);
    if (!stageFirstEnteredAt.has(visit.stageId)) {
      stageFirstEnteredAt.set(visit.stageId, visit.enteredAt);
    }
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
        const startStage = str(payload.stage) ?? entry.stageId ?? "(unknown)";
        openVisit({
          stageId: startStage,
          enteredAt: entry.at,
          enteredVia: "start",
          terminal: false,
          openVersion: version,
        });
        // `started` carries no cycle; entering the initial stage IS cycle 1 —
        // the factory's own counter semantics, not an invented value.
        noteEntry(startStage, entry.at, version, 1);
        break;
      }
      case "reset": {
        eras += 1;
        const resetStage = entry.stageId ?? "(unknown)";
        openVisit({
          stageId: resetStage,
          enteredAt: entry.at,
          enteredVia: "reset",
          terminal: false,
          openVersion: version,
        });
        // A reset restores the initial stage, so this entry is that stage's
        // cycle 1 again only if no cycle was recorded; the payload wins.
        noteEntry(
          resetStage,
          entry.at,
          version,
          typeof payload.cycle === "number" ? payload.cycle : undefined,
        );
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
        noteEntry(
          to,
          entry.at,
          version,
          typeof payload.cycle === "number" ? payload.cycle : undefined,
        );
        // Yield / park facts come from the explicit `from` / `to` payload the
        // engine writes — never inferred from a stage name.
        const from = str(payload.from);
        if (!terminal && from !== undefined) {
          const existing = ceremonyReplay.advancedOutOf.get(from) ?? [];
          existing.push(journalSource(version));
          ceremonyReplay.advancedOutOf.set(from, existing);
        }
        if (terminal) {
          terminalAt = entry.at;
          terminalStageId = to;
          terminalVersion = version;
          if (to !== DONE_TERMINAL_STAGE) {
            const existing = ceremonyReplay.parkedAtStage.get(to) ?? [];
            existing.push(journalSource(version));
            ceremonyReplay.parkedAtStage.set(to, existing);
          }
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
        // A cycle-override approval is a human buying one more entry into a
        // stage that hit its limit, not an ordinary definition gate clearing.
        const gateId = str(payload.gateId);
        if (gateId !== undefined && gateId.startsWith(CYCLE_OVERRIDE_PREFIX)) {
          overrideGrants.push({
            // The stage the run occupied when the grant was recorded; the
            // OVERRIDDEN stage is the gate id's suffix, which can differ.
            stage: entry.stageId ?? "(unknown)",
            gateId,
          });
        }
        break;
      }
      case "rejected": {
        rejections += 1;
        touchSources.push(journalSource(version));
        // Key on the rejected gate. An event with no usable gateId still has
        // to be counted somewhere, or the per-gate counts stop summing to
        // `rejections` — it buckets under "(unknown)" instead of vanishing.
        const gateId = str(payload.gateId) ?? "(unknown)";
        rejectionsByGate[gateId] = (rejectionsByGate[gateId] ?? 0) + 1;
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
  // Time-to-gate: wall clock from the run's start to a stage's first entry.
  // Deliberately inclusive of park/idle time — it is the gap between two
  // journal timestamps, not a sum of active occupancy.
  const firstEnteredMsFor = (stageId: string): number | null => {
    const enteredAt = stageFirstEnteredAt.get(stageId);
    if (enteredAt === undefined || startedAt === undefined) return null;
    return msBetween(startedAt, enteredAt) ?? null;
  };
  const stages: StageMetric[] = [...stageIds]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((stageId) => {
      const validVisits = stageValidDurationVisits.get(stageId) ?? 0;
      const invalidVisits = stageInvalidDurationVisits.get(stageId) ?? 0;
      const durationAvailability: Availability = invalidVisits === 0 &&
          validVisits > 0
        ? "available"
        : validVisits > 0
        ? "partial"
        : "unavailable";
      return {
        stageId,
        entries: stageEntries.get(stageId) ?? 0,
        totalMs: validVisits > 0 ? stageMs.get(stageId) ?? 0 : null,
        durationAvailability,
        durationReason: durationAvailability === "available"
          ? undefined
          : validVisits > 0
          ? `${invalidVisits} stage visit(s) had invalid duration endpoints; total covers ${validVisits} valid visit(s) only`
          : "no stage visit had valid duration endpoints",
        firstEnteredMs: firstEnteredMsFor(stageId),
        dispatchAttempts: stageDispatches.get(stageId) ?? 0,
        terminal: terminalStageId === stageId && runStatus === "terminal",
      };
    });

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
  // This public boolean is a proven-positive flag, not a complete
  // classification. Unknown/incomplete history stays false.
  const acceptedFirstPass = runStatus === "terminal" &&
    terminalStageId === DONE_TERMINAL_STAGE &&
    !data.journalTruncated &&
    rejections === 0 && eras === 1;

  const humanTouches = approvals + rejections;

  // --- Cycle exhaustion (inferred from overrides; see the doc comment) ------
  // Keyed by the OVERRIDDEN stage — the gate id's suffix — because that is the
  // stage whose limit was reached, regardless of where the grant was recorded.
  const exhaustionCounts = new Map<string, number>();
  for (const grant of overrideGrants) {
    const target = grant.gateId.slice(CYCLE_OVERRIDE_PREFIX.length);
    const stage = target.length > 0 ? target : "(unknown)";
    exhaustionCounts.set(stage, (exhaustionCounts.get(stage) ?? 0) + 1);
  }
  const cycleExhaustions: CycleExhaustion[] = [...exhaustionCounts.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((stage) => ({ stage, overrides: exhaustionCounts.get(stage) ?? 0 }));

  // --- Delivery mode (intake artifact, latest version) ----------------------
  // Read as recorded from `approved-work-order`; never defaulted. See the
  // FlowMetrics.deliveryMode doc comment for why no fallback is applied.
  let deliveryMode: string | null = null;
  const deliveryModeSources: MetricSource[] = [];
  // Also captured for the ceremony breakdown dimensions, which read further
  // fields off the very same intake record.
  let workOrderSource: MetricSource | null = null;
  let workOrderPayload: Record<string, unknown> | null = null;
  const workOrderVersions = data.artifactVersions.get(WORK_ORDER_ARTIFACT);
  if (workOrderVersions !== undefined && workOrderVersions.size > 0) {
    const latestVersion = Math.max(...workOrderVersions.keys());
    const envelope = workOrderVersions.get(latestVersion);
    if (envelope !== undefined) {
      workOrderSource = {
        kind: "artifact",
        name: artifactInstance(data.slug, WORK_ORDER_ARTIFACT),
        version: latestVersion,
      };
      deliveryModeSources.push(workOrderSource);
      workOrderPayload = envelope.payload;
      deliveryMode = str(envelope.payload.deliveryMode) ?? null;
    }
  }

  // --- Ceremony / approval-friction baseline -------------------------------
  ceremonyReplay.startedAt = startedAt;
  for (const count of stageEntries.values()) {
    ceremonyReplay.totalVisits += count;
  }
  const ceremony = buildCeremonyMetrics(data, ceremonyReplay, {
    journalSource,
    stateSource,
    workOrderSource,
    workOrderPayload,
    factoryName: options.factoryName ?? null,
    cycleOverrideGrants: overrideGrants,
    cycleExhaustions,
  });

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
    rejectionsByGate,
    cycleOverrides: {
      count: overrideGrants.length,
      grants: overrideGrants,
    },
    cycleExhaustions,
    patchCycles: { value: patchCycles, sources: patchSources },
    outcome: { value: outcome, sources: outcomeSources },
    deliveryMode: { value: deliveryMode, sources: deliveryModeSources },
    acceptedFirstPass,
    journalTruncated: data.journalTruncated,
    ceremony,
  };
}

// ---------------------------------------------------------------------------
// aggregateFlowMetrics: fold many per-run metrics into a cross-run summary.
// ---------------------------------------------------------------------------

/**
 * Fold the ceremony baseline across runs.
 *
 * Every mean here divides by the number of runs (or decisions) that actually
 * produced a value. A run whose metric was `unavailable` contributes nothing —
 * it is not a zero in the numerator and not a unit in the denominator.
 */
export function aggregateCeremonyMetrics(
  runs: FlowMetrics[],
): CeremonyAggregate {
  const ceremonies = runs.map((r) => r.ceremony);
  const withRecords = ceremonies.filter(
    (c) => c.humanTouches.availability !== "unavailable",
  );

  /** Sum a per-run count over runs where it was available. */
  const sumAvailable = (
    pick: (c: CeremonyMetrics) => TrustedValue<number>,
  ): TrustedValue<number> => {
    const present = ceremonies
      .map(pick)
      .filter((t) => t.value !== null);
    if (present.length === 0) {
      return {
        value: null,
        availability: "unavailable",
        reason: "no run had this metric available",
        sources: [],
        covered: 0,
        total: ceremonies.length,
      };
    }
    return {
      value: present.reduce((a, t) => a + (t.value ?? 0), 0),
      availability: present.length === ceremonies.length
        ? "available"
        : "partial",
      reason: present.length === ceremonies.length
        ? undefined
        : `${
          ceremonies.length - present.length
        } of ${ceremonies.length} runs had no surviving approval records and are excluded`,
      sources: present.flatMap((t) => t.sources),
      covered: present.length,
      total: ceremonies.length,
    };
  };

  /** Mean a per-run value over runs where it was available. */
  const meanAvailable = (
    pick: (c: CeremonyMetrics) => TrustedValue<number>,
    label: string,
  ): TrustedValue<number> => {
    const present = ceremonies.map(pick).filter((t) => t.value !== null);
    if (present.length === 0) {
      return {
        value: null,
        availability: "unavailable",
        reason: `no run had ${label} available`,
        sources: [],
        covered: 0,
        total: ceremonies.length,
      };
    }
    // Denominator is present.length — NOT ceremonies.length. Dividing by the
    // full population would silently treat every unavailable run as a zero.
    return {
      value: present.reduce((a, t) => a + (t.value ?? 0), 0) / present.length,
      availability: present.length === ceremonies.length
        ? "available"
        : "partial",
      reason: present.length === ceremonies.length
        ? undefined
        : `mean over the ${present.length} of ${ceremonies.length} runs where ${label} was derivable`,
      sources: present.flatMap((t) => t.sources),
      covered: present.length,
      total: ceremonies.length,
    };
  };

  // Approval wait is decision-weighted, not run-weighted: a run with 5 slow
  // approvals should count more than a run with 1 fast one.
  const allWaits = ceremonies.flatMap((c) => c.approvalWaits);
  const measuredWaits = allWaits.filter((w) => w.waitMs !== null);
  const meanApprovalWaitMs: TrustedValue<number> = measuredWaits.length === 0
    ? {
      value: null,
      availability: "unavailable",
      reason: allWaits.length === 0
        ? "no human decisions were recorded on any run"
        : "no recorded decision on any run had a derivable pending timestamp",
      sources: [],
      covered: 0,
      total: allWaits.length,
    }
    : {
      value: Math.round(
        measuredWaits.reduce((a, w) => a + (w.waitMs ?? 0), 0) /
          measuredWaits.length,
      ),
      availability: measuredWaits.length === allWaits.length
        ? "available"
        : "partial",
      reason: measuredWaits.length === allWaits.length
        ? undefined
        : `${
          allWaits.length - measuredWaits.length
        } of ${allWaits.length} decisions across all runs had no derivable pending timestamp and are excluded`,
      sources: measuredWaits.flatMap((w) => w.sources),
      covered: measuredWaits.length,
      total: allWaits.length,
    };

  const approvalsByGate = countMap();
  const rejectionsByGate = countMap();
  for (const c of ceremonies) {
    for (const gateId of Object.keys(c.approvalsByGate)) {
      approvalsByGate[gateId] = (approvalsByGate[gateId] ?? 0) +
        (c.approvalsByGate[gateId] ?? 0);
    }
    for (const gateId of Object.keys(c.rejectionsByGate)) {
      rejectionsByGate[gateId] = (rejectionsByGate[gateId] ?? 0) +
        (c.rejectionsByGate[gateId] ?? 0);
    }
  }

  const unblocked = new Set<string>();
  for (const c of ceremonies) {
    for (const stage of c.stagesUnblocked) unblocked.add(stage);
  }

  // Dimension buckets. An absent dimension buckets under "unknown" — it is
  // never inferred from a stage id, a work-item ref, or prose.
  const bucket = (
    pick: (c: CeremonyMetrics) => string | null,
  ): Record<string, number> => {
    const out = countMap();
    for (const c of ceremonies) {
      const key = pick(c) ?? "unknown";
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  };

  return {
    runs: ceremonies.length,
    runsWithDecisionRecords: withRecords.length,
    totalDistinctDecisions: sumAvailable((c) => c.distinctDecisionCount),
    totalRawDecisionRecords: sumAvailable((c) => c.humanTouches),
    totalApprovals: sumAvailable((c) => c.approvals),
    totalRejections: sumAvailable((c) => c.rejections),
    approvalsByGate,
    rejectionsByGate,
    meanApprovalWaitMs,
    approvalWaitCoverage: {
      covered: measuredWaits.length,
      total: allWaits.length,
    },
    meanStageVisits: meanAvailable((c) => c.stageVisitCount, "stage visits"),
    meanReviewFrequency: meanAvailable(
      (c) => c.reviewFrequency,
      "review frequency",
    ),
    meanPatchFrequency: meanAvailable(
      (c) => c.patchFrequency,
      "patch frequency",
    ),
    meanTimeToVerifiedDraftMs: meanAvailable(
      (c) => c.timeToVerifiedDraftMs,
      "time to verified draft",
    ),
    totalCycleOverrides: ceremonies.reduce(
      (a, c) => a + (c.cycleOverrideCount.value ?? 0),
      0,
    ),
    stagesUnblocked: [...unblocked].sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
    runsByWorkClass: bucket((c) => c.dimensions.workClass),
    runsByRiskProfile: bucket((c) => c.dimensions.riskProfile),
    runsByAuthorityProfile: bucket((c) => c.dimensions.authorityProfile),
    runsByFactory: bucket((c) => c.dimensions.factory),
  };
}

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

  // Delivery-mode mix. Runs with nothing recorded bucket under "unset" rather
  // than inheriting a default the report has no business inventing. The keys
  // come from recorded run data, so the accumulator is null-prototyped: a run
  // whose recorded mode is literally "__proto__" or "toString" must count as
  // an ordinary bucket, not collide with an inherited Object member.
  const runsByDeliveryMode: Record<string, number> = Object.create(
    null,
  ) as Record<string, number>;
  for (const r of runs) {
    const key = r.deliveryMode.value ?? "unset";
    runsByDeliveryMode[key] = (runsByDeliveryMode[key] ?? 0) + 1;
  }

  // Per-gate rejection totals across runs. Null-prototyped for the same
  // recorded-key reason, and read with an own-property check so a hostile gate
  // name on one run cannot pollute the merge from another.
  const totalRejectionsByGate: Record<string, number> = Object.create(
    null,
  ) as Record<string, number>;
  for (const r of runs) {
    for (const gateId of Object.keys(r.rejectionsByGate)) {
      const count = r.rejectionsByGate[gateId] ?? 0;
      totalRejectionsByGate[gateId] = (totalRejectionsByGate[gateId] ?? 0) +
        count;
    }
  }

  return {
    runs: runs.length,
    terminalRuns: terminal.length,
    doneRuns,
    parkedRuns,
    cleanupRequiredRuns,
    abortedRuns,
    activeRuns,
    acceptedFirstPassRate: terminal.length > 0
      ? terminal.filter((r) => r.acceptedFirstPass).length / terminal.length
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
    runsByDeliveryMode,
    totalRejectionsByGate,
    totalCycleOverrides: runs.reduce((a, r) => a + r.cycleOverrides.count, 0),
    ceremony: aggregateCeremonyMetrics(runs),
  };
}

/**
 * Render a recorded-key count map as a deterministic `key: n, key: n` list,
 * or an em dash when empty. Keys sort so the same data always renders alike.
 */
function fmtCountMap(counts: Record<string, number>): string {
  const keys = Object.keys(counts).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  if (keys.length === 0) return "—";
  return keys.map((k) => `${k}: ${counts[k]}`).join(", ");
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

/**
 * Render a trusted value. An unavailable value renders as "unavailable" with
 * its reason — deliberately NOT as "0" or "—", so a reader can never mistake
 * "we could not measure this" for "this measured zero".
 */
function fmtTrusted(
  t: TrustedValue<number>,
  format: (value: number) => string,
): string {
  if (t.value === null) {
    return `unavailable${t.reason !== undefined ? ` — ${t.reason}` : ""}`;
  }
  const body = format(t.value);
  if (t.availability === "partial") {
    const coverage = t.covered !== undefined && t.total !== undefined
      ? ` ${t.covered}/${t.total}`
      : "";
    return `${body} _(partial${coverage}${
      t.reason !== undefined ? `: ${t.reason}` : ""
    })_`;
  }
  return body;
}

function fmtRate(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

/** Render the ceremony / approval-friction baseline for one run. */
function renderCeremony(c: CeremonyMetrics): string[] {
  const lines: string[] = [];
  lines.push("### Ceremony & approval friction", "");

  if (c.approvalsTruncated) {
    lines.push(
      "_Some approval record versions were garbage-collected; decision counts" +
        " below are a lower bound._",
      "",
    );
  }

  lines.push("| Metric | Value | Traceability |", "| --- | --- | --- |");
  const row = (label: string, value: string, sources: MetricSource[]) =>
    lines.push(
      `| ${escapeCell(label)} | ${escapeCell(value)} | _${
        escapeCell(sourcePointer(sources))
      }_ |`,
    );
  const trow = (
    label: string,
    t: TrustedValue<number>,
    format: (v: number) => string = String,
  ) => row(label, fmtTrusted(t, format), t.sources);

  trow("Human touches (raw decision records)", c.humanTouches);
  trow("Distinct decisions", c.distinctDecisionCount);
  row(
    "Duplicate decision records",
    String(
      c.rawDecisionRecordCount - (c.distinctDecisionCount.value ?? 0),
    ),
    c.duplicateDecisionSources,
  );
  trow("Approvals", c.approvals);
  trow("Rejections", c.rejections);
  row(
    "Approvals by gate",
    fmtCountMap(c.approvalsByGate),
    Object.values(c.approvalsByGateSources).flat(),
  );
  row(
    "Rejections by gate",
    fmtCountMap(c.rejectionsByGate),
    Object.values(c.rejectionsByGateSources).flat(),
  );
  trow("Mean approval wait", c.meanApprovalWaitMs, fmtDuration);
  trow("Stage visits", c.stageVisitCount);
  trow("Unique stages", c.uniqueStageCount);
  trow("Cycles", c.cycleCount);
  trow("Review frequency", c.reviewFrequency, fmtRate);
  trow("Patch frequency", c.patchFrequency, fmtRate);
  trow("Time to verified draft", c.timeToVerifiedDraftMs, fmtDuration);
  trow("Cycle overrides granted", c.cycleOverrideCount);
  row(
    "Stages unblocked by override",
    fmtTrusted(
      {
        value: c.stagesUnblockedAvailability === "unavailable"
          ? null
          : c.stagesUnblocked.length,
        availability: c.stagesUnblockedAvailability,
        reason: c.stagesUnblockedReason,
        sources: c.stagesUnblockedSources,
      },
      () => c.stagesUnblocked.length === 0 ? "—" : c.stagesUnblocked.join(", "),
    ),
    c.stagesUnblockedSources,
  );
  row(
    "Bounded-loop exhaustions",
    fmtTrusted(
      {
        value: c.boundedLoopExhaustionsAvailability === "unavailable"
          ? null
          : c.boundedLoopExhaustions.length,
        availability: c.boundedLoopExhaustionsAvailability,
        reason: c.boundedLoopExhaustionsReason,
        sources: c.boundedLoopExhaustionSources,
      },
      () =>
        c.boundedLoopExhaustions.length === 0
          ? "—"
          : c.boundedLoopExhaustions.map((e) => `${e.stage}: ${e.overrides}`)
            .join(", "),
    ),
    c.boundedLoopExhaustionSources,
  );
  row(
    "Dimensions (factory / work class / risk / authority)",
    [
      c.dimensions.factory ?? "unknown",
      c.dimensions.workClass ?? "unknown",
      c.dimensions.riskProfile ?? "unknown",
      c.dimensions.authorityProfile ?? "unknown",
    ].join(" / "),
    c.dimensions.sources,
  );
  lines.push("");

  // Per-decision approval waits, including the ones that could not be
  // measured — showing them is the point: invisible unavailability reads as
  // an absence of friction.
  if (c.approvalWaits.length > 0) {
    lines.push("#### Approval waits", "");
    lines.push(
      "| Gate | Stage | Cycle | Decision | Wait | Availability |",
      "| --- | --- | ---: | --- | ---: | --- |",
    );
    for (const w of c.approvalWaits) {
      lines.push(
        "| " +
          [
            `\`${escapeCell(w.gateId)}\``,
            `\`${escapeCell(w.stageId)}\``,
            String(w.cycle),
            w.decision,
            w.waitMs === null ? "unavailable" : fmtDuration(w.waitMs),
            w.availability === "available" ? "available" : escapeCell(
              `${w.availability}${
                w.reason !== undefined ? `: ${w.reason}` : ""
              }`,
            ),
          ].join(" | ") +
          " |",
      );
    }
    lines.push("");
  }

  if (c.stageFlow.length > 0) {
    lines.push("#### Stage yield / park", "");
    lines.push(
      "| Stage | Advanced out | Parked at | Yield rate | Park rate | Availability | Traceability |",
      "| --- | ---: | ---: | ---: | ---: | --- | --- |",
    );
    for (const s of c.stageFlow) {
      lines.push(
        "| " +
          [
            `\`${escapeCell(s.stageId)}\``,
            String(s.advancedOut),
            String(s.parkedAt),
            s.yieldRate === null ? "—" : fmtRate(s.yieldRate),
            s.parkRate === null ? "—" : fmtRate(s.parkRate),
            escapeCell(
              `${s.availability ?? "available"}${
                s.reason !== undefined ? `: ${s.reason}` : ""
              }`,
            ),
            `_${escapeCell(sourcePointer(s.sources))}_`,
          ].join(" | ") +
          " |",
      );
    }
    lines.push("");
  }
  return lines;
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
  row(
    "Rejections by gate",
    fmtCountMap(m.rejectionsByGate),
    m.humanTouches,
  );
  row(
    "Cycle overrides granted",
    m.cycleOverrides.count === 0
      ? "—"
      : `${m.cycleOverrides.count} (${
        m.cycleOverrides.grants
          .map((g) => `${g.gateId} @ ${g.stage}`)
          .join(", ")
      })`,
    m.humanTouches,
  );
  row(
    "Cycle limits exhausted",
    m.cycleExhaustions.length === 0 ? "—" : m.cycleExhaustions
      .map((e) => `${e.stage}: ${e.overrides}`)
      .join(", "),
    m.humanTouches,
  );
  row("Patch cycles", String(m.patchCycles.value), m.patchCycles);
  row("Failed/parked stage", m.failedStage.value ?? "—", m.failedStage);
  row("Delivery mode", m.deliveryMode.value ?? "—", m.deliveryMode);
  row("Accepted first pass", m.acceptedFirstPass ? "yes" : "no", m.outcome);
  lines.push("");

  // Per-stage rollup.
  lines.push("### Per-stage rollup", "");
  if (m.stages.length === 0) {
    lines.push("_No stage visits reconstructed._", "");
  } else {
    lines.push(
      "| Stage | Entries | Total time | Duration trust | First entered | Dispatch attempts | Terminal |",
      "| --- | ---: | ---: | --- | ---: | ---: | --- |",
    );
    for (const s of m.stages) {
      lines.push(
        "| " +
          [
            `\`${escapeCell(s.stageId)}\``,
            String(s.entries),
            s.totalMs === null ? "unavailable" : fmtDuration(s.totalMs),
            escapeCell(
              `${s.durationAvailability}${
                s.durationReason === undefined ? "" : `: ${s.durationReason}`
              }`,
            ),
            s.firstEnteredMs === null ? "—" : fmtDuration(s.firstEnteredMs),
            String(s.dispatchAttempts),
            s.terminal ? "yes" : "no",
          ].join(" | ") +
          " |",
      );
    }
    lines.push("");
  }
  lines.push(...renderCeremony(m.ceremony));
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
    arow("Total rejections by gate", fmtCountMap(a.totalRejectionsByGate));
    arow("Total cycle overrides", String(a.totalCycleOverrides));
    // Delivery-mode mix, sorted for deterministic output.
    arow("Runs by delivery mode", fmtCountMap(a.runsByDeliveryMode));
    lines.push("");

    // Cross-run ceremony rollup. Every mean states the denominator it was
    // actually taken over, so a partial mean cannot read as a full one.
    const c = a.ceremony;
    lines.push("### Ceremony & approval friction (cross-run)", "");
    lines.push("| Aggregate metric | Value |", "| --- | --- |");
    arow(
      "Runs with surviving approval records",
      `${c.runsWithDecisionRecords}/${c.runs}`,
    );
    arow(
      "Total distinct decisions",
      fmtTrusted(c.totalDistinctDecisions, String),
    );
    arow(
      "Total raw decision records",
      fmtTrusted(c.totalRawDecisionRecords, String),
    );
    arow("Total approvals", fmtTrusted(c.totalApprovals, String));
    arow("Total rejections", fmtTrusted(c.totalRejections, String));
    arow("Approvals by gate", fmtCountMap(c.approvalsByGate));
    arow("Rejections by gate", fmtCountMap(c.rejectionsByGate));
    arow("Mean approval wait", fmtTrusted(c.meanApprovalWaitMs, fmtDuration));
    arow(
      "Approval wait coverage (measured / recorded decisions)",
      `${c.approvalWaitCoverage.covered}/${c.approvalWaitCoverage.total}`,
    );
    arow(
      "Mean stage visits",
      fmtTrusted(c.meanStageVisits, (v) => v.toFixed(1)),
    );
    arow("Mean review frequency", fmtTrusted(c.meanReviewFrequency, fmtRate));
    arow("Mean patch frequency", fmtTrusted(c.meanPatchFrequency, fmtRate));
    arow(
      "Mean time to verified draft",
      fmtTrusted(c.meanTimeToVerifiedDraftMs, fmtDuration),
    );
    arow("Total cycle overrides", String(c.totalCycleOverrides));
    arow(
      "Stages unblocked by override",
      c.stagesUnblocked.length === 0 ? "—" : c.stagesUnblocked.join(", "),
    );
    arow("Runs by factory", fmtCountMap(c.runsByFactory));
    arow("Runs by work class", fmtCountMap(c.runsByWorkClass));
    arow("Runs by risk profile", fmtCountMap(c.runsByRiskProfile));
    arow("Runs by authority profile", fmtCountMap(c.runsByAuthorityProfile));
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
    findAllForModel?(
      type: unknown,
      modelId: string,
    ): Promise<unknown[]>;
    listNames?(type: unknown, modelId: string): Promise<string[]>;
  };
}

const FACTORY_TYPE = "@swamp/software-factory";

/** The report contract swamp invokes: method-scoped, gated to the factory type. */
export const report = {
  name: "@mgreten/software-factory-flow-metrics",
  description:
    "Deterministic quality/reliability/flow/ceremony metrics for a factory work item — time-to-terminal, per-stage durations and entry counts, dispatch attempts, failed/parked stage, human touches, deduplicated decisions keyed by gate+stage+cycle+decision, per-gate approvals and rejections, approval wait durations, stage visits/cycles, review and patch frequency, stage yield and park rates, time to verified draft, bounded-loop exhaustion, cycle-limit overrides and the stages they unblocked, and terminal outcome — with a cross-run aggregate, every metric carrying a trust/availability label and a journal/approval/artifact source pointer so unmeasurable values read as unavailable rather than zero, rendered statically from recorded run data",
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

    // Cross-run aggregate: prefer canonical model-data enumeration, with
    // listNames retained as a compatible secondary route.
    const others: { workItem: string; data: MetricsData }[] = [];
    const enumeration = await enumerateReaderNames(reader);
    if (enumeration.complete) {
      const names = enumeration.names;
      for (const slug of runSlugsFromNames(names)) {
        if (slug === primarySlug) continue;
        const data = await loadMetricsData(reader, slug);
        const otherWorkItem = data.state?.workItem ?? slug;
        others.push({ workItem: otherWorkItem, data });
      }
    }

    // The factory's own definition name is the one breakdown dimension that
    // is a property of the model instance rather than the run's data.
    const built = buildFlowMetricsReport(workItem, primaryData, others, {
      factoryName: context.definition?.name,
    });
    return {
      markdown: renderFlowMetricsMarkdown(built),
      json: built as unknown as Record<string, unknown>,
    };
  },
};
