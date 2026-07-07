import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PromptService } from '../../../src/context/prompts/prompt.service.js';
import { SkillsRegistryService } from '../../../src/context/skills/skills-registry.service.js';

const promptsDir = fileURLToPath(new URL('../../../src/prompts', import.meta.url));
const skillsDir = fileURLToPath(new URL('../../../src/skills', import.meta.url));

const adapterSkillNames = [
  'live_database_ingest',
  'lookml_ingest',
  'metabase_ingest',
  'metricflow_ingest',
  'notion_synthesize',
  'gdrive_synthesize',
  'sharepoint_synthesize',
  'historic_sql_table_digest',
  'historic_sql_patterns',
  'ingest_triage',
  'wiki_capture',
  'sl_capture',
] as const;

const adapterReconcileSkillNames = [
  'ingest_triage',
  'wiki_capture',
  'sl_capture',
] as const;

const pageTriagePromptNames = ['skills/page_triage_classifier', 'skills/light_extraction'] as const;

function forbiddenProductPattern() {
  return new RegExp([['Kae', 'lio'].join(''), ['kae', 'lio'].join(''), ['KAE', 'LIO_'].join('')].join('|'));
}

describe('ingest runtime assets', () => {
  it('resolves every reusable ingest skill from packaged ktx assets without server fallback', async () => {
    const registry = new SkillsRegistryService({ skillsDir });
    const expected = [...new Set([...adapterSkillNames, ...adapterReconcileSkillNames])].sort();

    const skills = await registry.listSkills(expected, 'memory_agent');

    expect(skills.map((skill) => skill.name).sort()).toEqual(expected);
    for (const skill of skills) {
      expect(skill.path.startsWith(skillsDir)).toBe(true);
      const body = await readFile(join(skill.path, 'SKILL.md'), 'utf-8');
      expect(body).not.toMatch(forbiddenProductPattern());
    }
  });

  it('loads page-triage and light-extraction prompts from packaged ktx prompt assets', async () => {
    const prompts = new PromptService({ promptsDir, partials: [] });

    for (const promptName of pageTriagePromptNames) {
      const prompt = await prompts.loadPrompt(promptName);
      expect(prompt.trim().length).toBeGreaterThan(100);
      expect(prompt).not.toMatch(forbiddenProductPattern());
    }

    await expect(prompts.loadPrompt('skills/page_triage_classifier')).resolves.toContain('# Page Triage Classifier');
    await expect(prompts.loadPrompt('skills/light_extraction')).resolves.toContain('# Light Context Extraction');
  });

  it('packages historic-SQL table digest guidance from ktx assets', async () => {
    const registry = new SkillsRegistryService({ skillsDir });
    const skills = await registry.listSkills(['historic_sql_table_digest'], 'memory_agent');

    expect(skills.map((skill) => skill.name)).toEqual(['historic_sql_table_digest']);

    const body = await readFile(join(skills[0]!.path, 'SKILL.md'), 'utf-8');
    expect(body).toContain('# Historic SQL Table Digest');
    expect(body).toContain('tables/<schema>.<name>.json');
    expect(body).toContain('tableUsageOutputSchema');
    expect(body).toContain('emit_historic_sql_evidence');
    expect(body).toContain('Do not call wiki_write');
    expect(body).toContain('Do not call sl_write_source');
    expect(body).not.toMatch(forbiddenProductPattern());
  });

  it('packages historic-SQL patterns guidance from ktx assets', async () => {
    const registry = new SkillsRegistryService({ skillsDir });
    const skills = await registry.listSkills(['historic_sql_patterns'], 'memory_agent');

    expect(skills.map((skill) => skill.name)).toEqual(['historic_sql_patterns']);

    const body = await readFile(join(skills[0]!.path, 'SKILL.md'), 'utf-8');
    expect(body).toContain('# Historic SQL Patterns');
    expect(body).toContain('patterns-input/part-0001.json');
    expect(body).toContain('patternsArraySchema');
    expect(body).toContain('emit_historic_sql_evidence');
    expect(body).toContain('cross-table');
    expect(body).not.toMatch(forbiddenProductPattern());
  });

  it('packages identifier verification prompt assets', async () => {
    const shared = await readFile(join(skillsDir, '_shared', 'identifier-verification.md'), 'utf-8');
    const legacyConnectionPrefix = ['connection', 'Name'].join('');

    expect(shared).toContain('## Identifier Verification Protocol');
    expect(shared).toContain('discover_data');
    expect(shared).toContain('entity_details');
    expect(shared).toContain('sql_execution');
    expect(shared).toContain('sql_execution({connectionId, sql: "SELECT DISTINCT');
    expect(shared).toContain('sql_execution({connectionId, sql: "SELECT 1 FROM');
    expect(shared).not.toContain(`entity_details({${legacyConnectionPrefix}`);
    expect(shared).not.toContain(`sql_execution({${legacyConnectionPrefix}`);
  });
});
