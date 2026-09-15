/**
 * One `claude` CLI process, driven turn by turn.
 *
 * The process stays alive for the whole conversation: stdin is never closed
 * until close(), each turn is one `user` line, and the `result` line the CLI
 * writes at the end of a turn is what runTurn() resolves with. Tool approvals
 * arrive as `can_use_tool` control requests and are answered on stdin.
 */
import {
  ClaudeDirectError,
  isClaudeCliCanUseToolRequest,
  isClaudeCliControlCancelMessage,
  isClaudeCliControlRequestMessage,
  isClaudeCliControlResponseMessage,
  isClaudeCliInitMessage,
  isClaudeCliResultMessage,
  type ClaudeCliCanUseToolRequest,
  type ClaudeCliInitMessage,
  type ClaudeCliInitializeResponse,
  type ClaudeCliOutboundControlRequest,
  type ClaudeCliPermissionResult,
  type ClaudeCliProcessExit,
  type ClaudeCliProcessHandle,
  type ClaudeCliResultMessage,
  type ClaudeContentBlock,
  type ClaudeDirectPermissionDecision,
  type ClaudeDirectErrorCode,
  type ClaudeDirectPermissionMode,
  type ClaudeDirectPermissionRequest,
  type ClaudeDirectSession,
  type ClaudeDirectSessionConfig,
  type ClaudeDirectSessionDeps,
  type ClaudeDirectSessionEvent,
  type ClaudeDirectSessionFactory,
  type ClaudeDirectSessionState,
  type ClaudeDirectStartResult,
  type ClaudeCliTerminateOptions,
  type JsonRecord,
} from "./contract";
import {
  buildClaudeCliArgs,
  parseClaudeCliLine,
  redactForLog,
  serializeClaudeCliMessage,
} from "./protocol";

const DEFAULT_START_TIMEOUT_MS = 30_000;

type PendingTurn = {
  resolve: (result: ClaudeCliResultMessage) => void;
  reject: (error: ClaudeDirectError) => void;
  release: () => void;
};

type PendingControl = {
  resolve: (response: unknown) => void;
  reject: (error: ClaudeDirectError) => void;
};

function randomRequestId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  try {
    const uuid = cryptoObj?.randomUUID?.();
    if (uuid) return uuid;
  } catch {
    /* fall through to the arithmetic id */
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function toPermissionRequest(
  requestId: string,
  request: ClaudeCliCanUseToolRequest,
): ClaudeDirectPermissionRequest {
  return {
    requestId,
    toolName: request.tool_name,
    displayName: request.display_name,
    input: (request.input || {}) as JsonRecord,
    description: request.description,
    title: request.title,
    toolUseId: request.tool_use_id,
    agentId: request.agent_id,
    blockedPath: request.blocked_path,
    decisionReason: request.decision_reason,
    suggestions: request.permission_suggestions ?? [],
  };
}

class ClaudeDirectSessionImpl implements ClaudeDirectSession {
  readonly config: Readonly<ClaudeDirectSessionConfig>;

  private readonly deps: ClaudeDirectSessionDeps;
  private readonly listeners = new Set<
    (event: ClaudeDirectSessionEvent) => void
  >();
  private readonly pendingControls = new Map<string, PendingControl>();
  private readonly pendingPermissions = new Map<
    string,
    ClaudeDirectPermissionRequest
  >();
  private readonly unsubscribes: Array<() => void> = [];

  private currentState: ClaudeDirectSessionState = "created";
  private handle: ClaudeCliProcessHandle | null = null;
  private sessionId: string | null = null;
  private pendingTurn: PendingTurn | null = null;
  private awaitInit: {
    resolve: (init: ClaudeCliInitMessage) => void;
    reject: (error: ClaudeDirectError) => void;
  } | null = null;
  private initMessage: ClaudeCliInitMessage | null = null;
  private initializeResponse: ClaudeCliInitializeResponse | null = null;
  private lastExit: ClaudeCliProcessExit | null = null;
  private closePromise: Promise<ClaudeCliProcessExit | null> | null = null;

  constructor(
    config: ClaudeDirectSessionConfig,
    deps: ClaudeDirectSessionDeps,
  ) {
    this.config = config;
    this.deps = deps;
  }

  get state(): ClaudeDirectSessionState {
    return this.currentState;
  }

  get cliSessionId(): string | null {
    return this.sessionId;
  }

  subscribe(listener: (event: ClaudeDirectSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ClaudeDirectSessionEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* one bad listener must not stop the stream */
      }
    }
  }

  private setState(state: ClaudeDirectSessionState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.emit({ type: "state", state });
  }

  private fail(error: ClaudeDirectError): void {
    this.emit({ type: "error", error });
  }

  async start(): Promise<ClaudeDirectStartResult> {
    if (this.currentState === "closed" || this.currentState === "closing") {
      throw new ClaudeDirectError("closed", "The session is closed");
    }
    if (this.currentState !== "created") {
      throw new ClaudeDirectError(
        "busy",
        `start() was already called; the session is ${this.currentState}`,
      );
    }
    this.setState("starting");
    let binary;
    try {
      binary = await this.deps.spawner.resolveBinary({
        preferredPath: this.config.preferredBinaryPath ?? null,
      });
      this.handle = await this.deps.spawner.spawn({
        binaryPath: binary.path,
        args: buildClaudeCliArgs(this.config),
        cwd: this.config.cwd,
        ...(this.config.environment
          ? { environment: this.config.environment }
          : {}),
      });
    } catch (error) {
      this.setState("failed");
      const wrapped = this.asDirectError(error, "spawn_failed");
      this.fail(wrapped);
      throw wrapped;
    }
    const handle = this.handle;
    this.unsubscribes.push(handle.onLine((line) => this.handleLine(line)));
    this.unsubscribes.push(
      handle.onStderr((text) => {
        const redacted = redactForLog(text);
        if (redacted) this.emit({ type: "stderr", text: redacted });
      }),
    );
    this.unsubscribes.push(handle.onExit((exit) => this.handleExit(exit)));

    try {
      const init = await this.waitForInit();
      this.setState("idle");
      return { init, binary, pid: handle.pid };
    } catch (error) {
      const wrapped = this.asDirectError(error, "start_timeout");
      this.setState("failed");
      this.fail(wrapped);
      await handle.terminate().catch(() => undefined);
      throw wrapped;
    }
  }

  private waitForInit(): Promise<ClaudeCliInitMessage> {
    if (this.initMessage) return Promise.resolve(this.initMessage);
    const timeoutMs = Math.max(
      0,
      this.config.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    );
    return new Promise<ClaudeCliInitMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.awaitInit = null;
        reject(
          new ClaudeDirectError(
            "start_timeout",
            `The claude CLI did not send its init line within ${timeoutMs} ms`,
            { timeoutMs },
          ),
        );
      }, timeoutMs);
      this.awaitInit = {
        resolve: (init) => {
          clearTimeout(timer);
          this.awaitInit = null;
          resolve(init);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.awaitInit = null;
          reject(error);
        },
      };
    });
  }

  private asDirectError(
    error: unknown,
    fallbackCode: ClaudeDirectErrorCode,
  ): ClaudeDirectError {
    if (error instanceof ClaudeDirectError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new ClaudeDirectError(fallbackCode, message);
  }

  private handleLine(line: string): void {
    const message = parseClaudeCliLine(line);
    if (!message) return;
    this.emit({ type: "message", message });

    if (isClaudeCliInitMessage(message)) {
      this.initMessage = message;
      this.sessionId = message.session_id;
      this.awaitInit?.resolve(message);
      return;
    }
    if (isClaudeCliResultMessage(message)) {
      this.sessionId = message.session_id || this.sessionId;
      const turn = this.pendingTurn;
      this.pendingTurn = null;
      turn?.release();
      if (this.currentState === "busy") this.setState("idle");
      this.emit({ type: "turn_completed", result: message });
      turn?.resolve(message);
      return;
    }
    if (isClaudeCliControlRequestMessage(message)) {
      if (!isClaudeCliCanUseToolRequest(message.request)) return;
      const request = toPermissionRequest(message.request_id, message.request);
      this.pendingPermissions.set(request.requestId, request);
      this.emit({ type: "permission_request", request });
      return;
    }
    if (isClaudeCliControlCancelMessage(message)) {
      this.pendingPermissions.delete(message.request_id);
      this.pendingControls.delete(message.request_id);
      this.emit({
        type: "permission_cancelled",
        requestId: message.request_id,
      });
      return;
    }
    if (isClaudeCliControlResponseMessage(message)) {
      const response = message.response;
      const pending = this.pendingControls.get(response.request_id);
      if (!pending) return;
      this.pendingControls.delete(response.request_id);
      if (response.subtype === "success") {
        pending.resolve(response.response);
      } else {
        pending.reject(
          new ClaudeDirectError(
            "control_rejected",
            `The claude CLI rejected a control request: ${response.error}`,
            { requestId: response.request_id },
          ),
        );
      }
    }
  }

  private handleExit(exit: ClaudeCliProcessExit): void {
    this.lastExit = exit;
    this.emit({ type: "process_exited", exit });
    const error = new ClaudeDirectError(
      "process_exited",
      `The claude CLI process exited (${exit.reason}${
        exit.code === null ? "" : `, code ${exit.code}`
      })`,
      { reason: exit.reason, code: exit.code },
    );
    this.awaitInit?.reject(error);
    this.rejectPendingWork(error);
    if (this.currentState !== "closing" && this.currentState !== "closed") {
      this.setState("failed");
    }
  }

  private rejectPendingWork(error: ClaudeDirectError): void {
    const turn = this.pendingTurn;
    this.pendingTurn = null;
    if (turn) {
      turn.release();
      turn.reject(error);
    }
    const controls = [...this.pendingControls.values()];
    this.pendingControls.clear();
    for (const control of controls) control.reject(error);
    const cancelled = [...this.pendingPermissions.keys()];
    this.pendingPermissions.clear();
    for (const requestId of cancelled) {
      this.emit({ type: "permission_cancelled", requestId });
    }
  }

  private requireHandle(): ClaudeCliProcessHandle {
    if (this.currentState === "closed" || this.currentState === "closing") {
      throw new ClaudeDirectError("closed", "The session is closed");
    }
    if (!this.handle) {
      throw new ClaudeDirectError("closed", "The session has not been started");
    }
    if (this.handle.exited) {
      throw new ClaudeDirectError(
        "process_exited",
        "The claude CLI process has exited",
        this.lastExit
          ? { reason: this.lastExit.reason, code: this.lastExit.code }
          : undefined,
      );
    }
    return this.handle;
  }

  private write(
    message: Parameters<typeof serializeClaudeCliMessage>[0],
  ): void {
    this.requireHandle().writeLine(serializeClaudeCliMessage(message));
  }

  private sendControlRequest(
    request: ClaudeCliOutboundControlRequest["request"],
  ): Promise<unknown> {
    const requestId = (this.deps.generateRequestId ?? randomRequestId)();
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingControls.set(requestId, { resolve, reject });
    });
    try {
      this.write({ type: "control_request", request_id: requestId, request });
    } catch (error) {
      this.pendingControls.delete(requestId);
      throw this.asDirectError(error, "process_exited");
    }
    return promise;
  }

  async initialize(): Promise<ClaudeCliInitializeResponse> {
    if (this.initializeResponse) return this.initializeResponse;
    const response = await this.sendControlRequest({ subtype: "initialize" });
    const payload =
      response && typeof response === "object"
        ? (response as ClaudeCliInitializeResponse)
        : ({} as ClaudeCliInitializeResponse);
    // The payload carries the signed-in account; it is cached, never logged.
    this.initializeResponse = payload;
    return payload;
  }

  runTurn(
    content: string | ClaudeContentBlock[],
    options?: { signal?: AbortSignal },
  ): Promise<ClaudeCliResultMessage> {
    if (this.currentState === "closing" || this.currentState === "closed") {
      return Promise.reject(
        new ClaudeDirectError("closed", "The session is closed"),
      );
    }
    if (this.pendingTurn || this.currentState === "busy") {
      return Promise.reject(
        new ClaudeDirectError("busy", "A turn is already in flight"),
      );
    }
    if (this.currentState !== "idle") {
      return Promise.reject(
        new ClaudeDirectError(
          "closed",
          `The session is ${this.currentState}; start() must succeed first`,
        ),
      );
    }
    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.reject(
        new ClaudeDirectError("interrupted", "The turn was aborted"),
      );
    }
    try {
      this.write({
        type: "user",
        message: { role: "user", content },
      });
    } catch (error) {
      return Promise.reject(this.asDirectError(error, "process_exited"));
    }
    this.setState("busy");
    return new Promise<ClaudeCliResultMessage>((resolve, reject) => {
      const onAbort = () => {
        const turn = this.pendingTurn;
        this.pendingTurn = null;
        turn?.release();
        if (this.currentState === "busy") this.setState("idle");
        void this.sendInterrupt();
        reject(new ClaudeDirectError("interrupted", "The turn was aborted"));
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      this.pendingTurn = {
        resolve,
        reject,
        release: () => {
          if (signal) signal.removeEventListener("abort", onAbort);
        },
      };
    });
  }

  private async sendInterrupt(): Promise<void> {
    try {
      await this.sendControlRequest({ subtype: "interrupt" });
    } catch (error) {
      this.fail(this.asDirectError(error, "control_rejected"));
    }
  }

  async respondToPermission(
    requestId: string,
    decision: ClaudeDirectPermissionDecision,
  ): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new ClaudeDirectError(
        "protocol",
        `No permission request is waiting for an answer (${requestId})`,
        { requestId },
      );
    }
    this.pendingPermissions.delete(requestId);
    this.write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: buildPermissionResult(pending, decision),
      },
    });
  }

  async interrupt(): Promise<void> {
    const turn = this.pendingTurn;
    await this.sendControlRequest({ subtype: "interrupt" });
    if (turn && this.pendingTurn === turn) {
      this.pendingTurn = null;
      turn.release();
      if (this.currentState === "busy") this.setState("idle");
      turn.reject(
        new ClaudeDirectError("interrupted", "The turn was interrupted"),
      );
    }
  }

  async setPermissionMode(mode: ClaudeDirectPermissionMode): Promise<void> {
    await this.sendControlRequest({ subtype: "set_permission_mode", mode });
  }

  async setModel(model: string | undefined): Promise<void> {
    await this.sendControlRequest({
      subtype: "set_model",
      ...(model === undefined ? {} : { model }),
    });
  }

  close(
    options?: ClaudeCliTerminateOptions,
  ): Promise<ClaudeCliProcessExit | null> {
    if (this.currentState === "closed") {
      return Promise.resolve(this.lastExit);
    }
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.setState("closing");
      this.denyPendingPermissions();
      this.rejectPendingWork(
        new ClaudeDirectError("closed", "The session was closed"),
      );
      const handle = this.handle;
      let exit: ClaudeCliProcessExit | null = this.lastExit;
      if (handle) {
        exit = await handle.terminate(options).catch(() => this.lastExit);
      }
      this.lastExit = exit;
      for (const unsubscribe of this.unsubscribes.splice(0)) {
        try {
          unsubscribe();
        } catch {
          /* ignore */
        }
      }
      this.setState("closed");
      this.listeners.clear();
      return exit;
    })();
    return this.closePromise;
  }

  /** The CLI is going away, so every prompt still on screen becomes a deny. */
  private denyPendingPermissions(): void {
    const pending = [...this.pendingPermissions.values()];
    this.pendingPermissions.clear();
    for (const request of pending) {
      try {
        this.handle?.writeLine(
          serializeClaudeCliMessage({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: request.requestId,
              response: {
                behavior: "deny",
                message: "The Zotero session was closed",
              },
            },
          }),
        );
      } catch {
        // The process may already be gone; close() must not throw for that.
      }
      this.emit({
        type: "permission_cancelled",
        requestId: request.requestId,
      });
    }
  }
}

function buildPermissionResult(
  request: ClaudeDirectPermissionRequest,
  decision: ClaudeDirectPermissionDecision,
): ClaudeCliPermissionResult {
  // The captured CLI exchange answers with `behavior` and `updatedInput`
  // only, so `toolUseID` stays out of the response.
  if (decision.behavior === "allow") {
    return {
      behavior: "allow",
      updatedInput: decision.updatedInput ?? request.input,
    };
  }
  return {
    behavior: "deny",
    message: decision.message ?? "The request was denied in Zotero",
    ...(decision.interrupt ? { interrupt: true } : {}),
  };
}

export const createClaudeDirectSession: ClaudeDirectSessionFactory = (
  config,
  deps,
) => new ClaudeDirectSessionImpl(config, deps);
