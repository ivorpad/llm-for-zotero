import { assert } from "chai";
import {
  appendSelectedTextContextForItem,
  getSelectedTextContextEntries,
} from "../src/modules/contextPanel/contextResolution";
import {
  autoAttachReaderSelection,
  resetAutoAttachedReaderSelections,
  type AutoAttachReaderSelectionDependencies,
} from "../src/modules/contextPanel/autoReaderSelection";
import {
  includeReaderSelectedText,
  type IncludeReaderSelectedTextInput,
} from "../src/modules/contextPanel/readerTextInclusion";
import { clearAllState } from "../src/modules/contextPanel/state";
import type { PaperContextRef } from "../src/modules/contextPanel/types";

type FakeStatus = { textContent: string; className: string };

function fakePanelBody(conversationKey: number): {
  body: Element;
  status: FakeStatus;
  inputFocused: () => boolean;
} {
  const root = { dataset: { itemId: `${conversationKey}` } };
  const status: FakeStatus = { textContent: "", className: "" };
  let focused = false;
  const input = {
    focus: () => {
      focused = true;
    },
  };
  const body = {
    isConnected: true,
    querySelector: (selector: string) => {
      if (selector === "#llm-main") return root;
      if (selector === "#llm-status") return status;
      if (selector === "#llm-input") return input;
      return null;
    },
  } as unknown as Element;
  return { body, status, inputFocused: () => focused };
}

const readerPaper: PaperContextRef = {
  itemId: 71,
  contextItemId: 72,
  title: "Reader paper",
};

function dependencies(
  overrides: Partial<AutoAttachReaderSelectionDependencies> = {},
): AutoAttachReaderSelectionDependencies & {
  inclusionCalls: IncludeReaderSelectedTextInput[];
} {
  const inclusionCalls: IncludeReaderSelectedTextInput[] = [];
  return {
    inclusionCalls,
    getSelectedTextContextEntries,
    getReaderSelectionText: () => "highlighted passage",
    getActiveReader: () => ({ itemID: 72 }),
    getSelectionLocation: () => ({ contextItemId: 72, pageIndex: 4 }),
    resolveReaderPaperContext: () => readerPaper,
    includeReaderSelectedText: (input) => {
      inclusionCalls.push(input);
      return includeReaderSelectedText(input, {
        getCurrentLocation: () => null,
        resolveLocation: async () => null,
      });
    },
    ...overrides,
  };
}

describe("auto reader selection", function () {
  afterEach(function () {
    clearAllState();
    resetAutoAttachedReaderSelections();
  });

  it("sends the reader highlight when the turn has no text context", async function () {
    const conversationKey = 9201;
    const panel = fakePanelBody(conversationKey);
    const deps = dependencies();

    const outcome = await autoAttachReaderSelection(
      { body: panel.body, conversationKey, isGlobalConversation: false },
      deps,
    );

    assert.equal(outcome, "attached");
    const entries = getSelectedTextContextEntries(conversationKey);
    assert.lengthOf(entries, 1);
    assert.deepInclude(entries[0], {
      text: "highlighted passage",
      source: "pdf",
      contextItemId: 72,
      pageIndex: 4,
    });
  });

  it("leaves the panel status and composer focus alone", async function () {
    const conversationKey = 9202;
    const panel = fakePanelBody(conversationKey);

    await autoAttachReaderSelection(
      { body: panel.body, conversationKey, isGlobalConversation: false },
      dependencies(),
    );

    assert.equal(panel.status.textContent, "");
    assert.isFalse(panel.inputFocused());
  });

  it("never overrides text the user attached explicitly", async function () {
    const conversationKey = 9203;
    const panel = fakePanelBody(conversationKey);
    appendSelectedTextContextForItem(conversationKey, "chosen by hand", "pdf");
    const deps = dependencies();

    const outcome = await autoAttachReaderSelection(
      { body: panel.body, conversationKey, isGlobalConversation: false },
      deps,
    );

    assert.equal(outcome, "already-attached");
    assert.lengthOf(deps.inclusionCalls, 0);
    const entries = getSelectedTextContextEntries(conversationKey);
    assert.lengthOf(entries, 1);
    assert.equal(entries[0]!.text, "chosen by hand");
  });

  it("attaches nothing when the reader has no selection", async function () {
    const conversationKey = 9204;
    const panel = fakePanelBody(conversationKey);
    const deps = dependencies({ getReaderSelectionText: () => "" });

    const outcome = await autoAttachReaderSelection(
      { body: panel.body, conversationKey, isGlobalConversation: false },
      deps,
    );

    assert.equal(outcome, "no-selection");
    assert.lengthOf(deps.inclusionCalls, 0);
    assert.lengthOf(getSelectedTextContextEntries(conversationKey), 0);
  });

  it("takes one highlight once, not on every follow-up turn", async function () {
    const conversationKey = 9205;
    const panel = fakePanelBody(conversationKey);
    const deps = dependencies();
    const input = {
      body: panel.body,
      conversationKey,
      isGlobalConversation: false,
    };

    assert.equal(await autoAttachReaderSelection(input, deps), "attached");
    // The turn consumed the passage the way an unpinned context is consumed.
    clearAllState();
    assert.equal(await autoAttachReaderSelection(input, deps), "already-used");
    assert.lengthOf(deps.inclusionCalls, 1);

    // A fresh highlight is a new passage and goes in.
    const nextDeps = dependencies({
      getReaderSelectionText: () => "a later passage",
    });
    assert.equal(await autoAttachReaderSelection(input, nextDeps), "attached");
    assert.equal(
      getSelectedTextContextEntries(conversationKey)[0]!.text,
      "a later passage",
    );
  });

  it("names the reader's paper in library chat only", async function () {
    const paperPanel = fakePanelBody(9206);
    const paperDeps = dependencies();
    await autoAttachReaderSelection(
      {
        body: paperPanel.body,
        conversationKey: 9206,
        isGlobalConversation: false,
      },
      paperDeps,
    );
    assert.isNull(paperDeps.inclusionCalls[0]!.paperContext ?? null);

    resetAutoAttachedReaderSelections();
    const globalPanel = fakePanelBody(9207);
    const globalDeps = dependencies();
    await autoAttachReaderSelection(
      {
        body: globalPanel.body,
        conversationKey: 9207,
        isGlobalConversation: true,
      },
      globalDeps,
    );
    assert.deepEqual(globalDeps.inclusionCalls[0]!.paperContext, readerPaper);
  });

  it("ignores a conversation key that is not a real target", async function () {
    const panel = fakePanelBody(9208);
    const deps = dependencies();

    const outcome = await autoAttachReaderSelection(
      { body: panel.body, conversationKey: 0, isGlobalConversation: false },
      deps,
    );

    assert.equal(outcome, "not-attached");
    assert.lengthOf(deps.inclusionCalls, 0);
  });
});
