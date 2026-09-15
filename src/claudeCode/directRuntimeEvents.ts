import type { AgentEvent, AgentPendingAction } from "../agent/types";
import {
  isClaudeCliAssistantMessage,
  isClaudeCliResultMessage,
  isClaudeCliStreamEventMessage,
  isClaudeCliUserMessage,
  isClaudeToolResultBlock,
  isClaudeToolUseBlock,
  type ClaudeCliInboundMessage,
  type ClaudeDirectPermissionRequest,
  type ClaudeDirectSessionEvent,
} from "../claudeCodeDirect/contract";

export type ClaudeDirectEventPipelineParams = {
  /** Where a mapped event goes. Awaited, so the panel can apply it in order. */
  emit: (event: AgentEvent) => Promise<void>;
  now: () => number;
  getSessionId: () => string | null;
  /** Model the turn was configured with; reported with usage. */
  model?: string;
  onPermissionRequest: (requestId: string, action: AgentPendingAction) => void;
  onPermissionCancelled: (requestId: string) => void;
};

export type ClaudeDirectEventPipeline = {
  /** Subscribe this to a session; it never throws at the call site. */
  handle: (event: ClaudeDirectSessionEvent) => void;
  /** Resolves once every event handed to `handle` has been emitted. */
  drain: () => Promise<void>;
  /** Assistant text seen through `text_delta`, for a turn with no result text. */
  getStreamedText: () => string;
};

function usageNumber(usage: Record<string, unknown> | undefined, key: string) {
  const value = usage?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Lines that say something about the CLI's plumbing, not about the turn. */
function isSystemNoise(message: ClaudeCliInboundMessage): boolean {
  if (message.type === "keep_alive" || message.type === "rate_limit_event") {
    return true;
  }
  const subtype = (message as { subtype?: unknown }).subtype;
  return (
    message.type === "system" &&
    typeof subtype === "string" &&
    subtype.startsWith("hook_")
  );
}

export function buildClaudeDirectPermissionAction(
  request: ClaudeDirectPermissionRequest,
): AgentPendingAction {
  return {
    toolName: request.toolName,
    title: request.displayName || request.toolName,
    mode: "approval",
    confirmLabel: "Allow",
    cancelLabel: "Deny",
    description: request.description || request.decisionReason || undefined,
    fields: [
      {
        id: "input",
        type: "code_preview",
        label: request.title || "Tool input",
        value: JSON.stringify(request.input, null, 2),
        language: "json",
      },
    ],
  };
}

/**
 * Maps one turn's CLI stream-json lines to the agent events the panel renders.
 *
 * Text and thinking arrive as `stream_event` deltas because the session runs
 * with `--include-partial-messages`, so the assistant message's own text
 * blocks are left alone; re-emitting them would double the reply.
 */
export function createClaudeDirectEventPipeline(
  params: ClaudeDirectEventPipelineParams,
): ClaudeDirectEventPipeline {
  const { emit, now } = params;
  const toolNamesByCallId = new Map<string, string>();
  let assistantRound = 0;
  let reasoningSummary = "";
  let streamedText = "";
  let resultHandled = false;

  const handleMessage = async (
    message: ClaudeCliInboundMessage,
  ): Promise<void> => {
    if (isSystemNoise(message)) return;
    // The session reports the closing `result` line as a message and again
    // as `turn_completed`; the turn gets one usage event either way.
    if (isClaudeCliResultMessage(message)) {
      if (resultHandled) return;
      resultHandled = true;
    }
    await emit({
      type: "provider_event",
      providerType: "claude_cli",
      sessionId: params.getSessionId() || undefined,
      payload: message as Record<string, unknown>,
      ts: now(),
    });

    if (isClaudeCliStreamEventMessage(message)) {
      const event = message.event;
      if (event.type === "message_start") {
        assistantRound += 1;
        reasoningSummary = "";
        return;
      }
      if (event.type !== "content_block_delta") return;
      if (event.delta.type === "text_delta") {
        streamedText += event.delta.text;
        await emit({ type: "message_delta", text: event.delta.text });
        return;
      }
      if (event.delta.type === "thinking_delta") {
        reasoningSummary += event.delta.thinking;
        await emit({
          type: "reasoning",
          round: Math.max(assistantRound, 1),
          summary: reasoningSummary,
        });
      }
      return;
    }

    if (isClaudeCliAssistantMessage(message)) {
      for (const block of message.message.content) {
        if (!isClaudeToolUseBlock(block)) continue;
        toolNamesByCallId.set(block.id, block.name);
        await emit({
          type: "tool_call",
          callId: block.id,
          name: block.name,
          args: block.input,
        });
      }
      return;
    }

    if (isClaudeCliUserMessage(message)) {
      const content = message.message.content;
      if (typeof content === "string") return;
      for (const block of content) {
        if (!isClaudeToolResultBlock(block)) continue;
        await emit({
          type: "tool_result",
          callId: block.tool_use_id,
          name: toolNamesByCallId.get(block.tool_use_id) || "tool",
          ok: block.is_error !== true,
          content: block.content,
          actionReceipts: [],
        });
      }
      return;
    }

    if (message.type === "system") {
      const status = (message as { status?: unknown }).status;
      if (typeof status === "string" && status.trim()) {
        await emit({ type: "status", text: status.trim() });
      }
      return;
    }

    if (isClaudeCliResultMessage(message)) {
      const usage = message.usage as Record<string, unknown> | undefined;
      const inputTokens = usageNumber(usage, "input_tokens");
      const cacheCreation = usageNumber(usage, "cache_creation_input_tokens");
      const cacheRead = usageNumber(usage, "cache_read_input_tokens");
      await emit({
        type: "usage",
        inputTokens,
        outputTokens: usageNumber(usage, "output_tokens"),
        cacheCreationInputTokens: cacheCreation,
        cacheReadInputTokens: cacheRead,
        contextTokens: inputTokens + cacheCreation + cacheRead,
        sessionId: message.session_id,
        model: params.model,
      });
    }
  };

  const handleSessionEvent = async (
    event: ClaudeDirectSessionEvent,
  ): Promise<void> => {
    if (event.type === "message") {
      await handleMessage(event.message);
      return;
    }
    if (event.type === "turn_completed") {
      await handleMessage(event.result);
      return;
    }
    if (event.type === "permission_request") {
      const action = buildClaudeDirectPermissionAction(event.request);
      params.onPermissionRequest(event.request.requestId, action);
      await emit({
        type: "confirmation_required",
        requestId: event.request.requestId,
        action,
      });
      return;
    }
    if (event.type === "permission_cancelled") {
      params.onPermissionCancelled(event.requestId);
      return;
    }
    if (event.type === "stderr" && event.text.trim()) {
      await emit({ type: "status", text: event.text.trim() });
    }
  };

  // Every session event is handled in the order it arrived. Without the queue
  // two events that each await emit would interleave and the panel would see
  // a tool_result before the tool_call that produced it.
  let queue: Promise<void> = Promise.resolve();

  return {
    handle: (event) => {
      const step = () => handleSessionEvent(event);
      queue = queue.then(step, step);
    },
    drain: () => queue,
    getStreamedText: () => streamedText,
  };
}
