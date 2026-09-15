import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import {
  createClaudeDirectRuntime,
  toClaudeDirectPermissionMode,
} from "../src/claudeCode/directRuntime";
import {
  getClaudeBridgeRuntime,
  resetClaudeBridgeRuntime,
} from "../src/claudeCode/runtime";
import type {
  AgentConfirmationResolution,
  AgentEvent,
} from "../src/agent/types";
import type {
  ClaudeCliInitializeResponse,
  ClaudeCliProcessSpawner,
  ClaudeCliResultMessage,
  ClaudeContentBlock,
  ClaudeDirectPermissionDecision,
  ClaudeDirectSession,
  ClaudeDirectSessionConfig,
  ClaudeDirectSessionEvent,
  ClaudeDirectStartResult,
} from "../src/claudeCodeDirect/contract";

type FakeSessionScript = {
  events?: ClaudeDirectSessionEvent[];
  result?: ClaudeCliResultMessage;
  initializeResponse?: ClaudeCliInitializeResponse;
  initializeError?: string;
};

const RESULT_LINE: ClaudeCliResultMessage = {
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "cli-session-1",
  result: "Done.",
  usage: {
    input_tokens: 11,
    output_tokens: 7,
    cache_creation_input_tokens: 3,
    cache_read_input_tokens: 5,
  },
};

/** A stand-in for workstream A's session: it replays a script and records. */
class FakeSession implements ClaudeDirectSession {
  readonly config: ClaudeDirectSessionConfig;
  state: ClaudeDirectSession["state"] = "created";
  cliSessionId: string | null = null;
  startCount = 0;
  closeCount = 0;
  initializeCount = 0;
  initializeForceCount = 0;
  turns: Array<string | ClaudeContentBlock[]> = [];
  permissionDecisions: Array<{
    requestId: string;
    decision: ClaudeDirectPermissionDecision;
  }> = [];
  modelChanges: Array<string | undefined> = [];
  permissionModeChanges: ClaudeDirectSessionConfig["permissionMode"][] = [];
  private readonly listeners = new Set<
    (event: ClaudeDirectSessionEvent) => void
  >();

  constructor(
    config: ClaudeDirectSessionConfig,
    private readonly script: FakeSessionScript,
  ) {
    this.config = config;
  }

  async start(): Promise<ClaudeDirectStartResult> {
    this.startCount += 1;
    // start() is the initialize handshake, so a handshake that fails fails
    // the start, exactly as a missing binary or a stale login does.
    if (this.script.initializeError) {
      this.state = "failed";
      throw new Error(this.script.initializeError);
    }
    this.state = "idle";
    this.cliSessionId =
      this.config.resumeSessionId || this.config.sessionId || "cli-session-1";
    return {
      initialize: this.script.initializeResponse || {},
      binary: { path: "/usr/local/bin/claude", source: "explicit" },
      pid: 4242,
    };
  }

  async initialize(options?: {
    force?: boolean;
  }): Promise<ClaudeCliInitializeResponse> {
    this.initializeCount += 1;
    this.initializeForceCount += options?.force ? 1 : 0;
    if (this.script.initializeError) {
      throw new Error(this.script.initializeError);
    }
    return this.script.initializeResponse || {};
  }

  async runTurn(
    content: string | ClaudeContentBlock[],
  ): Promise<ClaudeCliResultMessage> {
    this.turns.push(content);
    for (const event of this.script.events || []) {
      this.emit(event);
    }
    return this.script.result || RESULT_LINE;
  }

  async respondToPermission(
    requestId: string,
    decision: ClaudeDirectPermissionDecision,
  ): Promise<void> {
    this.permissionDecisions.push({ requestId, decision });
  }

  async interrupt(): Promise<void> {
    return;
  }

  async setPermissionMode(
    mode: ClaudeDirectSessionConfig["permissionMode"],
  ): Promise<void> {
    this.permissionModeChanges.push(mode);
  }

  async setModel(model: string | undefined): Promise<void> {
    this.modelChanges.push(model);
  }

  subscribe(listener: (event: ClaudeDirectSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close() {
    this.closeCount += 1;
    this.state = "closed";
    return { code: 0, reason: "terminated" as const };
  }

  emit(event: ClaudeDirectSessionEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function createFakeSpawner(): ClaudeCliProcessSpawner {
  return {
    resolveBinary: async () => ({
      path: "/usr/local/bin/claude",
      source: "explicit",
    }),
    spawn: async () => {
      throw new Error("the fake session never spawns a process");
    },
    liveProcesses: () => [],
    terminateAll: async () => undefined,
  };
}

type FakeCore = {
  core: any;
  pending: Map<string, (resolution: AgentConfirmationResolution) => void>;
  resolvedConfirmations: Array<{ requestId: string; approved: boolean }>;
};

function createFakeCore(): FakeCore {
  const pending = new Map<
    string,
    (resolution: AgentConfirmationResolution) => void
  >();
  const resolvedConfirmations: Array<{ requestId: string; approved: boolean }> =
    [];
  return {
    pending,
    resolvedConfirmations,
    core: {
      listTools: () => [],
      getToolDefinition: () => null,
      unregisterTool: () => undefined,
      registerTool: () => undefined,
      prepareExecutionRequest: async (request: any) => request,
      registerPendingConfirmation: (
        requestId: string,
        resolve: (resolution: AgentConfirmationResolution) => void,
      ) => {
        pending.set(requestId, resolve);
      },
      resolveConfirmation: (requestId: string, approved: boolean) => {
        resolvedConfirmations.push({ requestId, approved });
        return true;
      },
      getRunTrace: () => [],
      getCapabilities: () => ({}),
    },
  };
}

function buildRequest(conversationKey = 42) {
  return {
    conversationKey,
    userText: "Summarize this paper",
    model: "sonnet",
    turnPaperScope: { papers: [] },
    zoteroMetadataContext: {},
  } as any;
}

function createRuntime(
  script: FakeSessionScript,
  options: { closeDelayMs?: number } = {},
) {
  const fakeCore = createFakeCore();
  const sessions: FakeSession[] = [];
  const runtime = createClaudeDirectRuntime({
    coreRuntime: fakeCore.core,
    spawner: createFakeSpawner(),
    sessionFactory: (config) => {
      const session = new FakeSession(config, script);
      sessions.push(session);
      return session;
    },
    prefs: {
      getPermissionMode: () => "default",
      getSettingSources: () => ["user", "project", "local"],
      getCliPath: () => "",
      getRuntimeRootDir: () => "/data/agent-runtime/profile-abc",
      getDataDir: () => "/data",
    },
    closeDelayMs: options.closeDelayMs ?? 0,
    generateSessionId: () => "11111111-2222-3333-4444-555555555555",
  });
  return { runtime, sessions, fakeCore };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The managed system prompt reads Zotero prefs, so a turn needs a prefs
 * object even when every pref the runtime itself uses is injected.
 */
const prefStore = new Map<string, unknown>();

function installZoteroPrefs(values: Record<string, unknown> = {}): void {
  prefStore.clear();
  for (const [key, value] of Object.entries(values)) {
    prefStore.set(`extensions.zotero.llmforzotero.${key}`, value);
  }
  (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
    Prefs: {
      get: (key: string) => prefStore.get(key) ?? "",
      set: (key: string, value: unknown) => {
        prefStore.set(key, value);
      },
    },
  } as typeof Zotero;
}

describe("Claude Code direct CLI runtime", function () {
  const originalZotero = globalThis.Zotero;

  beforeEach(function () {
    installZoteroPrefs();
  });

  afterEach(function () {
    resetClaudeBridgeRuntime();
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("maps one turn's session events to agent events in order", async function () {
    const { runtime, sessions } = createRuntime({
      events: [
        {
          type: "message",
          message: {
            type: "stream_event",
            event: { type: "message_start", message: {} },
          },
        },
        {
          type: "message",
          message: {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "Looking" },
            },
          },
        },
        {
          type: "message",
          message: {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 1,
              delta: { type: "text_delta", text: "Ready." },
            },
          },
        },
        {
          type: "message",
          message: { type: "system", subtype: "hook_started", hook: "Stop" },
        },
        { type: "message", message: { type: "keep_alive" } },
        {
          type: "message",
          message: {
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "toolu_1",
                  name: "Read",
                  input: { file_path: "/data/paper.pdf" },
                },
              ],
            },
          },
        },
        {
          type: "message",
          message: {
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_1",
                  content: "page 1",
                },
              ],
            },
          },
        },
        { type: "turn_completed", result: RESULT_LINE },
      ],
    });

    const events: AgentEvent[] = [];
    const startedRunIds: string[] = [];
    const outcome = await runtime.runTurn({
      request: buildRequest(),
      onStart: (runId) => {
        startedRunIds.push(runId);
      },
      onEvent: async (event) => {
        events.push(event);
      },
    });

    assert.lengthOf(startedRunIds, 1);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "provider_event",
        "provider_event",
        "reasoning",
        "provider_event",
        "message_delta",
        "provider_event",
        "tool_call",
        "provider_event",
        "tool_result",
        "provider_event",
        "usage",
      ],
    );

    const toolCall = events.find((event) => event.type === "tool_call");
    assert.deepEqual(toolCall, {
      type: "tool_call",
      callId: "toolu_1",
      name: "Read",
      args: { file_path: "/data/paper.pdf" },
    });
    const toolResult = events.find((event) => event.type === "tool_result");
    assert.deepEqual(toolResult, {
      type: "tool_result",
      callId: "toolu_1",
      name: "Read",
      ok: true,
      content: "page 1",
      actionReceipts: [],
    });
    const usage = events.find((event) => event.type === "usage");
    assert.deepInclude(usage, {
      inputTokens: 11,
      outputTokens: 7,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 5,
      contextTokens: 19,
      sessionId: "cli-session-1",
    });
    assert.deepEqual(outcome, {
      kind: "completed",
      runId: startedRunIds[0],
      text: "Done.",
      usedFallback: false,
    });

    assert.lengthOf(sessions, 1);
    assert.deepEqual(sessions[0].turns, ["Summarize this paper"]);
    assert.equal(sessions[0].config.cwd, "/data/agent-runtime/profile-abc");
    assert.deepEqual(sessions[0].config.addDirs, ["/data"]);
    assert.equal(sessions[0].config.permissionMode, "default");
    assert.deepEqual(sessions[0].config.settingSources, [
      "user",
      "project",
      "local",
    ]);
    assert.include(
      sessions[0].config.appendSystemPrompt || "",
      "Claude Code receives Zotero access",
    );
  });

  it("reports a failed result line as a fallback outcome", async function () {
    const { runtime } = createRuntime({
      result: {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "cli-session-1",
        result: "The CLI ran out of context",
      },
    });

    const outcome = await runtime.runTurn({ request: buildRequest() });

    assert.deepEqual(outcome.kind, "fallback");
    assert.equal(
      outcome.kind === "fallback" ? outcome.reason : "",
      "The CLI ran out of context",
    );
  });

  it("turns a permission request into a confirmation the panel can answer", async function () {
    const { runtime, sessions, fakeCore } = createRuntime({
      events: [
        {
          type: "permission_request",
          request: {
            requestId: "perm-1",
            toolName: "Write",
            displayName: "Write file",
            title: "Write paper-notes.md",
            input: { file_path: "/data/notes.md", content: "ok" },
            description: "Claude wants to write a file",
            suggestions: [],
          },
        },
      ],
    });

    const events: AgentEvent[] = [];
    await runtime.runTurn({
      request: buildRequest(),
      onEvent: async (event) => {
        events.push(event);
      },
    });

    const confirmation = events.find(
      (event) => event.type === "confirmation_required",
    );
    assert.isDefined(confirmation);
    assert.deepEqual(
      confirmation?.type === "confirmation_required"
        ? confirmation.action
        : null,
      {
        toolName: "Write",
        title: "Write file",
        mode: "approval",
        confirmLabel: "Allow",
        cancelLabel: "Deny",
        description: "Claude wants to write a file",
        fields: [
          {
            id: "input",
            type: "code_preview",
            label: "Write paper-notes.md",
            value: JSON.stringify(
              { file_path: "/data/notes.md", content: "ok" },
              null,
              2,
            ),
            language: "json",
          },
        ],
      },
    );

    const resolve = fakeCore.pending.get("perm-1");
    assert.isFunction(resolve);
    resolve?.({ approved: true });
    await flush();

    assert.deepEqual(sessions[0].permissionDecisions, [
      { requestId: "perm-1", decision: { behavior: "allow" } },
    ]);
    assert.deepEqual(
      events
        .filter((event) => event.type === "confirmation_resolved")
        .map((event) =>
          event.type === "confirmation_resolved" ? event.approved : null,
        ),
      [true],
    );
  });

  it("denies with a message and cancels through the core runtime", async function () {
    const { runtime, sessions, fakeCore } = createRuntime({
      events: [
        {
          type: "permission_request",
          request: {
            requestId: "perm-2",
            toolName: "Bash",
            input: { command: "rm -rf /" },
            suggestions: [],
          },
        },
        { type: "permission_cancelled", requestId: "perm-2" },
      ],
    });

    await runtime.runTurn({ request: buildRequest() });
    fakeCore.pending.get("perm-2")?.({ approved: false });
    await flush();

    assert.deepEqual(sessions[0].permissionDecisions, [
      {
        requestId: "perm-2",
        decision: { behavior: "deny", message: "Denied in Zotero" },
      },
    ]);
    assert.deepEqual(fakeCore.resolvedConfirmations, [
      { requestId: "perm-2", approved: false },
    ]);
  });

  it("builds the model catalog from the CLI's initialize response", async function () {
    const { runtime, sessions } = createRuntime({
      initializeResponse: {
        models: [
          {
            value: "opus",
            resolvedModel: "claude-opus-5",
            displayName: "Opus 5",
            description: "Largest",
            supportsEffort: true,
            supportedEffortLevels: ["low", "high", "max"],
          },
          {
            value: "haiku",
            displayName: "Haiku 4.5",
          },
        ],
        commands: [
          {
            name: "zotero-notes",
            description: "Write notes",
            argumentHint: "[item]",
          },
        ],
      },
    });

    const probed = await runtime.listModels(true);

    assert.isFalse(probed.legacy);
    assert.deepEqual(
      probed.models.map((model) => model.value),
      ["opus", "haiku"],
    );
    assert.deepEqual(await runtime.listEfforts("opus"), ["low", "high", "max"]);
    assert.deepEqual(await runtime.listEfforts("haiku"), []);

    // A live conversation answers from the handshake start() already paid
    // for; only a forced refresh sends a second initialize.
    await runtime.runTurn({ request: buildRequest() });
    const live = sessions[sessions.length - 1];
    const cached = await runtime.listModels(true);
    assert.deepEqual(
      cached.models.map((model) => model.value),
      ["opus", "haiku"],
    );
    assert.equal(live.initializeCount, 1);
    assert.equal(live.initializeForceCount, 1);
    assert.equal(live.startCount, 1);
  });

  it("falls back to the four aliases when initialize fails", async function () {
    const { runtime } = createRuntime({
      initializeError: "claude: command not found",
    });

    const catalog = await runtime.listModels(true);

    assert.isFalse(catalog.legacy);
    assert.deepEqual(
      catalog.models.map((model) => model.value),
      ["default", "opus", "sonnet", "haiku"],
    );
    assert.deepEqual(
      catalog.models.find((model) => model.value === "sonnet")
        ?.supportedEffortLevels,
      ["low", "medium", "high", "xhigh", "max"],
    );
    assert.deepEqual(
      catalog.models.find((model) => model.value === "haiku")
        ?.supportedEffortLevels,
      [],
    );
  });

  it("lists the CLI's slash commands once a session exists", async function () {
    const { runtime } = createRuntime({
      initializeResponse: {
        commands: [
          {
            name: "zotero-notes",
            description: "Write notes",
            argumentHint: "[item]",
          },
        ],
      },
    });

    assert.deepEqual(runtime.listSlashCommandsSync(), []);
    await runtime.runTurn({ request: buildRequest() });
    await runtime.refreshSlashCommands(true);

    assert.deepEqual(runtime.listSlashCommandsSync(), [
      {
        name: "zotero-notes",
        description: "Write notes",
        argumentHint: "[item]",
        source: "sdk",
      },
    ]);
  });

  it("closes the session when the last mount releases the conversation", async function () {
    const { runtime, sessions } = createRuntime({}, { closeDelayMs: 0 });

    await runtime.runTurn({ request: buildRequest(7) });
    await runtime.updateRuntimeRetention({
      conversationKey: 7,
      mountId: "mount-a",
      retain: true,
    });
    await flush();
    assert.equal(sessions[0].closeCount, 0);

    await runtime.updateRuntimeRetention({
      conversationKey: 7,
      mountId: "mount-a",
      retain: false,
    });
    await flush();

    assert.equal(sessions[0].closeCount, 1);
  });

  it("reuses one session per conversation and closes every session on dispose", async function () {
    const { runtime, sessions } = createRuntime({});

    await runtime.runTurn({ request: buildRequest(1) });
    await runtime.runTurn({ request: buildRequest(1) });
    await runtime.runTurn({ request: buildRequest(2) });
    assert.lengthOf(sessions, 2);

    await runtime.dispose();

    assert.deepEqual(
      sessions.map((session) => session.closeCount),
      [1, 1],
    );
  });

  it("closes only the invalidated conversation's session", async function () {
    const { runtime, sessions } = createRuntime({});

    await runtime.runTurn({ request: buildRequest(1) });
    await runtime.runTurn({ request: buildRequest(2) });
    const invalidation = await runtime.invalidateSession({
      conversationKey: 1,
    });

    assert.isTrue(invalidation?.invalidated);
    assert.equal(sessions[0].closeCount, 1);
    assert.equal(sessions[1].closeCount, 0);
  });

  it("refuses Zotero actions until the MCP seam lands", async function () {
    const { runtime } = createRuntime({});

    assert.deepEqual(runtime.listExternalActionsSync(), []);
    try {
      await runtime.runExternalAction("cc_tool::library_search", {});
      assert.fail("runExternalAction should reject in direct mode");
    } catch (error) {
      assert.include(
        (error as Error).message,
        "Zotero actions are not available in Direct CLI mode yet",
      );
    }
  });

  it("maps the host-only permission modes to the CLI's four", function () {
    assert.equal(toClaudeDirectPermissionMode("auto"), "default");
    assert.equal(toClaudeDirectPermissionMode("dontAsk"), "default");
    assert.equal(toClaudeDirectPermissionMode("default"), "default");
    assert.equal(toClaudeDirectPermissionMode("acceptEdits"), "acceptEdits");
    assert.equal(toClaudeDirectPermissionMode("plan"), "plan");
    assert.equal(
      toClaudeDirectPermissionMode("bypassPermissions"),
      "bypassPermissions",
    );
  });
});

describe("Claude runtime selection by preference", function () {
  const originalZotero = globalThis.Zotero;

  function installPrefs(runtime: string): void {
    installZoteroPrefs({ claudeCodeRuntime: runtime });
  }

  afterEach(function () {
    resetClaudeBridgeRuntime();
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("keeps the bridge runtime while the pref says bridge", function () {
    installPrefs("bridge");
    const coreRuntime = {} as any;

    const first = getClaudeBridgeRuntime(coreRuntime);
    const second = getClaudeBridgeRuntime(coreRuntime);

    assert.strictEqual(first, second);
    assert.isFunction(first.invalidateAllHotRuntimes);
  });

  it("hands out the direct runtime when the pref says direct", async function () {
    installPrefs("direct");
    const coreRuntime = {} as any;

    const direct = getClaudeBridgeRuntime(coreRuntime);
    installPrefs("bridge");
    const bridge = getClaudeBridgeRuntime(coreRuntime);

    assert.notStrictEqual(direct, bridge);
    assert.deepEqual(direct.listExternalActionsSync(), []);
    try {
      await direct.runExternalAction("cc_tool::library_search", {});
      assert.fail("the direct runtime should refuse Zotero actions");
    } catch (error) {
      assert.include((error as Error).message, "Direct CLI mode");
    }
  });
});
