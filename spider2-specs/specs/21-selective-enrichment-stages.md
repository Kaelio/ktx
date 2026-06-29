# Selective enrichment stages (`--stages`) + per-stage cache keys

> Refined spec. Intake draft: `todo/21-selective-enrichment-stages.md`.
>
> **Scope: make the three enrichment stages independently invalidatable and
> independently re-runnable.** Today one coarse cache key gates all three stages,
> so changing any one stage's inputs re-pays for every stage — most painfully the
> expensive per-table `descriptions`. And there is no CLI surface to re-run a
> chosen subset. This spec splits the key per stage (so a change invalidates only
> the stage it touched) and adds a `--stages` flag that force-re-runs a chosen
> subset while preserving the others. It is the operability follow-on to spec 19
> (durable, cross-run stage resume) and spec 20 (resilient, per-table-resumable
> descriptions); it composes with both rather than replacing them.

## Problem

Enrichment has three stages — **`descriptions`** (one paid LLM call per table),
**`embeddings`** (sentence-transformer vectors over the schema + descriptions),
**`relationships`** (FK/join detection, optionally LLM-proposed). After specs 19
and 20 these stages are durable and resumable, but they are still **coupled for
cache invalidation and unreachable for selective re-run**. Three facts make a
targeted re-run impossible without a full, expensive re-enrich.

### 1. One coarse cache key gates all three stages

`runLocalScanEnrichment` (`context/scan/local-enrichment.ts:611`) computes a single
`inputHash` from `{ snapshot, mode, detectRelationships, providerIdentity,
relationshipSettings }` and every stage reuses it — `descriptions` (~`:642`),
`embeddings` (~`:673`), `relationships` (~`:729`). `providerIdentity` itself
(`localScanProviderIdentity`, `local-scan.ts:241–255`) is one blob conflating the
description LLM identity, the embedding model/dimensions/batch size, **and** the
whole relationship config — and it redundantly re-encodes `mode` and
`relationships`, which the coarse hash already mixes in.

The consequence: flipping `scan.relationships.llmProposals`, switching the LLM
backend, or upgrading the embeddings model changes the **one** hash and so
invalidates **all three** stages. ktx then re-runs the expensive per-table
`descriptions` even though they did not conceptually change. The headline cost of
the system — paid LLM description calls — is thrown away on any unrelated
enrichment-config edit.

### 2. No CLI surface to select stages

The enrichment internals already support a relationships-only path
(`KtxScanMode` `'relationships'`, `types.ts:12` — `descriptions`/`embeddings` are
gated on `mode === 'enriched'` at `local-enrichment.ts:632`, while
`shouldDetectRelationships` admits `mode === 'relationships'` at `:624–626`). But
`ktx ingest` hardcodes `mode: 'enriched'` (`public-ingest.ts:973`) and exposes no
flag to select a subset (`ingest-commands.ts:26–49` — only `--no-query-history`
and friends). The relationships-only capability is built but unreachable, and there
is no way at all to ask for "descriptions only" or "embeddings only."

### 3. The foundation for "touch one stage, keep the rest" already exists

The per-stage store `local_scan_enrichment_stages` is keyed
`(connection_id, stage, input_hash)` (spec 19) and the descriptions write is
additive — `mergeDescriptionsPreservingExternal` (`manifest.ts`) and
`loadExistingManifestState` (`local-enrichment-artifacts.ts`) preserve prior `ai:`,
`db:`, and external description keys on rewrite; spec 20's per-table resume record
(`createKtxScanDescriptionResumeStore`, `local-enrichment-artifacts.ts:286`) already
re-issues LLM calls only for the still-failed tables. So "recompute one stage, leave
the others byte-for-byte" needs only two missing pieces: **per-stage key
granularity** and a **CLI surface** to select stages.

**Requirement:** let an operator re-run a chosen subset of enrichment stages on an
already-ingested connection, recomputing only those stages, preserving the others'
artifacts untouched, and **re-paying only for what genuinely changed** — never
re-running the costly `descriptions` because an unrelated stage's inputs moved.

## Generic use case (independent of any benchmark)

Any team running ktx in production maintains its semantic layer over time: they
improve the description prompt or switch the description LLM, upgrade the embeddings
model, or turn on LLM-proposed joins. Today each of those forces a **full re-enrich
of every connection** — re-running the expensive per-table descriptions even when
only embeddings or relationships changed. Two routine operations should be cheap and
targeted:

- **"Re-embed everything on the new model."** Swapping the embeddings model should
  recompute only embeddings, leaving descriptions and joins on disk.
- **"Backfill joins now that `llmProposals` is on."** Enabling LLM-proposed
  relationships should recompute only relationships.

And one operation needs an explicit trigger because no input changed:

- **"These descriptions came out thin — re-run them with a longer timeout."** A
  connection whose description coverage is poor because tables timed out (same
  snapshot, same LLM, so the hash is unchanged) should be re-runnable on demand,
  cheaply retrying only the tables that failed.

This is core operability for a long-lived ingestion product and is wholly
independent of any benchmark.

## Design decisions (resolved during refinement)

These resolve ambiguities the intake draft left open. They constrain the
implementer; the exact code is theirs (requirement-level, per the specs README).

### D1 — Split the coarse hash into three per-stage input hashes

Replace the single `computeKtxScanEnrichmentInputHash` call with **per-stage** hash
computation, each keyed on only that stage's own inputs. Decompose the
`localScanProviderIdentity` blob into the slices each stage actually depends on:

- **`descriptions`** → `{ snapshot, llmIdentity }`, where `llmIdentity` is the
  description-LLM identity (`llm.models.default`, `baseUrlConfigured`). **Not** the
  embedding model/dimensions/batch size, **not** relationship settings.
- **`embeddings`** → `{ snapshot, embeddingIdentity, descriptionDigest }`, where
  `embeddingIdentity` is `{ model, dimensions, batchSize }` and `descriptionDigest`
  is a stable digest of the resolved description text the embeddings consume (the
  same text `buildEmbeddings` → `buildKtxColumnEmbeddingText` feeds the model,
  `local-enrichment.ts:466–486`, `embedding-text.ts:17–44`). This content-addresses
  embeddings on their real upstream (D4).
- **`relationships`** → `{ snapshot, relationshipSettings (incl. `llmProposals` and
  `detectionBudgetMs`), llmIdentity }`. **Not** the description content (decision X,
  D5), **not** the embedding identity.

`mode` and `detectRelationships` drop out of the per-stage inputs: each stage
produces output under exactly one mode, so the stage name already scopes that, and
re-mixing `mode` only re-couples the keys. After the split, flipping `llmProposals`
invalidates only `relationships`; swapping the embeddings model invalidates only
`embeddings`; switching the description LLM invalidates only `descriptions`.

The per-stage hash becomes the key everywhere a single hash is used today: the
`local_scan_enrichment_stages` lookup/save in `runEnrichmentStage`, and the spec-20
descriptions resume record (`createKtxScanDescriptionResumeStore`), which is now
keyed on the **descriptions** stage's hash — so changing the embedding model no
longer busts the descriptions resume record, a strict improvement.

> **No migration bridge.** The stage store and the descriptions resume record are
> disposable local `.ktx` state (regenerable from a fresh ingest). The new per-stage
> keys simply miss the old coarse-keyed rows, forcing one full re-enrich on the next
> run after upgrade. Recreate/ignore stale-shaped records with no compatibility
> shim, consistent with specs 19/20 and ktx's no-backward-compatibility policy.

### D2 — `--stages <comma-list>` selects a subset; one gate, no new mode

Add `ktx ingest [connectionId] --stages <comma-list>`, a non-empty subset of
`descriptions,embeddings,relationships`. Plural because it takes a **set**:
`--stages relationships` and `--stages descriptions,embeddings` both read naturally,
and the plural signals "list expected." Flag absent = all three (today's behavior).

A Commander custom parser validates each name against the canonical stage registry
and parses into an ordered, de-duplicated set. **An unknown or empty stage name is a
hard `InvalidArgumentError`** — never silently ignored. The set threads CLI →
`runKtxPublicIngest` (`KtxScanArgs`) → `runLocalScan` → `runLocalScanEnrichment`.

Inside enrichment the run set is **`(mode/provider-eligible stages) ∩ (selected
stages)`** — a single gate. Each existing stage block additionally checks
membership in the selected set (`descriptions`/`embeddings` already gate on
`mode === 'enriched'` + providers; `relationships` on `shouldDetectRelationships`).
This adds **no** new `KtxScanMode` variant and **no** second parallel selection
path; `mode` keeps meaning "the connection's enrichment level," and `--stages` means
"which of those stages to (re)compute this run." A named stage that cannot run
because a prerequisite is absent (e.g. `--stages embeddings` with no embedding
provider configured) MUST fail or warn clearly, never silently no-op.

> Rejected alternative — repurpose `mode` (`--stages relationships` →
> `mode: 'relationships'`). It only expresses single-stage cases, leaves
> `descriptions,embeddings` with no mode, and creates two ways to say "relationships
> only." The explicit stage set is the one canonical selector.

### D3 — A named stage force-re-runs; per-table resume still avoids re-paying

Naming a stage in `--stages` carries the intent "recompute this," so a named stage
**re-enters its `compute()`, bypassing the spec-19 completed-row short-circuit** in
`runEnrichmentStage` (`local-enrichment.ts:538–547`). The spec-20 machinery still
applies **inside** `compute()`:

- `--stages descriptions` re-enters `generateDescriptions`, which loads the
  per-table resume record and re-issues LLM calls **only for the still-null/failed
  tables** (when the descriptions hash is unchanged) — the "fill thin coverage with
  a longer `KTX_ENRICH_LLM_TIMEOUT_MS`" case, paying only for the gaps.
- A genuine input change (e.g. switching the LLM → a new descriptions hash)
  invalidates the resume record and rebuilds the stage fully, as today.

Stages **not** named are skipped entirely — not run, not resumed — and their
on-disk artifacts are left exactly as they are (additive write; preserve-others is
already the behavior). The **no-flag default is unchanged**: all eligible stages
run, the completed-row short-circuit is respected (spec-19 cross-run resume).

Behavior follows from the input (did you explicitly name the stage?), not the call
path. A consequence to state plainly: `--stages descriptions,embeddings,relationships`
is **not** identical to passing no flag — naming all three is the explicit "force a
full enrichment recompute," whereas no flag is "ingest, resuming whatever is done."

### D4 — Downstream staleness: one real edge, content-addressed, surfaced not silent

The only hard dependency between stages is **`descriptions → embeddings`**
(embeddings embed the description text; `relationships` is decoupled, D5). Two
mechanisms keep it correct without a hardcoded dependency table:

- **Self-healing via content-addressing.** Because the embeddings hash includes
  `descriptionDigest` (D1), re-running `descriptions` changes that digest, so a
  later embeddings run (or a full ingest) sees a hash miss and recomputes — stale
  embeddings can never silently persist across a future embeddings run. (Without
  this, the embeddings hash would be unchanged after a description edit and a later
  run would wrongly short-circuit on stale vectors.)
- **Surfaced immediately.** After a selective run, for each **unselected** stage that
  has artifacts on disk, recompute its *current* per-stage hash from on-disk state
  and compare it to the stored completed-row hash; if they differ, emit a
  **recoverable `enrichment_stage_stale` warning** naming the stale stage and the
  cascade command (e.g. `--stages descriptions,embeddings`). This is derived from the
  system's own state — it also catches "you changed the embedding model in `ktx.yaml`
  but only ran `--stages descriptions`."

The run **never silently leaves a stale-but-unflagged downstream**, and **never
silently auto-cascades** extra work — the operator is told and decides. Re-running
`descriptions` does **not** flag `relationships` stale (D5).

### D5 — Relationships are decoupled from description content, but still get it as context

`relationships` keys on `{ snapshot, relationshipSettings, llmIdentity }` and is
**not** invalidated or stale-flagged by a description change (decision X). Rationale:
relationships are the low-value, best-effort, expensive-to-probe stage (spec 19's
own framing); coupling them to description content would make every routine
description re-run also invalidate joins — re-opening the exact over-invalidation
this spec exists to close.

Independently, a `relationships`-only run (descriptions stage not running this
invocation) MUST **hydrate its working schema from the persisted on-disk enriched
`_schema`** (AI descriptions + embeddings) so `llmProposals` runs with full
description context, not raw column names. Today the relationship stage builds its
schema from the bare snapshot (db comments only — `local-enrichment.ts:621,688,740`
never merge the AI descriptions), so this also closes a latent gap: both the
full-run and the relationships-only paths MUST feed `llmProposals` the
best-available descriptions (fresh-this-run if `descriptions` ran, else on-disk) —
behavior from inputs, not path.

### D6 — Scope: enrichment stages only, composable with existing flags

`--stages` controls only the three enrichment stages. It is **orthogonal to and
composable with** the existing `--no-query-history` flag — a pure joins backfill
across everything is `ktx ingest --all --stages relationships --no-query-history`.
Schema introspection still runs (it is the hash substrate and the enrichment base,
and it is cheap — no LLM). The stage-name namespace is built as a **registry** so it
can later extend to the broader scan phases (schema / query-history / source /
memory) and subsume the inconsistent negative `--no-query-history` flag — but that
unification is **out of scope** here.

## Requirements

### 1. Per-stage input hashes

Each enrichment stage MUST key its cache lookup/save and (for `descriptions`) its
resume record on a hash of only that stage's own inputs, per D1
(`descriptions` ← snapshot + LLM identity; `embeddings` ← snapshot + embedding
identity + a digest of the embedded description text; `relationships` ← snapshot +
relationship settings + LLM identity). Changing one stage's inputs MUST invalidate
**only** that stage. The single coarse `computeKtxScanEnrichmentInputHash` over
`{ snapshot, mode, detectRelationships, providerIdentity, relationshipSettings }`
MUST be removed in favor of per-stage computation. The stage store and the
descriptions resume record MAY be recreated without a migration bridge (disposable
local state).

### 2. `--stages` flag with strict validation

`ktx ingest` MUST accept `--stages <comma-list>`, a non-empty subset of
`descriptions,embeddings,relationships`, defaulting (when absent) to all three. An
unknown or empty stage name MUST be a hard parse error (`InvalidArgumentError`),
never silently ignored. The selected set MUST thread through to enrichment and gate
which stage blocks run as `(mode/provider-eligible) ∩ (selected)` — one gate, no new
`KtxScanMode` variant, no second selection path. A selected stage whose prerequisite
is missing MUST fail or warn clearly, not silently no-op.

### 3. Selecting a stage force-re-runs it; unselected stages are preserved

A stage named in `--stages` MUST re-enter its `compute()`, bypassing the
completed-stage short-circuit, while still using the spec-20 per-table resume record
so `descriptions` re-issues LLM calls only for still-failed tables (unchanged hash)
and rebuilds fully on a changed hash. A stage **not** named MUST NOT run and MUST
leave its on-disk artifacts untouched. The no-flag default MUST preserve spec-19
cross-run resume (all eligible stages, completed-row short-circuit respected).

### 4. Downstream staleness is surfaced, never silent

After a selective run, the run MUST emit a recoverable `enrichment_stage_stale`
warning for every **unselected** stage whose current per-stage hash no longer
matches its stored completed-row hash (derived from on-disk state, naming the stage
and the cascade command). The embeddings hash MUST include a digest of the embedded
description text so a later embeddings run self-heals after a description change. The
run MUST NOT silently leave a stale-but-unflagged downstream and MUST NOT silently
auto-cascade. A description change MUST NOT stale-flag `relationships`.

### 5. Relationships run with description context

When the `relationships` stage runs without `descriptions` having run in the same
invocation, it MUST hydrate its working schema from the persisted on-disk enriched
`_schema` (AI descriptions + embeddings) so `llmProposals` has the same description
context as a full enriched run, not bare column names. The full-run and
relationships-only paths MUST feed `llmProposals` descriptions consistently.

### 6. No regression for normal ingests

A normal `ktx ingest` with no `--stages` flag MUST produce the same artifacts as
today (descriptions, embeddings, manifest, relationships) and MUST preserve spec-19
cross-run resume and spec-20 per-table description resume. The per-stage hash split
MUST NOT change a normal run's output, only which stages a *changed* input
invalidates.

## Acceptance criteria

- **Per-stage invalidation isolation:** flipping `scan.relationships.llmProposals`
  re-runs only `relationships` (descriptions + embeddings resolve from cache, no LLM
  description calls, no re-embedding); swapping the embeddings model re-runs only
  `embeddings`; switching the description LLM re-runs only `descriptions`. Verified by
  asserting no LLM description calls / no embed calls for the unaffected stages.
- **Flag parse + validation:** `--stages relationships` and
  `--stages descriptions,embeddings` parse to the right set; `--stages foo`,
  `--stages` (empty), and `--stages descriptions,foo` each fail with a clear
  `InvalidArgumentError`.
- **Resume-aware force-rerun:** on a connection whose `descriptions` stage completed
  with K failed/null tables (unchanged hash), `--stages descriptions` re-issues LLM
  calls for exactly those K tables and leaves the already-good descriptions
  untouched; the run completes and the K are now enriched. A changed descriptions
  hash instead rebuilds all tables.
- **Preserve others:** after `--stages descriptions`, the on-disk `embeddings` and
  `relationships` artifacts are byte-stable (unselected stages did not run).
- **Derived staleness warning:** after `--stages descriptions` changes the
  descriptions, the run emits `enrichment_stage_stale` for `embeddings` (its
  recomputed hash diverged) and does **not** emit it for `relationships` (decision
  X); a subsequent `--stages embeddings` clears it.
- **Relationships context:** a `--stages relationships` run on an already-described
  connection feeds the on-disk AI descriptions into `llmProposals` (verified: the
  proposal prompt carries descriptions, not just column names).
- **No regression:** a normal uninterrupted `ktx ingest` (no flag) yields identical
  artifacts and the same descriptions/embeddings/relationship output as today, with
  spec-19/20 resume intact.

## Non-goals

- **Unifying `--stages` with the broader scan phases or `--no-query-history`.** The
  namespace is built to extend later; this spec ships only the three enrichment
  stages, composable with the existing query-history flag (D6).
- **A new `KtxScanMode` variant or a second stage-selection path.** One gate,
  `(eligible) ∩ (selected)` (D2).
- **Coupling `relationships` to description content** (decision X, D5). Improving
  descriptions does not invalidate or stale-flag joins.
- **Auto-cascading downstream re-runs.** Staleness is surfaced as a warning; the
  operator chooses to cascade (D4).
- **Capturing prompt/code-level description-prompt changes in the hash.** The
  descriptions hash keys on snapshot + LLM identity (config/model), not the prompt
  text; a pure prompt improvement that does not change a hash input will not
  force-rebuild already-good descriptions. Forcing that is out of scope — the
  operator changes a real input or selects the stage with a changed config.
- **Re-implementing spec 19 (cross-run stage resume, completed-row store) or spec 20
  (per-table description resume, enforced timeout).** This spec composes above them:
  it splits the key those stages resume on and adds the CLI surface to select and
  force-re-run stages.
- **A general per-phase incremental-flush framework.** The selection mechanism is the
  three enrichment stages; it is not a generic abstraction over every ingest phase.

## Implementation orientation

Line numbers drift; treat these as anchors, not addresses. The implementer owns the
design.

- **Coarse hash → per-stage hashes** — `context/scan/enrichment-state.ts`
  (`computeKtxScanEnrichmentInputHash` `:78`, `ComputeKtxScanEnrichmentInputHashInput`
  `:57`): replace with per-stage hash functions (or one function taking a per-stage
  input slice). `context/scan/local-enrichment.ts` (`:611` single hash; the three
  `runEnrichmentStage` calls at `descriptions` ~`:635`, `embeddings` ~`:666`,
  `relationships` ~`:722`; `runEnrichmentStage` `:524` and its short-circuit
  `:538–547`). The `descriptions` hash also feeds `generateDescriptions`'
  `resumeStore.load(inputHash)` (`:345`).
- **Provider-identity decomposition** — `context/scan/local-scan.ts`
  (`localScanProviderIdentity` `:241–255`, the enrichment call site `:498–537`):
  split into `llmIdentity` / `embeddingIdentity`, drop the redundant `mode` /
  `relationships` re-encoding, and pass each stage only its slice.
- **`descriptionDigest`** — `context/scan/local-enrichment.ts` (`buildEmbeddings`
  `:457–486`) and `context/scan/embedding-text.ts` (`buildKtxColumnEmbeddingText`
  `:17–44`): digest the resolved per-column/table description text that the embeddings
  consume, and fold that digest into the embeddings hash.
- **CLI flag** — `commands/ingest-commands.ts` (`:26–49` option declarations,
  `:51–104` action handler): add `--stages` with a custom parser that validates
  against the canonical stage registry (`KTX_SCAN_ENRICHMENT_STAGES` in
  `enrichment-state.ts:4`) and rejects unknown/empty names with `InvalidArgumentError`.
  Thread through `public-ingest.ts` (`KtxScanArgs` build `:969–978`, `mode: 'enriched'`
  `:973`) → `scan.ts` (`runKtxScan`) → `local-scan.ts` (`runLocalScan`) →
  `runLocalScanEnrichment`.
- **Stage gating + force-rerun** — `context/scan/local-enrichment.ts`: gate each stage
  block on membership in the selected set (`descriptions` `:632`, `embeddings`
  `:663–665`, `relationships` `:720`); make a named stage bypass the completed-row
  short-circuit in `runEnrichmentStage` while the inner `compute()` keeps the spec-20
  per-table resume. `KtxLocalScanEnrichmentInput` (`:60–85`) gains the selected-stage
  set.
- **Staleness detection + warning** — `context/scan/local-enrichment.ts` (after the
  stage blocks): recompute each unselected stage's current hash from on-disk state,
  compare to the stored completed-row hash, push a recoverable warning on mismatch.
  Add `enrichment_stage_stale` to the `KtxScanWarningCode` union in
  `context/scan/types.ts` (alongside `relationship_detection_partial`).
- **Relationships description context** — `context/scan/local-enrichment.ts`
  (`schema` built at `:621`/`:688`, passed to `discoverKtxRelationships` `:736–746`):
  hydrate `schema` with the best-available descriptions (fresh-this-run or loaded from
  the on-disk `_schema` via `loadExistingManifestState`,
  `local-enrichment-artifacts.ts`) before relationship detection.
- **Stage store + resume record** —
  `context/scan/sqlite-local-enrichment-state-store.ts`
  (`local_scan_enrichment_stages`, PK `(connection_id, stage, input_hash)`,
  `findCompletedStage`, `saveCompletedStage`); `createKtxScanDescriptionResumeStore`
  (`local-enrichment-artifacts.ts:286–332`, path `:265–267`, inputHash gate
  `:305–307`) — both now keyed on the relevant per-stage hash. No migration bridge.
- **Config inputs** — `context/project/config.ts` (`scanRelationshipsSchema`
  `:171–218` incl. `llmProposals` `:174` and `detectionBudgetMs`;
  `scan.enrichment.embeddings` model/dimensions/batchSize; `llm.models.default`,
  `llm.provider.gateway.base_url`): the sources of each per-stage identity slice.
- **Tests** — per-stage invalidation isolation (flip one input, assert only the
  matching stage recomputes); `--stages` parse/validate (good subsets + unknown/empty
  rejected); resume-aware force-rerun (`--stages descriptions` retries only the null
  tables, leaves good ones, completes); preserve-others (unselected artifacts
  byte-stable); derived staleness (`enrichment_stage_stale` fires for embeddings after
  a descriptions change, not for relationships; cleared by a later `--stages
  embeddings`); relationships-only run feeds on-disk descriptions to `llmProposals`;
  regression — a normal no-flag ingest yields identical artifacts with spec-19/20
  resume intact.
- After implementing, rebuild and re-link so the playground picks it up:
  `pnpm run build && pnpm run link:dev`.
- **Docs:** add `--stages` to the `ktx ingest` CLI reference
  (`docs-site/content/docs/cli-reference/`) and note the per-stage cache behavior
  where enrichment/ingest is described.

## Benchmark context (motivation, not a requirement)

Surfaced during the Spider 2.0-Lite multi-backend ingestion (2026-06-24). A
level-aware audit found (a) a tail of BigQuery datasets with poor *column*-description
coverage (`google_dei` ~1%, `gnomAD`, `usfs_fia`, …) that want a **`descriptions`-only**
re-run with a longer timeout, and (b) a desire to **backfill joins** across all
already-ingested datasets after enabling `llmProposals` — without re-paying for
descriptions. Both were blocked by the coarse single `inputHash` (flipping
`llmProposals` or re-describing invalidated the whole enrichment) and the absence of a
stage-selective CLI flag. The benchmark merely exercised large-scale multi-backend
ingestion at scale; the gap and the fix are generic production operability. Do not
encode any benchmark specifics in the implementation.

## Implementation notes

Shipped on branch `write-feature-spec-wiki`. All seven requirements implemented;
all acceptance criteria covered by tests.

**What was built / where:**

- **Per-stage hashes (D1, Req 1).** `context/scan/enrichment-state.ts`: removed the
  coarse `computeKtxScanEnrichmentInputHash` and added
  `computeKtxDescriptionsStageHash` (snapshot + `llmIdentity`),
  `computeKtxEmbeddingsStageHash` (snapshot + `embeddingIdentity` + `descriptionDigest`),
  `computeKtxRelationshipsStageHash` (snapshot + `relationshipSettings` + `llmIdentity`),
  plus `computeKtxScanDescriptionDigest` and the `KtxScanLlmIdentity` /
  `KtxScanEmbeddingIdentity` types. `KTX_SCAN_ENRICHMENT_STAGES` is now exported as the
  canonical registry. `local-scan.ts` `localScanProviderIdentity` was split into
  `localScanLlmIdentity` + `localScanEmbeddingIdentity` (dropping the redundant
  `mode`/`relationships` re-encoding). `mode`/`detectRelationships` dropped out of the
  keys. No migration bridge — the stage store + descriptions resume record just miss the
  old coarse-keyed rows.
- **`descriptionDigest` (D1/D4).** `local-enrichment.ts`: extracted
  `buildKtxColumnEmbeddingTexts(snapshot, descriptions)`, shared by the embeddings stage
  and the digest, so the embeddings hash content-addresses the exact text the model sees.
- **`--stages` flag (D2/D6, Req 2).** `commands/ingest-commands.ts`:
  `parseEnrichmentStagesOption` (Commander parser) validates against the registry,
  rejects unknown/empty with `InvalidArgumentError`, returns an ordered de-duplicated
  set; threaded through `KtxPublicIngestArgs` → `context-build-view` → `KtxScanArgs` →
  `RunLocalScanOptions` → `KtxLocalScanEnrichmentInput`. One gate
  (`(eligible) ∩ (selected)`); no new `KtxScanMode`. A selected-but-ineligible stage
  emits a new `enrichment_stage_skipped` warning (never a silent no-op).
- **Force-rerun (D3, Req 3).** `runEnrichmentStage` gained `forceRecompute`; a named
  stage bypasses the spec-19 completed-row short-circuit while `generateDescriptions`
  still consults the spec-20 per-table resume record (retries only failed tables on an
  unchanged hash).
- **Descriptions hydration + `llmProposals` context (D5, Req 5).** `runLocalScanEnrichment`
  resolves best-available descriptions (fresh-this-run, else on-disk via a lazy
  `loadPriorDescriptions` thunk wired from `local-scan.ts` →
  `loadOnDiskDescriptionUpdates` in `local-enrichment-artifacts.ts`). `snapshotToKtxEnrichedSchema`
  now merges `ai` descriptions, and `relationship-llm-proposal.ts` `buildEvidencePacket`
  now carries the resolved description text — closing the latent gap on **both** the
  full-run and relationships-only paths.
- **Derived staleness (D4, Req 4).** `enrichment_stage_stale` warning code +
  `findLatestCompletedStage` on the state store (interface + sqlite + test store). After a
  selective run, each unselected stage with a completed row is compared against its
  freshly recomputed hash; a mismatch warns and names the cascade command. Relationships
  are never flagged by a description change (decoupled per D5).
- **Docs.** `docs-site/content/docs/cli-reference/ktx-ingest.mdx`: `--stages` flag row, a
  "Selecting enrichment stages" section (per-stage cache, force-rerun, staleness), and
  examples.

**Deviation from the spec — embeddings hydration is descriptions-only.** D5 states a
relationships-only run should hydrate "AI descriptions **and** embeddings" from the
on-disk `_schema`. Investigation found the `_schema` manifest shards store only
descriptions; embedding vectors are written to a **syncId-scoped** `enrichment/embeddings.json`
that no code reads back, and each run mints a fresh syncId — so there is no durable
per-connection embeddings artifact to hydrate from. A relationships-only run therefore
hydrates **descriptions** (required for, and verified against, the `llmProposals`
acceptance criterion) but **not** embeddings. Consequence: a `--stages relationships`
backfill gets deterministic + name-based + LLM-proposed candidates (the point of
`llmProposals`), but not the embedding-similarity candidates a full run would add.
Durable embeddings hydration (persist vectors at a stable per-connection path, or read
them from the vector index) is a clean follow-on and was left out of scope.

**Tests:** `enrichment-state.test.ts` (per-stage hash stability + isolation),
`commands/ingest-commands.test.ts` (parser good/bad subsets, threading, text-capture
guard), `local-enrichment.test.ts` (force-rerun bypasses short-circuit + preserves
others, naming all three forces a full recompute, per-stage invalidation isolation,
prerequisite warning, on-disk descriptions reach `llmProposals`, resume-aware forced
descriptions rerun, derived `enrichment_stage_stale` fires for embeddings/not
relationships and clears after re-embed). Full `pnpm --filter @kaelio/ktx run test`,
`type-check`, `dead-code`, and `build` pass. (One pre-existing unrelated failure in
`test/skills/analytics-skill-content.test.ts` — the analytics `SKILL.md` lacks a
`**Window functions**` heading the test expects — was present before this work and left
untouched.)

---

## ⚠️ Defect found in post-implementation validation (2026-06-24)

**`--stages` subset excluding `descriptions` WIPES existing on-disk descriptions.** Violates Req
"preserve-others / a selective run never deletes another stage's artifacts."

**Reproduction (deterministic):**
- `northwind` before: 110 `ai:` column/table descriptions, 0 join edges.
- `ktx-dev ingest northwind --stages relationships` → completes in ~35s, adds **22 join edges** ✅
  but the rewritten `public.yaml` has **0 descriptions** (no `ai:`, no `db:`, columns bare). ❌
- A full `ktx-dev ingest northwind` (all stages) restores 110 descriptions + keeps the 22 joins.

**Likely root cause:** the relationships-only path rewrites the schema from the raw snapshot + only the
freshly-run stage. The implementation notes claim `snapshotToKtxEnrichedSchema` merges `ai` descriptions
and that descriptions are hydrated "fresh-this-run, else on-disk via `loadPriorDescriptions`" — but on the
**write path** of a subset run the prior descriptions are NOT merged into the emitted schema (they reach
the `llmProposals` evidence packet only). So the on-disk `_schema` loses them.

**Impact:** blocks the intended joins-everywhere backfill (`--stages relationships` across all dbs) and the
`--stages descriptions`-only re-runs — either would destroy the unselected stage's artifacts across every
db. Caught on a 1-db validation before any rollout.

**Acceptance fix:** after any `--stages` subset, the on-disk `_schema` must **retain all prior `ai:`/`db:`
descriptions** (and prior joins when descriptions-only) for stages not named — only the named stages'
artifacts change. Add a regression test that ingests a fully-enriched fixture, runs `--stages relationships`,
and asserts description count is unchanged while joins increase.

### ✅ Fixed (2026-06-24)

**Real root cause (deeper than the first diagnosis):** the wipe happened in **two** places, and the first
fix attempt only addressed one. `runLocalScan` (`context/scan/local-scan.ts`) writes the **structural**
manifest shard from the bare snapshot *before* enrichment runs; that write merges with the on-disk shard,
but the merge (`mergeDescriptionsPreservingExternal`, `live-database/manifest.ts`) treats `ai`/`db` as
**scan-managed** and overwrites them with whatever the run emits — and the structural write emits none. So a
subset run deleted the descriptions on the structural pre-write, *then* `runLocalScanEnrichment` read the
already-wiped shard via `loadPriorDescriptions` and had nothing to restore. (A unit-level enrichment test
passed because it never exercised the structural pre-write — a divergent-harness miss; the regression test
was rewritten to go through the full `runLocalScan` path.)

**What changed:**
- `runLocalScanEnrichment` (`local-enrichment.ts`) now returns the **best-available** descriptions
  (`resolveDownstreamDescriptions()` — fresh-this-run if `descriptions` ran, else the on-disk ones) as
  `descriptionUpdates`, instead of `[]` when the stage is skipped — so the enrichment write re-applies them.
- `runLocalScan` (`local-scan.ts`) now, on a subset run, **captures the prior on-disk descriptions before
  the structural manifest write** and feeds them to both the structural write and enrichment — so the
  structural pre-write preserves them too (robust even if relationship detection later fails).
- Joins were already preserved for `--stages descriptions` via the existing manual/inferred
  `preservedJoins` path; verified by a symmetric test.

**Tests:** `local-scan.test.ts` — a full `runLocalScan` `--stages relationships` run preserves on-disk `ai`
descriptions while adding a join (RED without the fix, GREEN with it). `local-enrichment.test.ts` — the
enrichment-layer contract (`--stages relationships` preserves descriptions / `--stages descriptions`
preserves joins).

**Live validation (northwind, 15 tables):** `--stages relationships` BEFORE `ai:110 joins:22` → AFTER
`ai:110 joins:22` (descriptions intact; previously wiped to 0). `--stages descriptions` restored the
descriptions from the spec-20 resume record (`ai:0 → ai:110`) with **no** LLM calls while keeping `joins:22`.
Full `pnpm --filter @kaelio/ktx run test` (3089 passed), `type-check`, `dead-code`, and `build` pass.
