/**
 * Wire protocol for the Claude Code CLI run with `--input-format stream-json
 * --output-format stream-json`: argv construction, one-line-per-object parsing
 * and serialization, log redaction, and the assembler that folds partial
 * message events back into whole content blocks.
 *
 * Every type lives in ./contract.ts; the fixtures under
 * test/fixtures/claudeDirect/ are the source of truth for the shapes here.
 */
import type {
  ClaudeCliArgsBuilder,
  ClaudeCliInboundMessage,
  ClaudeCliLineParser,
  ClaudeCliMessageSerializer,
  ClaudeContentBlock,
  ClaudeStreamEvent,
} from "./contract";
import { isClaudeCliStreamEventMessage } from "./contract";

/**
 * Flags the CLI always gets: prompt mode, both stream-json formats, the
 * verbose stream that carries the `init` line, partial message events, and the
 * stdio permission prompt so tool approvals arrive as control requests.
 */
const ALWAYS_ON_ARGS: readonly string[] = [
  "-p",
  "--output-format",
  "stream-json",
  "--input-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--permission-prompt-tool",
  "stdio",
];

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
}

export const buildClaudeCliArgs: ClaudeCliArgsBuilder = (config) => {
  const args: string[] = [...ALWAYS_ON_ARGS];
  args.push("--permission-mode", config.permissionMode);
  if (config.settingSources.length > 0) {
    args.push("--setting-sources", config.settingSources.join(","));
  }
  const model = nonEmpty(config.model);
  if (model) args.push("--model", model);
  if (config.effort) args.push("--effort", config.effort);
  const appendSystemPrompt = nonEmpty(config.appendSystemPrompt);
  if (appendSystemPrompt) {
    args.push("--append-system-prompt", appendSystemPrompt);
  }
  const seenDirs = new Set<string>();
  for (const dir of config.addDirs) {
    const value = nonEmpty(dir);
    if (!value || value === config.cwd || seenDirs.has(value)) continue;
    seenDirs.add(value);
    args.push("--add-dir", value);
  }
  // `--resume` continues a CLI session, so it wins over a fresh session id.
  const resumeSessionId = nonEmpty(config.resumeSessionId);
  const sessionId = nonEmpty(config.sessionId);
  if (resumeSessionId) {
    args.push(`--resume=${resumeSessionId}`);
  } else if (sessionId) {
    args.push("--session-id", sessionId);
  }
  const mcpConfigJson = nonEmpty(config.mcpConfigJson);
  if (mcpConfigJson) {
    args.push("--mcp-config", mcpConfigJson, "--strict-mcp-config");
  }
  if (config.permissionMode === "bypassPermissions") {
    args.push("--allow-dangerously-skip-permissions");
  }
  return args;
};

export const parseClaudeCliLine: ClaudeCliLineParser = (line) => {
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string" || !type) return null;
  return parsed as ClaudeCliInboundMessage;
};

export const serializeClaudeCliMessage: ClaudeCliMessageSerializer = (
  message,
) => `${JSON.stringify(message)}\n`;

const REDACTIONS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // Anthropic API keys, wherever they appear.
  { pattern: /sk-ant-[A-Za-z0-9_-]+/g, replacement: "sk-ant-[redacted]" },
  // `Bearer <token>` in a header or a log line.
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replacement: "Bearer [redacted]",
  },
  // An Authorization header or field, quoted or bare.
  {
    pattern:
      /(\bauthorization["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}"']+)/gi,
    replacement: "$1[redacted]",
  },
  // Long opaque values behind a token/key parameter.
  {
    pattern: /\b((?:api[_-]?key|access[_-]?token|token|key)=)[A-Za-z0-9_-]{40,}/gi,
    replacement: "$1[redacted]",
  },
];

/**
 * The single choke point for anything from the CLI that reaches a log: stderr
 * text, launch descriptions and unparsable lines all pass through here.
 */
export function redactForLog(text: string): string {
  if (typeof text !== "string" || !text) return "";
  let out = text;
  for (const { pattern, replacement } of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stream assembler
// ---------------------------------------------------------------------------

export type ClaudeStreamBlockKind = "text" | "thinking" | "tool_use" | "other";

export type ClaudeStreamBlock = {
  /** Index of the assistant message this block belongs to, from 0. */
  messageIndex: number;
  /** `content_block_start.index` within that message. */
  index: number;
  kind: ClaudeStreamBlockKind;
  /** The raw `content_block.type` the CLI announced. */
  blockType: string;
  text: string;
  thinking: string;
  signature: string;
  /** Concatenated `input_json_delta` chunks of a tool_use block. */
  partialJson: string;
  toolUseId?: string;
  toolName?: string;
  stopped: boolean;
};

export type ClaudeStreamAssemblerUpdate =
  | { type: "message_started"; messageIndex: number }
  | { type: "block_started"; block: ClaudeStreamBlock }
  | { type: "text_delta"; block: ClaudeStreamBlock; delta: string }
  | { type: "thinking_delta"; block: ClaudeStreamBlock; delta: string }
  | { type: "signature"; block: ClaudeStreamBlock }
  | { type: "tool_input_delta"; block: ClaudeStreamBlock; delta: string }
  | { type: "block_stopped"; block: ClaudeStreamBlock }
  | { type: "message_stopped"; messageIndex: number };

export type ClaudeStreamAssembler = {
  /** Folds one inbound line; returns null for anything that is not a stream event. */
  handle(message: ClaudeCliInboundMessage): ClaudeStreamAssemblerUpdate | null;
  /** Every block seen so far, in arrival order, across messages. */
  blocks(): readonly ClaudeStreamBlock[];
  /** Concatenated text of every text block. */
  text(): string;
  /** Concatenated thinking of every thinking block. */
  thinking(): string;
  /** The `partialJson` of every tool_use block, in arrival order. */
  toolInputs(): readonly string[];
  reset(): void;
};

function blockKindOf(blockType: string): ClaudeStreamBlockKind {
  if (blockType === "text") return "text";
  if (blockType === "thinking") return "thinking";
  if (blockType === "tool_use") return "tool_use";
  return "other";
}

export function createStreamAssembler(): ClaudeStreamAssembler {
  let blocks: ClaudeStreamBlock[] = [];
  let open = new Map<number, ClaudeStreamBlock>();
  let messageIndex = -1;

  const openBlock = (
    index: number,
    contentBlock?: ClaudeContentBlock,
  ): ClaudeStreamBlock => {
    const existing = open.get(index);
    if (existing) return existing;
    const blockType =
      typeof contentBlock?.type === "string" ? contentBlock.type : "text";
    const block: ClaudeStreamBlock = {
      messageIndex: messageIndex < 0 ? 0 : messageIndex,
      index,
      kind: blockKindOf(blockType),
      blockType,
      text: typeof (contentBlock as { text?: unknown })?.text === "string"
        ? ((contentBlock as { text: string }).text)
        : "",
      thinking:
        typeof (contentBlock as { thinking?: unknown })?.thinking === "string"
          ? ((contentBlock as { thinking: string }).thinking)
          : "",
      signature: "",
      partialJson: "",
      toolUseId:
        typeof (contentBlock as { id?: unknown })?.id === "string"
          ? ((contentBlock as { id: string }).id)
          : undefined,
      toolName:
        typeof (contentBlock as { name?: unknown })?.name === "string"
          ? ((contentBlock as { name: string }).name)
          : undefined,
      stopped: false,
    };
    open.set(index, block);
    blocks.push(block);
    return block;
  };

  const handleEvent = (
    event: ClaudeStreamEvent,
  ): ClaudeStreamAssemblerUpdate | null => {
    switch (event.type) {
      case "message_start": {
        messageIndex += 1;
        open = new Map();
        return { type: "message_started", messageIndex };
      }
      case "content_block_start": {
        const block = openBlock(event.index, event.content_block);
        return { type: "block_started", block };
      }
      case "content_block_delta": {
        const block = openBlock(event.index);
        const delta = event.delta;
        if (delta.type === "text_delta") {
          block.text += delta.text;
          return { type: "text_delta", block, delta: delta.text };
        }
        if (delta.type === "thinking_delta") {
          block.thinking += delta.thinking;
          return { type: "thinking_delta", block, delta: delta.thinking };
        }
        if (delta.type === "signature_delta") {
          block.signature += delta.signature;
          return { type: "signature", block };
        }
        if (delta.type === "input_json_delta") {
          block.partialJson += delta.partial_json;
          return {
            type: "tool_input_delta",
            block,
            delta: delta.partial_json,
          };
        }
        return null;
      }
      case "content_block_stop": {
        const block = openBlock(event.index);
        block.stopped = true;
        open.delete(event.index);
        return { type: "block_stopped", block };
      }
      case "message_stop": {
        const stopped = messageIndex < 0 ? 0 : messageIndex;
        open = new Map();
        return { type: "message_stopped", messageIndex: stopped };
      }
      default:
        return null;
    }
  };

  return {
    handle(message) {
      if (!isClaudeCliStreamEventMessage(message)) return null;
      const event = message.event as ClaudeStreamEvent | undefined;
      if (!event || typeof event.type !== "string") return null;
      return handleEvent(event);
    },
    blocks() {
      return blocks;
    },
    text() {
      return blocks
        .filter((block) => block.kind === "text")
        .map((block) => block.text)
        .join("");
    },
    thinking() {
      return blocks
        .filter((block) => block.kind === "thinking")
        .map((block) => block.thinking)
        .join("");
    },
    toolInputs() {
      return blocks
        .filter((block) => block.kind === "tool_use")
        .map((block) => block.partialJson);
    },
    reset() {
      blocks = [];
      open = new Map();
      messageIndex = -1;
    },
  };
}
