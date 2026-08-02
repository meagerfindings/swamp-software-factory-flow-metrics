# @mgreten/software-factory-flow-metrics

A deterministic **quality / reliability / flow / ceremony** report for
[`@swamp/software-factory`](https://swamp-club.com) work items. It fires after
the factory's `summary` method and reconstructs a run's flow metrics purely from
the run data the factory already recorded — its state record, its journal, and
its versioned artifact / evidence envelopes. No LLM is involved anywhere: the
same run data always produces the same metrics, and every displayed number
carries a source pointer back to the journal or artifact record it came from.

It answers the questions you actually ask about a software-development lifecycle:
how long did this take, how many times did it loop, where did it get stuck, how
often did a human have to step in, and — across every run on the instance — what
is the accepted-first-pass rate and cleanup health.

## Installation

```bash
swamp extension pull @mgreten/software-factory-flow-metrics
swamp extension install
```

## Setup

This is a **report**, not a model — there is nothing to instantiate. Once the
extension is installed, the report activates automatically for any
`@swamp/software-factory` model instance in the repo. It is scoped to the
factory's `summary` method: run the summary and the report renders alongside it.

```bash
# Run a factory summary for a work item; the flow-metrics report renders with it.
swamp model method run <your-factory-instance> summary --arg workItem=<work-item-ref>
```

## Usage

The report emits both markdown (human-readable) and JSON (machine-readable). A
single-run report renders headline metrics plus a per-stage rollup:

```markdown
# Flow Metrics: PROJ-123

**Run status:** terminal · **Outcome:** done

| Metric | Value | Traceability |
| --- | --- | --- |
| Time to terminal | 42m 10s (2530000 ms) | _source: state state-PROJ-123, journal journal-PROJ-123 v18_ |
| Eras (start + resets) | 1 | _source: state state-PROJ-123_ |
| Dispatch attempts | 3 | _source: journal journal-PROJ-123 v4 …_ |
| Human touches | 1 (1 approved, 0 rejected) | _source: journal journal-PROJ-123 v12_ |
| Patch cycles | 0 | _source: (none)_ |
| Accepted first pass | yes | _source: journal journal-PROJ-123 v18_ |
```

The additive `ceremony` block also reports raw and distinct human decisions,
approval/rejection splits by gate, stage visits and cycles, review/patch
frequency, explicit transition yield/park facts, cycle-limit overrides, and
canonical work-class/risk/authority dimensions when present. Every ceremony
value carries availability, provenance, and coverage where a denominator is
involved. Stage durations likewise expose `available`, `partial`, or
`unavailable` trust: malformed endpoints never become zero and only surviving
valid visits contribute to totals and aggregate duration denominators.

When more than one run exists on the model instance, a cross-run aggregate is
appended. Means use only available contributors and expose their actual
coverage.

## Global Arguments

None. The report reads only the run data recorded by the factory instance it
attaches to; it takes no configuration.

## Report: flow-metrics

Scope: `method` (activates on `@swamp/software-factory`'s `summary`).

| Behaviour | Detail |
| --- | --- |
| Trigger | `modelType == @swamp/software-factory` and `methodName == summary` |
| Primary input | `methodArgs.workItem` (the work item to report on) |
| Failure path | Renders the failure reason instead of an empty placeholder |
| Cross-run aggregate | Rendered when canonical `findAllForModel` (or compatible `listNames`) enumerates >1 run |

## How It Works

The report replays the factory's **journal** — the ordered event log the state
machine writes as it runs — into stage visits, era boundaries (start + resets),
dispatch attempts, and human approvals/rejections. From that reconstruction it
derives:

- **time-to-terminal** — start to terminal `run_terminal`;
- **per-stage durations and entry counts**, aggregated across reset cycles;
- **dispatch attempts** (`dispatched` events);
- **failed / parked stage** (terminal `*-blocked` / `cleanup-required` /
  `aborted`);
- **human touches** (`approved` + `rejected`);
- **patch cycles** (`findings_resolved` events + patch-stage re-entries);
- **terminal outcome class** (`done` | `cleanup-required` | `parked` |
  `aborted` | `active` | `unknown`);
- **accepted-first-pass** — a proven-positive flag: `true` only when a complete,
  non-truncated journal proves terminal `done`, zero rejections, and exactly one
  era. `false` includes unknown/incomplete histories and is not a complete
  classification.

Two requested duration metrics are intentionally unavailable with current
canonical factory records:

- **approval wait** requires a recorded request/pending timestamp as well as
  `decidedAt`; stage entry is not used as a proxy;
- **time to verified draft** requires an explicit verified-draft lifecycle
  fact; arbitrary `evidence_recorded` and `findings_resolved` events do not
  prove that endpoint.

The report is deliberately zero-dependency and zod-free so it bundles cleanly as
a report extension (report bundles are built without the extension import map).
All decoded run data is validated with hand-written structural guards, and
invalid records are skipped rather than fatal, so a partially garbage-collected
journal still produces a report (flagged as truncated).

## License

MIT — see LICENSE for details.
