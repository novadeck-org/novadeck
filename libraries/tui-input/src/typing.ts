import { randomBytes } from "node:crypto"

/** A fresh nonce, short and unguessable enough to tell the line it marks from any other. */
export const freshNonce = (): string => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
  return [...randomBytes(6)].map((byte) => alphabet[byte % alphabet.length]).join("")
}

/** The line written as one bracketed paste, which the TUI takes as text, never as keys. */
export const bracketedPaste = (line: string): string => `\x1b[200~${line}\x1b[201~`

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
export const gate = (facts: GateFacts, still = calmMs): Readiness => {
  if (facts.vetoed) return "vetoed"
  if (facts.calmMs < still) return "restless"
  if (!facts.bracketedPaste) return "no-bracketed-paste"
  if (facts.foreground === false) return "not-foreground"
  if (facts.inputBox === false) return "no-input-box"
  return "open"
}
