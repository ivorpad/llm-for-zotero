/**
 * Seam between the Claude Code direct-CLI protocol layer and the plugin.
 *
 * Workstream A implements the process spawner (`src/utils/claudeCliProcess.ts`),
 * the wire protocol (`src/claudeCodeDirect/protocol.ts`) and the session
 * (`src/claudeCodeDirect/session.ts`). Workstream B consumes only the types and
 * the exported names listed at the bottom of this file. Neither workstream
 * edits this file; changes go through the coordinator.
 *
 * Wire-format sources of truth: `test/fixtures/claudeDirect/*.jsonl`, captured
 * from Claude Code CLI 2.1.272 with `--output-format stream-json
 * --input-format stream-json`, and `@anthropic-ai/claude-agent-sdk` 0.3.220.
 */

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

export type ClaudeDirectPermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export type ClaudeDirectSettingSource = "user" | "project" | "local";

export type ClaudeDirectEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type JsonRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Anthropic message content and streaming events, as the CLI forwards them
// ---------------------------------------------------------------------------

export type ClaudeTextBlock = { type: "text"; text: string };
export type ClaudeThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature?: string;
};
export type ClaudeToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
export type ClaudeToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
};
/** Any block type this contract does not model; kept verbatim. */
export type ClaudeUnknownBlock = { type: string } & JsonRecord;

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeThinkingBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock
  | ClaudeUnknownBlock;

export function isClaudeTextBlock(
  block: ClaudeContentBlock,
): block is ClaudeTextBlock {
  return (
    block.type === "text" && typeof (block as ClaudeTextBlock).text === "string"
  );
}

export function isClaudeThinkingBlock(
  block: ClaudeContentBlock,
): block is ClaudeThinkingBlock {
  return (
    block.type === "thinking" &&
    typeof (block as ClaudeThinkingBlock).thinking === "string"
  );
}

export function isClaudeToolUseBlock(
  block: ClaudeContentBlock,
): block is ClaudeToolUseBlock {
  return (
    block.type === "tool_use" &&
    typeof (block as ClaudeToolUseBlock).id === "string" &&
    typeof (block as ClaudeToolUseBlock).name === "string"
  );
}

export function isClaudeToolResultBlock(
  block: ClaudeContentBlock,
): block is ClaudeToolResultBlock {
  return (
    block.type === "tool_result" &&
    typeof (block as ClaudeToolResultBlock).tool_use_id === "string"
  );
}

export type ClaudeStreamDelta =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }
  | { type: "input_json_delta"; partial_json: string };

export type ClaudeStreamEvent =
  | { type: "message_start"; message: JsonRecord }
  | {
      type: "content_block_start";
      index: number;
      content_block: ClaudeContentBlock;
    }
  | { type: "content_block_delta"; index: number; delta: ClaudeStreamDelta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: JsonRecord; usage?: JsonRecord }
  | { type: "message_stop" };

export type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
} & JsonRecord;

// ---------------------------------------------------------------------------
// Inbound lines: CLI stdout, one JSON object per line
// ---------------------------------------------------------------------------

export type ClaudeCliMessageEnvelope = {
  session_id?: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
};

export type ClaudeCliInitMessage = ClaudeCliMessageEnvelope & {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  model: string;
  permissionMode: string;
  tools: string[];
  mcp_servers?: Array<{ name: string; status: string }>;
  slash_commands?: string[];
  claude_code_version?: string;
  apiKeySource?: string;
} & JsonRecord;

export type ClaudeCliStatusMessage = ClaudeCliMessageEnvelope & {
  type: "system";
  subtype: "status";
  status?: string | null;
  permissionMode?: string;
};

/** `hook_started`, `hook_response`, `thinking_tokens` and future subtypes. */
export type ClaudeCliOtherSystemMessage = ClaudeCliMessageEnvelope & {
  type: "system";
  subtype: string;
} & JsonRecord;

export type ClaudeCliSystemMessage =
  | ClaudeCliInitMessage
  | ClaudeCliStatusMessage
  | ClaudeCliOtherSystemMessage;

/** Only emitted with `--include-partial-messages`. */
export type ClaudeCliStreamEventMessage = ClaudeCliMessageEnvelope & {
  type: "stream_event";
  event: ClaudeStreamEvent;
};

export type ClaudeCliAssistantMessage = ClaudeCliMessageEnvelope & {
  type: "assistant";
  message: {
    id?: string;
    model?: string;
    role: "assistant";
    content: ClaudeContentBlock[];
    stop_reason?: string | null;
    usage?: ClaudeUsage;
  };
};

/** Tool results echoed back by the CLI. */
export type ClaudeCliUserMessage = ClaudeCliMessageEnvelope & {
  type: "user";
  message: { role: "user"; content: string | ClaudeContentBlock[] };
  tool_use_result?: unknown;
};

/** One `result` line ends each turn. `subtype` is `success` or an error kind. */
export type ClaudeCliResultMessage = ClaudeCliMessageEnvelope & {
  type: "result";
  subtype: string;
  is_error: boolean;
  session_id: string;
  result?: string;
  stop_reason?: string | null;
  num_turns?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  usage?: ClaudeUsage;
  modelUsage?: JsonRecord;
  permission_denials?: unknown[];
};

export type ClaudeCliRateLimitMessage = ClaudeCliMessageEnvelope & {
  type: "rate_limit_event";
  rate_limit_info?: JsonRecord;
};

export type ClaudeCliPermissionSuggestion = {
  type: string;
  mode?: string;
  destination?: string;
} & JsonRecord;

/** Emitted with `--permission-prompt-tool stdio` when a tool needs approval. */
export type ClaudeCliCanUseToolRequest = {
  subtype: "can_use_tool";
  tool_name: string;
  display_name?: string;
  input: JsonRecord;
  description?: string;
  title?: string;
  tool_use_id?: string;
  agent_id?: string;
  blocked_path?: string;
  decision_reason?: string;
  permission_suggestions?: ClaudeCliPermissionSuggestion[];
};

export type ClaudeCliOtherControlRequest = { subtype: string } & JsonRecord;

export type ClaudeCliControlRequestMessage = {
  type: "control_request";
  request_id: string;
  request: ClaudeCliCanUseToolRequest | ClaudeCliOtherControlRequest;
};

/** The CLI's answer to a control_request we sent (initialize, interrupt, ...). */
export type ClaudeCliControlResponseMessage = {
  type: "control_response";
  response:
    | { subtype: "success"; request_id: string; response?: unknown }
    | { subtype: "error"; request_id: string; error: string };
};

export type ClaudeCliControlCancelMessage = {
  type: "control_cancel_request";
  request_id: string;
};

export type ClaudeCliKeepAliveMessage = { type: "keep_alive" };

export type ClaudeCliUnknownMessage = { type: string } & JsonRecord;

export type ClaudeCliInboundMessage =
  | ClaudeCliSystemMessage
  | ClaudeCliStreamEventMessage
  | ClaudeCliAssistantMessage
  | ClaudeCliUserMessage
  | ClaudeCliResultMessage
  | ClaudeCliRateLimitMessage
  | ClaudeCliControlRequestMessage
  | ClaudeCliControlResponseMessage
  | ClaudeCliControlCancelMessage
  | ClaudeCliKeepAliveMessage
  | ClaudeCliUnknownMessage;

export function isClaudeCliInitMessage(
  message: ClaudeCliInboundMessage,
): message is ClaudeCliInitMessage {
  return (
    message.type === "system" &&
    (message as ClaudeCliInitMessage).subtype === "init" &&
    typeof (message as ClaudeCliInitMessage).session_id === "string"
  );
}

export function isClaudeCliStreamEventMessage(
  message: ClaudeCliInboundMessage,
): message is ClaudeCliStreamEventMessage {
  return (
    message.type === "stream_event" &&
    typeof (message as ClaudeCliStreamEventMessage).event === "object" &&
    (message as ClaudeCliStreamEventMessage).event !== null
  );
}

export function isClaudeCliAssistantMessage(
  message: ClaudeCliInboundMessage,
): message is ClaudeCliAssistantMessage {
  const candidate = message as ClaudeCliAssistantMessage;
  return (
    message.type === "assistant" &&
    typeof candidate.message === "object" &&
    candidate.message !== null &&
    Array.isArray(candidate.message.content)
  );
}

export function isClaudeCliUserMessage(
  message: ClaudeCliInboundMessage,
): message is ClaudeCliUserMessage {
  const candidate = message as ClaudeCliUserMessage;
  return (
    message.type === "user" &&
    typeof candidate.message === "object" &&
    candidate.message !== null
  );
}

export function isClaudeCliResultMessage(
  message: ClaudeCliInboundMessage,
): message is ClaudeCliResultMessage {
  return (
    message.type === "result" &&
    typeof (message as ClaudeCliResultMessage).session_id === "string"
  );
}

export function isClaudeCliControlRequestMessage(
  message: ClaudeCliInboundMessage,
): message is ClaudeCliControlRequestMessage {
  const candidate = message as ClaudeCliControlRequestMessage;
  return (
    message.type === "control_request" &&
    typeof candidate.request_id === "string" &&
    typeof candidate.request === "object" &&
    candidate.request !== null
  );
}

export function isClaudeCliCanUseToolRequest(
  request: ClaudeCliControlRequestMessage["request"],
): request is ClaudeCliCanUseToolRequest {
  return (
    request.subtype === "can_use_tool" &&
    typeof (request as ClaudeCliCanUseToolRequest).tool_name === "string"
  );
}

export function isClaudeCliControlResponseMessage(
  message: ClaudeCliInboundMessage,
): message is ClaudeCliControlResponseMessage {
  const candidate = message as ClaudeCliControlResponseMessage;
  return (
    message.type === "control_response" &&
    typeof candidate.response === "object" &&
    candidate.response !== null &&
    typeof candidate.response.request_id === "string"
  );
}

export function isClaudeCliControlCancelMessage(
  message: ClaudeCliInboundMessage,
): message is ClaudeCliControlCancelMessage {
  return (
    message.type === "control_cancel_request" &&
    typeof (message as ClaudeCliControlCancelMessage).request_id === "string"
  );
}

/** Payload of the CLI's success response to our `initialize` control request. */
export type ClaudeCliModelInfo = {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
};

export type ClaudeCliCommandInfo = {
  name: string;
  description?: string;
  argumentHint?: string;
} & JsonRecord;

export type ClaudeCliInitializeResponse = {
  commands?: ClaudeCliCommandInfo[];
  models?: ClaudeCliModelInfo[];
  agents?: unknown[];
  /** Contains the signed-in account; never log or persist it. */
  account?: JsonRecord;
  current_permission_mode?: string;
  pid?: number;
} & JsonRecord;

// ---------------------------------------------------------------------------
// Outbound lines: written to CLI stdin, one JSON object per line
// ---------------------------------------------------------------------------

export type ClaudeCliOutboundUserMessage = {
  type: "user";
  message: { role: "user"; content: string | ClaudeContentBlock[] };
  parent_tool_use_id?: null;
  session_id?: string;
};

export type ClaudeCliOutboundControlRequest = {
  type: "control_request";
  request_id: string;
  request:
    | { subtype: "initialize" }
    | { subtype: "interrupt" }
    | { subtype: "set_permission_mode"; mode: ClaudeDirectPermissionMode }
    | { subtype: "set_model"; model?: string };
};

export type ClaudeCliPermissionResult =
  | {
      behavior: "allow";
      updatedInput: JsonRecord;
      updatedPermissions?: unknown[];
      toolUseID?: string;
    }
  | {
      behavior: "deny";
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

export type ClaudeCliOutboundControlResponse = {
  type: "control_response";
  response:
    | {
        subtype: "success";
        request_id: string;
        response: ClaudeCliPermissionResult;
      }
    | { subtype: "error"; request_id: string; error: string };
};

export type ClaudeCliOutboundMessage =
  | ClaudeCliOutboundUserMessage
  | ClaudeCliOutboundControlRequest
  | ClaudeCliOutboundControlResponse;

// ---------------------------------------------------------------------------
// Process layer (workstream A, src/utils/claudeCliProcess.ts)
// ---------------------------------------------------------------------------

/** Where the binary path came from, in lookup order. */
export type ClaudeCliBinarySource = "explicit" | "env" | "shell_lookup";

export type ClaudeCliBinaryResolution = {
  path: string;
  source: ClaudeCliBinarySource;
};

export type ClaudeCliDiscoveryInput = {
  /** The `claudeCodeCliPath` pref value, or a caller-supplied path. */
  preferredPath?: string | null;
};

export type ClaudeCliSpawnRequest = {
  binaryPath: string;
  args: string[];
  cwd: string;
  /** Appended to the inherited environment. Never logged. */
  environment?: Record<string, string>;
};

export type ClaudeCliProcessExit = {
  code: number | null;
  signal?: string | null;
  reason: "natural" | "terminated" | "killed" | "spawn_failed";
};

export type ClaudeCliTerminateOptions = {
  /** Wait this long for a natural exit before killing. */
  graceMs?: number;
  /** Force-kill this long after the first kill if the process is still alive. */
  forceAfterMs?: number;
};

/** The schedule the Agent SDK uses when it closes a CLI process. */
export const CLAUDE_CLI_TERMINATE_DEFAULTS: Readonly<
  Required<ClaudeCliTerminateOptions>
> = { graceMs: 2_000, forceAfterMs: 5_000 };

export interface ClaudeCliProcessHandle {
  readonly pid: number | null;
  /** Command line with secrets redacted; safe for logs. */
  readonly launchDescription: string;
  readonly exited: boolean;
  writeLine(line: string): void;
  endInput(): void;
  onLine(handler: (line: string) => void): () => void;
  onStderr(handler: (text: string) => void): () => void;
  onExit(handler: (exit: ClaudeCliProcessExit) => void): () => void;
  /** Resolves once the process has exited. Idempotent. */
  terminate(options?: ClaudeCliTerminateOptions): Promise<ClaudeCliProcessExit>;
}

export interface ClaudeCliProcessSpawner {
  /**
   * Lookup order: `preferredPath`, then the `CLAUDE_PATH` environment
   * variable, then `which claude` (`where claude` on Windows) through the
   * login shell, because Zotero's own PATH is `/usr/bin:/bin:/usr/sbin:/sbin`.
   */
  resolveBinary(
    input?: ClaudeCliDiscoveryInput,
  ): Promise<ClaudeCliBinaryResolution>;
  spawn(request: ClaudeCliSpawnRequest): Promise<ClaudeCliProcessHandle>;
  /** Handles that have not exited yet. */
  liveProcesses(): readonly ClaudeCliProcessHandle[];
  /** Terminate every live process; the Zotero quit path calls this. */
  terminateAll(options?: ClaudeCliTerminateOptions): Promise<void>;
}

// ---------------------------------------------------------------------------
// Session layer (workstream A, src/claudeCodeDirect/session.ts)
// ---------------------------------------------------------------------------

export type ClaudeDirectSessionConfig = {
  /** Working directory: the profile runtime root that holds CLAUDE.md and .claude/. */
  cwd: string;
  /** Extra directories the CLI may read (`--add-dir`). */
  addDirs: readonly string[];
  permissionMode: ClaudeDirectPermissionMode;
  settingSources: readonly ClaudeDirectSettingSource[];
  model?: string;
  effort?: ClaudeDirectEffort;
  appendSystemPrompt?: string;
  /** UUID for a brand-new CLI session (`--session-id`). Ignored when `resumeSessionId` is set. */
  sessionId?: string;
  /** Existing CLI session to continue (`--resume`). */
  resumeSessionId?: string;
  /** JSON for `--mcp-config`; adds `--strict-mcp-config`. Phase 2. */
  mcpConfigJson?: string;
  preferredBinaryPath?: string | null;
  environment?: Record<string, string>;
  /** How long `start()` waits for the `init` line. */
  startTimeoutMs?: number;
};

export type ClaudeDirectPermissionRequest = {
  requestId: string;
  toolName: string;
  displayName?: string;
  input: JsonRecord;
  description?: string;
  title?: string;
  toolUseId?: string;
  agentId?: string;
  blockedPath?: string;
  decisionReason?: string;
  suggestions: readonly ClaudeCliPermissionSuggestion[];
};

export type ClaudeDirectPermissionDecision =
  | { behavior: "allow"; updatedInput?: JsonRecord }
  | { behavior: "deny"; message?: string; interrupt?: boolean };

export type ClaudeDirectSessionState =
  | "created"
  | "starting"
  | "idle"
  | "busy"
  | "closing"
  | "closed"
  | "failed";

/**
 * Delivery rules: the session emits one `message` event for every parsed
 * stdout line, in wire order, including the closing `result` line, and only
 * then emits the derived event for it (`turn_completed`, `permission_request`,
 * ...). Listeners are invoked synchronously from the line reader, so a listener
 * that awaits must queue its own work to keep order.
 */
export type ClaudeDirectSessionEvent =
  | { type: "state"; state: ClaudeDirectSessionState }
  | { type: "message"; message: ClaudeCliInboundMessage }
  | { type: "permission_request"; request: ClaudeDirectPermissionRequest }
  | { type: "permission_cancelled"; requestId: string }
  | { type: "turn_completed"; result: ClaudeCliResultMessage }
  /** Stderr text with secrets redacted. */
  | { type: "stderr"; text: string }
  | { type: "process_exited"; exit: ClaudeCliProcessExit }
  | { type: "error"; error: ClaudeDirectError };

export type ClaudeDirectStartResult = {
  init: ClaudeCliInitMessage;
  binary: ClaudeCliBinaryResolution;
  pid: number | null;
};

export interface ClaudeDirectSession {
  readonly config: Readonly<ClaudeDirectSessionConfig>;
  readonly state: ClaudeDirectSessionState;
  /** Session id reported by the CLI's init line; null before start. */
  readonly cliSessionId: string | null;
  /** Resolve the binary, spawn, and wait for the `init` line. */
  start(): Promise<ClaudeDirectStartResult>;
  /** Send `initialize` and return its payload (models, commands, ...). */
  initialize(): Promise<ClaudeCliInitializeResponse>;
  /**
   * Send one user turn and resolve with the `result` line that ends it.
   * Rejects with a ClaudeDirectError when the session is busy, closed,
   * interrupted, or the process exits first.
   */
  runTurn(
    content: string | ClaudeContentBlock[],
    options?: { signal?: AbortSignal },
  ): Promise<ClaudeCliResultMessage>;
  respondToPermission(
    requestId: string,
    decision: ClaudeDirectPermissionDecision,
  ): Promise<void>;
  interrupt(): Promise<void>;
  setPermissionMode(mode: ClaudeDirectPermissionMode): Promise<void>;
  setModel(model: string | undefined): Promise<void>;
  /** Synchronous, wire-ordered delivery; see ClaudeDirectSessionEvent. */
  subscribe(listener: (event: ClaudeDirectSessionEvent) => void): () => void;
  /** Terminate the process with the SDK schedule and drop listeners. Idempotent. */
  close(
    options?: ClaudeCliTerminateOptions,
  ): Promise<ClaudeCliProcessExit | null>;
}

export type ClaudeDirectSessionDeps = {
  spawner: ClaudeCliProcessSpawner;
  now?: () => number;
  /** Ids for outbound control requests; defaults to a random id. */
  generateRequestId?: () => string;
};

export type ClaudeDirectSessionFactory = (
  config: ClaudeDirectSessionConfig,
  deps: ClaudeDirectSessionDeps,
) => ClaudeDirectSession;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ClaudeDirectErrorCode =
  | "binary_not_found"
  | "spawn_failed"
  | "start_timeout"
  | "protocol"
  | "process_exited"
  | "busy"
  | "closed"
  | "interrupted"
  | "control_rejected";

export class ClaudeDirectError extends Error {
  readonly code: ClaudeDirectErrorCode;
  readonly details?: JsonRecord;

  constructor(
    code: ClaudeDirectErrorCode,
    message: string,
    details?: JsonRecord,
  ) {
    super(message);
    this.name = "ClaudeDirectError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Protocol functions (workstream A, src/claudeCodeDirect/protocol.ts)
// ---------------------------------------------------------------------------

/** Builds the full argv after the binary: `-p --output-format stream-json ...`. */
export type ClaudeCliArgsBuilder = (
  config: ClaudeDirectSessionConfig,
) => string[];
/** Returns null for blank lines and non-JSON noise. */
export type ClaudeCliLineParser = (
  line: string,
) => ClaudeCliInboundMessage | null;
/** One JSON object with a trailing newline. */
export type ClaudeCliMessageSerializer = (
  message: ClaudeCliOutboundMessage,
) => string;

// ---------------------------------------------------------------------------
// Module contract: names A exports and B imports
// ---------------------------------------------------------------------------

/**
 * `src/utils/claudeCliProcess.ts`
 *   `createClaudeCliProcessSpawner(): ClaudeCliProcessSpawner`
 *   `terminateAllClaudeCliProcesses(): Promise<void>` (Zotero quit hook)
 *
 * `src/claudeCodeDirect/protocol.ts`
 *   `buildClaudeCliArgs: ClaudeCliArgsBuilder`
 *   `parseClaudeCliLine: ClaudeCliLineParser`
 *   `serializeClaudeCliMessage: ClaudeCliMessageSerializer`
 *   `redactForLog(text: string): string`
 *
 * `src/claudeCodeDirect/session.ts`
 *   `createClaudeDirectSession: ClaudeDirectSessionFactory`
 */
export const CLAUDE_DIRECT_CONTRACT_VERSION = 1 as const;
