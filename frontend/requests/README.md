# @novadeck/requests

An agent's request, drawn and answered: what it asks (`ChatRequest`), and the controls of its
dialog (`ChatDialog`). The card, a numbered menu for choices, tabbed pages and a Review for
several questions, a line per field for a form, and the dialog's text or the terminal's own rows
for one it can't read. The chat draws its requests with it, and the Inbox will too
(`architecture/request-surface.md` in the workspace), so a style change or a fix for a harness's
changed dialog lands here once.

## Contract

- **It depends on `core` (and the toolkit where it needs it), and on no other frontend
  package.** Not `frontend/chat`, `frontend/ui` or `frontend/items`, no backend and no
  harness. `scripts/workspace/graph.test.ts` holds it, as it does the chat's. It knows nothing
  of the chat's store, its composer, the Inbox's state or a layout: its hosts pass in what it
  needs.
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
- **Drafts are the dialog's own state for now**: a dialog read again keeps what still means
  the same (`forms.ts`' `keptEntries`, core's `reconcile`).

## Subpaths

Only what its hosts import: `./RequestCard` (the card, with the `RequestPlace` and `Live`
types), `./Hint`, `./shown-controls`, `./submit-on-enter` and `./use-mounted` (which the chat's
composer and transcript use too), and the stylesheet `./requests.css`. `src/test.ts` is
Vitest's re-export for the package's own tests and is not exported. A module is exported when
something outside imports it; the rest of `src` is internal.

## Tests

`forms.test.ts` holds the form's entries. The card and its dialogs are tested through the chat
that draws them (`frontend/chat`'s `Requests.test.ts`) and pinned by `frontend/chat-contract`'s
goldens.

## Tailwind and the cascade

The package's TSX uses Tailwind utilities (`sr-only`, which other folders write too, so it has
no build guard), and the UI's `styles.css` scans `src` with `@source` (and leaves the tests out).
`requests.css` is imported by `styles.css` into `layer(components)` right after the chat's
`chat.css`, the rules it held before. Its classes keep their `chat-` names, and it reads the
chat's private tokens (`--_ink`, `--_pad` and the rest, which `.chat` sets) and draws the head's
key, the spinner and the error line with the chat's `.chat-key`, `.chat-spin` and `.chat-error`:
a host that isn't the chat sets those tokens and classes, until the Inbox's adoption gives the
package its own.
