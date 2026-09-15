# Claude Code CLI stream-json fixtures

Captured on 2026-09-15 from Claude Code CLI 2.1.272 (`claude --version`) on macOS, model alias `haiku`,
cwd an empty scratch directory with no project settings. Each `.jsonl` file holds the CLI's stdout
one JSON object per line, exactly as emitted, except for the value substitutions listed at the bottom.

## Files

`one-word-haiku.stream.jsonl`

    echo '{"type":"user","message":{"role":"user","content":"Reply with one word."}}' \
      | claude -p --output-format stream-json --input-format stream-json --verbose --model haiku

`one-word-haiku-partial.stream.jsonl`: the same prompt with `--include-partial-messages` added, so the
file also contains `stream_event` lines (`message_start`, `content_block_start`, `content_block_delta`
with `thinking_delta`, `signature_delta` and `text_delta`, `content_block_stop`, `message_delta`, `message_stop`).

`permission-write-haiku.stdout.jsonl` and `permission-write-haiku.stdin.jsonl`: a full permission round trip.
The CLI was spawned with

    claude -p --output-format stream-json --input-format stream-json --verbose --include-partial-messages \
      --permission-prompt-tool stdio --permission-mode default --model haiku

The `.stdin` file is what the client wrote, in order: a `control_request` with subtype `initialize`, the user
turn asking for a Write tool call, and the `control_response` that allowed the `can_use_tool` request.
The `.stdout` file contains the CLI's `control_response` to `initialize` (which carries the `models` list,
`commands`, `agents` and `account`), the `control_request` with subtype `can_use_tool` for the Write tool,
the tool result as a `user` message, and the final `result`.

Read-only Bash commands such as `echo` are auto-approved by the CLI in `default` mode and produce no
`can_use_tool` request. That is why the tool call in this fixture is a Write.

## Substitutions

Personal values were replaced after capture without changing any type, subtype or field name:
the scratch cwd became `/tmp/claude-direct-fixture`, the home directory became `/Users/example`,
`account.email` and `account.organization` became placeholders, and the `slash_commands`, `agents`,
`skills`, `plugins`, `memory_paths` (init) and `commands`, `agents` (initialize response) lists were cut
to their first two entries. The `input_json_delta` chunks were re-split after the path substitution so
their concatenation still equals the `tool_use.input` of the following `assistant` message.
