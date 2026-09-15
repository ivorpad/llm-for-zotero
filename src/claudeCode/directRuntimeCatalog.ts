import type {
  ClaudeModelCatalog,
  ClaudeModelCatalogEntry,
} from "./modelCatalog";

/**
 * Effort levels the Claude CLI accepts for the models that support effort.
 * Haiku has no effort ladder, so its entry below carries an empty list.
 */
export const CLAUDE_DIRECT_EFFORT_LEVELS: readonly string[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * What Direct CLI mode offers when the CLI could not be asked for its own
 * catalog: the four aliases every Claude Code version resolves itself. The
 * alias is passed to `--model` verbatim, so a login with a different default
 * still gets the model its account is entitled to.
 */
const CLAUDE_DIRECT_FALLBACK_MODELS: ReadonlyArray<
  Omit<ClaudeModelCatalogEntry, "supportedEffortLevels"> & {
    supportedEffortLevels: readonly string[];
  }
> = [
  {
    value: "default",
    displayName: "Default",
    description: "Whatever model your Claude Code login is configured to use.",
    supportsEffort: true,
    supportedEffortLevels: CLAUDE_DIRECT_EFFORT_LEVELS,
  },
  {
    value: "opus",
    displayName: "Opus",
    description: "Anthropic's largest model, for hard multi-step work.",
    supportsEffort: true,
    supportedEffortLevels: CLAUDE_DIRECT_EFFORT_LEVELS,
  },
  {
    value: "sonnet",
    displayName: "Sonnet",
    description: "The balanced default for most Zotero turns.",
    supportsEffort: true,
    supportedEffortLevels: CLAUDE_DIRECT_EFFORT_LEVELS,
  },
  {
    value: "haiku",
    displayName: "Haiku",
    description: "The fastest and cheapest model; no effort control.",
    supportsEffort: false,
    supportedEffortLevels: [],
  },
] as const;

export function buildClaudeDirectFallbackCatalog(): ClaudeModelCatalog {
  return {
    models: CLAUDE_DIRECT_FALLBACK_MODELS.map((entry) => ({
      ...entry,
      supportedEffortLevels: [...entry.supportedEffortLevels],
    })),
    legacy: false,
  };
}
