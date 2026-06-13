import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { z } from 'zod';
import { type KtxLogger, noopLogger } from '../../context/core/config.js';
import type { KtxRuntimeToolSet } from '../../context/llm/runtime-port.js';
import { revertSourceToPreHead, type SlValidationDeps } from '../../context/sl/tools/sl-warehouse-validation.js';
import type { SemanticLayerSource } from '../../context/sl/types.js';
import type { SlValidatorPort } from '../../context/sl/sl-validator.port.js';
import { createTouchedSlSources, deleteTouchedSlSource, listTouchedSlSources, touchedSlSourceCount, touchedSlSourceNamesForConnection } from '../../context/tools/touched-sl-sources.js';
import { SYSTEM_GIT_AUTHOR } from '../../context/tools/authors.js';
import type { ToolContext } from '../../context/tools/base-tool.js';
import type { ToolSession } from '../../context/tools/tool-session.js';
import {
  buildRequiredSkillsBlock,
  DEFAULT_SKILL_NAMES,
  detectCaptureSignals,
  prefilterSkipReason,
  promptNameFor,
  stepBudgetFor,
} from './capture-signals.js';
import type {
  CaptureSession,
  MemoryAction,
  MemoryAgentInput,
  MemoryAgentResult,
  MemoryAgentServiceDeps,
  MemoryAgentSourceType,
} from './types.js';

type GateDeps = SlValidationDeps & { slValidator: SlValidatorPort<SlValidationDeps> };

export class MemoryAgentService {
  private readonly logger: KtxLogger;

  constructor(private readonly deps: MemoryAgentServiceDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  async ingest(input: MemoryAgentInput): Promise<MemoryAgentResult> {
    const chatId = input.chatId;
    const sourceType: MemoryAgentSourceType = input.sourceType ?? 'research';
    const empty: MemoryAgentResult = { signalDetected: false, actions: [], skillsLoaded: [], commitHash: null };

    const hasSL = !!input.connectionId;
    const userScopedEnabled = this.deps.settings.knowledge.userScopedKnowledgeEnabled;
    const forceGlobalScope = sourceType === 'external_ingest';

    const signals = detectCaptureSignals(input);

    const skipReason = prefilterSkipReason(input, signals);
    if (skipReason) {
      this.logger.debug(`[memory-agent] chat=${chatId} skipped (pre-filter: ${skipReason})`);
      return empty;
    }

    // Phase 1 — create a per-session git worktree branched at main's HEAD. This runs under
    // a brief `config:repo` lock so the baseSha snapshot is consistent with the branch
    // creation, but releases before the LLM loop starts. The unlocked loop is what lets
    // concurrent ingest() calls and interactive saves on main run in parallel.
    const sessionWorktree = await this.deps.lockingService.withLock('config:repo', async () => {
      const mainHead = await this.deps.gitService.revParseHead();
      if (!mainHead) {
        throw new Error('memory-agent: config repo has no HEAD');
      }
      return this.deps.sessionWorktreeService.create(chatId, mainHead);
    });

    const [wikiIndex, slIndex] = await Promise.all([
      this.buildWikiIndex(input.userId, userScopedEnabled),
      hasSL ? this.buildSlIndex(input.connectionId!) : Promise.resolve(''),
    ]);

    const skillsLoaded: string[] = [];
    const actions: MemoryAction[] = [];
    const session: CaptureSession = {
      userId: input.userId,
      chatId,
      userMessageId: input.userMessageId,
      userMessage: input.userMessage,
      connectionId: input.connectionId,
      userScopedEnabled,
      forceGlobalScope,
      touchedSlSources: createTouchedSlSources(),
      preHead: sessionWorktree.baseSha,
    };

    // Wire scoped services so the LLM loop's reads + writes both target the session
    // worktree, not main. Scoped wiki/SL services route their internal `configService`
    // to the worktree; sl-tools take an explicit `configService` and `gitService`.
    const scopedWikiService = this.deps.wikiService.forWorktree(sessionWorktree.workdir);
    const scopedSemanticLayerService = this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir);

    const toolSession: ToolSession = {
      connectionId: input.connectionId ?? null,
      isWorktreeScoped: true,
      preHead: sessionWorktree.baseSha,
      touchedSlSources: session.touchedSlSources,
      actions,
      semanticLayerService: scopedSemanticLayerService,
      wikiService: scopedWikiService,
      configService: sessionWorktree.config,
      gitService: sessionWorktree.git,
    };

    const toolset = hasSL
      ? this.deps.toolsetFactory.createIngestWuToolset(toolSession)
      : this.deps.toolsetFactory.createToolset(['wiki']);

    const toolContext: ToolContext = {
      sourceId: 'memory-agent',
      messageId: chatId,
      userId: input.userId,
      connectionId: input.connectionId,
      session: toolSession,
    };

    const loadSkillTool: KtxRuntimeToolSet = {
      load_skill: {
        name: 'load_skill',
        description:
          'Load a skill to get specialized instructions. Call this when a skill listed in the system prompt matches the current task.',
        inputSchema: z.object({
          name: z.string().describe('The skill name as listed in the system prompt.'),
        }),
        execute: async ({ name }) => {
          const skill = await this.deps.skillsRegistry.getSkill(name, 'memory_agent');
          if (!skill) {
            const available =
              (await this.deps.skillsRegistry.listSkills('memory_agent')).map((s) => s.name).join(', ') || '(none)';
            return { markdown: `Skill "${name}" not available to the memory agent. Available: ${available}` };
          }
          try {
            const body = await readFile(join(skill.path, 'SKILL.md'), 'utf-8');
            if (!skillsLoaded.includes(skill.name)) {
              skillsLoaded.push(skill.name);
            }
            const structured = {
              name: skill.name,
              skillDirectory: skill.path,
              content: this.deps.skillsRegistry.stripFrontmatter(body),
            };
            return {
              markdown: `# ${structured.name}\n\n${structured.content}`,
              structured,
            };
          } catch (e) {
            return { markdown: `Error loading skill "${name}": ${e instanceof Error ? e.message : String(e)}` };
          }
        },
      },
    };

    const skillNames: string[] = [...DEFAULT_SKILL_NAMES];
    if (signals.dialect === 'lookml') {
      skillNames.push('lookml_ingest');
    }
    const skills = await this.deps.skillsRegistry.listSkills(skillNames, 'memory_agent');
    const skillsPrompt = this.deps.skillsRegistry.buildSkillsPrompt(skills, 'memory_agent');
    const baseFraming = await this.loadBaseFraming(sourceType);
    const requiredSkillsBlock = buildRequiredSkillsBlock(signals);
    const systemPrompt = [baseFraming.trimEnd(), skillsPrompt, requiredSkillsBlock].filter(Boolean).join('\n');

    const clipLimit = sourceType === 'external_ingest' ? 48000 : 16000;
    const assistantSection = input.assistantMessage?.trim()
      ? `## Assistant Response\n${clip(input.assistantMessage.trim(), clipLimit)}`
      : '';
    const prompt = [
      `# Wiki Index\n\n${wikiIndex}`,
      hasSL ? `\n# Semantic Layer Sources (connectionId: ${input.connectionId})\n\n${slIndex}` : '',
      '\n---\n',
      assistantSection,
      `\n## User Message\n\n${input.userMessage.trim()}`,
    ]
      .filter(Boolean)
      .join('\n');

    const stepBudget = stepBudgetFor(sourceType);
    const modelName = this.deps.settings.llm.memoryIngestionModel;

    const signalsList = [signals.knowledge && 'knowledge', signals.sl && 'sl'].filter(Boolean) as string[];
    const signalsSuffix =
      signalsList.length > 0 ? ` signals=[${signalsList.join(', ')}] reasons=[${signals.reasons.join('; ')}]` : '';

    const dialectSuffix = signals.dialect ? ` dialect=${signals.dialect}` : '';
    this.logger.log(
      `[memory-agent] chat=${chatId} running (sourceType=${sourceType}, hasSL=${hasSL}, budget=${stepBudget}, model=${modelName})${signalsSuffix}${dialectSuffix}`,
    );

    if (process.env.KTX_MEMORY_AGENT_DEBUG_PROMPTS === '1') {
      this.logger.debug(`[memory-agent prompt-debug] system=${systemPrompt}`);
      this.logger.debug(`[memory-agent prompt-debug] user=${prompt}`);
    }

    // Phase 2 — unlocked LLM loop against the session worktree. Crashes inside generateText
    // are isolated; we still try to run the cross-ref + gate steps and surface what we can.
    let sessionOutcome: 'success' | 'empty' | 'conflict' | 'crash' = 'success';
    let squashSha: string | null = null;
    let touchedPaths: string[] = [];
    let reconciledCrossRefs = 0;
    let gateRevertedSources: string[] = [];
    let sessionConflictPaths: string[] | undefined;
    let sessionCrashed = false;

    try {
      const runResult = await this.deps.agentRunner.runLoop({
        modelRole: 'candidateExtraction',
        systemPrompt,
        userPrompt: prompt,
        toolSet: { ...toolset.toRuntimeTools(toolContext), ...loadSkillTool },
        stepBudget,
        telemetryTags: {
          operationName: 'memory-agent-ingest',
          userId: input.userId,
          chatId,
        },
      });
      if (runResult.stopReason === 'error') {
        throw runResult.error ?? new Error(`[memory-agent] chat=${chatId} loop failed with no error detail`);
      }

      // Cross-ref + revert gate: still scoped to the session worktree (writes via
      // sl-tools' deps already use scoped services). Wiki cross-refs live in the DB,
      // so they're connection-state and don't need scoping.
      const gateDeps: GateDeps = {
        semanticLayerService: scopedSemanticLayerService,
        connections: this.deps.connections,
        configService: sessionWorktree.config,
        gitService: sessionWorktree.git,
        slSourcesRepository: this.deps.slSourcesRepository,
        slValidator: this.deps.slValidator,
        probeRowCount: this.deps.settings.slValidation.probeRowCount,
      };
      reconciledCrossRefs = await this.reconcileCrossRefs(actions, session);
      if (hasSL && touchedSlSourceCount(session.touchedSlSources) > 0) {
        gateRevertedSources = await this.gateRevertInvalidSourcesWithDeps(session, actions, gateDeps);
      }
      if (gateRevertedSources.length > 0) {
        this.logger.warn(
          `[memory-agent] chat=${chatId} gate: reverted ${gateRevertedSources.length} unvalidatable SL source(s): ${gateRevertedSources.join(', ')}`,
        );
      }

      // Phase 3 — squash-merge under a brief `config:repo` lock so interactive writes
      // serialize against this short window. Empty merges (no diff vs main) skip the
      // commit-message enqueue. Conflicts trigger a targeted DB rollback so eager
      // session writes don't leave DB ahead of main.
      const squashMessage = this.squashMessageForSession(
        sourceType,
        chatId,
        actions,
        reconciledCrossRefs,
        gateRevertedSources,
      );
      const mergeResult = await this.deps.lockingService.withLock('config:repo', () =>
        this.deps.gitService.squashMergeIntoMain(
          sessionWorktree.branch,
          SYSTEM_GIT_AUTHOR.name,
          SYSTEM_GIT_AUTHOR.email,
          squashMessage,
        ),
      );

      if (!mergeResult.ok) {
        sessionOutcome = 'conflict';
        sessionConflictPaths = mergeResult.conflictPaths;
        await this.rollbackDbForAbortedSession(session, actions);
      } else if (mergeResult.touchedPaths.length === 0) {
        sessionOutcome = 'empty';
      } else {
        squashSha = mergeResult.squashSha;
        touchedPaths = mergeResult.touchedPaths;
        // Single-file commits: pass the path so the handler diff is path-scoped.
        // Multi-file commits: omit path so the handler grabs the full commit diff
        // (a comma-joined pathspec would match nothing).
        const pathFilter = touchedPaths.length === 1 ? touchedPaths[0] : '';
        await this.deps.rootFileStore.enqueueCommitMessageJobForExternalCommit(
          { commitHash: squashSha },
          squashMessage,
          pathFilter,
        );
      }
    } catch (error) {
      sessionCrashed = true;
      sessionOutcome = 'crash';
      this.logger.error(
        `[memory-agent] chat=${chatId} session crashed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await this.deps.sessionWorktreeService.cleanup(sessionWorktree, sessionOutcome, {
        conflictPaths: sessionConflictPaths,
      });
    }

    if (sessionCrashed) {
      this.logger.warn(`[memory-agent] chat=${chatId} crashed; worktree preserved for inspection`);
    }

    // On conflict/crash the session's git work was discarded — the action list no longer
    // matches main. Drop it so callers don't think writes landed.
    const finalActions = sessionOutcome === 'conflict' || sessionOutcome === 'crash' ? [] : actions;

    // Reindex SL search if any SL actions actually landed on main.
    if (hasSL && finalActions.some((a) => a.target === 'sl')) {
      try {
        const { sources: allSources } = await this.deps.semanticLayerService.loadAllSources(input.connectionId!);
        await this.deps.slSearchService.indexSources(input.connectionId!, allSources);
      } catch (e) {
        this.logger.warn(
          `[memory-agent] chat=${chatId} SL index reindex failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const signalsActedOn: string[] = [];
    if (signals.knowledge && skillsLoaded.includes('wiki_capture')) {
      signalsActedOn.push('knowledge');
    }
    if (signals.sl && skillsLoaded.includes('sl')) {
      signalsActedOn.push('sl');
    }

    if (finalActions.length > 0) {
      this.logger.log(
        `[memory-agent] chat=${chatId} completed: ${finalActions.length} action(s) — ${finalActions.map((a) => `${a.target}:${a.type}:${a.key}`).join(', ')} (skills=[${skillsLoaded.join(', ')}], outcome=${sessionOutcome})`,
      );
      this.deps.telemetry?.trackMemoryIngestion(input.userId, {
        chat_id: chatId,
        source_type: sourceType,
        action_count: finalActions.length,
        actions: finalActions.map((a) => `${a.target}:${a.type}:${a.key}`),
        skills_loaded: skillsLoaded,
        signals_detected: signalsList,
        signals_acted_on: signalsActedOn,
        reconciled_cross_refs: reconciledCrossRefs,
        session_outcome: sessionOutcome,
      });
    } else {
      this.logger.log(
        `[memory-agent] chat=${chatId} completed: 0 actions (skills=[${skillsLoaded.join(', ')}], outcome=${sessionOutcome})`,
      );
      if (signalsList.length > 0) {
        this.deps.telemetry?.trackMemoryIngestion(input.userId, {
          chat_id: chatId,
          source_type: sourceType,
          action_count: 0,
          actions: [],
          skills_loaded: skillsLoaded,
          signals_detected: signalsList,
          signals_acted_on: signalsActedOn,
          reconciled_cross_refs: reconciledCrossRefs,
          session_outcome: sessionOutcome,
        });
      }
    }

    return {
      signalDetected: skillsLoaded.length > 0 || finalActions.length > 0,
      actions: finalActions,
      skillsLoaded,
      commitHash: squashSha,
    };
  }

  /**
   * Project wiki frontmatter `sl_refs:` into the `knowledge_sl_refs` DB index. The wiki
   * YAML remains the authored source of truth; this is a pure derivation. Called inside
   * the `config:repo` lock window so it lines up with the squash-at-end commit flow.
   *
   * Returns the number of DB rows that changed (inserts + deletes).
   */
  async reconcileCrossRefs(actions: MemoryAction[], session: CaptureSession): Promise<number> {
    const writesGlobal = session.forceGlobalScope || !session.userScopedEnabled;
    const wikiScope: 'GLOBAL' | 'USER' = writesGlobal ? 'GLOBAL' : 'USER';
    const wikiScopeId = wikiScope === 'USER' ? session.userId : null;

    let synced = 0;

    for (const action of actions) {
      if (action.target !== 'wiki' || (action.type !== 'created' && action.type !== 'updated')) {
        continue;
      }
      if (!session.connectionId) {
        this.logger.debug(
          `[memory-agent] reconcile: wiki=${action.key} skipped knowledge_sl_refs (no connectionId in session)`,
        );
        continue;
      }
      const page = await this.deps.wikiService.readPage(wikiScope, wikiScopeId, action.key);
      if (!page) {
        continue;
      }
      const slRefs = page.frontmatter.sl_refs ?? [];
      // Wiki authors write both bare source names (`fct_labs`) and measure-qualified refs
      // (`fct_labs.count_lab_orders`). The reverse-edge index is a source-level projection —
      // strip the `.measure` suffix and dedupe before persisting, so findBySource('fct_labs')
      // returns one row for this wiki no matter how many dotted measures it cited.
      const bareSources = [
        ...new Set(
          slRefs.map((ref) => ref.split('.')[0]).filter((sourceName): sourceName is string => sourceName.length > 0),
        ),
      ];
      const { inserted, deleted } = await this.deps.knowledgeSlRefs.syncFromWiki({
        wikiPageKey: action.key,
        wikiScope,
        wikiScopeId,
        refs: bareSources.map((sourceName) => ({ connectionId: session.connectionId!, sourceName })),
      });
      synced += inserted + deleted;
    }

    if (synced > 0) {
      this.logger.log(`[memory-agent] chat=${session.chatId} knowledge_sl_refs_synced=${synced}`);
    }
    return synced;
  }

  /**
   * Pre-squash gate: walk every SL source touched by the agent this session, re-run the
   * full validation (YAML + schema + warehouse dry-run), and for any that still fail,
   * roll back to the pre-session state. Returns the list of source names that were
   * reverted so the caller can log them and scrub the action list.
   *
   * Runs inside the `config:repo` lock; uses `skipLock: true` on downstream writes.
   */
  async gateRevertInvalidSources(session: CaptureSession, actions: MemoryAction[]): Promise<string[]> {
    return this.gateRevertInvalidSourcesWithDeps(session, actions, {
      semanticLayerService: this.deps.semanticLayerService,
      connections: this.deps.connections,
      configService: this.deps.rootFileStore,
      gitService: this.deps.gitService,
      slSourcesRepository: this.deps.slSourcesRepository,
      slValidator: this.deps.slValidator,
      probeRowCount: this.deps.settings.slValidation.probeRowCount,
    });
  }

  /**
   * Same as `gateRevertInvalidSources` but with explicit deps so the orchestrator can
   * pass session-worktree-scoped services for the revert reads/writes.
   */
  async gateRevertInvalidSourcesWithDeps(
    session: CaptureSession,
    actions: MemoryAction[],
    deps: GateDeps,
  ): Promise<string[]> {
    if (!session.connectionId) {
      return [];
    }
    const reverted: string[] = [];
    for (const sourceName of touchedSlSourceNamesForConnection(session.touchedSlSources, session.connectionId)) {
      const result = await deps.slValidator.validateSingleSource(deps, session.connectionId, sourceName);
      if (result.errors.length === 0) {
        continue;
      }
      try {
        await revertSourceToPreHead(deps, session.connectionId, session.preHead, sourceName);
        reverted.push(sourceName);
        deleteTouchedSlSource(session.touchedSlSources, session.connectionId, sourceName);
        for (let i = actions.length - 1; i >= 0; i--) {
          if (actions[i].target === 'sl' && actions[i].key === sourceName) {
            actions.splice(i, 1);
          }
        }
      } catch (e) {
        this.logger.error(
          `[memory-agent] chat=${session.chatId} gate: failed to revert ${sourceName}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return reverted;
  }

  /**
   * Abort-path DB rollback. After a session's merge was rejected because main moved
   * underneath, the session's eager DB writes (sl_sources rows, knowledge_index entries)
   * no longer correspond to anything on disk. For every source/page the agent touched,
   * re-derive from main's current state and overwrite DB. Scoped to touched keys only —
   * NOT a full reconciler run.
   */
  async rollbackDbForAbortedSession(session: CaptureSession, actions: MemoryAction[]): Promise<void> {
    if (session.connectionId) {
      for (const { connectionId, sourceName } of listTouchedSlSources(session.touchedSlSources)) {
        try {
          const file = await this.deps.semanticLayerService.readSourceFile(connectionId, sourceName);
          if (file?.content) {
            const parsed = this.parseYamlOrNull(file.content);
            if (parsed) {
              const hash = this.sha256Hex(file.content);
              await this.deps.semanticLayerSourceReconciler.upsertRow(parsed, file.path, hash);
            }
          } else {
            await this.deps.slSourcesRepository.deleteByConnectionAndName(connectionId, sourceName);
          }
        } catch (err) {
          this.logger.warn(
            `[memory-agent rollback] SL ${sourceName} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    const wikiActions = actions.filter((a) => a.target === 'wiki');
    const wikiScope: 'GLOBAL' | 'USER' = session.forceGlobalScope || !session.userScopedEnabled ? 'GLOBAL' : 'USER';
    const wikiScopeId = wikiScope === 'USER' ? session.userId : null;

    for (const action of wikiActions) {
      try {
        const page = await this.deps.wikiService.readPage(wikiScope, wikiScopeId, action.key).catch(() => null);
        if (page) {
          await this.deps.wikiService.syncSinglePage(
            wikiScope,
            wikiScopeId,
            action.key,
            page.frontmatter,
            page.content,
          );
        } else {
          await this.deps.wikiService.deleteFromIndex(wikiScope, wikiScopeId, action.key);
        }
      } catch (err) {
        this.logger.warn(
          `[memory-agent rollback] wiki ${action.key} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private parseYamlOrNull(content: string): SemanticLayerSource | null {
    try {
      return YAML.parse(content) as SemanticLayerSource;
    } catch {
      return null;
    }
  }

  private sha256Hex(content: string): string {
    return createHash('sha256').update(content, 'utf-8').digest('hex');
  }

  /**
   * Build the deterministic squash-merge commit message for a session ingest. Includes
   * action counts, cross-ref reconciles, and revert-gate counts for triage.
   */
  private squashMessageForSession(
    sourceType: MemoryAgentSourceType,
    chatId: string,
    actions: MemoryAction[],
    reconciledCrossRefs: number,
    gateRevertedSources: string[],
  ): string {
    const wikiCount = actions.filter((a) => a.target === 'wiki').length;
    const slCount = actions.filter((a) => a.target === 'sl').length;
    const parts: string[] = [];
    if (wikiCount > 0) {
      parts.push(`${wikiCount} wiki`);
    }
    if (slCount > 0) {
      parts.push(`${slCount} sl`);
    }
    if (reconciledCrossRefs > 0) {
      parts.push(`${reconciledCrossRefs} xref`);
    }
    if (gateRevertedSources.length > 0) {
      parts.push(`${gateRevertedSources.length} reverted`);
    }
    const summary = parts.length > 0 ? parts.join(', ') : 'no writes';
    return `Memory ingest (${sourceType}): ${summary} [chat=${chatId.slice(0, 8)}]`;
  }

  private async loadBaseFraming(sourceType: MemoryAgentSourceType): Promise<string> {
    return this.deps.promptService.loadPrompt(promptNameFor(sourceType));
  }

  private async buildWikiIndex(userId: string, userScopedEnabled: boolean): Promise<string> {
    const pages = await this.deps.knowledgeIndex.listPagesForUser(userId);
    if (pages.length === 0) {
      return '(empty — no wiki pages exist yet)';
    }

    const formatEntry = (p: { page_key: string; summary: string }) => `- ${p.page_key}: ${p.summary}`;
    if (!userScopedEnabled) {
      return `## Wiki Pages\n${pages.map(formatEntry).join('\n')}`;
    }

    const globalEntries: string[] = [];
    const userEntries: string[] = [];
    for (const page of pages) {
      const entry = formatEntry(page);
      if (page.scope === 'GLOBAL') {
        globalEntries.push(entry);
      } else {
        userEntries.push(entry);
      }
    }
    const sections: string[] = [];
    if (globalEntries.length > 0) {
      sections.push(`## Organization (read-only from USER scope)\n${globalEntries.join('\n')}`);
    }
    if (userEntries.length > 0) {
      sections.push(`## Your Preferences\n${userEntries.join('\n')}`);
    }
    return sections.join('\n\n');
  }

  private async buildSlIndex(connectionId: string): Promise<string> {
    const [sources, warehouseLine] = await Promise.all([
      this.deps.semanticLayerService.loadAllSources(connectionId).then((result) => result.sources),
      this.buildWarehouseLine(connectionId),
    ]);
    const indexLines =
      sources.length === 0
        ? '(no existing sources)'
        : sources
            .map((s) => {
              const measureCount = s.measures.length;
              const joinCount = s.joins?.length ?? 0;
              const header = `${s.name} [measures=${measureCount}, joins=${joinCount}]`;
              if (measureCount === 0 && joinCount === 0) {
                return `${header} — candidate for enrichment`;
              }
              const parts: string[] = [header];
              if (measureCount > 0) {
                parts.push(`  measures: ${s.measures.map((m) => `${s.name}.${m.name}`).join(', ')}`);
              }
              if (joinCount > 0) {
                parts.push(`  joins: ${(s.joins ?? []).map((j) => `→ ${j.to} (${j.relationship})`).join(', ')}`);
              }
              return parts.join('\n');
            })
            .join('\n');
    return warehouseLine ? `${warehouseLine}\n\n${indexLines}` : indexLines;
  }

  /**
   * Read the connection's warehouse type and project it as a `Warehouse: X` line so the
   * agent picks dialect-correct date arithmetic + SQL idioms. The sl_capture skill
   * documents the mapping; without this line the agent defaults to whatever flavor the
   * SKILL examples used to show.
   */
  private async buildWarehouseLine(connectionId: string): Promise<string> {
    try {
      const connection = await this.deps.connections.getConnectionById(connectionId);
      return `Warehouse: ${connection.connectionType}`;
    } catch {
      return '';
    }
  }
}

function clip(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
