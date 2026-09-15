import { assert } from "chai";
import {
  createClaudeCliProcessSpawnerForTest,
  selectClaudeLookupLine,
} from "../src/utils/claudeCliProcess";
import { ClaudeDirectError } from "../src/claudeCodeDirect/contract";
import { getRuntimePlatformInfo } from "../src/utils/runtimePlatform";
import {
  createFakeSubprocess,
  type FakeSubprocessScript,
} from "./helpers/claudeDirectFakeProcess";

/**
 * Zotero starts with PATH=/usr/bin:/bin:/usr/sbin:/sbin, so a `claude`
 * installed by npm, homebrew or a version manager is only visible through a
 * login shell. These tests pin the lookup order and the terminate schedule
 * without spawning anything real: `Subprocess` is injected.
 */
const CLAUDE_ENV_KEY = "CLAUDE_PATH";

function withoutClaudePathEnv<T>(task: () => T): T {
  const previous = process.env[CLAUDE_ENV_KEY];
  delete process.env[CLAUDE_ENV_KEY];
  try {
    return task();
  } finally {
    if (previous === undefined) delete process.env[CLAUDE_ENV_KEY];
    else process.env[CLAUDE_ENV_KEY] = previous;
  }
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

function spawnRequest(overrides: Record<string, unknown> = {}) {
  return {
    binaryPath: "/opt/homebrew/bin/claude",
    args: ["-p", "--output-format", "stream-json"],
    cwd: "/tmp/claude-direct-fixture",
    ...overrides,
  } as Parameters<
    ReturnType<typeof createClaudeCliProcessSpawnerForTest>["spawn"]
  >[0];
}

describe("claude cli process", function () {
  describe("resolveBinary", function () {
    it("prefers the configured path and never asks the shell", async function () {
      await withoutClaudePathEnv(async () => {
        const subprocess = createFakeSubprocess();
        const spawner = createClaudeCliProcessSpawnerForTest(subprocess);
        const resolution = await spawner.resolveBinary({
          preferredPath: "  /Users/example/.local/bin/claude  ",
        });
        assert.deepEqual(resolution, {
          path: "/Users/example/.local/bin/claude",
          source: "explicit",
        });
        assert.lengthOf(subprocess.calls, 0);
      });
    });

    it("falls back to CLAUDE_PATH before the shell lookup", async function () {
      const previous = process.env[CLAUDE_ENV_KEY];
      process.env[CLAUDE_ENV_KEY] = "/env/bin/claude";
      try {
        const subprocess = createFakeSubprocess();
        const spawner = createClaudeCliProcessSpawnerForTest(subprocess);
        assert.deepEqual(await spawner.resolveBinary(), {
          path: "/env/bin/claude",
          source: "env",
        });
        assert.deepEqual(await spawner.resolveBinary({ preferredPath: "" }), {
          path: "/env/bin/claude",
          source: "env",
        });
        assert.lengthOf(subprocess.calls, 0);
      } finally {
        if (previous === undefined) delete process.env[CLAUDE_ENV_KEY];
        else process.env[CLAUDE_ENV_KEY] = previous;
      }
    });

    it("asks the login shell last and takes the last line it printed", async function () {
      await withoutClaudePathEnv(async () => {
        const subprocess = createFakeSubprocess(() => ({
          // A login shell prints the profile's own output first.
          stdout: ["nvm: using node 24\n", "/Users/example/.n/bin/claude\n"],
          exitCode: 0,
        }));
        const spawner = createClaudeCliProcessSpawnerForTest(subprocess);
        assert.deepEqual(await spawner.resolveBinary(), {
          path: "/Users/example/.n/bin/claude",
          source: "shell_lookup",
        });
        const info = getRuntimePlatformInfo();
        assert.equal(subprocess.calls[0].command, info.shellPath);
        assert.deepEqual(subprocess.calls[0].arguments, [
          "-lc",
          "which claude",
        ]);
      });
    });

    it("uses cmd.exe and `where claude` on Windows", async function () {
      const previousZotero = (globalThis as any).Zotero;
      (globalThis as any).Zotero = { isWin: true };
      try {
        await withoutClaudePathEnv(async () => {
          const subprocess = createFakeSubprocess(() => ({
            stdout: [
              "C:\\Users\\example\\AppData\\Roaming\\npm\\claude.cmd\r\n",
            ],
            exitCode: 0,
          }));
          const spawner = createClaudeCliProcessSpawnerForTest(subprocess);
          const resolution = await spawner.resolveBinary();
          assert.equal(
            resolution.path,
            "C:\\Users\\example\\AppData\\Roaming\\npm\\claude.cmd",
          );
          assert.deepEqual(subprocess.calls[0].arguments, [
            "/c",
            "where claude",
          ]);
          assert.include(subprocess.calls[0].command, "cmd.exe");
        });
      } finally {
        if (previousZotero === undefined) delete (globalThis as any).Zotero;
        else (globalThis as any).Zotero = previousZotero;
      }
    });

    it("reports binary_not_found when the lookup fails", async function () {
      await withoutClaudePathEnv(async () => {
        const subprocess = createFakeSubprocess(() => ({
          stdout: ["claude not found\n"],
          exitCode: 1,
        }));
        const spawner = createClaudeCliProcessSpawnerForTest(subprocess);
        try {
          await spawner.resolveBinary();
          assert.fail("expected resolveBinary to reject");
        } catch (error) {
          assert.instanceOf(error, ClaudeDirectError);
          assert.equal((error as ClaudeDirectError).code, "binary_not_found");
        }
      });
    });

    it("keeps the last non-empty line of a noisy lookup", function () {
      assert.equal(selectClaudeLookupLine(""), "");
      assert.equal(selectClaudeLookupLine("\n\n"), "");
      assert.equal(
        selectClaudeLookupLine("banner\r\n/usr/local/bin/claude\r\n\r\n"),
        "/usr/local/bin/claude",
      );
    });
  });

  describe("spawn", function () {
    it("passes the working directory and appends the environment", async function () {
      const subprocess = createFakeSubprocess(() => ({ stayAlive: true }));
      const spawner = createClaudeCliProcessSpawnerForTest(subprocess);
      const handle = await spawner.spawn(
        spawnRequest({ environment: { ANTHROPIC_API_KEY: "sk-ant-secret" } }),
      );
      const options = subprocess.calls[0].options;
      assert.equal(options.command, "/opt/homebrew/bin/claude");
      assert.equal(options.workdir, "/tmp/claude-direct-fixture");
      assert.equal(options.stderr, "pipe");
      assert.deepEqual(options.environment, {
        ANTHROPIC_API_KEY: "sk-ant-secret",
      });
      assert.isTrue(options.environmentAppend);
      assert.isNumber(handle.pid);
      assert.lengthOf(spawner.liveProcesses(), 1);
      await handle.terminate({ graceMs: 0, forceAfterMs: 0 });
    });

    it("keeps environment values out of launchDescription", async function () {
      const subprocess = createFakeSubprocess(() => ({ stayAlive: true }));
      const spawner = createClaudeCliProcessSpawnerForTest(subprocess);
      const handle = await spawner.spawn(
        spawnRequest({
          args: [
            "-p",
            "--append-system-prompt",
            "token=0123456789012345678901234567890123456789abcd",
          ],
          environment: { ANTHROPIC_API_KEY: "sk-ant-secret-value" },
        }),
      );
      assert.include(handle.launchDescription, "/opt/homebrew/bin/claude");
      assert.include(handle.launchDescription, "--append-system-prompt");
      assert.notInclude(handle.launchDescription, "sk-ant-secret-value");
      assert.notInclude(handle.launchDescription, "ANTHROPIC_API_KEY");
      assert.include(handle.launchDescription, "token=[redacted]");
      await handle.terminate({ graceMs: 0, forceAfterMs: 0 });
    });

    it("reports a spawn failure as spawn_failed", async function () {
      const subprocess = createFakeSubprocess(() => ({
        failWith: new Error("no such file or directory"),
      }));
      const spawner = createClaudeCliProcessSpawnerForTest(subprocess);
      try {
        await spawner.spawn(spawnRequest());
        assert.fail("expected spawn to reject");
      } catch (error) {
        assert.instanceOf(error, ClaudeDirectError);
        assert.equal((error as ClaudeDirectError).code, "spawn_failed");
        assert.include(
          (error as ClaudeDirectError).message,
          "no such file or directory",
        );
      }
    });
  });

  describe("handle", function () {
    async function spawnHandle(script: FakeSubprocessScript = {}) {
      const subprocess = createFakeSubprocess(() => script);
      const spawner = createClaudeCliProcessSpawnerForTest(subprocess);
      const handle = await spawner.spawn(spawnRequest());
      return { handle, spawner, child: subprocess.children[0] };
    }

    it("delivers whole lines from chunked stdout and skips blank ones", async function () {
      const { handle, child } = await spawnHandle({ stayAlive: true });
      const lines: string[] = [];
      handle.onLine((line) => lines.push(line));
      child.pushStdout('{"type":"sys');
      child.pushStdout('tem","subtype":"init"}\n\n{"type":"keep');
      child.pushStdout('_alive"}\n{"type":"result"}');
      await waitFor(() => lines.length === 2);
      child.exit(0);
      await waitFor(() => lines.length === 3);
      assert.deepEqual(lines, [
        '{"type":"system","subtype":"init"}',
        '{"type":"keep_alive"}',
        // The tail without a trailing newline still arrives, at EOF.
        '{"type":"result"}',
      ]);
    });

    it("redacts stderr and reports a natural exit", async function () {
      const { handle, child, spawner } = await spawnHandle({ stayAlive: true });
      const errors: string[] = [];
      const exits: Array<{ code: number | null; reason: string }> = [];
      handle.onStderr((text) => errors.push(text));
      handle.onExit((exit) => exits.push(exit));
      child.pushStderr("auth error for sk-ant-api03-SECRET-0001\n");
      await waitFor(() => errors.length === 1);
      assert.notInclude(errors[0], "SECRET");
      child.exit(7);
      await waitFor(() => exits.length === 1);
      assert.deepEqual(exits[0], { code: 7, signal: null, reason: "natural" });
      assert.isTrue(handle.exited);
      assert.lengthOf(spawner.liveProcesses(), 0);
    });

    it("writes one line per message and refuses to write after the exit", async function () {
      const { handle, child } = await spawnHandle({ stayAlive: true });
      handle.writeLine('{"type":"user"}\n');
      handle.writeLine('{"type":"control_request"}');
      assert.deepEqual(child.written, [
        '{"type":"user"}\n',
        '{"type":"control_request"}\n',
      ]);
      child.exit(0);
      await waitFor(() => handle.exited);
      try {
        handle.writeLine('{"type":"user"}');
        assert.fail("expected writeLine to reject a dead process");
      } catch (error) {
        assert.instanceOf(error, ClaudeDirectError);
        assert.equal((error as ClaudeDirectError).code, "process_exited");
      }
    });

    it("closes stdin first and reports a graceful exit as terminated", async function () {
      const { handle, child } = await spawnHandle({ stayAlive: true });
      const terminated = handle.terminate({
        graceMs: 200,
        forceAfterMs: 200,
      });
      await waitFor(() => child.stdinClosed);
      child.exit(0);
      const exit = await terminated;
      assert.deepEqual(exit, { code: 0, signal: null, reason: "terminated" });
      assert.lengthOf(child.kills, 0);
    });

    it("escalates from the grace period to a kill and a force kill", async function () {
      // The first kill() is swallowed, so the force-kill step has to run.
      const subprocess = createFakeSubprocess(() => ({
        stayAlive: true,
        ignoreKills: 1,
      }));
      const spawner = createClaudeCliProcessSpawnerForTest(subprocess);
      const handle = await spawner.spawn(spawnRequest());
      const child = subprocess.children[0];
      const exit = await handle.terminate({ graceMs: 5, forceAfterMs: 5 });
      assert.equal(exit.reason, "killed");
      assert.isTrue(handle.exited);
      // SIGTERM through kill(), then the immediate kill(0) of the force step.
      assert.deepEqual(child.kills, [undefined, 0]);
      assert.isTrue(child.stdinClosed);
      // terminate() is idempotent: the second call adds no signals.
      const again = await handle.terminate();
      assert.equal(again.reason, "killed");
      assert.deepEqual(child.kills, [undefined, 0]);
    });

    it("waits out the SDK grace period when no options are given", async function () {
      const subprocess = createFakeSubprocess(() => ({ stayAlive: true }));
      const spawner = createClaudeCliProcessSpawnerForTest(subprocess);
      const handle = await spawner.spawn(spawnRequest());
      const child = subprocess.children[0];
      const terminated = handle.terminate();
      // CLAUDE_CLI_TERMINATE_DEFAULTS.graceMs is 2 s, so nothing is signalled
      // in the first fraction of a second.
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.deepEqual(child.kills, []);
      assert.isTrue(child.stdinClosed);
      child.exit(0);
      assert.equal((await terminated).reason, "terminated");
    });

    it("terminates every live process the spawner owns", async function () {
      const subprocess = createFakeSubprocess(() => ({ stayAlive: true }));
      const spawner = createClaudeCliProcessSpawnerForTest(subprocess);
      const first = await spawner.spawn(spawnRequest());
      const second = await spawner.spawn(spawnRequest());
      assert.lengthOf(spawner.liveProcesses(), 2);
      await first.terminate({ graceMs: 0, forceAfterMs: 0 });
      assert.deepEqual(spawner.liveProcesses(), [second]);
      await spawner.terminateAll({ graceMs: 0, forceAfterMs: 0 });
      assert.lengthOf(spawner.liveProcesses(), 0);
      assert.isTrue(second.exited);
    });
  });
});
