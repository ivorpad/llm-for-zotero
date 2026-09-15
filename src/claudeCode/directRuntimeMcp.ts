import type {
  AgentConfirmationResolution,
  AgentEvent,
  AgentPendingAction,
  AgentRuntimeRequest,
} from "../agent/types";
import { buildClaudeZoteroMcpScope } from "../agent/externalBackendBridge";
import {
  getOrCreateZoteroMcpBearerToken,
  getZoteroMcpServerName,
  getZoteroMcpServerUrl,
  qualifyZoteroMcpToolName,
  registerScopedZoteroMcpScope,
  resolveConversationScopeToken,
  ZOTERO_MCP_AUTH_HEADER,
  ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
  ZOTERO_MCP_SCOPE_HEADER,
  type ZoteroMcpActiveScope,
} from "../agent/mcp/server";
import { isNativeZoteroMcpToolsEnabled } from "../codexAppServer/prefs";
import { getClaudeProfileSignature } from "./projectSkills";

/** The handle `registerScopedZoteroMcpScope` hands back for one turn's scope. */
export type ClaudeDirectScopedMcp = {
  token: string;
  clear: () => void;
  getState: () => ZoteroMcpActiveScope | null;
};

/**
 * Everything the direct runtime needs from the Zotero MCP server, injected so
 * the runtime's tests stay hermetic: nothing here reads Zotero prefs or the
 * live server unless the real defaults are used.
 */
export type ClaudeDirectMcpDeps = {
  /** When false the runtime behaves exactly as it did before MCP: no config, no scope. */
  isEnabled: () => boolean;
  getProfileSignature: () => string;
  getServerUrl: () => string;
  getBearerToken: () => string;
  getServerName: (profileSignature?: string) => string;
  resolveScopeToken: (params: {
    profileSignature?: string;
    conversationKey: number;
  }) => string;
  buildScope: (
    request: AgentRuntimeRequest,
    profileSignature: string,
  ) => ZoteroMcpActiveScope;
  registerScope: (
    scope: ZoteroMcpActiveScope,
    options: { token?: string },
  ) => ClaudeDirectScopedMcp;
  authHeader: string;
  scopeHeader: string;
  safeReadToolNames: readonly string[];
};

export function resolveClaudeDirectMcpDeps(
  overrides?: Partial<ClaudeDirectMcpDeps>,
): ClaudeDirectMcpDeps {
  return {
    isEnabled: isNativeZoteroMcpToolsEnabled,
    getProfileSignature: getClaudeProfileSignature,
    getServerUrl: getZoteroMcpServerUrl,
    getBearerToken: getOrCreateZoteroMcpBearerToken,
    getServerName: getZoteroMcpServerName,
    resolveScopeToken: resolveConversationScopeToken,
    buildScope: buildClaudeZoteroMcpScope,
    registerScope: registerScopedZoteroMcpScope,
    authHeader: ZOTERO_MCP_AUTH_HEADER,
    scopeHeader: ZOTERO_MCP_SCOPE_HEADER,
    safeReadToolNames: ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
    ...(overrides || {}),
  };
}

/**
 * The `--mcp-config` value for the claude CLI. This is the CLI's own schema
 * (`mcpServers.<key>.{type,url,headers}`), not Codex's `buildZoteroMcpConfigValue`
 * shape. The bearer token lives in the header value and never leaves this
 * string, so no caller logs it.
 */
export function buildClaudeDirectMcpConfigJson(
  deps: ClaudeDirectMcpDeps,
  params: { serverName: string; scopeToken: string },
): string {
  return JSON.stringify({
    mcpServers: {
      [params.serverName]: {
        type: "http",
        url: deps.getServerUrl(),
        headers: {
          [deps.authHeader]: `Bearer ${deps.getBearerToken()}`,
          [deps.scopeHeader]: params.scopeToken,
        },
      },
    },
  });
}

/**
 * A predicate over the qualified tool names the CLI reports in `can_use_tool`.
 * The read tools (`mcp__<server>__paper_read`, `library_search`, ...) are
 * answered `allow` without a card so a paper read does not prompt every call.
 */
export function buildClaudeDirectMcpReadToolMatcher(
  deps: ClaudeDirectMcpDeps,
  serverName: string,
): (toolName: string) => boolean {
  const readNames = new Set(
    deps.safeReadToolNames.map((name) =>
      qualifyZoteroMcpToolName(serverName, name),
    ),
  );
  return (toolName: string): boolean => readNames.has(toolName);
}

/**
 * Registers one turn's scope under the conversation-stable token and wires the
 * two host channels the MCP server calls back on: `publishHostEvent` for tool
 * activity and `requestInteraction` for a write that needs the user's nod.
 * The caller keeps the returned `clear` and releases it when the turn ends.
 */
export function activateClaudeDirectMcpScope(
  deps: ClaudeDirectMcpDeps,
  params: {
    request: AgentRuntimeRequest;
    profileSignature: string;
    scopeToken: string;
    publishHostEvent: (event: AgentEvent) => Promise<void>;
    requestInteraction: (
      action: AgentPendingAction,
    ) => Promise<AgentConfirmationResolution>;
  },
): ClaudeDirectScopedMcp {
  const scope = deps.buildScope(params.request, params.profileSignature);
  scope.publishHostEvent = params.publishHostEvent;
  scope.requestInteraction = params.requestInteraction;
  return deps.registerScope(scope, { token: params.scopeToken });
}
