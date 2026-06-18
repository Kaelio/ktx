import { createHash } from 'node:crypto';
import YAML from 'yaml';
import type { KtxFileStorePort } from '../../context/core/file-store.js';

// Semantic-layer source identity lives in the file's `name:` field, which mirrors
// the warehouse identifier verbatim (Snowflake's uppercase `SIGNED_UP`, `EVENT$LOG`).
// The filename is a derived label and never participates in identity: reads resolve
// a source by scanning the connection directory and matching `name:`, and writes
// reuse the resolved file's path, so files can be freely renamed by humans without
// changing which source they define.

function assertSafePathToken(kind: string, value: string): string {
  if (
    value.trim().length === 0 ||
    value.includes('..') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.startsWith('.') ||
    value.includes('//')
  ) {
    throw new Error(`Unsafe ${kind}: ${value}`);
  }
  return value;
}

/** @internal */
export function isReservedConnectionId(connectionId: string): boolean {
  return connectionId.startsWith('_ktx_');
}

export function assertSafeConnectionId(connectionId: string): string {
  if (isReservedConnectionId(connectionId)) {
    throw new Error(`Connection id "${connectionId}" uses the reserved "_ktx_" prefix.`);
  }
  if (!isSafeConnectionId(connectionId)) {
    throw new Error(`Unsafe connection id: ${connectionId}`);
  }
  return assertSafePathToken('connection id', connectionId);
}

export function isSafeConnectionId(connectionId: string | undefined): connectionId is string {
  return typeof connectionId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(connectionId);
}

export function sourceNameFromPath(path: string): string {
  return (
    path
      .split('/')
      .at(-1)
      ?.replace(/\.ya?ml$/, '') ?? path
  );
}

// The one predicate for "this path is a semantic-layer YAML file". ktx itself
// always writes `.yaml` (see `slSourceFileName`), but humans rename freely and
// the dbt ecosystem's habit is `.yml`, so every reader must accept both — a
// listing that recognizes only one extension makes the same file visible to
// some entry points and invisible to others.
export function isSlYamlPath(path: string): boolean {
  return path.endsWith('.yaml') || path.endsWith('.yml');
}

// Windows refuses these basenames regardless of extension — a genuinely universal
// filesystem invariant, so the static list is acceptable.
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

const SAFE_FILE_BASENAME = /^[a-z0-9][a-z0-9_]{0,63}$/;

/**
 * Derive the filename for a semantic-layer source. Total over all possible
 * source names — never throws.
 *
 * Names that are already safe lowercase snake_case become `<name>.yaml`;
 * anything else becomes `<slug>-<8 hex of sha256(name)>.yaml`. The two ranges
 * are disjoint and the mapping is injective: safe filenames contain no `-`,
 * hashed filenames always end in `-<8 hex>`, and slugs are lowercased so names
 * differing only by case get distinct hashes instead of colliding paths on
 * case-insensitive filesystems (macOS APFS, Windows).
 *
 * @internal
 */
export function slSourceFileName(sourceName: string): string {
  if (SAFE_FILE_BASENAME.test(sourceName) && !WINDOWS_RESERVED_BASENAME.test(sourceName)) {
    return `${sourceName}.yaml`;
  }
  const slug = sourceName
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  const hash = createHash('sha256').update(sourceName, 'utf-8').digest('hex').slice(0, 8);
  return `${slug || 'src'}-${hash}.yaml`;
}

export function slSourceFilePath(connectionId: string, sourceName: string): string {
  return `semantic-layer/${assertSafeConnectionId(connectionId)}/${slSourceFileName(sourceName)}`;
}

export interface SlSourceFile {
  path: string;
  content: string;
}

// Same keying as `loadLocalSlSourceRecords`: the in-file `name:` is the identity;
// the filename is only a fallback for files so broken that even the `name:` is
// unrecoverable, or genuinely nameless ones. A file left mid-edit with a syntax
// error below its `name:` line keeps its declared identity (see
// `slDeclaredSourceName`), so a human-renamed source is still addressed by name
// while broken instead of silently reverting to its filename.
export function slSourceNameForFile(path: string, content: string): string {
  return slDeclaredSourceName(content) ?? sourceNameFromPath(path);
}

/**
 * The `name:` a semantic-layer YAML file declares, or null when the file is
 * nameless or so broken even the name is unrecoverable. Null is how
 * `writeSource` tells a genuine name conflict at a derived path apart from the
 * broken remains of the source being written, which a rewrite must repair
 * rather than refuse.
 *
 * Uses `parseDocument`, not `parse`: a file with a syntax error below the
 * `name:` line still parses into a partial tree whose top-level `name:` is
 * intact. `parse` would throw on the same input and drop the source to its
 * filename — wrong for human-renamed files, whose filename is not the name.
 */
export function slDeclaredSourceName(content: string): string | null {
  let doc: ReturnType<typeof YAML.parseDocument>;
  try {
    doc = YAML.parseDocument(content);
  } catch {
    return null;
  }
  const name = doc.get('name');
  return typeof name === 'string' && name.length > 0 ? name : null;
}

/**
 * Find the standalone/overlay file that defines `sourceName` for a connection.
 * Returns null when no file declares the name (the source may still exist as a
 * manifest entry under `_schema/`). Throws when more than one file declares the
 * same name — that breaks the one-file-per-name invariant and must be repaired
 * by hand rather than silently picking one.
 */
export async function resolveSlSourceFile(
  fileStore: Pick<KtxFileStorePort, 'listFiles' | 'readFile'>,
  connectionId: string,
  sourceName: string,
): Promise<SlSourceFile | null> {
  const dir = `semantic-layer/${assertSafeConnectionId(connectionId)}`;
  const schemaDir = `${dir}/_schema`;
  const listed = await fileStore.listFiles(dir);
  const paths = listed.files.filter((file) => isSlYamlPath(file) && !file.startsWith(`${schemaDir}/`)).sort();

  const matches: SlSourceFile[] = [];
  for (const path of paths) {
    const raw = await fileStore.readFile(path);
    if (slSourceNameForFile(path, raw.content) === sourceName) {
      matches.push({ path, content: raw.content });
    }
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple semantic-layer files declare source "${sourceName}": ${matches.map((match) => match.path).join(', ')}`,
    );
  }
  return matches[0] ?? null;
}
