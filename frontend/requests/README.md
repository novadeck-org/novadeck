# @novadeck/requests

An agent's request, drawn and answered: what it asks (`ChatRequest`), and the controls of its
dialog (`ChatDialog`). The card, one numbered menu, tabbed pages and a Review for several
questions, a line per field for a form, what a request asks in full, and the dialog's text or
the terminal's own rows for one it can't read. The chat draws its requests with it, and so does
the Inbox: a request's sheet is the same `RequestCard`, and the Inbox's own kinds (an agent's
ask, a held message, trouble, an update) are drawn in its frame (`RequestFrame`) with its menu
and detail box (`architecture/request-surface.md` in the workspace), so a style change or a fix
for a harness's changed dialog lands here once, for both.

## Contract

- **It depends on `core` (and the toolkit where it needs it), and on no other frontend
  package.** Not `frontend/chat`, `frontend/ui` or `frontend/items`, no backend and no harness.
  `scripts/workspace/graph.test.ts` holds it: of the frontend, the package's manifest names only
  the core and the toolkit, and nothing it reaches is the chat, the UI, the items package, a
  backend or a harness. It knows nothing of the chat's store, its composer, the Inbox's state or
  a layout: its hosts pass in what it needs.
- **It is a renderer over core's request.** The request and its dialog are core's
  (`conversation`), and what an answer is, is core's `conversation/picks`. The package draws
  them and builds the answer the person gives.
- **`send` is the only way an answer leaves.** `RequestCard` takes
  `send(answer): Promise<void>`, which settles once the answer took and rejects with why not;
  the card holds its controls while one goes and shows the failure's message.
- **What only a host has comes in as props**, each optional where a host may not have it:
  - `place`: where the card sits, for focus and scrolling. `area` is the part of the page whose
    focus a dialog may take as it appears (while that focus holds none of the person's words),
    `scroller` what scrolls the card. The chat gives `.chat` and `.chat-requests`.
  - `live`: the terminal's own rows of a dialog no adapter read, drawn by the host (the chat's
    `LiveSlice`), and whether the person's keys reach the terminal from them.
  - `clock`: how long the request has waited, in the host's own look and clock (the chat's
    `Fact` and `Since`).
  - `notice`: a line to say under the dialog (the chat's "Another identical request").
  - `handedBack`: whether a failed answer took all the same, its words handed elsewhere to send
    (the chat's `WordsLost`): the dialog's fields empty.
  - `replying`, `replySending`, `onReply`: the host's own box answering a question dialog in its
    place. Without `onReply`, only a dialog whose words go on as the agent's prompt offers to
    talk it over.
  - `onSubmitted`, `onSettled`, `onEdited`: the person submitted from the card, the card went
    after an answer took, the person edited the dialog.
  - `draft`: where the host keeps what the person put in and hasn't sent (`drafts.ts`'
    `DialogDraft`: the words typed into a choices dialog's options, a dialog of questions' picks
    and page, a form's entries), with the way to change it. The Inbox keeps it with its row, so
    it lasts the sheet closing; without it (the chat) the dialog keeps its own while drawn.
  - `menu`: a `MenuHandle` on the menu the person is on (the choices', or the question page on
    screen's, or a form's), for keys the host takes on its own row or title (the Inbox's).
  - `arrived`: the host moved on to the card from an answer (the Inbox): focus comes to its
    dialog, and for a moment no key or click answers it, on any dialog.
  - `detail`: the host's own box in place of what a choices dialog asks in full (the Inbox's
    plan, read from the transcript and drawn as Markdown, `.request-plan`).
  - `fieldRefused`: why words typed into a field of the agent's won't go, where its harness says
    (the Inbox: Antigravity's field, which takes no `/`, `?`, `!` first, nor an `@`).
- **A dialog read again keeps what still means the same** (`forms.ts`' `keptEntries`, core's
  `reconcile`), the host's draft or its own.
- **One menu, `Menu`**, for a request's options: the chat's choices, and every Inbox card's. The
  question pages, their Review and a form keep rows of their own (`use-menu.ts`'s `useMenu`), in
  the same look and with the same keys; `forwardKey` and `goToRow` take a host's keys for them as
  the `Menu`'s handle does. A host gives it
  rows (`MenuItem`: its words as the host draws them, a scope and an effect line under them, ticked
  or chosen, armed first, a field for the person's own words in the row's place, a way out that
  answers nothing, more to show under the menu) and is told which was pressed. Its keys are
  `menu-keys.ts`'s, pure. Where the host moves on to it from an answer (`arrived`, the Inbox), it
  takes focus from the host's `area` and, for a moment, no key; the host's own row and title forward
  their keys through its `key`/`go` handle. A row that takes the person's own words is a field in
  the row's place, typed into as it is reached, the row's label its placeholder and its name; it
  takes as many characters as the way its words go: `answerWordsLimit` (16,384, a request's answer
  and an agent's prompt), or the host's own (the Inbox's 4,096 for an ask's reply).
- **The harness's words as written**: the chat's choices show an option's label verbatim, with
  what core reads into it (`conversation/extras`) beside it, never in its place: a standing
  yes's scope on a line under its head, what a plan's standing yes lets the agent do, and that
  answer armed before it sends.
- **`Detail`** shows what a request asks in full: whatever draws as nothing as a mark
  (`command-view.ts`), how many lines, the folder and a Copy where the host has them.

## Subpaths

Only what its hosts import: `./RequestCard` (the card and its frame, with the `RequestPlace` and
`Live` types), `./Menu`, `./Detail` and `./drafts` (the Inbox's sheets), `./Hint`, `./shown-controls`, `./submit-on-enter`
and `./use-mounted` (which the chat uses beyond its requests too: its composer, transcript, tool
rows and view), and the stylesheet `./requests.css`. `src/test.ts` is Vitest's re-export for the package's own tests and is not
exported. A module is exported when something outside imports it; the rest of `src` is internal.

## Tests

`forms.test.ts` holds the form's entries, `menu-keys.test.ts` the menu's keys, `use-menu.test.ts`
the keys a host passes on, `drafts.test.ts` what a draft holds and `command-view.test.ts` the
marks. The card and its dialogs are tested through the views that
draw them: the chat's (`frontend/chat`'s `Requests.test.ts`, pinned by `frontend/chat-contract`'s
goldens) and the Inbox's (`frontend/ui`'s `ConsoleSheet.test.ts`).

## Tailwind and the cascade

The package's TSX uses Tailwind utilities (`sr-only`, which other folders write too, so it has no
build guard), and the UI's `styles.css` scans `src` with `@source` (and leaves the tests out).
Copy is the toolkit's `Tooltip` over the app's `icon-button`.
`requests.css` is imported by `styles.css` into `layer(components)` right after the chat's
`chat.css`, the place of the rules it held before. Its classes are `request-*`, and it reads its
host's private tokens (`--_ink`, `--_mid`, `--_muted`, `--_accent`, `--_red`, `--_line`, `--_pad`,
`--_lh`, and `--_inset` where no card sets it): `.chat` sets them for the chat, and chat.css's
`.chat-inline` (the chat's tokens and type, none of its layout) for the Inbox's sheets, whose
`.console-page` sets only `--_pad`, the sheet's edge. The card draws its answered line's spinner
and its error line with the chat's `.chat-spin` and `.chat-error`, which both hosts load.
