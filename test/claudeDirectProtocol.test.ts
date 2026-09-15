import { assert } from "chai";
import {
  buildClaudeCliArgs,
  createStreamAssembler,
  parseClaudeCliLine,
  redactForLog,
  serializeClaudeCliMessage,
} from "../src/claudeCodeDirect/protocol";
import type {
  ClaudeCliInboundMessage,
  ClaudeCliOutboundMessage,
  ClaudeDirectSessionConfig,
} from "../src/claudeCodeDirect/contract";
import { readClaudeDirectFixtureLines } from "./helpers/claudeDirectFakeProcess";

/**
 * The fixtures under test/fixtures/claudeDirect are captures from Claude Code
 * CLI 2.1.272, so they are the only statement about the wire format this test
 * trusts. The per-type counts below come from the README's description of each
 * capture; a CLI change that adds or drops a line type shows up here.
 */
function classify(message: ClaudeCliInboundMessage): string {
  const record = message as Record<string, any>;
  if (record.type === "stream_event") {
    const event = record.event as Record<string, any>;
    const delta = event?.delta as Record<string, any> | undefined;
    return `stream_event:${event?.type}${delta ? `:${delta.type}` : ""}`;
  }
  if (record.type === "control_request") {
    return `control_request:${record.request?.subtype}`;
  }
  if (record.type === "control_response") {
    return `control_response:${record.response?.subtype}`;
  }
  return record.subtype ? `${record.type}:${record.subtype}` : record.type;
}

function countByType(lines: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of lines) {
    const message = parseClaudeCliLine(line);
    assert.isNotNull(message, `line did not parse: ${line.slice(0, 80)}`);
    const key = classify(message!);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

const fullConfig: ClaudeDirectSessionConfig = {
  cwd: "/Users/example/Zotero/llm-for-zotero/claude",
  addDirs: ["/Users/example/Zotero", "/Users/example/Zotero", "  "],
  permissionMode: "default",
  settingSources: ["user", "project"],
  model: "claude-haiku-4-5-20251001",
  effort: "high",
  appendSystemPrompt: "Answer in one sentence.",
  sessionId: "11111111-2222-3333-4444-555555555555",
  startTimeoutMs: 5_000,
};

describe("claude direct protocol", () => {
  describe("parseClaudeCliLine", () => {
    it("parses and classifies every line of the plain turn capture", () => {
      const counts = countByType(
        readClaudeDirectFixtureLines("one-word-haiku.stream.jsonl"),
      );
      assert.deepEqual(counts, {
        "system:hook_started": 7,
        "system:hook_response": 7,
        "system:init": 1,
        "system:status": 1,
        "system:thinking_tokens": 2,
        rate_limit_event: 1,
        assistant: 2,
        "result:success": 1,
      });
    });

    it("parses the partial-message capture, stream events included", () => {
      const counts = countByType(
        readClaudeDirectFixtureLines("one-word-haiku-partial.stream.jsonl"),
      );
      assert.deepEqual(counts, {
        "system:hook_started": 7,
        "system:hook_response": 7,
        "system:init": 1,
        "system:status": 2,
        "system:thinking_tokens": 2,
        rate_limit_event: 1,
        "stream_event:message_start": 1,
        "stream_event:content_block_start": 2,
        "stream_event:content_block_delta:thinking_delta": 2,
        "stream_event:content_block_delta:signature_delta": 1,
        "stream_event:content_block_delta:text_delta": 2,
        "stream_event:content_block_stop": 2,
        "stream_event:message_delta:undefined": 1,
        "stream_event:message_stop": 1,
        assistant: 2,
        "result:success": 1,
      });
    });

    it("parses the permission capture, control traffic included", () => {
      const counts = countByType(
        readClaudeDirectFixtureLines("permission-write-haiku.stdout.jsonl"),
      );
      assert.equal(counts["control_request:can_use_tool"], 1);
      assert.equal(counts["control_response:success"], 1);
      assert.equal(counts["stream_event:content_block_delta:input_json_delta"], 9);
      assert.equal(counts["result:success"], 1);
      assert.equal(counts.user, 1);
    });

    it("returns null for blank lines and for noise the CLI writes to stdout", () => {
      assert.isNull(parseClaudeCliLine(""));
      assert.isNull(parseClaudeCliLine("   \n"));
      assert.isNull(parseClaudeCliLine("Loading plugins..."));
      assert.isNull(parseClaudeCliLine("[1, 2, 3]"));
      assert.isNull(parseClaudeCliLine('{"no":"type"}'));
      assert.isNull(parseClaudeCliLine('{"type":"result"'));
    });
  });

  describe("buildClaudeCliArgs", () => {
    it("builds the argv for a full session config", () => {
      assert.deepEqual(buildClaudeCliArgs(fullConfig), [
        "-p",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
        "--permission-mode",
        "default",
        "--setting-sources",
        "user,project",
        "--model",
        "claude-haiku-4-5-20251001",
        "--effort",
        "high",
        "--append-system-prompt",
        "Answer in one sentence.",
        "--add-dir",
        "/Users/example/Zotero",
        "--session-id",
        "11111111-2222-3333-4444-555555555555",
      ]);
    });

    it("resumes instead of opening a new session and adds the MCP flags", () => {
      const args = buildClaudeCliArgs({
        ...fullConfig,
        resumeSessionId: "aaaa-bbbb",
        mcpConfigJson: '{"mcpServers":{}}',
      });
      assert.include(args, "--resume=aaaa-bbbb");
      assert.notInclude(args, "--session-id");
      assert.include(args, "--mcp-config");
      assert.include(args, "--strict-mcp-config");
    });

    it("passes the skip-permissions flag only in bypassPermissions mode", () => {
      const bypass = buildClaudeCliArgs({
        ...fullConfig,
        permissionMode: "bypassPermissions",
      });
      assert.deepEqual(bypass.slice(9), [
        "--permission-mode",
        "bypassPermissions",
        "--setting-sources",
        "user,project",
        "--model",
        "claude-haiku-4-5-20251001",
        "--effort",
        "high",
        "--append-system-prompt",
        "Answer in one sentence.",
        "--add-dir",
        "/Users/example/Zotero",
        "--session-id",
        "11111111-2222-3333-4444-555555555555",
        "--allow-dangerously-skip-permissions",
      ]);
      for (const mode of ["default", "acceptEdits", "plan"] as const) {
        assert.notInclude(
          buildClaudeCliArgs({ ...fullConfig, permissionMode: mode }),
          "--allow-dangerously-skip-permissions",
        );
      }
    });
  });

  describe("serializeClaudeCliMessage", () => {
    it("reproduces every line the client wrote in the permission capture", () => {
      const lines = readClaudeDirectFixtureLines(
        "permission-write-haiku.stdin.jsonl",
      );
      assert.lengthOf(lines, 3);
      for (const line of lines) {
        const message = JSON.parse(line) as ClaudeCliOutboundMessage;
        assert.equal(serializeClaudeCliMessage(message), `${line}\n`);
      }
    });
  });

  describe("createStreamAssembler", () => {
    it("rebuilds the assistant text of the partial-message capture", () => {
      const assembler = createStreamAssembler();
      for (const line of readClaudeDirectFixtureLines(
        "one-word-haiku-partial.stream.jsonl",
      )) {
        const message = parseClaudeCliLine(line);
        if (message) assembler.handle(message);
      }
      assert.equal(assembler.text(), "Ready.");
      // The capture blanked the thinking text but kept the signature chunk.
      const thinkingBlock = assembler.blocks()[0];
      assert.equal(thinkingBlock.kind, "thinking");
      assert.isTrue(thinkingBlock.signature.length > 0);
      assert.deepEqual(
        assembler.blocks().map((block) => block.kind),
        ["thinking", "text"],
      );
      assert.isTrue(assembler.blocks().every((block) => block.stopped));
    });

    it("rebuilds the Write tool input from the input_json_delta chunks", () => {
      const assembler = createStreamAssembler();
      const messages = readClaudeDirectFixtureLines(
        "permission-write-haiku.stdout.jsonl",
      )
        .map((line) => parseClaudeCliLine(line))
        .filter((message): message is ClaudeCliInboundMessage =>
          Boolean(message),
        );
      for (const message of messages) assembler.handle(message);

      const toolInputs = assembler.toolInputs();
      assert.lengthOf(toolInputs, 1);
      assert.deepEqual(JSON.parse(toolInputs[0]), {
        file_path: "/tmp/claude-direct-fixture/permission-fixture.txt",
        content: "ok",
      });
      // The same value the CLI reported in the assistant message that follows.
      const toolUse = messages
        .filter((message) => message.type === "assistant")
        .flatMap(
          (message) =>
            (message as any).message.content as Array<Record<string, any>>,
        )
        .find((block) => block.type === "tool_use");
      assert.deepEqual(JSON.parse(toolInputs[0]), toolUse?.input);
      assert.equal(assembler.text(), "Done.");
      // Two assistant messages, so the block indices repeat and the assembler
      // keeps them apart by message.
      assert.deepEqual(
        assembler.blocks().map((block) => `${block.messageIndex}:${block.index}`),
        ["0:0", "0:1", "1:0", "1:1"],
      );
    });

    it("ignores lines that are not stream events", () => {
      const assembler = createStreamAssembler();
      assert.isNull(
        assembler.handle({ type: "keep_alive" } as ClaudeCliInboundMessage),
      );
      assert.lengthOf(assembler.blocks(), 0);
    });
  });

  describe("redactForLog", () => {
    it("masks API keys, bearer tokens, authorization fields and long secrets", () => {
      const redacted = redactForLog(
        [
          "key sk-ant-api03-ABCDEF123456-secret",
          "Authorization: Bearer abc123.def456-ghi",
          "proxy handshake Bearer zzz111.yyy222-xxx",
          '{"authorization":"token-value-that-is-secret"}',
          "https://example.test/cb?token=0123456789012345678901234567890123456789abcd",
          "https://example.test/cb?key=0123456789012345678901234567890123456789abcd",
        ].join("\n"),
      );
      assert.notInclude(redacted, "api03");
      assert.notInclude(redacted, "abc123.def456-ghi");
      assert.notInclude(redacted, "token-value-that-is-secret");
      assert.notInclude(redacted, "0123456789012345678901234567890123456789abcd");
      assert.notInclude(redacted, "zzz111.yyy222-xxx");
      assert.include(redacted, "sk-ant-[redacted]");
      assert.include(redacted, "Authorization: [redacted]");
      assert.include(redacted, "proxy handshake Bearer [redacted]");
      assert.include(redacted, "token=[redacted]");
      assert.include(redacted, "key=[redacted]");
    });

    it("leaves ordinary text and short query values alone", () => {
      assert.equal(redactForLog("spawning claude --model haiku"), "spawning claude --model haiku");
      assert.equal(redactForLog("?key=short"), "?key=short");
      assert.equal(redactForLog(""), "");
    });
  });
});
