# Vocabulary conversations

Hand-written records, not recordings. Each file holds conversations in one harness's native
record shape (Claude's JSONL with `tool_use` and `tool_result`, a Codex rollout, Antigravity's
steps), so they go through that harness's real decoder like any fixture.

They exist because the recorded fixtures are thin: they name a handful of tools, mostly
redacted, while the chat's vocabulary (`toolSummary`, `inputText`, the tool kinds, the fold)
knows many more. Between them they name every tool each harness's branch of `knownTool`
knows, every Novadeck tool in each harness's spelling, a non-Novadeck MCP call, an input and a
result over 16 KiB, a tool name over 256 characters, a result with no call, a run long enough
to fold, the plain interruption and another agent's message (Codex).

Their goldens pin today's rendering. They were written from the code before the vocabulary
moved (2b), and a move must leave them as they are. Changing a record here changes a golden;
review both together.
