import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SkillsRegistryService } from '../../src/context/skills/skills-registry.service.js';

const skillPath = fileURLToPath(new URL('../../src/skills/analytics/SKILL.md', import.meta.url));
const skill = readFileSync(skillPath, 'utf-8');

describe('analytics SKILL.md SQL craft', () => {
  it('keeps the frontmatter parseable as ktx-analytics', () => {
    const service = new SkillsRegistryService({ skillsDir: '/tmp' });
    expect(service.parseFrontmatter(skill).name).toBe('ktx-analytics');
  });

  it('groups the craft under the five sub-headings', () => {
    expect(skill).toContain('<sql_craft>');
    expect(skill).toContain('</sql_craft>');
    expect(skill).toContain('**Schema discovery before writing SQL**');
    expect(skill).toContain('**Composition**');
    expect(skill).toContain('**Window functions**');
    expect(skill).toContain('**Numeric precision**');
    expect(skill).toContain('**Answer completeness / interpretation**');
  });

  it('represents every craft behavior', () => {
    const phrases = [
      'Sample before you compose', // inspect representative rows
      'Cast to the real type before comparing', // string-vs-number compares
      'Build incrementally', // one CTE at a time
      'Avoid fan-out joins', // grain / pre-aggregate
      'the danger is cumulative', // multi-hop fan-out generalization
      'Verify the grain holds across each join', // affirmative grain-verification habit
      'Make the ordering deterministic', // window tie-breaker
      'Filter after the window, not before', // window-then-filter
      'Round only at the end', // precision + truncation
      'Macro vs micro average', // AVG(group) vs SUM/SUM
      'Top / highest / most / lowest', // winning row(s) only
      'For each X / per X / by X', // one row per X
      'Keep the inputs to a derived value', // inputs alongside ratio
      'Expose identity, not just the label', // entity identifier
      'Diagnose empty results', // relax filters one at a time
    ];
    for (const phrase of phrases) {
      expect(skill).toContain(phrase);
    }
  });

  it('ships two dialect-agnostic worked examples: window-then-filter and multi-hop fan-out', () => {
    const sqlFences = skill.match(/```sql/g) ?? [];
    expect(sqlFences).toHaveLength(2);
    // window-then-filter (spec 07)
    expect(skill).toContain('WITH ranked AS');
    expect(skill).toContain('ROW_NUMBER() OVER');
    expect(skill).toContain('WHERE seq = 1');
    // multi-hop fan-out, pre-aggregated right side + count-only escape hatch (spec 09)
    expect(skill).toContain('WITH returned_orders AS');
    expect(skill).toContain('COUNT(DISTINCT o.order_id)');
  });

  it('leaves the existing interactive guidance intact', () => {
    expect(skill).toContain('<workflow>');
    expect(skill).toContain('<rules>');
    expect(skill).toContain('<examples>');
    expect(skill).toContain('Always run `discover_data` before writing SQL.');
    expect(skill).toContain('Treat a `dictionary_search` miss as non-authoritative.');
    expect(skill).toContain('ARR is reported in cents');
  });

  it('points to the dialect-notes tool without inlining dialect syntax (spec 08)', () => {
    // Engine-specific syntax lives behind the sql_dialect_notes MCP tool; the flat
    // skill only names the tool (the dialect-clean assertion above still holds).
    expect(skill).toContain('sql_dialect_notes');
  });

  it('stays dialect-agnostic and free of any benchmark/grader reference', () => {
    const banned = [/\bQUALIFY\b/i, /strftime/i, /julianday/i, /\bspider\b/i, /\bbenchmark\b/i, /\bgold\b/i, /\bgrader\b/i];
    for (const pattern of banned) {
      expect(skill).not.toMatch(pattern);
    }
    // no BigQuery/Snowflake-style backtick-quoted three-part FQTN
    expect(skill).not.toMatch(/`[A-Za-z_]\w*\.[A-Za-z_]\w*\.[A-Za-z_]\w*`/);
  });

  it('never anchors relative time to the data maximum date', () => {
    // Phrase-level guard (not a raw MAX() grep — MAX() is a legitimate aggregate):
    // no single line ties "recent"/"past N <unit>" to a MAX(...) over the data.
    const relativeTime = /(recent|past\s+\w+\s+(day|week|month|year)s?)/i;
    const maxCall = /\bMAX\s*\(/i;
    for (const line of skill.split('\n')) {
      if (maxCall.test(line)) {
        expect(line).not.toMatch(relativeTime);
      }
    }
  });

  it('stays comfortably within the skill size budget', () => {
    expect(skill.split('\n').length).toBeLessThan(500);
  });
});
