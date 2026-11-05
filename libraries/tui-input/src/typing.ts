import { randomBytes } from "node:crypto"

/** A fresh nonce, short and unguessable enough to tell the line it marks from any other. */
export const freshNonce = (): string => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
  return [...randomBytes(6)].map((byte) => alphabet[byte % alphabet.length]).join("")
}

// C0 controls but the tab, the line feed and the carriage return, DEL, and C1 controls: an
// escape would end the paste early and have what follows typed as keys, a Ctrl-U clear the box.
// eslint-disable-next-line no-control-regex -- Control characters are what it finds.
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/

/** Whether a text can go in a bracketed paste whole, as text: it holds no control character but a tab or line break. */
export const pasteable = (text: string): boolean => !controls.test(text)

/**
 * The line written as one bracketed paste, which the TUI takes as text, never as keys. Throws
 * a `RangeError` for a line that holds a control character but a tab or line break, which
 * could end the paste and press keys: callers keep them out.
 */
export const bracketedPaste = (line: string): string => {
  if (!pasteable(line))
    throw new RangeError(
      "A paste can't hold a control character: the program would take it as keys.",
    )
  return `\x1b[200~${line}\x1b[201~`
}

/** What the gate needs to know of a terminal before it types into it. */
export type GateFacts = {
  /** Whether the caller forbids typing now: its own say, asked first. */
  readonly vetoed: boolean
  /** How long its screen's text has been unchanged, in milliseconds. */
  readonly calmMs: number
  readonly bracketedPaste: boolean
  /** Whether the program typed to holds the foreground; undefined where the platform can't tell. */
  readonly foreground: boolean | undefined
  /**
   * Whether the program's own input box shows, empty and taking a prompt; omitted where the
   * caller doesn't look. A TUI that reads the console's keys (on Windows) gets a bracketed
   * paste as keys, which a menu or dialog would take, so its box must be seen first, as a
   * prompt's is. The caller looks everywhere, as a key or a view since the screen calmed may
   * have left text there or something else in its place.
   */
  readonly inputBox?: boolean
}

/** How long a screen must be still before anything is typed, in milliseconds. */
export const calmMs = 750

/** Why the gate is shut, or `open`. */
export type Readiness =
  | "open"
  | "vetoed"
  | "restless"
  | "no-bracketed-paste"
  | "not-foreground"
  | "no-input-box"

/** Whether to type now: why not, or `open`. */
export const gate = (facts: GateFacts, calmNeeded = calmMs): Readiness => {
  if (facts.vetoed) return "vetoed"
  if (facts.calmMs < calmNeeded) return "restless"
  if (!facts.bracketedPaste) return "no-bracketed-paste"
  if (facts.foreground === false) return "not-foreground"
  if (facts.inputBox === false) return "no-input-box"
  return "open"
}
