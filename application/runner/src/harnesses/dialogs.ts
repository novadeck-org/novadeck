import type { RequestAnswer, RequestDialog } from "@novadeck/protocol"

/**
 * Answering a request from outside the agent's TUI, as the person would with its keys.
 * Each harness has an adapter (`Harness["dialogs"]`, in its own folder) that alone knows
 * how its dialogs look and which keys answer them; the shared driver
 * (`terminals/answers.ts`) only reads the screen, asks the adapter, presses what it says
 * and checks what it predicts. Nothing outside an adapter parses a dialog.
 *
 * An adapter never guesses. It recognises a dialog only in full, and only where what it
 * read agrees with what the request asks (its question text and option labels, its
 * command, its file), and returns undefined otherwise: a dialog an update changed reads as
 * unrecognised, and the request falls back to its raw text and the terminal.
 */

/** What a request waiting on the person asks, as its harness's hooks told it. */
export type RequestFacts = {
  readonly kind: "permission" | "question" | "plan"
  /** The tool it asks about, in the harness's own words. */
  readonly tool: string
  /** The tool's input as the hook gave it, where it gave one: questions, a command, a plan. */
  readonly input: unknown
  /**
   * The session's working directory from its binding, where known, so an adapter can
   * resolve the paths a dialog shows (a relative file, `~`).
   */
  readonly cwd: string | null
}

/**
 * A dialog the adapter can answer: what it offers, as the protocol shows it, but for its
 * `id`, a fingerprint of the read that the driver gives it. A `choices` dialog's `detail`
 * is the adapter's to give: what the dialog shows of what it asks about (the command, the
 * tool's arguments, the permission), as the terminal draws it.
 */
export type ReadDialog =
  | Omit<Extract<RequestDialog, { type: "choices" }>, "id">
  | Omit<Extract<RequestDialog, { type: "questions" }>, "id">
  | Omit<Extract<RequestDialog, { type: "form" }>, "id">

/**
 * One step of an answer: keys written to the terminal as the person's (`press`, raw bytes
 * such as "1", "\r", "\x1b[B"); text typed into a field the dialog opened (`type`, written
 * as one bracketed paste where the screen takes them); or a wait until the screen shows
 * what the next step needs (`until`), failing the answer when `timeoutMs` passes first.
 * `why` says what it waits for, in the driver's log.
 */
export type KeyStep =
  | { readonly press: string }
  | { readonly type: string }
  | {
      readonly until: (rows: readonly string[]) => boolean
      readonly timeoutMs: number
      readonly why: string
    }

/**
 * The dialog on screen for a request, as its adapter recognised it. The driver reads it
 * once the screen has settled, refuses it where it reads for more than one pending
 * request, and checks the fingerprint the answer names on the screen read and again on the
 * one right before the first key, never after: later steps rely on the adapter's own `until`
 * waits. After a `type` step it waits for the typed text to show before going on.
 */
export type DialogRead = {
  readonly dialog: ReadDialog
  /**
   * The steps that give `answer`, from the screen as read; undefined when this dialog
   * can't take it (an option it doesn't have, words where it takes none).
   */
  readonly keys: (answer: RequestAnswer) => readonly KeyStep[] | undefined
  /**
   * Whether a later screen shows the dialog answered: gone, or moved on as answering it
   * should. The driver waits for it after the last step; a screen that never shows it
   * fails the answer.
   */
  readonly answered: (rows: readonly string[]) => boolean
}

/** A request the screen alone tells, as a prompt that fires no hook. */
export type ScreenRequest = Omit<RequestFacts, "cwd"> & {
  /** What it asks about, shortly, as the request's `subject`. */
  readonly subject: string | null
}

export type DialogAdapter = {
  /**
   * The dialog on screen for this request, recognised in full and agreeing with what the
   * request asks; undefined when the screen shows none, or one the adapter can't vouch
   * for. `rows` are the visible screen's rows as text, top to bottom.
   */
  readonly read: (rows: readonly string[], request: RequestFacts) => DialogRead | undefined
  /**
   * Requests the screen alone tells, which no hook reports (Codex's plan prompt): what
   * the current screen asks, or undefined. Absent where hooks report them all.
   */
  readonly screenRequest?: (rows: readonly string[]) => ScreenRequest | undefined
}
