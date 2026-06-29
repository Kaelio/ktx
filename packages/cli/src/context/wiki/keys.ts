const FLAT_WIKI_KEY_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

export function suggestFlatWikiKey(key: string): string {
  const suggested = key
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return suggested.length > 0 ? suggested : 'page-key';
}

function invalidFlatWikiKeyMessage(key: string): string {
  return `Invalid wiki key "${key}". Wiki keys must be flat; use "${suggestFlatWikiKey(key)}".`;
}

export function isFlatWikiKey(key: string): boolean {
  return FLAT_WIKI_KEY_PATTERN.test(key);
}

export function validateFlatWikiKey(key: string): { ok: true; key: string } | { ok: false; error: string } {
  return isFlatWikiKey(key) ? { ok: true, key } : { ok: false, error: invalidFlatWikiKeyMessage(key) };
}

export function assertFlatWikiKey(key: string): string {
  const result = validateFlatWikiKey(key);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.key;
}
