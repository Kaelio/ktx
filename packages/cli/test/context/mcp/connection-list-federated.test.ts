import { describe, expect, it } from 'vitest';
import { createLocalProjectMcpContextPorts } from '../../../src/context/mcp/local-project-ports.js';

const project = {
  projectDir: '/tmp/p',
  config: {
    connections: {
      books_db: { driver: 'sqlite', path: './b.db' },
      reviews_db: { driver: 'sqlite', path: './r.db' },
    },
  },
} as never;

describe('MCP connection_list federated entry', () => {
  it('includes _ktx_federated with members and hint', async () => {
    const ports = createLocalProjectMcpContextPorts(project, { embeddingService: null });
    const list = await ports.connections!.list();
    const federated = list.find((c) => c.id === '_ktx_federated');
    expect(federated).toBeDefined();
    expect(federated!.connectionType).toBe('DUCKDB');
    expect(federated!.members).toEqual(['books_db', 'reviews_db']);
    expect(federated!.hint).toContain('Cross-database');
  });

  it('omits _ktx_federated with a single connection', async () => {
    const single = {
      projectDir: '/tmp/p',
      config: { connections: { books_db: { driver: 'sqlite', path: './b.db' } } },
    } as never;
    const ports = createLocalProjectMcpContextPorts(single, { embeddingService: null });
    const list = await ports.connections!.list();
    expect(list.find((c) => c.id === '_ktx_federated')).toBeUndefined();
  });
});
