/**
 * Spawns and supervises `claude` processes for the direct-CLI runtime.
 *
 * Zotero runs inside Gecko, so there is no `child_process` here: processes come
 * from `resource://gre/modules/Subprocess.sys.mjs`, the same module
 * `codexAppServerProcess.ts` uses. Zotero's own PATH is
 * `/usr/bin:/bin:/usr/sbin:/sbin`, which is why binary discovery ends in a
 * login-shell lookup.
 */
import {
  CLAUDE_CLI_TERMINATE_DEFAULTS,
  ClaudeDirectError,
  type ClaudeCliBinaryResolution,
  type ClaudeCliDiscoveryInput,
  type ClaudeCliProcessExit,
  type ClaudeCliProcessHandle,
  type ClaudeCliProcessSpawner,
  type ClaudeCliSpawnRequest,
  type ClaudeCliTerminateOptions,
} from "../claudeCodeDirect/contract";
import { redactForLog } from "../claudeCodeDirect/protocol";
import { getRuntimePlatformInfo } from "./runtimePlatform";
import type { RuntimePlatformInfo } from "./runtimePlatform";

/** The shape of `Subprocess` this module relies on. */
export type SubprocessLike = {
  call(options: Record<string, unknown>): Promise<any>;
};

type SpawnedProcess = {
  pid?: number;
  stdin?: { write?: (chunk: string) => unknown; close?: () => unknown };
  stdout?: { readString?: () => Promise<string | null | undefined> };
  stderr?: { readString?: () => Promise<string | null | undefined> };
  kill?: (timeoutMs?: number) => unknown;
  wait?: () => Promise<{ exitCode?: number } | undefined>;
};

/** Every live handle a production spawner created; the quit path drains this. */
const globalLiveHandles = new Set<ClaudeCliProcessHandle>();

function debugLog(message: string): void {
  try {
    (globalThis as { Zotero?: { debug?: (text: string) => void } }).Zotero?.debug?.(
      `[llm-for-zotero] claude cli: ${redactForLog(message)}`,
    );
  } catch {
    /* logging must never break a spawn */
  }
}

async function loadSubprocessModule(): Promise<SubprocessLike> {
  const CU = (globalThis as any).ChromeUtils;
  let Subprocess: any;
  if (CU?.importESModule) {
    try {
      const mod = CU.importESModule("resource://gre/modules/Subprocess.sys.mjs");
      Subprocess = mod.Subprocess || mod.default || mod;
    } catch {
      /* fall through to the legacy module */
    }
  }
  if (!Subprocess?.call && CU?.import) {
    try {
      const mod = CU.import("resource://gre/modules/Subprocess.jsm");
      Subprocess = mod.Subprocess || mod;
    } catch {
      /* fall through to the error below */
    }
  }
  if (!Subprocess?.call) {
    throw new ClaudeDirectError(
      "spawn_failed",
      "Subprocess module not available in this Zotero environment",
    );
  }
  return Subprocess as SubprocessLike;
}

function getRuntimeEnvValue(key: string): string | undefined {
  const processValue = (globalThis as any).process?.env?.[key];
  if (typeof processValue === "string" && processValue.trim()) {
    return processValue.trim();
  }
  try {
    const servicesValue = (globalThis as any).Services?.env?.get?.(key);
    if (typeof servicesValue === "string" && servicesValue.trim()) {
      return servicesValue.trim();
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * The login shell prints the profile's banners too, and the path we want is the
 * last thing `which`/`where` wrote.
 */
export function selectClaudeLookupLine(output: string): string {
  const lines = String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

/** `-lc` so the user's profile PATH is loaded, the way a terminal would see it. */
function lookupShellFlag(info: RuntimePlatformInfo): string {
  return info.shellFlag === "-c" ? "-lc" : info.shellFlag;
}

async function readStreamToEnd(stream: {
  readString?: () => Promise<string | null | undefined>;
}): Promise<string> {
  let out = "";
  try {
    for (;;) {
      const chunk = await stream?.readString?.();
      if (!chunk) break;
      out += chunk;
    }
  } catch {
    /* ignore */
  }
  return out;
}

async function waitForExitCode(
  proc: SpawnedProcess,
): Promise<number | undefined> {
  try {
    const result = await proc.wait?.();
    const exitCode = result?.exitCode;
    return typeof exitCode === "number" ? exitCode : undefined;
  } catch {
    return undefined;
  }
}

async function resolveBinaryFromShellLookup(
  info: RuntimePlatformInfo,
  Subprocess: SubprocessLike | null,
): Promise<string | undefined> {
  if (!Subprocess?.call) return undefined;
  try {
    const lookupCmd =
      info.platform === "windows" ? "where claude" : "which claude";
    const proc: SpawnedProcess = await Subprocess.call({
      command: info.shellPath,
      arguments: [lookupShellFlag(info), lookupCmd],
    });
    const out = await readStreamToEnd(proc.stdout ?? {});
    const exitCode = await waitForExitCode(proc);
    if (exitCode !== undefined && exitCode !== 0) return undefined;
    return selectClaudeLookupLine(out) || undefined;
  } catch {
    return undefined;
  }
}

function formatLaunchDescription(command: string, args: string[]): string {
  // Arguments can carry a system prompt or an MCP config, so the description
  // is redacted; the environment is never part of it.
  return redactForLog([command, ...args].join(" "));
}

function callHandlers<T>(handlers: Set<(value: T) => void>, value: T): void {
  for (const handler of [...handlers]) {
    try {
      handler(value);
    } catch {
      /* a listener must not break the read loop */
    }
  }
}

class ClaudeCliProcessHandleImpl implements ClaudeCliProcessHandle {
  readonly launchDescription: string;

  private readonly proc: SpawnedProcess;
  private readonly registries: ReadonlyArray<Set<ClaudeCliProcessHandle>>;
  private readonly lineHandlers = new Set<(line: string) => void>();
  private readonly stderrHandlers = new Set<(text: string) => void>();
  private readonly exitHandlers = new Set<(exit: ClaudeCliProcessExit) => void>();
  private readonly exitWaiters = new Set<(exit: ClaudeCliProcessExit) => void>();
  private stdoutBuffer = "";
  private exitRecord: ClaudeCliProcessExit | null = null;
  private terminatePromise: Promise<ClaudeCliProcessExit> | null = null;
  private stdinClosed = false;
  /** Set by terminate() so a kill is not reported as a natural exit. */
  private pendingReason: ClaudeCliProcessExit["reason"] | null = null;

  constructor(
    proc: SpawnedProcess,
    launchDescription: string,
    registries: ReadonlyArray<Set<ClaudeCliProcessHandle>>,
  ) {
    this.proc = proc;
    this.launchDescription = launchDescription;
    this.registries = registries;
    for (const registry of registries) registry.add(this);
    void this.runStdoutLoop();
    void this.runStderrLoop();
  }

  get pid(): number | null {
    const pid = this.proc.pid;
    return typeof pid === "number" ? pid : null;
  }

  get exited(): boolean {
    return this.exitRecord !== null;
  }

  writeLine(line: string): void {
    if (this.exitRecord) {
      throw new ClaudeDirectError(
        "process_exited",
        "The Claude CLI process has exited; cannot write to its stdin",
        { reason: this.exitRecord.reason },
      );
    }
    const payload = line.endsWith("\n") ? line : `${line}\n`;
    try {
      this.proc.stdin?.write?.(payload);
    } catch (error) {
      throw new ClaudeDirectError(
        "process_exited",
        `Writing to the Claude CLI stdin failed: ${describeError(error)}`,
      );
    }
  }

  endInput(): void {
    if (this.stdinClosed) return;
    this.stdinClosed = true;
    try {
      this.proc.stdin?.close?.();
    } catch {
      /* the process may already be gone */
    }
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
    if (this.exitRecord) {
      const exit = this.exitRecord;
      // A late subscriber still learns the process is gone.
      queueTask(() => {
        if (this.exitHandlers.has(handler)) handler(exit);
      });
    }
    return () => this.exitHandlers.delete(handler);
  }

  /**
   * The Agent SDK schedule: close stdin and wait `graceMs` for the CLI to
   * leave on its own, then SIGTERM, then SIGKILL `forceAfterMs` after that.
   */
  terminate(
    options?: ClaudeCliTerminateOptions,
  ): Promise<ClaudeCliProcessExit> {
    if (this.exitRecord) return Promise.resolve(this.exitRecord);
    if (this.terminatePromise) return this.terminatePromise;
    const graceMs = Math.max(
      0,
      options?.graceMs ?? CLAUDE_CLI_TERMINATE_DEFAULTS.graceMs,
    );
    const forceAfterMs = Math.max(
      0,
      options?.forceAfterMs ?? CLAUDE_CLI_TERMINATE_DEFAULTS.forceAfterMs,
    );
    this.pendingReason = "terminated";
    this.terminatePromise = (async () => {
      this.endInput();
      const graceful = await this.waitForExit(graceMs);
      if (graceful) return graceful;
      this.kill(false);
      const killed = await this.waitForExit(forceAfterMs);
      if (killed) return killed;
      this.pendingReason = "killed";
      this.kill(true);
      const forced = await this.waitForExit(forceAfterMs);
      if (forced) return forced;
      // The process never reported an exit; record one so callers of
      // terminate() and close() are never left waiting on it.
      return this.settleExit({
        code: null,
        signal: "SIGKILL",
        reason: "killed",
      });
    })();
    return this.terminatePromise;
  }

  private kill(force: boolean): void {
    try {
      if (force) this.proc.kill?.(0);
      else this.proc.kill?.();
    } catch {
      /* already gone */
    }
  }

  private waitForExit(timeoutMs: number): Promise<ClaudeCliProcessExit | null> {
    if (this.exitRecord) return Promise.resolve(this.exitRecord);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (exit: ClaudeCliProcessExit) => {
        if (timer !== undefined) clearTimeout(timer);
        this.exitWaiters.delete(waiter);
        resolve(exit);
      };
      this.exitWaiters.add(waiter);
      timer = setTimeout(() => {
        this.exitWaiters.delete(waiter);
        resolve(null);
      }, timeoutMs);
    });
  }

  private settleExit(exit: ClaudeCliProcessExit): ClaudeCliProcessExit {
    if (this.exitRecord) return this.exitRecord;
    this.exitRecord = exit;
    for (const registry of this.registries) registry.delete(this);
    callHandlers(this.exitWaiters, exit);
    this.exitWaiters.clear();
    callHandlers(this.exitHandlers, exit);
    return exit;
  }

  private emitLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    callHandlers(this.lineHandlers, line);
  }

  private async runStdoutLoop(): Promise<void> {
    const stdout = this.proc.stdout;
    if (!stdout?.readString) {
      await this.reportProcessExit();
      return;
    }
    for (;;) {
      let chunk: string | null | undefined;
      try {
        chunk = await stdout.readString();
      } catch {
        break;
      }
      if (!chunk) break;
      this.stdoutBuffer += chunk;
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) this.emitLine(line);
    }
    const tail = this.stdoutBuffer;
    this.stdoutBuffer = "";
    this.emitLine(tail);
    await this.reportProcessExit();
  }

  private async runStderrLoop(): Promise<void> {
    const stderr = this.proc.stderr;
    if (!stderr?.readString) return;
    for (;;) {
      let chunk: string | null | undefined;
      try {
        chunk = await stderr.readString();
      } catch {
        break;
      }
      if (!chunk) break;
      const text = redactForLog(chunk);
      if (text) callHandlers(this.stderrHandlers, text);
    }
  }

  private async reportProcessExit(): Promise<void> {
    if (this.exitRecord) return;
    const exitCode = await waitForExitCode(this.proc);
    if (this.exitRecord) return;
    const reason = this.pendingReason ?? "natural";
    this.settleExit({
      code: typeof exitCode === "number" ? exitCode : null,
      signal: null,
      reason,
    });
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function queueTask(task: () => void): void {
  setTimeout(task, 0);
}

type SpawnerOptions = {
  subprocess?: SubprocessLike;
  /** Production spawners publish their handles so the quit path can drain them. */
  registerGlobally?: boolean;
};

function createSpawner(options: SpawnerOptions): ClaudeCliProcessSpawner {
  const liveHandles = new Set<ClaudeCliProcessHandle>();
  const registries: Array<Set<ClaudeCliProcessHandle>> = [liveHandles];
  if (options.registerGlobally !== false) registries.push(globalLiveHandles);

  const getSubprocess = async (): Promise<SubprocessLike> =>
    options.subprocess ?? (await loadSubprocessModule());

  return {
    async resolveBinary(
      input?: ClaudeCliDiscoveryInput,
    ): Promise<ClaudeCliBinaryResolution> {
      const preferred = (input?.preferredPath || "").trim();
      if (preferred) return { path: preferred, source: "explicit" };
      const fromEnv = getRuntimeEnvValue("CLAUDE_PATH");
      if (fromEnv) return { path: fromEnv, source: "env" };
      const info = getRuntimePlatformInfo();
      let subprocess: SubprocessLike | null = null;
      try {
        subprocess = await getSubprocess();
      } catch {
        subprocess = null;
      }
      const found = await resolveBinaryFromShellLookup(info, subprocess);
      if (found) return { path: found, source: "shell_lookup" };
      throw new ClaudeDirectError(
        "binary_not_found",
        `The claude CLI was not found. Set the Claude CLI path in preferences or make \`claude\` available on the PATH of ${info.shellName}.`,
        { platform: info.platform },
      );
    },

    async spawn(
      request: ClaudeCliSpawnRequest,
    ): Promise<ClaudeCliProcessHandle> {
      const subprocess = await getSubprocess();
      const launchDescription = formatLaunchDescription(
        request.binaryPath,
        request.args,
      );
      let proc: SpawnedProcess;
      try {
        proc = await subprocess.call({
          command: request.binaryPath,
          arguments: request.args,
          workdir: request.cwd,
          stderr: "pipe",
          ...(request.environment
            ? { environment: request.environment, environmentAppend: true }
            : {}),
        });
      } catch (error) {
        throw new ClaudeDirectError(
          "spawn_failed",
          `Failed to spawn the claude CLI (${launchDescription}): ${describeError(error)}`,
          { launchDescription },
        );
      }
      if (!proc || typeof proc !== "object" || !proc.stdin) {
        throw new ClaudeDirectError(
          "spawn_failed",
          `The claude CLI process has no stdin (${launchDescription})`,
          { launchDescription },
        );
      }
      debugLog(`spawned ${launchDescription}`);
      return new ClaudeCliProcessHandleImpl(proc, launchDescription, registries);
    },

    liveProcesses(): readonly ClaudeCliProcessHandle[] {
      return [...liveHandles];
    },

    async terminateAll(options?: ClaudeCliTerminateOptions): Promise<void> {
      const handles = [...liveHandles];
      await Promise.all(
        handles.map((handle) =>
          handle.terminate(options).catch(() => undefined),
        ),
      );
    },
  };
}

export function createClaudeCliProcessSpawner(): ClaudeCliProcessSpawner {
  return createSpawner({ registerGlobally: true });
}

/** Injects a `Subprocess`-like object and keeps the handles out of the quit registry. */
export function createClaudeCliProcessSpawnerForTest(
  subprocess: SubprocessLike,
): ClaudeCliProcessSpawner {
  return createSpawner({ subprocess, registerGlobally: false });
}

/** Zotero quit hook: no `claude` child outlives the application. */
export async function terminateAllClaudeCliProcesses(
  options?: ClaudeCliTerminateOptions,
): Promise<void> {
  const handles = [...globalLiveHandles];
  await Promise.all(
    handles.map((handle) => handle.terminate(options).catch(() => undefined)),
  );
}
