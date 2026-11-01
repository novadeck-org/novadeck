import type { AutoRunManualReason, AutoRunOutcome } from "@novadeck/core/autorun"

// What the AutoRun card and Preferences say, in Novadeck's own words. Values the runner read
// are shown as code by the caller, never put into a sentence here.

export const autoRunWhy =
  "cmd prints text of its own before every command (an AutoRun), so Antigravity asks for each command and its hooks' answers can't be read outside Novadeck's terminals."

export const autoRunEverywhere =
  "This applies to every cmd window, not only Antigravity's. Redirecting the output also hides what the AutoRun shows in a cmd window (prompts, colours, messages)."

const handles = (list: readonly string[]): string => list.map((handle) => `@${handle}`).join(", ")

// A value as the person reads it, verbatim but for the characters nothing shows: control,
// format (bidi marks, zero-width characters, the byte order mark) and line separators are
// written as \u{…}, so a value can't look like another or hide a character.
export const visibleText = (value: string): string =>
  value.replaceAll(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (char) => `\\u{${char.codePointAt(0)!.toString(16).toUpperCase()}}`,
  )

// What the person's last click came to.
export const outcomeText = (outcome: AutoRunOutcome): string => {
  switch (outcome.kind) {
    case "applied-clean": {
      const later = [
        outcome.waiting.length > 0
          ? `once ${handles(outcome.waiting)} close${outcome.waiting.length === 1 ? "s" : ""}`
          : "",
        outcome.restart ? "after Novadeck restarts" : "",
      ].filter(Boolean)
      return later.length > 0
        ? `cmd prints nothing now. Antigravity's Novadeck plugin is installed ${later.join(" and ")}; a grant reaches an Antigravity started after that.`
        : "cmd prints nothing now."
    }
    case "applied-still-prints-hklm":
      return "The value was changed, but cmd still prints: the machine's AutoRun does, and Novadeck doesn't change it."
    case "rolled-back":
      return "The change didn't silence cmd, so it was undone."
    case "conflict":
      return "The AutoRun changed since this was shown, so nothing was written."
    case "failed":
      return `Not done: ${outcome.message}`
    case "undone":
      return "The AutoRun is back as it was."
    case "undo-refused":
      return outcome.restart
        ? "Undo waits: Antigravity terminals from before Novadeck started may still run. Restart Novadeck once they are gone, then undo."
        : `Close Antigravity in ${handles(outcome.terminals)} first: Undo can't change its plugin while it runs.`
  }
}

// Why Novadeck gives the step instead of making the change.
export const manualWhy = (reason: AutoRunManualReason, rule: string | null): string => {
  switch (reason) {
    case "machine":
      return "The AutoRun that prints is the machine's (HKLM), which needs an administrator."
    case "refused":
      return rule === null
        ? "Novadeck can't rewrite this value safely."
        : `Novadeck can't rewrite this value safely: ${rule}.`
    case "form":
      return "Novadeck can't read this value as plain text it could put back exactly."
    case "quiet":
      return "This value prints nothing on its own, so the output comes from somewhere else."
    case "unchecked":
      return "Novadeck couldn't tell whether this value prints."
  }
}
