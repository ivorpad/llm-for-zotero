// Placeholder until workstream A lands. Keeps both worktrees compiling against
// the names fixed in ../claudeCodeDirect/contract.ts.
import {
  ClaudeDirectError,
  type ClaudeCliProcessSpawner,
} from "../claudeCodeDirect/contract";

export function createClaudeCliProcessSpawner(): ClaudeCliProcessSpawner {
  throw new ClaudeDirectError(
    "spawn_failed",
    "The Claude CLI process spawner is not implemented yet",
  );
}

export async function terminateAllClaudeCliProcesses(): Promise<void> {
  return;
}
