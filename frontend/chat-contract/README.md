# @novadeck/chat-contract

The chat's contract test: real recorded harness transcripts, run through every stage to the
rendered chat. A test-only package; it ships nothing. It may depend on the harnesses and the
UI at once, which don't depend on each other.

## What it checks

For each harness fixture that carries transcript records (`harnesses/*/src/fixtures`):

1. the harness's decoder reads each record line (`transcripts.items`);
2. the entries get the index the runner gives them and parse through the protocol's strict
   `transcriptItem`;
3. the runner adapter maps them to the chat's items (`withBatch`);
4. core's `groupItems` makes blocks of them;
5. the UI's real `Transcript` renders the blocks in jsdom.

The rendered DOM is read as text, one line per block, and compared with a golden in
`src/goldens/`: one file per fixture, a `# scenario` heading for each conversation in it.

```
# deny
user: <text>
tools: tool → 1 line: The user doesn't want to proceed with this tool…
note: Interrupted
```

A tool block is one line of its rows, `title · detail → result`, where the result is its line
count and first line. A run of four or more calls folds in the chat; the golden opens it and
starts with the fold's own line in brackets. A block is read as a person sees it, so a change
to how the chat draws a title, a detail, a note or a fold shows as a golden diff.

## Changing a golden

A golden changes only with a reviewed diff. Run the package's tests without `CI` and with
`-u`, and read what changed:

```
pnpm --filter @novadeck/chat-contract exec vitest run -u
git diff frontend/chat-contract/src/goldens
```

With `CI=true` a missing or changed golden fails the test instead of being written.

A change to a decoder, to `groupItems`, to `toolSummary` or to the components should change a
golden only when the chat is meant to show something else. A move of code (a package split,
a rename) must leave every golden as it is.

## Fixtures

`src/fixtures.ts` has one small extractor per fixture shape (scenarios of records, a list of
records, Antigravity's steps, Codex's rollout stages, Claude's flattened `transcriptTail`).
An extractor that finds no records throws; so does a fixture that renders no block, and one
expected to call tools that renders no tool row.
