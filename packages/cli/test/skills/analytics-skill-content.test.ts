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
    expect(skill).toContain('**Ordering & aggregation determinism**');
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
      'Complete the panel', // full-domain spine for "each/every/all" panels
      'Default by additivity', // COALESCE 0 for additive, NULL otherwise
      'Keep the inputs to a derived value', // inputs alongside ratio
      'Project BOTH identity and label', // entity identifier
      'Diagnose empty results', // relax filters one at a time
      'Cumulative / running total', // explicit unbounded-preceding frame (spec 11)
      'Rolling window over calendar time', // calendar range, not row count (spec 11)
      'minimum periods', // emit NULL until the window is full (spec 11)
      'Period-over-period', // LAG + guarded growth ratio (spec 11)
      'Parse text-encoded numerics before doing math on them', // detect text-encoded numbers (spec 12)
      'Strip, scale, and cast in one early CTE', // parse/scale early (spec 12)
      'Confirm the parse covered every value', // failure-detecting cast coverage (spec 12)
      'Answer every requested output', // multi-part/multi-output umbrella over identity+inputs (spec 14)
      'Final completeness check', // re-read the question, confirm the projection covers all four facets (spec 14)
      "Don't over-project", // match the request exactly, no padding columns (spec 14)
    ];
    for (const phrase of phrases) {
      expect(skill).toContain(phrase);
    }
  });

  it('ships six dialect-agnostic worked examples: window-then-filter, multi-hop fan-out, panel-completeness spine, cumulative running total, text-encoded-numeric parse-and-scale, multi-part output completeness', () => {
    const sqlFences = skill.match(/```sql/g) ?? [];
    expect(sqlFences).toHaveLength(6);
    // window-then-filter (spec 07)
    expect(skill).toContain('WITH ranked AS');
    expect(skill).toContain('ROW_NUMBER() OVER');
    expect(skill).toContain('WHERE seq = 1');
    // multi-hop fan-out, pre-aggregated right side + count-only escape hatch (spec 09)
    expect(skill).toContain('WITH returned_orders AS');
    expect(skill).toContain('COUNT(DISTINCT o.order_id)');
    // panel completeness: distinct-dimension spine -> LEFT JOIN -> COALESCE (spec 10)
    expect(skill).toContain('SELECT DISTINCT region_id FROM regions');
    expect(skill).toContain('LEFT JOIN');
    expect(skill).toMatch(/COALESCE\(/);
    // cumulative running total: explicit unbounded-preceding frame + complete tie-breaker (spec 11)
    expect(skill).toContain('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW');
    expect(skill).toContain('ORDER BY txn_date, txn_id');
    // text-encoded numeric: strip with chained REPLACE -> CASE suffix scale -> CAST (spec 12)
    expect(skill).toContain('WITH parsed AS');
    expect(skill).toContain('REPLACE(');
    expect(skill).toMatch(/AS DECIMAL\(/);
    expect(skill).toContain("LIKE '%K' THEN 1000");
    // multi-part output completeness: a column per clause + entity identity, at grain (spec 14)
    expect(skill).toContain('region_monthly');
    expect(skill).toContain('MAX(rm.monthly_orders)');
    expect(skill).toContain('MIN(rm.monthly_orders)');
    expect(skill).toContain('MAX(rm.monthly_orders) - MIN(rm.monthly_orders)');
    expect(skill).toContain('r.region_id, r.region_name');
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
    const banned = [
      /\bQUALIFY\b/i,
      /strftime/i,
      /julianday/i,
      /generate_series/i, // postgres-only series generator — belongs in dialect notes, not the skill
      /GENERATE_DATE_ARRAY/i, // bigquery-only series generator — belongs in dialect notes, not the skill
      /\bRANGE\b[\s\S]{0,40}\bINTERVAL\b/i, // inline dialect range-interval frame — belongs in dialect notes, not the skill
      /\bSAFE_CAST\b/i, // bigquery failure-detecting cast — belongs in dialect notes, not the skill
      /\bTRY_CAST\b/i, // snowflake/tsql failure-detecting cast — belongs in dialect notes, not the skill
      /\bTRY_TO_NUMBER\b/i, // snowflake failure-detecting cast — belongs in dialect notes, not the skill
      /\bREGEXP_REPLACE\b/i, // dialect regex strip — the portable strip is chained REPLACE
      /toFloat64OrNull/i, // clickhouse failure-detecting cast — belongs in dialect notes, not the skill
      /\bGLOB\b/i, // sqlite numeric-pattern guard — belongs in dialect notes, not the skill
      /\bspider\b/i,
      /\bbenchmark\b/i,
      /\bgold\b/i,
      /\bgrader\b/i,
    ];
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
