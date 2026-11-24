# @novadeck/chat-contract

The chat's contract test: real recorded harness transcripts, run through every stage to the
rendered chat. A test-only package; it ships nothing. It may depend on the harnesses and the
chat package at once, which don't depend on each other.

## What it checks

For each harness fixture that carries transcript records (`harnesses/*/src/fixtures`), and for
the hand-written vocabulary conversations (below):

1. the harness's decoder reads each record line (`transcripts.items`);
2. the entries get the index the runner gives them and parse through the protocol's strict
   `transcriptItem`;
3. the runner adapter maps them to the chat's items (`withBatch`);
4. core's `groupItems` makes blocks of them;
5. the chat package's real `Transcript` renders the blocks in jsdom.

The rendered DOM is read as text, one line per block, and compared with a golden in
`src/goldens/`: one file per fixture, a `# scenario` heading for each conversation in it.

```
# deny
user: <text>
tools: tool [other] · failed → 1 line: The user doesn't want to proceed with this tool…
note: Interrupted
```

A tool row reads `title [kind] · detail <what came of it> | Call: <label>: <call lines> →
<result or diff lines>`. The kind is the chat's `data-kind`. The row is opened, so the call part
is `inputBeyondLine`'s text, as the chat shows it, by line count and first line, there only where
it says more than the line, and the label is the one the chat gives it. Calls made inside a
script follow their script's row, each after `in script:`. A run of four or more calls folds in the chat; the golden opens it
and starts with the fold's own line in brackets. A block is read as a person sees it, so a
change to how the chat draws a title, a detail, a kind, a call, a note or a fold shows as a
golden diff.

`sent.test.ts` renders the person's prompts the agent's record doesn't show yet (queued, on
their way, unrecorded, back in the agent's box) among a conversation each harness recorded in
its own shape, against `src/sent/<harness>.txt`: `sent (<state>): <words> · <note> [button]`.

`live.test.ts` renders a conversation each harness's agent still works on, against
`src/live/<harness>.txt`: the latest run's unanswered call reads `→ running`, and a fold that
starts open (the latest run's, while the agent works) reads `[open: …]`. Every other golden is
of a finished conversation.

`slices.test.ts` replays each harness's `fixtures/live-slice.probe.json` through `readSlice`, as
the runner reads screens, the screen at rest kept from state to state, against
`src/slices/<harness>.txt`: for each state its keys, `menu`, `view` or `none`, the screen rows it
spans, `secret` if so, and those rows. A harness that moves what it draws changes the rows.

`wordings.test.ts` reads every permission and plan dialog each harness's `fixtures/ask.probe*.json`
and `tall.probe.json` recorded, with its own dialog adapter and the request its hooks told (the
commands a tall probe names; the adapter's `screenRequest` where only the screen tells it; for
a probe that kept screens alone, the requests its other scenarios recorded, and the few calls
the harness's own dialog tests give for unrecorded ones). The options go through core's
`optionExtras`, against `src/wordings/<harness>.txt`: for each distinct dialog, each scenario
(`name@version`) and the screens (sizes, steps) that show it, then each option as
`label [text] → role, lines "…" / "…", effect "…", armed`. A harness that rewords a dialog
changes a line; an adapter that stops reading one, at any size, drops its scenario or screen.

`outcomes.test.ts` reads each case of a tool's outcome from `tool-outcomes.probe.json`, every
harness's, through the same stages to `groupItems`' entry, against `src/outcomes/<harness>.txt`:
`title · detail → failed …, exit …, running, N lines, +A -R [its first lines]`, or `nothing
known` for an entry the chat keeps today's line for. A call made inside a Codex script reads
`in script:`. It is the chat's data, not yet drawn: the rendered golden of the same fixture
shows today's rows.

A prompt that carried images reads `user (images: Image #1, Image #2): <words>`: the names the
thumbnails show (the words' own `[Image #N]`), with no picture, since nothing here asks a backend.
Each harness's vocabulary has an `image-prompts` conversation: Claude Code's blocks (and one
queued into a running turn), Codex's `input_image` parts and Antigravity's `media` (and a prompt
of 1.4.3, which lists none).

What it does not read: which icon a kind maps to, styling, and the Markdown rendering of
assistant text beyond its words.

## Recorded and hand-written

The recorded fixtures are thin: mostly redacted, naming a handful of tools. So
`src/vocabulary/` holds one set of conversations per harness, written by hand in that
harness's native record shape and read by its real decoder. They are synthetic records that
pin today's rendering, not recordings; see `src/vocabulary/README.md` for what they name. They
are what protects a move of the chat's vocabulary (each harness's `describe`, `inputBeyondLine`,
the tool kinds, the fold).

opencode has no hand-written vocabulary: its transcript is the JSONL Novadeck's plugin writes
(`harnesses/opencode/src/plugin-source.ts`), and every conversation here is a recording of it.
`src/recorded/` keeps the ones this package made (opencode 1.19.6 in a pty on the e2e fake model,
Novadeck's real plugin loaded, paths made generic), one scenario to a prompt: `opencode-outcomes`
(each case of a tool's outcome), `opencode-tools` (the other tools, Novadeck's through a stand-in
MCP server that answers fixed texts, a subagent and its own session, a question, pasted images, the
plan agent, three turns the live test cuts while their calls run), `opencode-attached` (a prompt with an `@file`),
and `opencode-words` (the prompts the sent and turn-start tests share with the other harnesses). The
harness's own `session.probe.json` and `edges.probe.json` sit beside them. What the fake model can't
make has no record: a reasoning part, and the tools `list` and `multiedit`, which 1.19.6 offered no
agent or model it was probed with (`coverage.test.ts`).

pi has no hand-written vocabulary either: its transcript is pi's own session file, and every
conversation here is a recording of it. `src/recorded/` keeps the ones this package made (pi 1.6.0
on a scripted fake model, Novadeck's real extension loaded, its tools through a stand-in of
Novadeck's MCP server that answers fixed texts, paths made generic): `pi-outcomes` (each case of a
tool's outcome), `pi-tools` (the other tools, a codemode script and its own calls, `tool_search`
over a person's deferred MCP server, a person's own MCP tool, Novadeck's tools, pasted images, the
person's `!` command, an answer stopped with Escape, a compaction, and three turns the live test
cuts while their calls run) and `pi-words` (the prompts the sent and turn-start tests share). The
harness's own `session.jsonl` sits beside them. `powershell` has no record: pi offers it on
Windows alone (`coverage.test.ts`).

Where opencode draws less than the others, the tests say so: it has no plan dialog of its own (`wordings.test.ts`); its experimental plan mode asks its plan review through the question dialog, which `harnesses/opencode/src/question-dialog.test.ts` covers.

## Changing a golden

A golden changes only with a reviewed diff. Run the package's tests without `CI` and with
`-u`, and read what changed:

```
pnpm --filter @novadeck/chat-contract exec vitest run -u
git diff frontend/chat-contract/src
```

With `CI=true` a missing or changed golden fails the test instead of being written. The tests
also fail on a golden nothing owns, in `goldens/`, `sent/`, `live/` and `outcomes/`.

A change to a decoder, to `groupItems`, to a harness's `describe` or to the components should
change a golden only when the chat is meant to show something else. A move of code (a package
split, a rename) must leave every golden as it is.

## Fixtures

`src/fixtures.ts` has one small extractor per fixture shape (scenarios of records, a list of
records, Antigravity's steps, Codex's rollout stages, Claude's flattened `transcriptTail`).
Each fixture says how many conversations it has and which scenarios it skips (those with
nothing to render, listed in `src/skipped.ts`), and the test compares both with what the
extractor found. An extractor that finds no records throws; so does a fixture that renders no
block, and one expected to call tools that renders no tool row.
