import { assert } from "chai";
import { buildClaudeDirectTurnText } from "../src/claudeCode/directRuntimeContext";
import type { AgentRuntimeRequest } from "../src/agent/types";

/**
 * The CLI gets one `user` line per turn, so the paper scope and the passages
 * the user highlighted have to travel inside it. A turn that reached the model
 * as the bare word "translate" is the failure these tests pin down.
 */
function buildRequest(
  overrides: Partial<AgentRuntimeRequest> = {},
): AgentRuntimeRequest {
  return {
    conversationKey: 42,
    userText: "translate",
    conversationKind: "paper",
    turnPaperScope: {
      libraryID: 1,
      libraryName: "My Library",
      conversationKind: "paper",
      papers: [],
      collections: [],
      tags: [],
      selectedPassagePaperRefs: [],
    },
    zoteroMetadataContext: { papers: [] },
    ...overrides,
  } as unknown as AgentRuntimeRequest;
}

describe("Claude direct turn text", function () {
  it("carries the highlighted passage and the user's own words", function () {
    const text = buildClaudeDirectTurnText(
      buildRequest({
        selectedTextContexts: [
          {
            text: "Mechanically enforce authority and irreversible effects.",
            source: "pdf",
            pageIndex: 6,
            pageLabel: "7",
            contextItemId: 101,
          },
        ],
      } as unknown as Partial<AgentRuntimeRequest>),
    );
    assert.include(text, "<zotero-turn-context>");
    assert.include(text, "Selected passage 1");
    assert.include(
      text,
      "Mechanically enforce authority and irreversible effects.",
    );
    // The user's text stays last, so the instruction reads after its context.
    assert.match(text, /translate\s*$/);
  });

  it("marks a passage that exceeded its budget instead of silently cutting", function () {
    const long = "x".repeat(9000);
    const text = buildClaudeDirectTurnText(
      buildRequest({
        selectedTextContexts: [{ text: long, source: "pdf" }],
      } as unknown as Partial<AgentRuntimeRequest>),
    );
    assert.include(text, "truncated=true");
    assert.isBelow(text.length, 9000);
  });

  it("falls back to the user's text when the scope cannot be rendered", function () {
    // A malformed scope must cost the user nothing: the model still gets the
    // words they typed, exactly as Direct mode sent them before this change.
    const text = buildClaudeDirectTurnText({
      conversationKey: 7,
      userText: "hello",
      turnPaperScope: { libraryID: 1, conversationKind: "paper" },
    } as unknown as AgentRuntimeRequest);
    assert.equal(text, "hello");
  });

  it("still describes the scope when nothing is highlighted", function () {
    const text = buildClaudeDirectTurnText(buildRequest());
    assert.include(text, "<zotero-turn-context>");
    assert.notInclude(text, "Selected passage");
    assert.match(text, /translate\s*$/);
  });
});
