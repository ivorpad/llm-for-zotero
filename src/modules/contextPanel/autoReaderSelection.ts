import {
  getActiveContextAttachmentFromTabs,
  getActiveReaderSelectionText,
  getSelectedTextContextEntries,
  type SelectedTextPageLocation,
} from "./contextResolution";
import { getActiveReaderForSelectedTab } from "../../services/pdf/zoteroReaderTabs";
import { resolvePaperContextRefFromAttachment } from "../../services/paperContent/paperAttribution";
import { getCurrentSelectionPageLocationFromReader } from "./livePdfSelectionLocator";
import { activeContextPanels } from "./state";
import {
  includeReaderSelectedText,
  type IncludeReaderSelectedTextInput,
  type IncludeReaderSelectedTextResult,
} from "./readerTextInclusion";
import { TTLMap } from "../../utils/ttlMap";
import type { PaperContextRef, SelectedTextContext } from "./types";

/**
 * Highlighting a passage in the reader does not attach it to the turn; the
 * "Add Text" button does. Users read that as a bug — they highlight, type
 * "translate", and the model has nothing to translate. So when a turn is about
 * to be sent with no text context at all, fall back to whatever the reader is
 * still showing as selected.
 *
 * Only ever a fallback: an explicit attachment always wins, and the attached
 * passage is dropped after the turn like any other unpinned text context.
 */
export type AutoAttachReaderSelectionOutcome =
  | "attached"
  | "already-attached"
  | "already-used"
  | "no-selection"
  | "not-attached";

// The reader selection stays readable for five minutes after the popup closes,
// which is what lets the fallback find it once focus has moved to the composer.
// The same lifetime would otherwise re-send one highlight on every follow-up
// turn, so remember what each conversation already pulled in and take it once.
// Mirrors that cache's own bounds; a lost entry only costs an Add Text click.
const autoAttachedTextByConversation = new TTLMap<number, string>(
  5 * 60 * 1000,
  50,
);

export function resetAutoAttachedReaderSelections(): void {
  autoAttachedTextByConversation.clear();
}

export type AutoAttachReaderSelectionInput = {
  body: Element;
  conversationKey: number;
  isGlobalConversation: boolean;
  log?: (message: string, ...args: unknown[]) => void;
};

export type AutoAttachReaderSelectionDependencies = {
  getSelectedTextContextEntries: (
    conversationKey: number,
  ) => SelectedTextContext[];
  getReaderSelectionText: (body: Element) => string;
  getActiveReader: () => any | null;
  getSelectionLocation: (
    reader: any,
    selectedText: string,
  ) => SelectedTextPageLocation | null;
  resolveReaderPaperContext: () => PaperContextRef | null;
  includeReaderSelectedText: (
    input: IncludeReaderSelectedTextInput,
  ) => Promise<IncludeReaderSelectedTextResult>;
};

const defaultDependencies: AutoAttachReaderSelectionDependencies = {
  getSelectedTextContextEntries,
  getReaderSelectionText: (body) =>
    getActiveReaderSelectionText(
      body.ownerDocument as Document,
      activeContextPanels.get(body)?.() ?? null,
    ),
  getActiveReader: () => getActiveReaderForSelectedTab(),
  getSelectionLocation: (reader, selectedText) =>
    getCurrentSelectionPageLocationFromReader(reader, selectedText),
  resolveReaderPaperContext: () =>
    resolvePaperContextRefFromAttachment(getActiveContextAttachmentFromTabs()),
  includeReaderSelectedText: (input) => includeReaderSelectedText(input),
};

export async function autoAttachReaderSelection(
  input: AutoAttachReaderSelectionInput,
  dependencies: AutoAttachReaderSelectionDependencies = defaultDependencies,
): Promise<AutoAttachReaderSelectionOutcome> {
  const conversationKey = Math.floor(Number(input.conversationKey || 0));
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) {
    return "not-attached";
  }
  if (dependencies.getSelectedTextContextEntries(conversationKey).length) {
    return "already-attached";
  }

  let selectedText = "";
  try {
    selectedText = dependencies.getReaderSelectionText(input.body) || "";
  } catch (error) {
    input.log?.("LLM autoAddText: reader selection lookup failed", error);
    return "no-selection";
  }
  if (!selectedText) return "no-selection";
  if (autoAttachedTextByConversation.get(conversationKey) === selectedText) {
    return "already-used";
  }

  const reader = dependencies.getActiveReader();
  let initialLocation: SelectedTextPageLocation | null = null;
  if (reader) {
    try {
      initialLocation = dependencies.getSelectionLocation(reader, selectedText);
    } catch (error) {
      input.log?.("LLM autoAddText: page-location lookup failed", error);
    }
  }

  // Paper Chat already knows which paper it is about; only Library Chat has to
  // name the reader's paper on the passage. This mirrors the Add Text button.
  const paperContext = input.isGlobalConversation
    ? dependencies.resolveReaderPaperContext()
    : null;

  const result = await dependencies.includeReaderSelectedText({
    body: input.body,
    conversationKey,
    selectedText,
    reader,
    paperContext,
    initialLocation,
    suppressFeedback: true,
    log: input.log,
  });
  if (!result.added) return "not-attached";
  autoAttachedTextByConversation.set(conversationKey, selectedText);
  return "attached";
}
