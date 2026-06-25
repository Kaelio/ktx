# Resumable and fault-tolerant source ingest

> Refined spec. No intake draft — surfaced by a real user report, not the
> playground agent (see Motivation). Lives beside the analogous scan-durability
> specs 19/20.
>
> **Scope: make `ktx ingest` (the source-ingest work-unit pipeline behind dbt /
> Metabase / Notion) survive interruption and partial failure on large
> projects.** Two compounding gaps live on the source-ingest path: (1) an
> interrupted run restarts every work unit from scratch — there is no cross-run
> reuse of already-generated work-unit output, so a multi-day dbt ingest loses
> *all* progress to a single VPN/network blip; (2) the final integration gate is
> all-or-nothing — one artifact that cannot pass it (after LLM repair) discards
> the **entire** run with nothing committed. This is the source-ingest analog of
> spec 19 (move the durability boundary to the cost boundary so expensive LLM
> work is not lost) and spec 20 (a stage survives an interruption with per-item
> durability). It **reuses** the same content-keyed durability primitive those
> specs established rather than copying it.

## Problem

Two independent failure modes on the source-ingest work-unit (WU) pipeline,
both confirmed in the current code, both observed by a user on a ~2-day dbt
ingest. Their union makes large-project ingest brittle: any interruption is
total loss, and any single unfixable artifact at the end is total loss.

### 1. An interrupted run resumes nothing — every work unit re-runs

`IngestBundleRunner` (`context/ingest/ingest-bundle.runner.ts`) executes a run as
a sequence of stages: fetch → parse/extract into **work units** → run each WU as
an isolated agent loop in a child worktree (`runIsolatedWorkUnit` →
`executeWorkUnit`, `stages/stage-3-work-units.ts`) → integrate the successful WU
patches → reconcile → finalize → final gates → one atomic squash commit
(`squashMergeIntoMain`, ~2716). The WU stage is where the LLM cost lives: each WU
is an agent loop that reads its `rawFiles`/`dependencyPaths` and writes SL/wiki
artifacts, producing a git patch (`WorkUnitOutcome.patchPath` /
`patchTouchedPaths`, `stage-3-work-units.ts:31-46`).

The only persisted cross-run state is `SqliteBundleIngestStore`
(`context/ingest/sqlite-bundle-ingest-store.ts`): run metadata, the final report,
and provenance — all written at or near **run completion**. There is **no
checkpoint of completed WU output**. A run that dies mid-flight (the user's
VPN/network drop) leaves nothing reusable: the next `ktx ingest` re-fetches,
re-parses, and **re-executes every WU from scratch**, re-paying the entire LLM
cost. The store even keys `job_id` UNIQUE, so a re-run is a brand-new job with no
relationship to the interrupted one.

> Observed (user report, large dbt project): a run reached deep into its
> work-unit progress and was lost to a network blip; the follow-up run started
> over from zero. On a ~2-day ingest this is the difference between a 5-minute
> resume and a 2-day redo.

### 2. The final integration gate is all-or-nothing

After all surviving WUs are integrated, `validateFinalIngestArtifacts`
(`context/ingest/artifact-gates.ts:96`) runs the final gate. It checks, across
the *integrated* tree:

- **intrinsic source validity** — `validateTouchedSources` →
  `validateWuTouchedSources` (`stages/validate-wu-sources.ts:124`) →
  `validateSingleSource` (`context/sl/tools/sl-warehouse-validation.ts:56`),
  which runs a **live warehouse dry-run** (`SELECT * FROM (sql) LIMIT 1`);
- **cross-artifact references** — dangling join targets
  (`findJoinTargetErrors`, `validate-wu-sources.ts:89`), dangling `wiki→wiki`
  refs (`validateWikiRefs` → `findMissingWikiRefs`), broken `wiki→sl_ref`s
  (`validateWikiSlRefs`, `artifact-gates.ts:39`), and broken wiki body refs
  (`findInvalidWikiBodyRefs`).

On any error it **`throw`s a single concatenated string** (`artifact-gates.ts:129`).
The runner catches it, runs the LLM repair `repairFinalGateFailure`
(`runner.ts:2595`, `maxAttempts: 2`), and if repair still fails, **re-throws**
(`runner.ts:2623`) → `markFailed` → the squash never runs → `commitSha: null`
(`runner.ts:2729`) → **the whole run is discarded, nothing committed.**

The crucial asymmetry: a WU that fails *on its own terms* never reaches this gate
— `executeWorkUnit` already validates each WU in isolation (`validateWikiRefs`
~143, `validateTouchedSources` ~150) and **soft-fails** it (`failWithReset`,
~155: the WU resets, is excluded from integration, and the run continues). So by
the time the final gate runs, intrinsic single-source failures are rare. The
gate fails predominantly on **cross-artifact dangling references**: WU-A's source
joins to a source WU-B was meant to create, but WU-B failed/was-excluded, so
A's join now points at nothing. Each WU passed *alone*; the break only appears
once the survivors are integrated — and that break currently nukes the run.

> Observed (user report): a run completed all task generation and then failed at
> the final integration gate on a **single model**; because the gate is
> all-or-nothing, that one failure discarded an ~18h run with nothing committed.

## Generic use case (independent of any benchmark)

Anyone ingesting a large warehouse/BI/dbt project with an LLM pipeline will hit
both failures. Large ingests run long enough that an interruption is a *when*,
not an *if* (laptop sleep, VPN reconnect, transient provider error, an operator
ctrl-C on an apparently-stuck run), and a large artifact set makes it
near-certain that *some* model lands a cross-reference its sibling didn't
produce. Without cross-run reuse, every interruption is a from-scratch redo of
the dominant (LLM) cost; without partial commit, one unfixable artifact throws
away every good one. Both fixes make large-project ingest **resilient and
resumable**: an interruption costs only the unfinished work, and a single bad
model costs only that model — not the run. This is core robustness for a
general-purpose ingestion product.

## Design decisions (resolved during refinement)

These resolve the design space explored during refinement. They constrain the
implementer; the exact code is theirs (requirement-level, per the specs README).

### D1 — Resume is automatic and content-keyed at the work-unit level

A successful WU's output is cached across runs, keyed by a **content hash of its
inputs**, with **no `--resume` flag**. Re-running the same `ktx ingest`
transparently replays any WU whose inputs are byte-identical to a cached success
and re-runs only the changed, failed, or missing WUs. The key is computed over:
the contents of the WU's `rawFiles` + `dependencyPaths` (the bytes the WU reads,
`types.ts:19-28`), the adapter/source identity, and a **version/prompt
fingerprint** (ktx version + the WU system/user prompt + model role). A changed
dbt model busts only that model's entry; everything unchanged replays for free.

> No flag, no config knob. Content-keying makes resume automatic; a flag would
> double the state space for no benefit. This is the same shape scan uses
> (`computeKtxScanEnrichmentInputHash`, spec 19), reached here for the WU
> pipeline.

### D2 — The cached unit is the successful WU's patch; replay verifies or recomputes

The cache stores a successful WU's **output artifacts**: its git patch
(`patchPath` content / `patchTouchedPaths`) plus the metadata integration needs
(`actions`, `touchedSlSources`, `slDisallowed`). On a cache hit, the runner
**replays the patch** into the session worktree — no agent loop, no LLM — exactly
where it would have integrated a freshly-run WU. If a cached patch **fails to
apply** (the surrounding tree drifted), the entry is discarded and the WU
**recomputes**. So a stale hit degrades to "recompute," never to a corrupt tree:
the cache can only make a run faster, never wrong.

### D3 — One durability primitive, shared by scan and ingest

Per the "one capability, one implementation" rule, the content-keyed store is
**extracted** into a shared primitive and **both** scan and ingest route through
it — not copied. Scan's `sqlite-local-enrichment-state-store.ts` (PK
`(connection_id, stage, input_hash)`, `findCompletedStage` / `saveCompletedStage`)
and its `inputHash` computation (`enrichment-state.ts`) are generalized to a
content-keyed result cache; scan is migrated onto the shared primitive **in the
same change** so no second copy exists even transiently. The ingest cache is a
new logical namespace (e.g. keyed `(connectionId, sourceKey, workUnitInputHash)`)
on that one store.

> Extract-and-share in one PR, not "build a copy for ingest now, unify later."
> A temporary fork is exactly the divergence the rule forbids; the one-time
> extraction cost is paid once and both paths benefit from every later fix.

### D4 — Only successes are cached; failures retry on the next run

A failed WU is **not** recorded as terminal — the next run retries it. WU
failures on this path are dominantly transient (network, provider stall, an LLM
slip), and the user's explicit ask is "resume and finish the rest," so a failure
must not be sticky. This deliberately differs from scan's stage store (which
caches failed stages and re-throws): there the failure is the stage's
deterministic verdict; here a WU failure is usually a blip to retry. Caching only
successes also keeps the invariant simple — a cache entry always means "this
exact input already produced this exact good output."

### D5 — The final gate becomes non-fatal: deterministic dangling-edge prune

Replace the gate's fatal `throw`-after-repair with a deterministic reconciliation
that always yields a committable, internally-consistent tree:

1. `validateFinalIngestArtifacts` is refactored to **return structured findings**
   (the danglers it already computes internally — join targets, `wiki→wiki`,
   `wiki→sl_ref`, wiki body refs — plus any intrinsic source failure) instead of
   flattening them into a thrown string.
2. **Drop the rare self-invalid source first.** A source that fails its *own*
   validation at the final gate (intrinsic — rare, since stage 3 already filters
   these) is removed, establishing the surviving artifact set.
3. **Prune the dead edges in a single pass** over that surviving set. For each
   dangling reference — whether it pointed at an absent sibling or at a
   just-dropped source — **remove that reference from its owner** (drop the join
   entry, remove the `wiki ref` / `sl_ref`, remove the broken body link), keeping
   the owning artifact. Because nodes are dropped first (step 2) and pruning only
   removes edges, pruning **cannot create a new dangling edge, so one pass
   suffices; no fixpoint.**
4. Re-run the gate to **confirm** the remainder is clean (warehouse dry-runs are
   cached per D6/D2, ref checks are in-memory, so this is cheap), then squash-commit
   the remainder. If the confirm pass *still* fails, that is a real bug — fail the
   run loudly rather than commit a dirty tree.

`repairFinalGateFailure` (the LLM repair, `runner.ts:2595` / `final-gate-repair.ts`)
is **removed**. The deterministic prune supersedes it for the referential class,
and the rare intrinsic case is handled by drop.

> **Prune the edge, do not cascade the node.** The rejected alternative drops the
> *referencing artifact* and, transitively, everything that referenced *it* — a
> node-quarantine fixpoint that cascades healthy artifacts and needs a closure
> search, a confirm loop, and an un-apply step. Pruning the dead edge keeps the
> dependent intact (minus one pointer that never resolved anyway), needs no
> fixpoint, and acts on findings the gate already produces.
>
> **Why remove the LLM repair rather than keep it as a pre-prune step.** Repair
> can occasionally *fix* a ref (e.g. correct a typo'd source name) where prune
> merely deletes it, preserving marginally more content. We drop it anyway:
> determinism beats an LLM round-trip with variance on the commit path, prune
> guarantees a commit where repair could only `throw`, and deleting it is a net
> maintenance reduction. The decision is reversible — repair could later run as a
> best-effort pass *before* prune — but the default is prune-only.

### D6 — Prune runs on the integrated tree, never poisons the cache (resume ∘ prune compose)

Pruning is applied to the **integrated session worktree** at gate time and is
**re-derived from the current survivor set on every run**. It MUST NOT mutate the
cached WU patches (D2). This makes resume and prune compose correctly and
**self-heal**:

- Run 1: WU-A (joins to B) succeeds and is cached *with its join intact*; WU-B
  fails; the gate prunes A's join-to-B from the integrated tree and commits A
  without it.
- Run 2 (after the root cause is fixed): A's input is unchanged → A **replays
  from cache with its join restored**; B now succeeds and exists; the gate finds
  no dangler and commits both, fully linked.

So a ref pruned because of a sibling's failure costs nothing permanent: fixing
the sibling and re-running restores the link for free. The cache stores
intent (the WU's real output); prune is a per-run consistency projection over
whatever survived.

### D7 — Pruning is faithful and never silent

A pruned reference was, by definition, non-functional (its target was absent), so
removing it loses nothing executable — and removing dangling SL joins is already
the established fix for the SL engine's eager orphan-join rejection. Every prune
and every drop MUST be **recorded in the run report and a trace event** naming
the artifact, the removed reference, and the absent target. The report status
MUST reflect partial completion (extend the existing `failedWorkUnits`
mechanism, `IngestBundleResult`, `types.ts:204-213`, with the pruned-refs /
dropped-sources detail) so a partial run is visibly partial, never a silent
"success."

### D8 — Cache state is regenerable; no migration bridge

The WU cache is regenerable local state under `.ktx/`. Its on-disk/SQLite shape
may change with **no migration bridge** — a stale-shaped or absent cache simply
forces a full (non-resumed) run, exactly today's behavior. Consistent with ktx's
no-backward-compatibility policy; the cache is an optimization, never a source of
truth.

## Requirements

1. **Cross-run WU resume, automatic and content-keyed.** A successful WU's output
   MUST be cached keyed by a content hash over its input bytes
   (`rawFiles` + `dependencyPaths`), the adapter/source identity, and a
   version/prompt fingerprint (ktx version + WU prompt + model role). Re-running
   `ktx ingest` MUST replay cached successes without an agent loop / LLM call and
   re-run only changed, failed, or missing WUs. No `--resume` flag and no config
   knob is added.
2. **Replay verifies or recomputes.** On a cache hit the runner MUST replay the
   stored patch into the session worktree; if the patch does not apply cleanly the
   entry MUST be discarded and the WU recomputed. A cache hit MUST NOT be able to
   produce a tree different from what a fresh run of that WU would have integrated.
3. **Only successes are cached.** A failed WU MUST NOT be recorded as terminal; it
   MUST be retried on the next run.
4. **Conservative invalidation.** The input hash MUST change when the ktx version,
   the WU prompt, or the model role changes (bias toward recompute). Under-keying
   (stale reuse) is a correctness bug; over-keying (an unnecessary recompute) is
   acceptable.
5. **The final gate is non-fatal.** A final-gate failure MUST NOT discard the run.
   `validateFinalIngestArtifacts` MUST return structured findings; the runner MUST
   deterministically **prune** every dangling reference from its owning artifact
   and **drop** any source that fails its own validation, then commit the
   remaining internally-consistent tree.
6. **Single-pass prune, dependents survive.** Pruning MUST remove dead *edges*, not
   cascade-drop owning artifacts; it MUST complete in a single pass (no fixpoint)
   because edge removal cannot create new dangling edges. A dependent that loses
   one dangling ref MUST otherwise be committed intact.
7. **Prune composes with resume.** Pruning MUST operate on the integrated tree and
   MUST NOT mutate cached WU patches. A reference pruned in one run because its
   target was absent MUST be restored automatically on a later run once the target
   exists (resume replays the owner's intact patch).
8. **Confirm before commit.** After pruning/dropping, the gate MUST be re-run on
   the remainder and MUST pass before the squash; if it still fails the run MUST
   fail loudly rather than commit a dirty tree.
9. **`repairFinalGateFailure` is removed.** The LLM final-gate repair path and its
   obsolete tests/branches MUST be deleted (no dormant compatibility path).
10. **Every prune/drop is reported.** Each pruned reference and dropped source MUST
    be recorded in the run report and a trace event (artifact, removed ref, absent
    target). A run that pruned or dropped anything MUST report as partial, never as
    an unqualified success.
11. **One shared durability primitive.** The content-keyed store MUST be a single
    implementation used by both scan and ingest; scan MUST be migrated onto it in
    the same change. No second copy may exist, even transiently.
12. **No regression for clean runs.** A small, uninterrupted run whose every WU
    passes and whose final gate is clean MUST produce byte-identical artifacts and
    the same `commitSha`/report shape (modulo new, empty pruned/dropped fields) as
    today.

## Acceptance criteria

- **Resume skips completed work:** interrupt an ingest after K of N WUs have
  succeeded; re-run the same command (unchanged inputs); the run issues **zero**
  agent loops / LLM calls for the K cached WUs, runs only the remaining N−K, and
  produces the same final artifacts as an uninterrupted run.
- **Changed model busts only its entry:** edit one dbt model between runs; the
  re-run re-executes **only** the WU(s) whose input bytes changed and replays the
  rest from cache.
- **Stale patch self-corrects:** a cached patch that no longer applies (forced
  drift in a test) causes that WU to recompute, not a corrupt tree or a crash.
- **Failures retry:** a WU that fails in run 1 (transient error) is **not** cached;
  run 2 retries it and, on success, integrates it.
- **One bad model no longer nukes the run:** a run where WU-B fails so WU-A's join
  to B dangles **commits** — A is committed with the dangling join **pruned**, the
  report lists the pruned ref, and `commitSha` is non-null (contrast: today this
  throws and commits nothing).
- **No cascade:** in that scenario A (and any other artifact that only referenced
  B) is committed intact except for the single pruned reference; nothing healthy
  is dropped.
- **Self-heal:** fix B's root cause and re-run; A replays from cache with its join
  intact, B succeeds, and the final tree commits both fully linked with no prune.
- **Intrinsic drop:** a source that fails its own warehouse dry-run at the final
  gate (forced) is dropped, refs to it are pruned, and the rest commits; the drop
  is reported.
- **Repair is gone:** `repairFinalGateFailure` and its tests no longer exist; the
  gate path has no LLM call.
- **One store:** scan and ingest both resume through the same content-keyed
  primitive (one implementation; scan's behavior is unchanged by the migration —
  spec 19/20 acceptance still passes).
- **Clean-run regression:** a small uninterrupted all-passing ingest yields
  identical artifacts, `commitSha`, and report (empty pruned/dropped fields) to
  today.

## Non-goals

- **Resuming the cross-WU stages.** Reconciliation, finalization, and the final
  gate re-run every time; their inputs depend on the full survivor set and their
  cost is small relative to WU generation. Only WU generation is cached.
- **A `--resume` flag or any timeout/cache config knob.** Content-keying makes
  resume automatic (D1); one opinionated default is the canonical ktx shape.
- **Caching failed WUs as terminal.** Failures retry (D4).
- **Node-cascade quarantine of the final gate.** Prune edges, do not drop
  dependents (D5). No closure search, confirm-loop-over-nodes, or un-apply step.
- **Tolerating dangling references (warn instead of remove).** Unsafe — the SL
  engine eagerly rejects orphan joins — so dead edges must be removed, not kept.
- **Keeping the LLM final-gate repair.** Removed (D5/req 9).
- **A general per-stage resume framework beyond the shared content-keyed store.**
  The store is the one shared primitive (D3); this spec does not abstract every
  ingest stage into a resumable framework.
- **Re-implementing spec 19/20 (scan durability).** This spec composes the same
  primitive onto the source-ingest WU pipeline.

## Implementation orientation

Line numbers drift; treat these as anchors, not addresses. The implementer owns
the design.

- **Run flow + the all-or-nothing seam** — `context/ingest/ingest-bundle.runner.ts`:
  WU run + integration of successful patches (~1600–1900), the final-gate block
  (~2549–2587, `runFinalArtifactGates`), the repair-then-rethrow that must be
  replaced by prune (~2588–2644; the fatal `throw` ~2623), and the atomic squash
  (~2701–2729; `commitSha: null` when nothing is touched ~2729). The prune step
  slots between the gate findings and the squash, operating on `sessionWorktree`.
- **Work units & cacheable output** — `context/ingest/types.ts` (`WorkUnit`
  ~19–28: `rawFiles`/`peerFileIndex`/`dependencyPaths`; `IngestBundleResult`
  ~204–213: extend with pruned/dropped detail);
  `context/ingest/stages/stage-3-work-units.ts` (`executeWorkUnit`; the per-WU
  validation + `failWithReset` ~134–157 that already soft-fails a WU;
  `WorkUnitOutcome` ~31–46 with `patchPath`/`patchTouchedPaths`/`actions`/
  `touchedSlSources` — the cache payload). The cache lookup/replay wraps the
  per-WU execution; only the agent-loop branch is skipped on a hit.
- **The gate (make it return findings)** — `context/ingest/artifact-gates.ts`
  (`validateFinalIngestArtifacts` ~96; the internal per-artifact danglers from
  `validateWikiSlRefs` ~39, `validateWikiRefs` ~74, `findInvalidWikiBodyRefs`;
  the concatenated `throw` ~129 to replace with a structured return);
  `context/ingest/stages/validate-wu-sources.ts` (`validateWuTouchedSources` ~124;
  `findJoinTargetErrors` ~89 already returns missing join targets per source —
  the join-edge danglers to prune); `context/sl/tools/sl-warehouse-validation.ts`
  (`validateSingleSource` ~56 — the intrinsic warehouse dry-run; its failures are
  the drop set, not the prune set).
- **Per-ref-type pruners (pair 1:1 with the validators)** — join: remove the
  offending `joins[]` entry from the source YAML; `wiki refs`/`sl_refs`: remove
  the entry from page frontmatter (`context/wiki/wiki-ref-validation.ts`
  `findMissingWikiRefs`); wiki body refs: remove the broken link token
  (`context/ingest/wiki-body-refs.ts` `findInvalidWikiBodyRefs`). Each pruner is
  deterministic and edits the integrated worktree only.
- **Remove the LLM repair** — `context/ingest/final-gate-repair.ts`
  (`repairFinalGateFailure`) and the `constrained-repair.ts` usage for
  `final_artifact_gate`; delete the call site (~2595) and its tests.
- **Durability primitive to extract & share** —
  `context/scan/sqlite-local-enrichment-state-store.ts` (`local_scan_enrichment_stages`,
  PK `(connection_id, stage, input_hash)`, `findCompletedStage`/`saveCompletedStage`),
  `context/scan/enrichment-state.ts` (`computeKtxScanEnrichmentInputHash` ~78), and
  the resume wrapper `runEnrichmentStage` (`context/scan/local-enrichment.ts`).
  Generalize to a content-keyed result cache; migrate scan onto it; add the ingest
  namespace. The existing ingest store
  `context/ingest/sqlite-bundle-ingest-store.ts` (`SqliteBundleIngestStore`) is
  where ingest-side persistence lives — the WU cache sits alongside it under
  `.ktx/`.
- **Tests** — resume: run an ingest against a real git-backed project with a fake
  agent runner, interrupt after K WUs, assert the re-run issues no agent loops for
  the K and the same artifacts result; changed-input bust; stale-patch recompute;
  failed-WU retry. Prune: a fixture where one WU fails so a sibling's join/wiki
  ref dangles → assert the run commits the sibling with the ref pruned, reports the
  prune, and `commitSha` is non-null; assert no cascade; assert self-heal on a
  follow-up run; assert intrinsic drop. Migration: spec 19/20 scan acceptance still
  green on the shared primitive. Regression: a small uninterrupted all-passing
  ingest is byte-identical to today.
- After implementing, rebuild and re-link so the playground picks it up:
  `pnpm run build && pnpm run link:dev`.

## Motivation (the real report, not a benchmark)

A user ingesting a fairly large dbt project (~2-day run) hit both gaps together.
First, an interruption — a VPN drop / network blip — lost all progress because
ingest cannot resume; they had to restart from scratch. Second, on a later run
that completed all task generation, a **single model** failed the final
integration gate, and because the gate is all-or-nothing the one failure
discarded an ~18h run with nothing committed. Their ask: "some form of resume or
checkpoint (or at least reusing the patches that were already generated), and a
way to skip or quarantine a single failing model instead of failing the entire
run." This spec delivers both — resume via the content-keyed WU cache, and
partial commit via deterministic dangling-edge pruning. Unlike specs 19/20 this
gap was surfaced by a real user on a real warehouse, not by the benchmark; the
fix is generic production hygiene for any large ingest.

## Implementation notes

Shipped on branch `write-feature-spec-wiki` (squash-merge target). All 12
requirements and every acceptance criterion are covered by committed code and
tests; the full `@kaelio/ktx` package suite is green.

What was built and where:

- **Shared content-keyed durability primitive** — `context/cache/content-result-cache.ts`
  + `sqlite-content-result-cache.ts` (`SqliteContentResultCache`, `local_content_results`).
  Scan was migrated onto it in the same change (`context/scan/sqlite-local-enrichment-state-store.ts`
  is now a thin adapter; the old `local_scan_enrichment_stages` table is dropped),
  so no second copy exists (D3 / req 11).
- **Content-keyed WU cache + replay** — `context/ingest/work-unit-cache.ts`
  (`computeIngestWorkUnitInputHash` over raw/dependency bytes + source identity +
  CLI version + prompt fingerprint + model role; success-only `saveSuccessfulWorkUnitCache`).
  Replay/recompute and stale-recompute state refresh wrap the WU loop in
  `ingest-bundle.runner.ts` (D1/D2/D4 / reqs 1–4).
- **Non-fatal final gate** — `artifact-gates.ts` `validateFinalIngestArtifacts`
  returns structured findings; `context/ingest/final-gate-prune.ts` deterministically
  drops self-invalid sources and prunes dangling edges in a single pass, then a
  confirm gate runs before squash (D5/D6 / reqs 5–8). `finalGatePrunedReferences`
  / `finalGateDroppedSources` are recorded in the report + trace and surface as a
  `partial` outcome (D7 / req 10). `repairFinalGateFailure` and its tests are
  deleted (req 9).

Deviations / decisions worth noting (all preserve spec intent):

- **Cache stores artifact content snapshots (payload schema v2), not just a raw
  git patch.** Replay materializes the owner's artifacts against the *current*
  base, so a ref pruned in one run because a sibling failed is restored for free
  on a later run once the sibling exists — without re-running the owner's agent
  loop (D2/D6 / req 7 self-heal). A drifted/stale snapshot degrades to recompute.
- **Final-gate prune/drop resolves sources through the canonical
  `resolveSlSourceFile` resolver**, not a derived `semantic-layer/<conn>/<name>.yaml`
  path, so it works for uppercase / hash-derived source filenames (not only
  lowercase demo names).
- **`executeWorkUnit` defers pruneable cross-artifact findings** (missing join
  target / wiki ref / sl_ref) to the final gate instead of soft-failing the WU;
  only intrinsic `source_validation` failures remain fatal at the WU level. This
  is what lets a sibling-failed WU's owner survive to be pruned rather than be
  excluded upstream (reqs 5–7, "no cascade").
- The raw report record keeps `status: 'completed'`; partial completion is derived
  by `ingestReportOutcome` from the populated prune/drop fields.
