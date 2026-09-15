/**
 * Composes the text of one Direct CLI turn.
 *
 * Bridge mode hands the bridge service a context envelope alongside the user's
 * text, so the model learns which paper is open and what the user highlighted.
 * Direct mode sends one `user` line to the CLI and has no second channel, so
 * the same facts have to travel inside that line. Without this, a turn whose
 * whole text is "translate" reaches the model with no passage attached and the
 * model can only ask what to translate.
 *
 * `renderTurnContextEnvelopeForModel` renders the scope (library, papers,
 * selection counts and locators) but deliberately never the passage text, so
 * the passages are rendered here.
 */
import type { AgentRuntimeRequest } from "../agent/types";
import {
  buildTurnContextEnvelope,
  renderTurnContextEnvelopeForModel,
} from "../agent/context/turnContextEnvelope";
import { formatSelectedTextLocator } from "../services/context/selectedTextAnchorFormatting";

/** At most this many highlighted passages travel with a turn. */
const MAX_PASSAGES = 6;
/** Per-passage character budget; a longer passage is cut with a marker. */
const MAX_PASSAGE_CHARS = 4000;
/** Budget across every passage, so a large multi-select cannot dominate. */
const MAX_TOTAL_PASSAGE_CHARS = 12000;

const OPEN_TAG = "<zotero-turn-context>";
const CLOSE_TAG = "</zotero-turn-context>";

function clip(text: string, limit: number): { text: string; cut: boolean } {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= limit) return { text: normalized, cut: false };
  return { text: normalized.slice(0, limit), cut: true };
}

/**
 * The passages the user highlighted, with their source and PDF locator so the
 * model can cite them the way the host expects.
 */
function renderSelectedPassages(
  envelope: ReturnType<typeof buildTurnContextEnvelope>,
): string[] {
  const anchorsByIndex = new Map(
    envelope.resolvedSelectedTextAnchors.map((anchor) => [
      anchor.contextIndex,
      anchor,
    ]),
  );
  const lines: string[] = [];
  let spent = 0;
  envelope.selectedTextContexts
    .slice(0, MAX_PASSAGES)
    .forEach((context, index) => {
      const raw = typeof context.text === "string" ? context.text : "";
      if (!raw.trim()) return;
      const remaining = MAX_TOTAL_PASSAGE_CHARS - spent;
      if (remaining <= 0) return;
      const { text, cut } = clip(raw, Math.min(MAX_PASSAGE_CHARS, remaining));
      if (!text) return;
      spent += text.length;
      const locator = formatSelectedTextLocator(
        context as Parameters<typeof formatSelectedTextLocator>[0],
        anchorsByIndex.get(index) as Parameters<
          typeof formatSelectedTextLocator
        >[1],
      );
      const label = [
        `Selected passage ${index + 1}`,
        context.source ? `source=${context.source}` : "",
        locator ? `locator=${locator}` : "",
        cut ? "truncated=true" : "",
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(`${label}:\n"""\n${text}\n"""`);
    });
  const omitted = envelope.selectedTextContexts.length - MAX_PASSAGES;
  if (omitted > 0) {
    lines.push(`(${omitted} further selected passage(s) not included.)`);
  }
  return lines;
}

/**
 * The turn text to write to the CLI: the Zotero context block, when the turn
 * has any context, followed by exactly what the user typed. A turn with no
 * scope, and any turn whose scope cannot be rendered, falls back to the user's
 * text alone, which is what Direct mode sent before this change.
 */
export function buildClaudeDirectTurnText(
  request: AgentRuntimeRequest,
): string {
  const userText = request.userText || "";
  try {
    const envelope = buildTurnContextEnvelope(request);
    const scope = renderTurnContextEnvelopeForModel(envelope).trim();
    const passages = renderSelectedPassages(envelope);
    if (!scope && !passages.length) return userText;
    const block = [OPEN_TAG, scope, ...passages, CLOSE_TAG]
      .filter(Boolean)
      .join("\n");
    return userText.trim() ? `${block}\n\n${userText}` : block;
  } catch {
    // A scope the renderer cannot read must never cost the user their turn;
    // the model then sees exactly what they typed, as it did before this.
    return userText;
  }
}
