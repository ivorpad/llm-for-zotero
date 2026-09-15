import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type {
  ClaudeCliBinaryResolution,
  ClaudeCliDiscoveryInput,
  ClaudeCliProcessExit,
  ClaudeCliProcessHandle,
  ClaudeCliProcessSpawner,
  ClaudeCliSpawnRequest,
  ClaudeCliTerminateOptions,
} from "../../src/claudeCodeDirect/contract";
import type { SubprocessLike } from "../../src/utils/claudeCliProcess";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "claudeDirect",
);

/** The stdout (or stdin) lines of one capture under test/fixtures/claudeDirect. */
export function readClaudeDirectFixtureLines(name: string): string[] {
  return readFileSync(join(fixtureDir, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

/**
 * Splits a capture into the lines the CLI writes before it is ready (hooks and
 * the `init` line) and the lines it writes for the turn that follows.
 */
export function partitionFixtureAtInit(lines: readonly string[]): {
  handshake: string[];
  turn: string[];
} {
  const initIndex = lines.findIndex((line) => {
    try {
      const parsed = JSON.parse(line) as { type?: string; subtype?: string };
      return parsed.type === "system" && parsed.subtype === "init";
    } catch {
      return false;
    }
  });
  if (initIndex < 0) return { handshake: [], turn: [...lines] };
  return {
    handshake: lines.slice(0, initIndex + 1),
    turn: lines.slice(initIndex + 1),
  };
}

// ---------------------------------------------------------------------------
// A fake ClaudeCliProcessHandle: replays lines, records writes
// ---------------------------------------------------------------------------

export type FakeClaudeHandle = ClaudeCliProcessHandle & {
  /** Every line the session wrote to stdin, newline included. */
  readonly written: string[];
  /** How many times terminate() was called, including the repeats. */
  readonly terminateCalls: number;
  readonly terminateOptions: Array<ClaudeCliTerminateOptions | undefined>;
  readonly inputEnded: boolean;
  emitLine(line: string): void;
  emitLines(lines: readonly string[]): void;
  emitStderr(text: string): void;
  /** Exit without being asked, the way a crashing CLI would. */
  exitNow(exit?: Partial<ClaudeCliProcessExit>): void;
};

class FakeHandle implements FakeClaudeHandle {
  readonly written: string[] = [];
  readonly terminateOptions: Array<ClaudeCliTerminateOptions | undefined> = [];
  terminateCalls = 0;
  inputEnded = false;

  private readonly lineHandlers = new Set<(line: string) => void>();
  private readonly stderrHandlers = new Set<(text: string) => void>();
  private readonly exitHandlers = new Set<(exit: ClaudeCliProcessExit) => void>();
  private exitRecord: ClaudeCliProcessExit | null = null;

  constructor(
    readonly pid: number | null,
    readonly launchDescription: string,
    private readonly onWrite:
      | ((line: string, handle: FakeClaudeHandle) => void)
      | undefined,
    // Named apart from the onExit() subscriber: a parameter property with that
    // name would shadow the method on the prototype.
    private readonly onSettled: (handle: FakeHandle) => void,
  ) {}

  get exited(): boolean {
    return this.exitRecord !== null;
  }

  writeLine(line: string): void {
    if (this.exitRecord) {
      throw new Error("fake claude process has exited");
    }
    const payload = line.endsWith("\n") ? line : `${line}\n`;
    this.written.push(payload);
    this.onWrite?.(payload.trimEnd(), this);
  }

  endInput(): void {
    this.inputEnded = true;
  }

  onLine(handler: (line: string) => void): () => void {
    this.lineHandlers.add(handler);
    return () => this.lineHandlers.delete(handler);
  }

  onStderr(handler: (text: string) => void): () => void {
    this.stderrHandlers.add(handler);
    return () => this.stderrHandlers.delete(handler);
  }

  onExit(handler: (exit: ClaudeCliProcessExit) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  emitLine(line: string): void {
    for (const handler of [...this.lineHandlers]) handler(line);
  }

  emitLines(lines: readonly string[]): void {
    for (const line of lines) this.emitLine(line);
  }

  emitStderr(text: string): void {
    for (const handler of [...this.stderrHandlers]) handler(text);
  }

  exitNow(exit?: Partial<ClaudeCliProcessExit>): void {
    this.settle({
      code: exit?.code ?? 1,
      signal: exit?.signal ?? null,
      reason: exit?.reason ?? "natural",
    });
  }

  terminate(
    options?: ClaudeCliTerminateOptions,
  ): Promise<ClaudeCliProcessExit> {
    this.terminateCalls += 1;
    this.terminateOptions.push(options);
    this.inputEnded = true;
    return Promise.resolve(
      this.settle({ code: 0, signal: null, reason: "terminated" }),
    );
  }

  private settle(exit: ClaudeCliProcessExit): ClaudeCliProcessExit {
    if (this.exitRecord) return this.exitRecord;
    this.exitRecord = exit;
    this.onSettled(this);
    for (const handler of [...this.exitHandlers]) handler(exit);
    return exit;
  }
}

export type FakeClaudeSpawnerOptions = {
  binary?: ClaudeCliBinaryResolution;
  /** resolveBinary() rejects with this. */
  resolveError?: unknown;
  /** spawn() rejects with this. */
  spawnError?: unknown;
  /** Replayed once the session has subscribed, so `start()` sees an init line. */
  linesOnSpawn?: readonly string[];
  /** Scripts the CLI's answer to a line the session wrote. */
  onWrite?: (line: string, handle: FakeClaudeHandle) => void;
};

export type FakeClaudeSpawner = ClaudeCliProcessSpawner & {
  readonly handles: FakeClaudeHandle[];
  readonly spawnRequests: ClaudeCliSpawnRequest[];
  readonly resolveInputs: Array<ClaudeCliDiscoveryInput | undefined>;
  lastHandle(): FakeClaudeHandle;
};

export function createFakeClaudeSpawner(
  options: FakeClaudeSpawnerOptions = {},
): FakeClaudeSpawner {
  const handles: FakeClaudeHandle[] = [];
  const live = new Set<ClaudeCliProcessHandle>();
  const spawnRequests: ClaudeCliSpawnRequest[] = [];
  const resolveInputs: Array<ClaudeCliDiscoveryInput | undefined> = [];
  let nextPid = 4200;

  const spawner: FakeClaudeSpawner = {
    handles,
    spawnRequests,
    resolveInputs,
    lastHandle() {
      const handle = handles[handles.length - 1];
      if (!handle) throw new Error("no fake claude process was spawned");
      return handle;
    },
    async resolveBinary(input?: ClaudeCliDiscoveryInput) {
      resolveInputs.push(input);
      if (options.resolveError) throw options.resolveError;
      return (
        options.binary ?? { path: "/usr/local/bin/claude", source: "explicit" }
      );
    },
    async spawn(request: ClaudeCliSpawnRequest) {
      spawnRequests.push(request);
      if (options.spawnError) throw options.spawnError;
      const handle = new FakeHandle(
        nextPid++,
        [request.binaryPath, ...request.args].join(" "),
        options.onWrite,
        (exited) => live.delete(exited),
      );
      handles.push(handle);
      live.add(handle);
      if (options.linesOnSpawn?.length) {
        const lines = options.linesOnSpawn;
        setTimeout(() => handle.emitLines(lines), 0);
      }
      return handle;
    },
    liveProcesses() {
      return [...live];
    },
    async terminateAll(terminateOptions?: ClaudeCliTerminateOptions) {
      await Promise.all(
        [...live].map((handle) =>
          handle.terminate(terminateOptions).catch(() => undefined),
        ),
      );
    },
  };
  return spawner;
}

// ---------------------------------------------------------------------------
// A fake Subprocess module for the process layer itself
// ---------------------------------------------------------------------------

export type FakeSubprocessScript = {
  stdout?: readonly string[];
  stderr?: readonly string[];
  exitCode?: number;
  /** Keep the streams open until kill() arrives. */
  stayAlive?: boolean;
  /** Swallow this many kill() calls so the force-kill step is exercised. */
  ignoreKills?: number;
  /** Throw instead of starting a process. */
  failWith?: unknown;
};

export type FakeSubprocessCall = {
  command: string;
  arguments: string[];
  options: Record<string, unknown>;
};

export type FakeChildProcess = {
  pid: number;
  readonly written: string[];
  readonly kills: Array<number | undefined>;
  stdinClosed: boolean;
  pushStdout(text: string): void;
  pushStderr(text: string): void;
  exit(code?: number): void;
};

export type FakeSubprocess = SubprocessLike & {
  readonly calls: FakeSubprocessCall[];
  readonly children: FakeChildProcess[];
};

type PendingRead = (chunk: string) => void;

function createFakeStream() {
  const queue: string[] = [];
  const waiting: PendingRead[] = [];
  let closed = false;
  return {
    push(text: string) {
      if (closed || !text) return;
      const next = waiting.shift();
      if (next) next(text);
      else queue.push(text);
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiting.length) waiting.shift()?.("");
    },
    readString(): Promise<string> {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (closed) return Promise.resolve("");
      return new Promise<string>((resolve) => waiting.push(resolve));
    },
  };
}

export function createFakeSubprocess(
  script: (call: FakeSubprocessCall) => FakeSubprocessScript = () => ({}),
): FakeSubprocess {
  const calls: FakeSubprocessCall[] = [];
  const children: FakeChildProcess[] = [];
  let nextPid = 9100;

  return {
    calls,
    children,
    async call(rawOptions: Record<string, unknown>) {
      const call: FakeSubprocessCall = {
        command: String(rawOptions.command ?? ""),
        arguments: Array.isArray(rawOptions.arguments)
          ? (rawOptions.arguments as string[])
          : [],
        options: rawOptions,
      };
      calls.push(call);
      const spec = script(call);
      if (spec.failWith) throw spec.failWith;
      const stdout = createFakeStream();
      const stderr = createFakeStream();
      const written: string[] = [];
      const kills: Array<number | undefined> = [];
      let ignoreKills = spec.ignoreKills ?? 0;
      let exitCode: number | undefined;
      let exited = false;
      const exitWaiters: Array<(result: { exitCode?: number }) => void> = [];

      const exit = (code?: number) => {
        if (exited) return;
        exited = true;
        exitCode = code ?? spec.exitCode ?? 0;
        stdout.close();
        stderr.close();
        while (exitWaiters.length) exitWaiters.shift()?.({ exitCode });
      };

      const child = {
        pid: nextPid++,
        written,
        kills,
        stdinClosed: false,
        pushStdout: (text: string) => stdout.push(text),
        pushStderr: (text: string) => stderr.push(text),
        exit,
      } satisfies FakeChildProcess;
      children.push(child);

      for (const chunk of spec.stdout ?? []) stdout.push(chunk);
      for (const chunk of spec.stderr ?? []) stderr.push(chunk);
      if (!spec.stayAlive) exit(spec.exitCode);

      return {
        pid: child.pid,
        stdin: {
          write: (chunk: string) => {
            if (exited) throw new Error("fake process has exited");
            written.push(chunk);
          },
          close: () => {
            child.stdinClosed = true;
          },
        },
        stdout: { readString: () => stdout.readString() },
        stderr: { readString: () => stderr.readString() },
        kill: (timeoutMs?: number) => {
          kills.push(timeoutMs);
          if (ignoreKills > 0) {
            ignoreKills -= 1;
            return;
          }
          exit(spec.exitCode ?? 143);
        },
        wait: () =>
          exited
            ? Promise.resolve({ exitCode })
            : new Promise<{ exitCode?: number }>((resolve) =>
                exitWaiters.push(resolve),
              ),
      };
    },
  };
}
