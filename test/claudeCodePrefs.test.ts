import { assert } from "chai";
import { after, beforeEach, describe, it } from "mocha";
import {
  getClaudeCliPathPref,
  getClaudeCodeRuntimePref,
  getClaudeRuntimeModelPref,
  setClaudeCliPathPref,
  setClaudeCodeRuntimePref,
  setClaudeRuntimeModelPref,
} from "../src/claudeCode/prefs";

describe("Claude Code model preferences", function () {
  const originalZotero = globalThis.Zotero;
  const prefStore = new Map<string, unknown>();

  beforeEach(function () {
    prefStore.clear();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("persists arbitrary model values without lowercasing or stripping suffixes", function () {
    setClaudeRuntimeModelPref("  FutureModel-V7[2m]  ");

    assert.equal(getClaudeRuntimeModelPref(), "FutureModel-V7[2m]");
  });

  it("keeps the previous model when an empty value is submitted", function () {
    setClaudeRuntimeModelPref("claude-fable-5[1m]");
    setClaudeRuntimeModelPref("   ");

    assert.equal(getClaudeRuntimeModelPref(), "claude-fable-5[1m]");
  });

  it("uses sonnet only when no model preference exists", function () {
    assert.equal(getClaudeRuntimeModelPref(), "sonnet");
  });

  it("keeps the bridge runtime until the pref says direct", function () {
    assert.equal(getClaudeCodeRuntimePref(), "bridge");

    setClaudeCodeRuntimePref("direct");
    assert.equal(getClaudeCodeRuntimePref(), "direct");

    setClaudeCodeRuntimePref("bridge");
    assert.equal(getClaudeCodeRuntimePref(), "bridge");
  });

  it("reads an unknown stored runtime value as the bridge", function () {
    prefStore.set("extensions.zotero.llmforzotero.claudeCodeRuntime", "cli");

    assert.equal(getClaudeCodeRuntimePref(), "bridge");
  });

  it("trims the Claude CLI path and defaults it to empty", function () {
    assert.equal(getClaudeCliPathPref(), "");

    setClaudeCliPathPref("  /opt/homebrew/bin/claude  ");
    assert.equal(getClaudeCliPathPref(), "/opt/homebrew/bin/claude");
  });
});
