import type { ScreenText } from "@novadeck/emulator/headless"
import type { RequestAnswer, RequestDialog } from "@novadeck/protocol"

/**
 * Answering a request from outside the agent's TUI, as the person would with its keys.
 * Each harness has an adapter (`Harness["dialogs"]`, in its own folder) that alone knows
 * how its dialogs look and which keys answer them; the shared driver (the runner's
 * `terminals/answers.ts`) only reads the screen, asks the adapter, presses what it says
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
  /**
   * The parts of a request asked in parts that are answered already, by index, as Codex's
   * async questions are one by one: what remains is what its dialog still asks.
   */
  readonly answered?: readonly number[]
  /**
   * Whether the turn that asked it has ended, as the agent's hooks tell, for a request that
   * outlives its turn (one asked without waiting, as Codex's async questions are): what its
   * harness still draws of it then may be a moment from going.
   */
  readonly turnEnded?: true
}

/**
 * A dialog the adapter can answer: what it offers, as the protocol shows it, but for its
 * `id`, a fingerprint of the read that the driver gives it. A `choices` dialog's `detail`
 * is the adapter's to give: what the dialog shows of what it asks about (the command, the
 * tool's arguments, the permission), as the terminal draws it.
 */
export type AnswerableDialog =
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
 * waits, which must follow each `type` step to check its words showed.
 */
export type DialogRead = {
  readonly dialog: AnswerableDialog
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
  /**
   * Where the dialog takes its answer as the agent's next prompt rather than keys, as
   * Codex's async question once the turn that asked it has ended: the prompt that gives
   * `answer`, undefined where it can't take it. Its `keys` and `answered` go unused then;
   * the prompt goes as the person's would, and the request waits until its hooks settle it.
   * Such dialogs never clash with each other on one screen: each prompt names its own.
   */
  readonly prompt?: (answer: RequestAnswer) => string | undefined
  /**
   * Set where this read comes from the request's facts alone, its dialog being held out of
   * view (Claude Code's fullscreen view scrolled up): the keys that bring it into view,
   * answering nothing. Such a read is not answered as it is. The driver presses these, waits
   * until the adapter reads the same request without one, and answers by that read (its
   * `keys`, its `answered`) or sets it aside; `keys` and `answered` of this one go unused.
   * It names no dialog on screen, so it counts only for a request that is the terminal's
   * only one, and its fingerprint differs from the same dialog's shown read.
   */
  readonly reveal?: string
}

/** A request the screen alone tells, as a prompt that fires no hook. */
export type ScreenRequest = Omit<RequestFacts, "cwd"> & {
  /** What it asks about, shortly, as the request's `subject`. */
  readonly subject: string | null
}

/** How one harness's dialogs read on screen and take an answer (see above). */
export type DialogAdapter = {
  /**
   * The dialog on screen for this request, recognised in full and agreeing with what the
   * request asks; undefined when the screen shows none, or one the adapter can't vouch
   * for. `rows` are the visible screen's rows as text, top to bottom. `screen` is the
   * whole screen they were read from, where the caller has it, for an adapter that needs more
   * than the text: the cells a dialog marks only by their background (`ScreenText.lit`).
   */
  readonly read: (
    rows: readonly string[],
    request: RequestFacts,
    screen?: ScreenText,
  ) => DialogRead | undefined
  /**
   * Requests the screen alone tells, which no hook reports (Codex's plan prompt): what
   * the current screen asks, or undefined. Absent where hooks report them all.
   */
  readonly screenRequest?: (rows: readonly string[]) => ScreenRequest | undefined
  /**
   * The keys that bring a dialog held out of view into view, answering nothing: what the
   * person would press to see a dialog their TUI drew where the screen doesn't show it
   * (Claude Code's fullscreen view scrolled up, which leaves only a pill; Codex's `/diff`
   * pager, which says nothing, closed with `q`); undefined when the screen holds none out of
   * view. A screen that may hold one is judged strictly, for the keys are typed into the
   * person's composer anywhere else. The runner presses them only for a terminal no client
   * has in sight, so a person reading it is never moved. Absent for Antigravity, which draws
   * its dialogs over its own views (`/help`, `/skills`). `cursor` is where the terminal's
   * cursor is, which tells which pane has the focus where a TUI shows two (Codex's `/side`
   * sidebar, whose focus holds the root's dialog out of view).
   */
  readonly reveal?: (
    rows: readonly string[],
    cursor?: { readonly row: number; readonly column: number },
  ) => string | undefined
  /**
   * Those of `reveal`'s keys that toggle, which a second press would undo (Codex's Ctrl-/, which
   * moves the focus between its root and a `/side` conversation): pressed at most once for each
   * request.
   */
  readonly revealToggles?: readonly string[]
}

/**
 * Why a read refused, for the log. An adapter's rejections `return refuse("question.footer")`
 * where they used to return undefined bare: the call notes the code in the trace that
 * `explain` opened, if one is open, and returns undefined, so a read behaves as it did and
 * costs a null check where nobody listens. Codes are static string literals of the form
 * `<dialog>.<step>.<n>`, never built from the screen or the request, so they are safe to
 * log. A guard test (`refusals.test.ts` in each harness) keeps adapters to that.
 */
let trace: string[] | undefined

/** Most codes one `explain` keeps: a read tries a few readers, each noting where it stopped. */
const maxRefusals = 32

/** Notes `code` in the open trace, if any, and returns undefined to refuse with. */
export const refuse = (code: string): undefined => {
  if (trace && trace.length < maxRefusals && trace[trace.length - 1] !== code) trace.push(code)
  return undefined
}

/**
 * Runs `fn`, which reads a screen, and gives its result with the codes of every refusal it
 * noted, in order, as a path: a wrapper notes its own after its readers', so the one that
 * decided is usually the first specific to the dialog asked, not the last. Not reentrant: a nested call
 * traces its own run and hands back to the outer one.
 */
export const explain = <T>(fn: () => T): { result: T; refusals: string[] } => {
  const outer = trace
  const own: string[] = []
  trace = own
  try {
    return { result: fn(), refusals: own }
  } finally {
    trace = outer
  }
}
