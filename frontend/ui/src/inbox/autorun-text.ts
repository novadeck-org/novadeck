import type { AutoRunManualReason, AutoRunOutcome } from "@novadeck/core/autorun"

// What the AutoRun card and Preferences say, in Novadeck's own words. Values the runner read
// are shown as code by the caller, never put into a sentence here.

export const autoRunWhy =
  "cmd prints text of its own before every command (an AutoRun), so Antigravity asks for each command and its hooks' answers can't be read outside Novadeck's terminals."

export const autoRunEverywhere = "This applies to every cmd window, not only Antigravity's."

// What the person's last click came to.
export const outcomeText = (outcome: AutoRunOutcome): string => {
  switch (outcome.kind) {
    case "applied-clean":
      return outcome.waiting.length > 0
        ? `cmd prints nothing now. Antigravity's plugin is updated once ${outcome.waiting
            .map((handle) => `@${handle}`)
            .join(", ")} close${outcome.waiting.length === 1 ? "s" : ""} and Novadeck starts again.`
        : "cmd prints nothing now."
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
      return `Close Antigravity in ${outcome.terminals
        .map((handle) => `@${handle}`)
        .join(", ")} first: Undo can't change its plugin while it runs.`
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
