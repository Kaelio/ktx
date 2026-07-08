import type { CaptureSignals, MemoryAgentInput, MemoryAgentSourceType } from './types.js';

const SQL_AGGREGATE_PATTERN = /\b(SUM|AVG|COUNT|MIN|MAX|GROUP\s+BY|JOIN|WITH\s+\w+\s+AS\s*\()\b/i;
const SL_DEFINITION_PATTERN = /\b(define|going forward|always (apply|exclude)|treat as|cohort|reusable)\b/i;
const KNOWLEDGE_DEFINITION_PATTERN =
  /\b(define|going forward|alias|stands for|means|convention|is the (canonical|definition))\b/i;
const TABLE_SEPARATOR_PATTERN = /\|\s*-{3,}\s*\|/;
const LOOKML_STRUCTURAL_PATTERN = /^\s*(view|explore|model|include)\s*:\s*[\w"`]/m;
const LOOKML_FIELDS_PATTERN =
  /^\s*(measure|dimension|dimension_group|sql_table_name|derived_table|sql_always_where|drill_fields|join)\s*:/m;

export const DEFAULT_SKILL_NAMES = ['sl', 'sl_capture', 'wiki_capture'] as const;

export function detectCaptureSignals(input: MemoryAgentInput): CaptureSignals {
  const userMessage = input.userMessage?.trim() ?? '';
  const assistantMessage = input.assistantMessage?.trim() ?? '';
  const reasons: string[] = [];

  // The user-message length gate is a research-path proxy for "the turn was substantive
  // enough to promote the assistant's SQL." External ingest carries a fixed boilerplate
  // user message and keeps the real content in the assistant message, so the proxy never
  // holds there - treat the deliberate submission itself as the substantive signal.
  const deliberateSubmission = input.sourceType === 'external_ingest';

  let sl = false;
  if (
    assistantMessage &&
    SQL_AGGREGATE_PATTERN.test(assistantMessage) &&
    (deliberateSubmission || userMessage.length >= 100)
  ) {
    sl = true;
    reasons.push('sql aggregate in assistant message');
  }
  if (userMessage && SL_DEFINITION_PATTERN.test(userMessage)) {
    sl = true;
    reasons.push('sl-style definition keyword in user message');
  }

  let knowledge = false;
  if (userMessage && KNOWLEDGE_DEFINITION_PATTERN.test(userMessage)) {
    knowledge = true;
    reasons.push('definition keyword in user message');
  }
  if (assistantMessage && TABLE_SEPARATOR_PATTERN.test(assistantMessage)) {
    knowledge = true;
    reasons.push('definition table in assistant message');
  }

  let dialect: CaptureSignals['dialect'];
  if (
    assistantMessage &&
    LOOKML_STRUCTURAL_PATTERN.test(assistantMessage) &&
    LOOKML_FIELDS_PATTERN.test(assistantMessage)
  ) {
    dialect = 'lookml';
    sl = true;
    reasons.push('lookml structure in assistant message');
  }

  return { knowledge, sl, dialect, reasons };
}

export function buildRequiredSkillsBlock(signals: CaptureSignals): string {
  const required: Array<{ name: string; reason: string }> = [];
  if (signals.knowledge) {
    const reason =
      signals.reasons.find((r) => r.includes('definition keyword') || r.includes('definition table')) ??
      'wiki signal detected';
    required.push({ name: 'wiki_capture', reason });
  }
  if (signals.sl) {
    const reason =
      signals.reasons.find((r) => r.includes('sql aggregate') || r.includes('sl-style')) ?? 'sl signal detected';
    required.push({ name: 'sl', reason });
  }
  if (signals.dialect === 'lookml') {
    const reason = signals.reasons.find((r) => r.includes('lookml')) ?? 'lookml dialect detected';
    required.push({ name: 'lookml_ingest', reason });
  }
  if (required.length === 0) {
    return '';
  }
  const lines = required.map((r) => `- \`${r.name}\` - reason: ${r.reason}`).join('\n');
  return [
    '<required_skills>',
    'The pre-scan flagged this turn as a likely capture candidate. Before exiting, you MUST `load_skill` for each skill below and follow its workflow. Skipping a required skill means a likely capture is being missed; only skip if, after reading the skill body and the turn, you are sure no capture applies.',
    '',
    lines,
    '</required_skills>',
  ].join('\n');
}

export function prefilterSkipReason(input: MemoryAgentInput, signals = detectCaptureSignals(input)): string | null {
  const trimmedUser = input.userMessage?.trim() ?? '';
  const assistantMessage = input.assistantMessage ?? '';

  const hasUserSignal = trimmedUser.length >= 6;
  const hasAssistantSqlSignal = /\b(SUM|AVG|COUNT|MIN|MAX|GROUP\s+BY)\b/i.test(assistantMessage);
  if (!hasUserSignal && !hasAssistantSqlSignal) {
    return 'message too short, no SQL keywords';
  }

  if (signals.dialect === 'lookml') {
    const hasStructural = /^\s*(derived_table|sql_always_where|join)\s*:/m.test(assistantMessage);
    const hasNonCountAggregate = /\btype:\s*(sum|average|avg|min|max|count_distinct|median|percentile)\b/i.test(
      assistantMessage,
    );
    if (!hasStructural && !hasNonCountAggregate) {
      return 'no semantic signal (lookml-wrapper)';
    }
  }

  return null;
}

/** @internal */
export function isWorthAnalyzing(input: MemoryAgentInput): boolean {
  return prefilterSkipReason(input, detectCaptureSignals(input)) === null;
}

export function stepBudgetFor(sourceType: MemoryAgentSourceType): number {
  switch (sourceType) {
    case 'research':
      return 20;
    case 'external_ingest':
      return 30;
    case 'backfill':
      return 25;
  }
}

export function promptNameFor(sourceType: MemoryAgentSourceType): string {
  return sourceType === 'external_ingest'
    ? 'memory_agent_external_ingest'
    : sourceType === 'backfill'
      ? 'memory_agent_backfill'
      : 'memory_agent_research';
}
