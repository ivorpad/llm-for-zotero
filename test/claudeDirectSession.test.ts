import { assert } from "chai";
import { createClaudeDirectSession } from "../src/claudeCodeDirect/session";
import { ClaudeDirectError } from "../src/claudeCodeDirect/contract";
import type {
  ClaudeDirectSessionConfig,
  ClaudeDirectSessionEvent,
  ClaudeDirectPermissionRequest,
} from "../src/claudeCodeDirect/contract";
import {
  createFakeClaudeSpawner,
  partitionFixtureAtInit,
  readClaudeDirectFixtureLines,
  type FakeClaudeHandle,
} from "./helpers/claudeDirectFakeProcess";

/**
 * The session is driven by the same captures the protocol test parses: the
 * fake process replays the CLI's stdout lines and records what the session
 * wrote, so "the session speaks the CLI's protocol" is checked against bytes
 * the real CLI produced rather than against a hand-written double.
 */
const partialLines = readClaudeDirectFixtureLines(
  "one-word-haiku-partial.stream.jsonl",
);
const partialTurn = partitionFixtureAtInit(partialLines);
const permissionStdout = readClaudeDirectFixtureLines(
  "permission-write-haiku.stdout.jsonl",
);
const permissionStdin = readClaudeDirectFixtureLines(
  "permission-write-haiku.stdin.jsonl",
);
/** The CLI's captured answer to an `initialize` control request. */
const initializeResponseLine = permissionStdout.find(
  (line) => JSON.parse(line).type === "control_response",
)!;

const baseConfig: ClaudeDirectSessionConfig = {
  cwd: "/tmp/claude-direct-fixture",
  addDirs: [],
  permissionMode: "default",
  settingSources: ["user", "project"],
  model: "haiku",
  sessionId: "11111111-2222-3333-4444-555555555555",
  startTimeoutMs: 2_000,
};

/** A `result` line of the shape the CLI writes at the end of a turn. */
function resultLine(text: string): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "2b729401-243a-427a-9749-74ee716d3591",
    result: text,
  });
}

function parseLine(line: string): Record<string, any> {
  return JSON.parse(line) as Record<string, any>;
}

function canonical(line: string): string {
  return JSON.stringify(parseLine(line));
}

/**
 * Answers an `initialize` control request with the captured response,
 * re-addressed to the request id the session generated. This is the whole
 * handshake: the CLI's `init` line does not arrive until the first turn.
 */
function answerInitialize(line: string, handle: FakeClaudeHandle): boolean {
  const parsed = parseLine(line);
  if (
    parsed.type !== "control_request" ||
    parsed.request?.subtype !== "initialize"
  ) {
    return false;
  }
  const reply = parseLine(initializeResponseLine);
  reply.response.request_id = parsed.request_id;
  replyLater(handle, [JSON.stringify(reply)]);
  return true;
}

/** Emits after the caller's write has returned, the way a real process would. */
function replyLater(handle: FakeClaudeHandle, lines: readonly string[]): void {
  setTimeout(() => handle.emitLines(lines), 0);
}

function collectEvents(): {
  events: ClaudeDirectSessionEvent[];
  subscribe: (event: ClaudeDirectSessionEvent) => void;
} {
  const events: ClaudeDirectSessionEvent[] = [];
  return { events, subscribe: (event) => events.push(event) };
}

async function expectDirectError(
  task: Promise<unknown>,
  code: string,
): Promise<ClaudeDirectError> {
  try {
    await task;
  } catch (error) {
    assert.instanceOf(error, ClaudeDirectError);
    assert.equal((error as ClaudeDirectError).code, code);
    return error as ClaudeDirectError;
  }
  throw new Error(`expected the promise to reject with ${code}`);
}

describe("claude direct session", function () {
  it("starts on the initialize response and completes a turn on the result line", async function () {
    const spawner = createFakeClaudeSpawner({
      binary: { path: "/opt/homebrew/bin/claude", source: "shell_lookup" },
      onWrite: (line, handle) => {
        if (answerInitialize(line, handle)) return;
        // The hook and init lines come with the turn, not with the spawn.
        if (parseLine(line).type === "user") {
          replyLater(handle, [...partialTurn.handshake, ...partialTurn.turn]);
        }
      },
    });
    const { events, subscribe } = collectEvents();
    const session = createClaudeDirectSession(baseConfig, { spawner });
    session.subscribe(subscribe);

    const started = await session.start();
    assert.equal(started.initialize.models?.[0].value, "default");
    assert.isTrue((started.initialize.commands?.length ?? 0) > 0);
    assert.equal(started.binary.source, "shell_lookup");
    assert.isNumber(started.pid);
    assert.equal(session.state, "idle");
    // Until the CLI reports one, the id is the one we asked it to use.
    assert.equal(session.cliSessionId, baseConfig.sessionId);
    assert.deepEqual(spawner.spawnRequests[0].cwd, baseConfig.cwd);
    assert.include(spawner.spawnRequests[0].args, "--include-partial-messages");

    const result = await session.runTurn("Reply with one word.");
    assert.equal(result.type, "result");
    assert.equal(result.subtype, "success");
    assert.equal(result.result, "Ready.");
    assert.isFalse(result.is_error);
    assert.equal(session.state, "idle");
    // The init line of the turn replaced the configured id.
    assert.equal(session.cliSessionId, "2b729401-243a-427a-9749-74ee716d3591");

    // Every line of the capture reached a subscriber, in capture order. The
    // handshake response is a line too, so it is taken out first.
    const messages = events
      .filter((event) => event.type === "message")
      .map((event) => (event as { message: Record<string, any> }).message)
      .filter((message) => message.type !== "control_response")
      .map((message) => JSON.stringify(message));
    assert.deepEqual(messages, partialLines.map(canonical));
    assert.lengthOf(
      events.filter((event) => event.type === "turn_completed"),
      1,
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === "state")
        .map((event) => (event as { state: string }).state),
      ["starting", "idle", "busy", "idle"],
    );
    const written = spawner.lastHandle().written.map(parseLine);
    assert.lengthOf(written, 2);
    assert.deepEqual(written[0].request, { subtype: "initialize" });
    assert.isString(written[0].request_id);
    assert.deepEqual(written[1], {
      type: "user",
      message: { role: "user", content: "Reply with one word." },
    });
  });

  it("reproduces the client side of the permission capture", async function () {
    const { handshake, turn } = partitionFixtureAtInit(permissionStdout);
    const handshakeLines = handshake.filter(
      (line) => line !== initializeResponseLine,
    );
    const permissionIndex = turn.findIndex(
      (line) => parseLine(line).type === "control_request",
    );
    const beforePermission = turn.slice(0, permissionIndex + 1);
    const afterPermission = turn.slice(permissionIndex + 1);
    const userPrompt = parseLine(permissionStdin[1]).message.content as string;

    const spawner = createFakeClaudeSpawner({
      onWrite: (line, handle) => {
        const parsed = parseLine(line);
        if (parsed.type === "control_request") {
          if (parsed.request.subtype === "initialize") {
            // The capture's response already carries this request id.
            replyLater(handle, [initializeResponseLine]);
          }
          return;
        }
        if (parsed.type === "user") {
          replyLater(handle, [...handshakeLines, ...beforePermission]);
        }
        if (parsed.type === "control_response") {
          replyLater(handle, afterPermission);
        }
      },
    });
    const requests: ClaudeDirectPermissionRequest[] = [];
    const session = createClaudeDirectSession(baseConfig, {
      spawner,
      // The capture used this id for its initialize request.
      generateRequestId: () => "init-1",
    });
    session.subscribe((event) => {
      if (event.type === "permission_request") requests.push(event.request);
    });

    const started = await session.start();
    const initialize = await session.initialize();
    assert.strictEqual(initialize, started.initialize);
    assert.equal(initialize.models?.[0].value, "default");
    assert.equal(initialize.models?.[0].resolvedModel, "claude-opus-5[1m]");
    assert.isTrue((initialize.commands?.length ?? 0) > 0);

    const turnPromise = session.runTurn(userPrompt);
    await waitFor(() => requests.length === 1);
    const request = requests[0];
    assert.equal(request.toolName, "Write");
    assert.equal(request.displayName, "Write");
    assert.equal(
      (request.input as { file_path?: string }).file_path,
      "/tmp/claude-direct-fixture/permission-fixture.txt",
    );
    assert.equal(request.toolUseId?.startsWith("toolu_"), true);
    assert.deepEqual(request.suggestions, [
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ]);

    await session.respondToPermission(request.requestId, {
      behavior: "allow",
    });
    const result = await turnPromise;
    assert.equal(result.result, "Done.");

    // The three lines the session wrote are the three lines of the capture,
    // apart from the tool use id the SDK echoes back in its answer, which the
    // capture did not carry.
    const written = spawner.lastHandle().written.map(parseLine);
    assert.equal(written[2].response.response.toolUseID, request.toolUseId);
    delete written[2].response.response.toolUseID;
    assert.deepEqual(written, permissionStdin.map(parseLine));
    assert.deepEqual(
      spawner.lastHandle().written.slice(0, 2),
      permissionStdin.slice(0, 2).map((line) => `${line}\n`),
    );
  });

  it("echoes the tool use id back when a permission is denied", async function () {
    const { session, spawner } = await startSession();
    const handle = spawner.lastHandle();
    handle.emitLine(
      JSON.stringify({
        type: "control_request",
        request_id: "deny-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "rm -rf /" },
          tool_use_id: "toolu_deny",
        },
      }),
    );
    await session.respondToPermission("deny-1", {
      behavior: "deny",
      message: "Not in a library",
      interrupt: true,
    });
    assert.deepEqual(parseLine(handle.written[handle.written.length - 1]), {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "deny-1",
        response: {
          behavior: "deny",
          message: "Not in a library",
          interrupt: true,
          toolUseID: "toolu_deny",
        },
      },
    });
    await session.close();
  });

  it("rejects a second turn while one is in flight", async function () {
    const { session } = await startSession();
    const first = session.runTurn("one");
    await expectDirectError(session.runTurn("two"), "busy");
    assert.equal(session.state, "busy");
    void first.catch(() => undefined);
    await session.close();
  });

  it("rejects the turn in flight when the process exits", async function () {
    const { session, spawner } = await startSession();
    const exits: ClaudeDirectSessionEvent[] = [];
    session.subscribe((event) => {
      if (event.type === "process_exited") exits.push(event);
    });
    const turn = session.runTurn("one");
    spawner.lastHandle().exitNow({ code: 2, reason: "natural" });
    const error = await expectDirectError(turn, "process_exited");
    assert.include(error.message, "code 2");
    assert.lengthOf(exits, 1);
    assert.equal(session.state, "failed");
    await expectDirectError(session.runTurn("again"), "closed");
  });

  it("fails start() when the initialize response never arrives", async function () {
    const spawner = createFakeClaudeSpawner();
    const session = createClaudeDirectSession(
      { ...baseConfig, startTimeoutMs: 20 },
      { spawner },
    );
    await expectDirectError(session.start(), "start_timeout");
    assert.equal(session.state, "failed");
    const written = spawner.lastHandle().written.map(parseLine);
    assert.lengthOf(written, 1);
    assert.deepEqual(written[0].request, { subtype: "initialize" });
    assert.equal(spawner.lastHandle().terminateCalls, 1);
  });

  it("re-asks the CLI only when initialize is forced", async function () {
    const { session, spawner } = await startSession();
    const handle = spawner.lastHandle();
    const cached = await session.initialize();
    assert.lengthOf(handle.written, 1);
    const refreshed = await session.initialize({ force: true });
    assert.lengthOf(handle.written, 2);
    assert.notStrictEqual(refreshed, cached);
    assert.equal(refreshed.models?.[0].value, cached.models?.[0].value);
    await session.close();
  });

  it("reports a binary that cannot be found", async function () {
    const spawner = createFakeClaudeSpawner({
      resolveError: new ClaudeDirectError(
        "binary_not_found",
        "claude is not on the PATH",
      ),
    });
    const session = createClaudeDirectSession(baseConfig, { spawner });
    await expectDirectError(session.start(), "binary_not_found");
    assert.lengthOf(spawner.handles, 0);
  });

  it("interrupts the turn in flight with a control request", async function () {
    const { session, spawner } = await startSession({ answerControls: true });
    const turn = session.runTurn("one");
    const interrupted = expectDirectError(turn, "interrupted");
    await session.interrupt();
    await interrupted;
    const written = spawner.lastHandle().written.map(parseLine);
    assert.deepEqual(
      written
        .filter((line) => line.type === "control_request")
        .map((line) => line.request),
      [{ subtype: "initialize" }, { subtype: "interrupt" }],
    );
    // The CLI still has the interrupted turn to finish.
    assert.equal(session.state, "busy");
    spawner.lastHandle().emitLine(resultLine("stopped"));
    assert.equal(session.state, "idle");
    await session.close();
  });

  it("interrupts the turn when its abort signal fires", async function () {
    const { session, spawner } = await startSession({ answerControls: true });
    const controller = new AbortController();
    const turn = session.runTurn("one", { signal: controller.signal });
    controller.abort();
    await expectDirectError(turn, "interrupted");
    await waitFor(() =>
      spawner
        .lastHandle()
        .written.map(parseLine)
        .some((line) => line.request?.subtype === "interrupt"),
    );
    assert.equal(session.state, "busy");
    await session.close();
  });

  it("never lets an interrupted turn's result resolve the next turn", async function () {
    const { session, spawner } = await startSession({ answerControls: true });
    const handle = spawner.lastHandle();
    const completed: Array<string | undefined> = [];
    session.subscribe((event) => {
      if (event.type === "turn_completed") completed.push(event.result.result);
    });

    const first = session.runTurn("one");
    const interrupted = expectDirectError(first, "interrupted");
    await session.interrupt();
    await interrupted;
    // Nothing else may run while the interrupted turn is still closing.
    await expectDirectError(session.runTurn("too early"), "busy");

    handle.emitLine(resultLine("interrupted turn"));
    assert.equal(session.state, "idle");

    const second = session.runTurn("two");
    let settled = false;
    void second.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.isFalse(settled, "the stale result must not resolve the new turn");

    handle.emitLine(resultLine("second turn"));
    const result = await second;
    assert.equal(result.result, "second turn");
    assert.deepEqual(completed, ["interrupted turn", "second turn"]);
    await session.close();
  });

  it("changes model and permission mode through control requests", async function () {
    const { session, spawner } = await startSession({ answerControls: true });
    await session.setModel("opus");
    await session.setPermissionMode("acceptEdits");
    await session.setModel(undefined);
    const requests = spawner
      .lastHandle()
      .written.map(parseLine)
      .filter((line) => line.type === "control_request")
      .map((line) => line.request);
    assert.deepEqual(requests, [
      // start() sent the handshake before any of these.
      { subtype: "initialize" },
      { subtype: "set_model", model: "opus" },
      { subtype: "set_permission_mode", mode: "acceptEdits" },
      { subtype: "set_model" },
    ]);
  });

  it("surfaces a control request the CLI rejects", async function () {
    const { session, spawner } = await startSession({
      onWrite: (line, handle) => {
        const parsed = parseLine(line);
        if (parsed.type !== "control_request") return;
        replyLater(handle, [
          JSON.stringify({
            type: "control_response",
            response: {
              subtype: "error",
              request_id: parsed.request_id,
              error: "unknown model",
            },
          }),
        ]);
      },
    });
    const error = await expectDirectError(
      session.setModel("nope"),
      "control_rejected",
    );
    assert.include(error.message, "unknown model");
  });

  it("treats control_cancel_request as a cancelled permission", async function () {
    const { session, spawner } = await startSession();
    const cancelled: string[] = [];
    const requests: ClaudeDirectPermissionRequest[] = [];
    session.subscribe((event) => {
      if (event.type === "permission_cancelled")
        cancelled.push(event.requestId);
      if (event.type === "permission_request") requests.push(event.request);
    });
    const handle = spawner.lastHandle();
    handle.emitLine(
      JSON.stringify({
        type: "control_request",
        request_id: "cancel-me",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: {} },
      }),
    );
    handle.emitLine(
      JSON.stringify({
        type: "control_cancel_request",
        request_id: "cancel-me",
      }),
    );
    assert.deepEqual(cancelled, ["cancel-me"]);
    assert.lengthOf(requests, 1);
    await expectDirectError(
      session.respondToPermission("cancel-me", { behavior: "allow" }),
      "protocol",
    );
  });

  it("denies a pending permission when the session closes", async function () {
    const { session, spawner } = await startSession();
    const handle = spawner.lastHandle();
    handle.emitLine(
      JSON.stringify({
        type: "control_request",
        request_id: "pending-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "rm -rf /" },
          tool_use_id: "toolu_pending",
        },
      }),
    );
    await session.close();
    const denial = parseLine(handle.written[handle.written.length - 1]);
    assert.deepEqual(denial, {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "pending-1",
        response: {
          behavior: "deny",
          message: "The Zotero session was closed",
          toolUseID: "toolu_pending",
        },
      },
    });
    assert.equal(session.state, "closed");
  });

  it("redacts stderr before it becomes an event", async function () {
    const { session, spawner } = await startSession();
    const texts: string[] = [];
    session.subscribe((event) => {
      if (event.type === "stderr") texts.push(event.text);
    });
    spawner
      .lastHandle()
      .emitStderr("auth failed for sk-ant-api03-SECRETVALUE-0123\n");
    assert.lengthOf(texts, 1);
    assert.notInclude(texts[0], "SECRETVALUE");
    assert.include(texts[0], "sk-ant-[redacted]");
  });

  it("leaves no orphan process behind", async function () {
    const spawner = createFakeClaudeSpawner({
      onWrite: (line, handle) => {
        answerInitialize(line, handle);
      },
    });
    const sessions = [];
    for (let index = 0; index < 3; index += 1) {
      const session = createClaudeDirectSession(baseConfig, { spawner });
      await session.start();
      sessions.push(session);
    }
    assert.lengthOf(spawner.liveProcesses(), 3);

    // Two conversations close on their own; the quit path takes the third.
    await sessions[0].close();
    await sessions[1].close();
    assert.lengthOf(spawner.liveProcesses(), 1);
    await spawner.terminateAll();

    assert.lengthOf(spawner.liveProcesses(), 0);
    assert.deepEqual(
      spawner.handles.map((handle) => handle.terminateCalls),
      [1, 1, 1],
    );
    assert.deepEqual(
      spawner.handles.map((handle) => handle.exited),
      [true, true, true],
    );
    // close() is idempotent and never re-terminates.
    assert.equal(await sessions[0].close(), await sessions[0].close());
    assert.equal(spawner.handles[0].terminateCalls, 1);
  });

  it("closes without throwing after the process already exited", async function () {
    const { session, spawner } = await startSession();
    spawner.lastHandle().exitNow({ code: 1, reason: "natural" });
    const exit = await session.close();
    assert.equal(exit?.reason, "natural");
    assert.equal(session.state, "closed");
    assert.equal(await session.close(), exit);
  });
});

async function startSession(options?: {
  answerControls?: boolean;
  onWrite?: (line: string, handle: FakeClaudeHandle) => void;
}) {
  let nextId = 0;
  const spawner = createFakeClaudeSpawner({
    onWrite: (line, handle) => {
      if (answerInitialize(line, handle)) return;
      options?.onWrite?.(line, handle);
      if (!options?.answerControls) return;
      const parsed = parseLine(line);
      if (parsed.type !== "control_request") return;
      replyLater(handle, [
        JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: parsed.request_id,
            response: {},
          },
        }),
      ]);
    },
  });
  const session = createClaudeDirectSession(baseConfig, {
    spawner,
    generateRequestId: () => `req-${++nextId}`,
  });
  await session.start();
  return { session, spawner };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was never met");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
