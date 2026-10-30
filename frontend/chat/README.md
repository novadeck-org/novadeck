# @novadeck/chat

The chat view: what a terminal shows when an agent's conversation is drawn as a chat rather
than as its screen. A transcript of the conversation's blocks (the person's words, the agent's
Markdown, the tool runs and their folds, notes), the requests an agent waits on, the composer,
and the chat's own store and commands.

## Contract

- **It depends on `core` and `toolkit`, and on no other frontend package.** Not `frontend/ui`,
  `frontend/items` or `frontend/runner-adapter`, no backend and no harness. Two checks in
  `scripts/workspace/graph.test.ts` hold this: the manifest edges (what it declares, and what
  those reach), and a source check that no relative import in a frontend package's `src` leaves
  that package's folder, so a path into the UI can't bypass the manifest. The host
  (`frontend/ui`) composes it and passes in what it needs; the chat knows nothing of a
  project, a layout or the companion pane.
- **It is a renderer over a conversation's items.** The items and their grouping into blocks
  are core's (`conversation`, `conversation/turns`), and the rules for what an answer is are
  core's `conversation/picks`. The package draws them, and `Markdown` is the toolkit's.
- **State is the chat's own store** (`state.ts`): `createChat` gives the drafts, the held
  replies, the sends in flight and the terminals shown as their screen while answered there,
  with their pure updates and selectors (`chatShown`, `chatDraftOf`, `chatReplyOf`,
  `chatSendOf`), and `watchChat`, which keeps the chat modes in step with the workspace.
  `state.ts` is React-free; `use-chat.ts` holds `useChat`, the one hook that reads the store.
- **Writes go through `createChatCommands`** (`commands.ts`), which the host builds with the
  store, the conversations, how a terminal is opened and the current context. What navigates
  (showing a terminal) stays the host's, and it calls the chat's `answerInTerminal`.
- **The view gets what it shows as props.** `WorkspaceTerminal` passes `ChatView` its draft,
  reply and send, and the callbacks that act on them.
- **Behaviour is pinned by `frontend/chat-contract`**, which renders recorded harness
  transcripts through `Transcript` and compares them with goldens.

## Subpaths

Only what the host and the contract test import: `./ChatView`, `./Transcript` (the contract
test renders it), `./state` (store, selectors and types), `./use-chat`, `./commands`, and the
stylesheet `./chat.css`. `src/test.ts` is Vitest's re-export for the package's own tests and
is not exported. A module is exported when something outside imports it; the rest of `src` is
internal.

## Tailwind and the cascade

The package's TSX uses Tailwind utilities (none that only it writes, so it has no build guard),
and the UI's `styles.css` scans `src` with `@source` (and leaves the tests out). `chat.css` is
imported by `styles.css` into `layer(components)` at the place it always had, right after the
toolkit's `markdown.css`, so the chat's rules for the Markdown it holds come after the Markdown's own.
A moved or new stylesheet that goes elsewhere changes the cascade.
