// Placeholder until workstream A lands. Keeps both worktrees compiling against
// the names fixed in ./contract.ts.
import {
  ClaudeDirectError,
  type ClaudeCliArgsBuilder,
  type ClaudeCliLineParser,
  type ClaudeCliMessageSerializer,
} from "./contract";

export const buildClaudeCliArgs: ClaudeCliArgsBuilder = () => {
  throw new ClaudeDirectError(
    "protocol",
    "buildClaudeCliArgs is not implemented",
  );
};

export const parseClaudeCliLine: ClaudeCliLineParser = () => {
  throw new ClaudeDirectError(
    "protocol",
    "parseClaudeCliLine is not implemented",
  );
};

export const serializeClaudeCliMessage: ClaudeCliMessageSerializer = () => {
  throw new ClaudeDirectError(
    "protocol",
    "serializeClaudeCliMessage is not implemented",
  );
};

export function redactForLog(text: string): string {
  return text;
}
