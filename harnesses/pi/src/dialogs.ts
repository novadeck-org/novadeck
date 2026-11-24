import { refuse } from "@novadeck/harness-core/dialogs"
import type { DialogAdapter, ScreenRequest } from "@novadeck/harness-core/dialogs"

import { confirm, select, trust, trustOf, trustTitle } from "./choice-dialog.js"
import { editorHint, inputHint, selectHint } from "./dialog-screen.js"
import { editor, input } from "./field-dialog.js"

/**
 * pi's dialogs, as its TUI draws them and takes keys (probed 2026-11-24, 1.6.0;
 * fixtures/dialogs.probe.json). pi asks no permission and has no question tool of its own: what
 * waits on the person is what an extension of theirs asks with pi's own dialogs, which
 * Novadeck's extension reports as each opens (`ui_prompt_start`, its kind and title, not its
 * options): a select (`ctx.ui.select`, a question), a confirm (`ctx.ui.confirm`, Yes or No, a
 * permission), an input (`ctx.ui.input`, a line of text) and an editor (`ctx.ui.editor`, lines of
 * text, filled in). The request names its kind as its tool and its title as `input.title`; the
 * dialog on screen is read only where its title is that one. The other request is the trust
 * prompt pi draws as it starts, which only the screen tells (`screenRequest`). Each dialog's look
 * is in `dialog-screen.ts`.
 *
 * Escape cancels any of them (the extension gets nothing, its turn goes on), so nothing here
 * presses it but to close the transcript's search over one (`reveal`). Ctrl-C does the same, but
 * twice within a second ends pi: never pressed.
 */

/** The transcript's search, over the top right of the screen, whose field takes the keys. */
const search = /│ Find in transcript\s+│/

export const dialogs: DialogAdapter = {
  read: (rows, request) => {
    switch (request.tool) {
      case "select":
        return select(rows, request)
      case "confirm":
        return confirm(rows, request)
      case "input":
        return input(rows, request)
      case "editor":
        return editor(rows, request)
      case "trust":
        return trust(rows, request)
      default:
        return refuse("dialogs.read.1")
    }
  },
  // The trust prompt asks before pi's extensions load, so only the screen tells it.
  screenRequest: (rows): ScreenRequest | undefined => {
    const now = trustOf(rows)
    return now
      ? {
          kind: "question",
          tool: "trust",
          input: { title: trustTitle, folder: now.folder },
          subject: trustTitle,
        }
      : undefined
  },
  // The transcript's search (Ctrl+Shift+F) takes the keys while a dialog shows in the box's
  // place; Escape closes it (probed 2026-11-24, 1.6.0, `searchCsiU120x40` of
  // fixtures/input-box.probe.json). With no search open an Escape would cancel the dialog, so it
  // goes only where both show.
  reveal: (rows) =>
    rows.some((row) => search.test(row)) &&
    rows.some((row) => selectHint.test(row) || inputHint.test(row) || editorHint.test(row))
      ? "\x1b"
      : undefined,
}
