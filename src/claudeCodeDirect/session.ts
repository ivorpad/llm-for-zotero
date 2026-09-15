// Placeholder until workstream A lands. Keeps both worktrees compiling against
// the names fixed in ./contract.ts.
import { ClaudeDirectError, type ClaudeDirectSessionFactory } from "./contract";

export const createClaudeDirectSession: ClaudeDirectSessionFactory = () => {
  throw new ClaudeDirectError(
    "spawn_failed",
    "Direct CLI sessions are not implemented yet",
  );
};
