import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PromptService } from '../../../src/context/prompts/prompt.service.js';
import { SkillsRegistryService } from '../../../src/context/skills/skills-registry.service.js';
import { DEFAULT_SKILL_NAMES, promptNameFor } from '../../../src/context/memory/capture-signals.js';
import type { MemoryAgentSourceType } from '../../../src/context/memory/types.js';

const promptsDir = fileURLToPath(new URL('../../../src/prompts', import.meta.url));
const skillsDir = fileURLToPath(new URL('../../../src/skills', import.meta.url));
const memorySourceTypes: MemoryAgentSourceType[] = ['research', 'external_ingest', 'backfill'];
const expectedSkillHeadings: Record<string, string> = {
  wiki_capture: '# Wiki Capture',
  sl: '# Semantic Layer',
  sl_capture: '# Semantic Layer',
};
const expectedAdapterSkillHeadings: Record<string, string> = {
  gdrive_synthesize: '# Google Drive Doc Synthesis',
  historic_sql_patterns: '# Historic SQL Patterns',
  historic_sql_table_digest: '# Historic SQL Table Digest',
  live_database_ingest: '# Live Database Ingest',
  looker_ingest: '# Looker Runtime Ingest',
  lookml_ingest: '# LookML to ktx Semantic Layer',
  metabase_ingest: '# Metabase to ktx Semantic Layer',
  metricflow_ingest: '# MetricFlow to ktx Semantic Layer',
  sigma_ingest: '# Sigma Ingest',
};
const verificationWriterSkills = [
  'gdrive_synthesize',
  'notion_synthesize',
  'dbt_ingest',
  'lookml_ingest',
  'looker_ingest',
  'metabase_ingest',
  'metricflow_ingest',
  'sigma_ingest',
  'live_database_ingest',
  'historic_sql_table_digest',
  'historic_sql_patterns',
  'wiki_capture',
  'sl_capture',
] as const;

function forbiddenProductPattern() {
  return new RegExp([['Kae', 'lio'].join(''), ['kae', 'lio'].join(''), ['KAE', 'LIO_'].join('')].join('|'));
}

function sqlExecutionCallBlocks(body: string): string[] {
  const blocks: string[] = [];
  const marker = 'sql_execution({';
  let offset = 0;

  while (offset < body.length) {
    const start = body.indexOf(marker, offset);
    if (start === -1) {
      break;
    }
    const end = body.indexOf('})', start + marker.length);
    blocks.push(body.slice(start, end === -1 ? start + marker.length : end + 2));
    offset = start + marker.length;
  }

  return blocks;
}

describe('memory runtime assets', () => {
  it('packages every memory-agent base prompt referenced by promptNameFor()', async () => {
    const prompts = new PromptService({ promptsDir, partials: [] });

    for (const sourceType of memorySourceTypes) {
      const promptName = promptNameFor(sourceType);
      const prompt = await prompts.loadPrompt(promptName);

      expect(prompt).toContain('<role>');
      expect(prompt).toContain('<workflow>');
      expect(prompt).not.toMatch(forbiddenProductPattern());
    }
  });

  it('packages the default memory capture skills referenced by DEFAULT_SKILL_NAMES', async () => {
    const registry = new SkillsRegistryService({ skillsDir });
    const skills = await registry.listSkills([...DEFAULT_SKILL_NAMES], 'memory_agent');

    expect(skills.map((skill) => skill.name).sort()).toEqual(['sl', 'sl_capture', 'wiki_capture']);

    for (const skill of skills) {
      const body = await readFile(join(skill.path, 'SKILL.md'), 'utf-8');
      const expectedHeading = expectedSkillHeadings[skill.name];
      expect(expectedHeading).toBeDefined();
      expect(body).toContain(expectedHeading);
      expect(body).not.toMatch(forbiddenProductPattern());
    }
  });

  it('keeps memory-only capture skills hidden from research callers', async () => {
    const registry = new SkillsRegistryService({ skillsDir });
    const skills = await registry.listSkills([...DEFAULT_SKILL_NAMES], 'research');

    expect(skills.map((skill) => skill.name)).toEqual(['sl']);
  });

  it('packages ingest adapter skills referenced by bundled adapters', async () => {
    const registry = new SkillsRegistryService({ skillsDir });
    const skillNames = Object.keys(expectedAdapterSkillHeadings);
    const skills = await registry.listSkills(skillNames, 'memory_agent');

    expect(skills.map((skill) => skill.name).sort()).toEqual([...skillNames].sort());

    for (const skill of skills) {
      const body = await readFile(join(skill.path, 'SKILL.md'), 'utf-8');
      expect(body).toContain(expectedAdapterSkillHeadings[skill.name]);
      expect(body).not.toMatch(forbiddenProductPattern());
    }
  });

  it('ships Looker runtime ingest guidance for warehouse target SL writes', async () => {
    const body = await readFile(join(skillsDir, 'looker_ingest', 'SKILL.md'), 'utf-8');

    expect(body).toContain('targetWarehouseConnectionId');
    expect(body).toContain('targetTable.ok === true');
    expect(body).toContain('targetTable.canonicalTable');
    expect(body).toContain('source_tables preflight');
    expect(body).toContain('emit_unmapped_fallback');
    expect(body).toContain('no_connection_mapping');
    expect(body).not.toContain('a standalone SL source only when raw evidence contains enough table or SQL structure');
  });

  it('ships Metabase guidance that avoids invalid joins for SQL-only card outputs', async () => {
    const body = await readFile(join(skillsDir, 'metabase_ingest', 'SKILL.md'), 'utf-8');

    expect(body).toContain('Do not declare a ktx join just because the card SQL joins that table internally');
    expect(body).toContain('only when the card output exposes a local key that matches the target source grain');
    expect(body).toContain('If `sl_discover` resolves the table, it is not outside the manifest');
    expect(body).toContain('reason: "parse_error"');
    expect(body).not.toContain('Tables outside the manifest');
    expect(body).not.toContain('reason: "metabase_sql_untranslated"');
  });

  it('ships Notion guidance for physical-table fallbacks and duplicate wiki reconciliation', async () => {
    const body = await readFile(join(skillsDir, 'notion_synthesize', 'SKILL.md'), 'utf-8');

    expect(body).toContain('Notion `dataSourceCount` counts Notion databases/data sources only');
    expect(body).toContain('Search existing wiki pages for the same `tables:` or `sl_refs:` frontmatter');
    expect(body).toContain('no_physical_table');
  });

  it('ships Google Drive guidance for knowledge-only doc synthesis', async () => {
    const body = await readFile(join(skillsDir, 'gdrive_synthesize', 'SKILL.md'), 'utf-8');

    expect(body).toContain('Google Drive docs are knowledge-only in v1');
    expect(body).toContain('Do not create semantic-layer sources under the `gdrive` connection');
    expect(body).toContain('Source: Google Doc -');
  });

  it('packages LookML connection-mismatch SL gate guidance', async () => {
    const body = await readFile(join(skillsDir, 'lookml_ingest', 'SKILL.md'), 'utf-8');

    expect(body).toContain('[LOOKML SL WRITES DISALLOWED]');
    expect(body).toContain('lookml_connection_mismatch');
    expect(body).toContain('Do not call `sl_write_source` or `sl_edit_source`');
    expect(body).toContain('LookML writes target the run connection directly');
  });

  it('ships identifier verification protocol in every synthesis writer skill', async () => {
    for (const skillName of verificationWriterSkills) {
      const body = await readFile(join(skillsDir, skillName, 'SKILL.md'), 'utf-8');
      expect(body).toContain('## Identifier Verification Protocol');
      expect(body).toMatch(/discover_data|entity_details/);
    }
  });

  it('does not ship stale warehouse verification tool names or fictional identifiers', async () => {
    for (const skillName of verificationWriterSkills) {
      const body = await readFile(join(skillsDir, skillName, 'SKILL.md'), 'utf-8');
      expect(body).not.toContain('orbit_analytics.customer');
      expect(body).not.toContain('wiki_sl_search');
      expect(body).not.toContain('sl_describe_table');
    }
  });

  it('ships only the ktx connectionId sql_execution call shape in writer guidance', async () => {
    const shared = await readFile(join(skillsDir, '_shared', 'identifier-verification.md'), 'utf-8');
    const bodies = [{ name: '_shared/identifier-verification.md', body: shared }];

    expect(shared).toContain('sql_execution({connectionId, sql: "SELECT DISTINCT');
    expect(shared).toContain('sql_execution({connectionId, sql: "SELECT 1 FROM');

    for (const skillName of verificationWriterSkills) {
      const body = await readFile(join(skillsDir, skillName, 'SKILL.md'), 'utf-8');
      bodies.push({ name: `${skillName}/SKILL.md`, body });
      expect(body).toContain('sql_execution({connectionId');
      expect(body).not.toContain('sql_execution({ sql');
      expect(body).not.toContain('session shape');
      expect(body).not.toContain('connection is already pinned by the ingest session');
    }

    for (const { name, body } of bodies) {
      const calls = sqlExecutionCallBlocks(body);
      expect(calls.length, `${name} should contain sql_execution guidance`).toBeGreaterThan(0);
      expect(
        calls.filter((call) => !call.includes('connectionId')),
        `${name} has sql_execution calls without connectionId`,
      ).toEqual([]);
      expect(body, `${name} has a connectionless multiline sql_execution call`).not.toMatch(
        /sql_execution\(\{\s*sql\s*:/,
      );
    }
  });
});
