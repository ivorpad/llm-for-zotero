import type { AgentRuntime } from "../agent/runtime";
import type {
  AgentEvent,
  AgentPendingAction,
  AgentRuntimeOutcome,
  AgentRuntimeRequest,
} from "../agent/types";
import {
  buildClaudeBridgeCustomInstruction,
  buildDocumentOutcomeInstruction,
  buildPlanAwareClaudePermissionMetadata,
  requestLocalDocuments,
  resolveClaudeBridgeModelForMetadata,
  resolveClaudeEffortForRequest,
  type AgentRuntimeLike,
  type RunTurnParams,
} from "../agent/externalBackendBridge";
import { resolveAgentRuntimeRequest } from "../agent/context/resolvedAgentRequest";
import { buildAgentModelCapabilities } from "../agent/model/contentCapabilities";
import type {
  ClaudeCliInitializeResponse,
  ClaudeCliProcessSpawner,
  ClaudeDirectEffort,
  ClaudeDirectPermissionMode,
  ClaudeDirectSession,
  ClaudeDirectSessionConfig,
  ClaudeDirectSessionFactory,
  ClaudeDirectSettingSource,
} from "../claudeCodeDirect/contract";
import { createClaudeDirectEventPipeline } from "./directRuntimeEvents";
import { createClaudeDirectSession } from "../claudeCodeDirect/session";
import { createClaudeCliProcessSpawner } from "../utils/claudeCliProcess";
import { buildClaudeDirectFallbackCatalog } from "./directRuntimeCatalog";
import {
  normalizeClaudeModelCatalog,
  type ClaudeModelCatalog,
  type ClaudeModelCatalogRequestContext,
} from "./modelCatalog";
import {
  getClaudeCliPathPref,
  getClaudePermissionModePref,
  getClaudeSettingSourcesByPref,
} from "./prefs";
import { getClaudeRuntimeRootDir } from "./projectSkills";
import type { ClaudePermissionMode } from "../shared/claudePermissionMode";

/** Same shape as `ClaudeSlashCommandDescriptor`, kept local to avoid a cycle. */
type DirectSlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  source: "sdk" | "fallback";
};

declare const Zotero: {
  DataDirectory?: { dir?: string };
} & Record<string, unknown>;

/** How long a conversation's CLI process survives after its last mount left. */
const SESSION_CLOSE_DELAY_MS = 10 * 60 * 1000;
const MODEL_CATALOG_TTL_MS = 10 * 60 * 1000;

const DIRECT_EXTERNAL_ACTION_MESSAGE =
  "Zotero actions are not available in Direct CLI mode yet";

export type ClaudeDirectRuntimePrefs = {
  getPermissionMode: () => ClaudePermissionMode;
  getSettingSources: () => readonly ClaudeDirectSettingSource[];
  getCliPath: () => string;
  getRuntimeRootDir: () => string;
  getDataDir: () => string | null;
};

export type ClaudeDirectRuntimeDeps = {
  coreRuntime: AgentRuntime;
  sessionFactory?: ClaudeDirectSessionFactory;
  spawner?: ClaudeCliProcessSpawner;
  prefs?: Partial<ClaudeDirectRuntimePrefs>;
  now?: () => number;
  /** Close delay after the last mount releases a conversation. */
  closeDelayMs?: number;
  generateSessionId?: () => string;
};

export type ClaudeDirectRuntime = AgentRuntimeLike & {
  /** Close every CLI process. The Zotero quit path goes through here. */
  dispose: () => Promise<void>;
};

type PooledSession = {
  session: ClaudeDirectSession;
  config: ClaudeDirectSessionConfig;
  mounts: Set<string>;
  closeTimer: ReturnType<typeof setTimeout> | null;
  initializePromise: Promise<ClaudeCliInitializeResponse> | null;
};

function defaultDataDir(): string | null {
  try {
    return Zotero?.DataDirectory?.dir?.trim() || null;
  } catch {
    return null;
  }
}

function resolvePrefs(
  overrides?: Partial<ClaudeDirectRuntimePrefs>,
): ClaudeDirectRuntimePrefs {
  return {
    getPermissionMode: getClaudePermissionModePref,
    getSettingSources: getClaudeSettingSourcesByPref,
    getCliPath: getClaudeCliPathPref,
    getRuntimeRootDir: getClaudeRuntimeRootDir,
    getDataDir: defaultDataDir,
    ...(overrides || {}),
  };
}

/**
 * The pref carries two host-only modes. `auto` and `dontAsk` describe how
 * Zotero itself asks, and the CLI has no equivalent, so both become `default`
 * and the user still sees every prompt. `bypassPermissions` is passed through
 * only because the pref says so; nothing here falls back to it.
 */
export function toClaudeDirectPermissionMode(
  mode: ClaudePermissionMode,
): ClaudeDirectPermissionMode {
  switch (mode) {
    case "acceptEdits":
    case "plan":
    case "bypassPermissions":
      return mode;
    default:
      return "default";
  }
}

function toClaudeDirectEffort(
  effort: ReturnType<typeof resolveClaudeEffortForRequest>,
): ClaudeDirectEffort | undefined {
  return effort && effort !== "auto" ? effort : undefined;
}

function parentDirectory(absolutePath: string): string {
  const normalized = absolutePath.trim();
  if (!normalized) return "";
  const cut = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  if (cut <= 0) return "";
  return normalized.slice(0, cut);
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Fields of the config that a live process cannot be talked out of. */
function structuralSignature(config: ClaudeDirectSessionConfig): string {
  return JSON.stringify({
    cwd: config.cwd,
    addDirs: config.addDirs,
    settingSources: config.settingSources,
    appendSystemPrompt: config.appendSystemPrompt || "",
    effort: config.effort || "",
    mcpConfigJson: config.mcpConfigJson || "",
  });
}

export function createClaudeDirectRuntime(
  deps: ClaudeDirectRuntimeDeps,
): ClaudeDirectRuntime {
  const coreRuntime = deps.coreRuntime;
  const prefs = resolvePrefs(deps.prefs);
  const now = deps.now || (() => Date.now());
  const closeDelayMs =
    typeof deps.closeDelayMs === "number"
      ? deps.closeDelayMs
      : SESSION_CLOSE_DELAY_MS;
  const sessionFactory = deps.sessionFactory || createClaudeDirectSession;
  let spawnerCache = deps.spawner || null;
  const getSpawner = (): ClaudeCliProcessSpawner => {
    if (!spawnerCache) spawnerCache = createClaudeCliProcessSpawner();
    return spawnerCache;
  };
  const generateSessionId =
    deps.generateSessionId ||
    (() => {
      const cryptoRef = (
        globalThis as { crypto?: { randomUUID?: () => string } }
      ).crypto;
      if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
      return `zotero-${now().toString(16)}-${Math.floor(Math.random() * 1e9).toString(16)}`;
    });

  const pool = new Map<number, PooledSession>();
  const mountsByConversation = new Map<number, Set<string>>();
  const resumeIdByConversation = new Map<number, string>();
  let catalogCache: { catalog: ClaudeModelCatalog; expiresAt: number } | null =
    null;
  let slashCommands: DirectSlashCommand[] = [];
  let runSequence = 0;

  const mountsFor = (conversationKey: number): Set<string> => {
    const existing = mountsByConversation.get(conversationKey);
    if (existing) return existing;
    const created = new Set<string>();
    mountsByConversation.set(conversationKey, created);
    return created;
  };

  const cancelCloseTimer = (entry: PooledSession): void => {
    if (entry.closeTimer === null) return;
    clearTimeout(entry.closeTimer);
    entry.closeTimer = null;
  };

  const closeSession = async (conversationKey: number): Promise<boolean> => {
    const entry = pool.get(conversationKey);
    if (!entry) return false;
    pool.delete(conversationKey);
    cancelCloseTimer(entry);
    const resumeId = entry.session.cliSessionId;
    if (resumeId) resumeIdByConversation.set(conversationKey, resumeId);
    try {
      await entry.session.close();
    } catch {
      // A process that already died is the state close() aims for.
    }
    return true;
  };

  const scheduleClose = (conversationKey: number): void => {
    const entry = pool.get(conversationKey);
    if (!entry) return;
    cancelCloseTimer(entry);
    entry.closeTimer = setTimeout(() => {
      entry.closeTimer = null;
      void closeSession(conversationKey);
    }, closeDelayMs);
  };

  const buildSessionConfig = (
    request: AgentRuntimeRequest,
  ): ClaudeDirectSessionConfig => {
    const localDocuments = requestLocalDocuments(request);
    const addDirs = dedupe([
      prefs.getDataDir() || "",
      ...localDocuments.map((document) =>
        parentDirectory(document.absolutePath),
      ),
    ]);
    const appendSystemPrompt = [
      buildClaudeBridgeCustomInstruction({
        rawPdfMode: localDocuments.length > 0,
      }),
      request.planContext?.phase === "planning"
        ? "Plan mode is active. Research and draft a structured plan only. Do not mutate Zotero, files, settings, processes, or external systems. Exit plan mode only when the plan is ready for explicit user approval."
        : "",
      buildDocumentOutcomeInstruction(request),
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      cwd: prefs.getRuntimeRootDir(),
      addDirs,
      permissionMode: toClaudeDirectPermissionMode(
        buildPlanAwareClaudePermissionMetadata(request).permissionMode,
      ),
      settingSources: prefs.getSettingSources(),
      model: resolveClaudeBridgeModelForMetadata(request.model),
      effort: toClaudeDirectEffort(resolveClaudeEffortForRequest(request)),
      appendSystemPrompt,
      preferredBinaryPath: prefs.getCliPath() || null,
    };
  };

  const startSession = async (
    conversationKey: number,
    config: ClaudeDirectSessionConfig,
  ): Promise<PooledSession> => {
    const resumeSessionId = resumeIdByConversation.get(conversationKey);
    const session = sessionFactory(
      resumeSessionId
        ? { ...config, resumeSessionId }
        : { ...config, sessionId: generateSessionId() },
      { spawner: getSpawner(), now },
    );
    const entry: PooledSession = {
      session,
      config,
      mounts: mountsFor(conversationKey),
      closeTimer: null,
      initializePromise: null,
    };
    pool.set(conversationKey, entry);
    try {
      await session.start();
    } catch (error) {
      pool.delete(conversationKey);
      throw error;
    }
    if (session.cliSessionId) {
      resumeIdByConversation.set(conversationKey, session.cliSessionId);
    }
    return entry;
  };

  const ensureSession = async (
    request: AgentRuntimeRequest,
  ): Promise<PooledSession> => {
    const conversationKey = request.conversationKey;
    const config = buildSessionConfig(request);
    const existing = pool.get(conversationKey);
    if (!existing) return startSession(conversationKey, config);
    cancelCloseTimer(existing);
    if (structuralSignature(existing.config) !== structuralSignature(config)) {
      await closeSession(conversationKey);
      return startSession(conversationKey, config);
    }
    try {
      if (existing.config.model !== config.model) {
        await existing.session.setModel(config.model);
      }
      if (existing.config.permissionMode !== config.permissionMode) {
        await existing.session.setPermissionMode(config.permissionMode);
      }
    } catch {
      // The CLI refused to change mid-session; a fresh process with --resume
      // keeps the conversation and gets the requested settings.
      await closeSession(conversationKey);
      return startSession(conversationKey, config);
    }
    existing.config = config;
    return existing;
  };

  const initializeSession = async (
    entry: PooledSession,
  ): Promise<ClaudeCliInitializeResponse> => {
    if (!entry.initializePromise) {
      entry.initializePromise = entry.session.initialize().catch((error) => {
        entry.initializePromise = null;
        throw error;
      });
    }
    return entry.initializePromise;
  };

  const anyPooledSession = (
    context?: ClaudeModelCatalogRequestContext,
  ): PooledSession | null => {
    const requested = Number(context?.conversationKey);
    if (Number.isFinite(requested)) {
      const entry = pool.get(Math.floor(requested));
      if (entry) return entry;
    }
    for (const entry of pool.values()) return entry;
    return null;
  };

  /** A short-lived session used only to ask the CLI what it can do. */
  const probeInitialize = async (): Promise<ClaudeCliInitializeResponse> => {
    const session = sessionFactory(
      {
        cwd: prefs.getRuntimeRootDir(),
        addDirs: dedupe([prefs.getDataDir() || ""]),
        permissionMode: toClaudeDirectPermissionMode(prefs.getPermissionMode()),
        settingSources: prefs.getSettingSources(),
        preferredBinaryPath: prefs.getCliPath() || null,
        sessionId: generateSessionId(),
      },
      { spawner: getSpawner(), now },
    );
    try {
      await session.start();
      return await session.initialize();
    } finally {
      void session.close().catch(() => undefined);
    }
  };

  const loadInitializeResponse = async (
    context?: ClaudeModelCatalogRequestContext,
  ): Promise<ClaudeCliInitializeResponse> => {
    const entry = anyPooledSession(context);
    return entry ? initializeSession(entry) : probeInitialize();
  };

  const listModels = async (
    force = false,
    context?: ClaudeModelCatalogRequestContext,
  ): Promise<ClaudeModelCatalog> => {
    if (!force && catalogCache && catalogCache.expiresAt > now()) {
      return catalogCache.catalog;
    }
    try {
      const response = await loadInitializeResponse(context);
      const catalog = normalizeClaudeModelCatalog({
        modelInfos: response.models || [],
      });
      if (!catalog.models.length) {
        throw new Error("The Claude CLI reported no models");
      }
      catalogCache = { catalog, expiresAt: now() + MODEL_CATALOG_TTL_MS };
      return catalog;
    } catch {
      // No CLI, no login, or an old CLI without a models list: the aliases
      // still work, and the preferences picker needs something to show.
      return buildClaudeDirectFallbackCatalog();
    }
  };

  const listEfforts = async (
    model?: string,
    context?: ClaudeModelCatalogRequestContext,
  ): Promise<string[]> => {
    const requested = (model || "").trim();
    if (!requested) return [];
    const catalog = await listModels(false, context);
    const entry = catalog.models.find(
      (candidate) =>
        candidate.value === requested || candidate.resolvedModel === requested,
    );
    return entry?.supportedEffortLevels ? [...entry.supportedEffortLevels] : [];
  };

  const refreshSlashCommands = async (): Promise<void> => {
    const entry = anyPooledSession();
    if (!entry) return;
    try {
      const response = await initializeSession(entry);
      slashCommands = (response.commands || []).map((command) => ({
        name: command.name,
        description:
          typeof command.description === "string" ? command.description : "",
        argumentHint:
          typeof command.argumentHint === "string"
            ? command.argumentHint
            : undefined,
        source: "sdk" as const,
      }));
    } catch {
      slashCommands = [];
    }
  };

  const registerPermissionPrompt = (
    entry: PooledSession,
    requestId: string,
    action: AgentPendingAction,
    emit: (event: AgentEvent) => void | Promise<void>,
  ): void => {
    coreRuntime.registerPendingConfirmation(requestId, (resolution) => {
      const decision = resolution.approved
        ? ({ behavior: "allow" } as const)
        : ({ behavior: "deny", message: "Denied in Zotero" } as const);
      void (async () => {
        try {
          await entry.session.respondToPermission(requestId, decision);
        } finally {
          await emit({
            type: "confirmation_resolved",
            requestId,
            approved: resolution.approved,
            actionId: resolution.actionId,
            data: resolution.data,
          });
        }
      })();
    });
  };

  const runTurn = async (
    rawParams: RunTurnParams,
  ): Promise<AgentRuntimeOutcome> => {
    const resolved =
      "turnPaperScope" in rawParams.request
        ? (rawParams.request as AgentRuntimeRequest)
        : resolveAgentRuntimeRequest(rawParams.request);
    const request = await coreRuntime.prepareExecutionRequest(resolved, {
      signal: rawParams.signal,
      permissionOwner: "external_runtime",
    });
    runSequence += 1;
    const runId = `claude-direct-${now().toString(36)}-${runSequence}`;
    await rawParams.onStart?.(runId);

    const emit = async (event: AgentEvent): Promise<void> => {
      await rawParams.onEvent?.(event);
    };

    const entry = await ensureSession(request);
    const pipeline = createClaudeDirectEventPipeline({
      emit,
      now,
      getSessionId: () => entry.session.cliSessionId,
      model: entry.config.model,
      onPermissionRequest: (requestId, action) =>
        registerPermissionPrompt(entry, requestId, action, emit),
      onPermissionCancelled: (requestId) => {
        coreRuntime.resolveConfirmation(requestId, false);
      },
    });
    const unsubscribe = entry.session.subscribe(pipeline.handle);

    try {
      const result = await entry.session.runTurn(request.userText || "", {
        signal: rawParams.signal,
      });
      await pipeline.drain();
      if (result.is_error) {
        return {
          kind: "fallback",
          runId,
          reason:
            (typeof result.result === "string" && result.result.trim()) ||
            `Claude CLI ended the turn with ${result.subtype}`,
          usedFallback: true,
        };
      }
      const text =
        (typeof result.result === "string" && result.result.trim()) ||
        pipeline.getStreamedText();
      return { kind: "completed", runId, text, usedFallback: false };
    } finally {
      unsubscribe();
    }
  };

  const runtime: ClaudeDirectRuntime = {
    listTools: () => coreRuntime.listTools(),
    prepareExecutionRequest: (request, options) =>
      coreRuntime.prepareExecutionRequest(request, options),
    getToolDefinition: (name: string) => coreRuntime.getToolDefinition(name),
    unregisterTool: (name: string) => coreRuntime.unregisterTool(name),
    registerTool: (tool) => coreRuntime.registerTool(tool),
    registerPendingConfirmation: (requestId, resolve) =>
      coreRuntime.registerPendingConfirmation(requestId, resolve),
    resolveConfirmation: (requestId, approvedOrResolution, data) =>
      coreRuntime.resolveConfirmation(requestId, approvedOrResolution, data),
    getRunTrace: (runId: string) => coreRuntime.getRunTrace(runId),
    getCapabilities: () =>
      buildAgentModelCapabilities({
        streaming: true,
        toolCalls: true,
        contentInputs: {
          images: true,
          pdfDocuments: true,
          nativeFiles: true,
        },
        fileInputs: true,
        reasoning: true,
      }),
    runTurn,
    listExternalActionsSync: () => [],
    refreshExternalActions: async () => undefined,
    listSlashCommandsSync: () =>
      slashCommands.map((command) => ({ ...command })),
    refreshSlashCommands: async () => refreshSlashCommands(),
    listEfforts,
    listModels,
    updateRuntimeRetention: async ({ conversationKey, mountId, retain }) => {
      const mounts = mountsFor(conversationKey);
      if (retain) {
        mounts.add(mountId);
        const entry = pool.get(conversationKey);
        if (entry) cancelCloseTimer(entry);
      } else {
        mounts.delete(mountId);
        if (!mounts.size) scheduleClose(conversationKey);
      }
      return {
        originalConversationKey: `${conversationKey}`,
        scopedConversationKey: `${conversationKey}`,
        retained: mounts.size > 0,
      };
    },
    invalidateSession: async ({ conversationKey }) => {
      const invalidated = await closeSession(conversationKey);
      resumeIdByConversation.delete(conversationKey);
      mountsByConversation.delete(conversationKey);
      return {
        originalConversationKey: `${conversationKey}`,
        scopedConversationKey: `${conversationKey}`,
        invalidated,
      };
    },
    invalidateSessionWithinWriteLock: async ({ conversationKey }) => {
      const invalidated = await closeSession(conversationKey);
      resumeIdByConversation.delete(conversationKey);
      mountsByConversation.delete(conversationKey);
      return {
        originalConversationKey: `${conversationKey}`,
        scopedConversationKey: `${conversationKey}`,
        invalidated,
      };
    },
    invalidateAllHotRuntimes: async () => {
      await Promise.all([...pool.keys()].map((key) => closeSession(key)));
      resumeIdByConversation.clear();
      return { invalidated: true };
    },
    runExternalAction: async () => {
      throw new Error(DIRECT_EXTERNAL_ACTION_MESSAGE);
    },
    dispose: async () => {
      await Promise.all([...pool.keys()].map((key) => closeSession(key)));
      mountsByConversation.clear();
      catalogCache = null;
      slashCommands = [];
    },
  };

  return runtime;
}
