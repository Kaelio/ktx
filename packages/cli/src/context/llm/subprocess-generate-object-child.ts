import { ClaudeCodeKtxLlmRuntime } from './claude-code-runtime.js';
import { CodexKtxLlmRuntime } from './codex-runtime.js';
import type { SubprocessRuntimeForkSpec } from './runtime-port.js';
import type { SubprocessGenerateObjectRequest, SubprocessGenerateObjectResponse } from './subprocess-generate-object.js';

// Forked by the parent as a process-group leader it can SIGKILL as a tree. Hosts
// one structured LLM call for a subprocess-backed runtime (codex/claude-code);
// the SDK spawns the model binary as this process's own child, so a parent
// tree-kill reaps the wedged model too. Credentials flow via inherited env — the
// runtimes re-derive their allowlisted env from process.env — never over IPC.

function buildRuntime(forkSpec: SubprocessRuntimeForkSpec): CodexKtxLlmRuntime | ClaudeCodeKtxLlmRuntime {
  if (forkSpec.backend === 'codex') {
    return new CodexKtxLlmRuntime({ projectDir: forkSpec.projectDir, modelSlots: forkSpec.modelSlots });
  }
  return new ClaudeCodeKtxLlmRuntime({ projectDir: forkSpec.projectDir, modelSlots: forkSpec.modelSlots });
}

// The parent owns this process's lifecycle. If the parent dies its IPC channel
// drops; exit rather than linger as an orphan holding a provider connection.
process.once('disconnect', () => process.exit(0));

process.once('message', (request: SubprocessGenerateObjectRequest) => {
  void (async () => {
    let response: SubprocessGenerateObjectResponse;
    try {
      const output = await buildRuntime(request.forkSpec).generateStructuredJson({
        role: request.role,
        prompt: request.prompt,
        ...(request.system !== undefined ? { system: request.system } : {}),
        jsonSchema: request.jsonSchema,
      });
      response = { ok: true, output };
    } catch (error) {
      response = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    process.send?.(response, () => process.exit(0));
  })();
});
