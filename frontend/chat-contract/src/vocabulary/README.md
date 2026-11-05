# Vocabulary conversations

Hand-written records, not recordings. Each file holds conversations in one harness's native
record shape (Claude's JSONL with `tool_use` and `tool_result`, a Codex rollout, Antigravity's
steps), so they go through that harness's real decoder like any fixture.

They exist because the recorded fixtures are thin: they name a handful of tools, mostly
redacted, while the chat's vocabulary (each harness's `describe`, `inputText`, the tool kinds,
the fold) knows many more. With the recorded fixtures, they name every Novadeck tool in each
harness's spelling, and every tool each harness's `describe` knows but these, which no
recording shows yet:

- Claude Code: `PowerShell` (its Windows shell tool).
- Codex: `clock.curr_time`, `image_generation`, `list_dir`, `list_mcp_resources`,
  `list_mcp_resource_templates`, `read_file`, `read_mcp_resource`, `update_goal` and the
  three `mcp__codex_worktrees` tools.
- Antigravity: `list_resources`, `read_resource`.

`src/coverage.test.ts` holds that list to each `describe`: a tool added to one fails it until
a conversation names it or the list does. A conversation for a tool on the list waits for a
real record of it, so its keys are the harness's own: those added since the list was first
written (Novadeck's `done`, `feedback` and `look`, Codex's `clock.sleep` and
`request_user_input_async`) take theirs from real transcripts and rollouts.

They also hold a non-Novadeck MCP call, an input and a result over 16 KiB, a tool name over
256 characters, a result with no call, a run long enough to fold, the plain interruption and
another agent's message (Codex).

Their goldens pin today's rendering. They were written from the code before the vocabulary
moved into each harness's `describe`, and a move must leave them as they are. Changing a
record here changes a golden; review both together.
