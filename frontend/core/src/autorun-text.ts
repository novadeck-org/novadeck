import type { AutoRunManualReason, AutoRunOutcome } from "./autorun"

// What the Command Prompt fix says on the Grant card, in the Inbox and in Preferences, in
// Novadeck's own plain words ("AutoRun" is the registry value's name, shown only in the
// details). Values the runner read are shown as code by the caller, never put into a sentence
// here.

export const autoRunTitle = "Antigravity can't use your approvals on this computer"

export const autoRunBody =
  "A startup script for Windows' Command Prompt prints text each time it runs, and that text garbles Novadeck's answers to Antigravity. Novadeck can hide that script's output. The script still runs, and you can undo this anytime."

export const autoRunEverywhere =
  "This applies to every Command Prompt window, not only Antigravity's. Hiding the output also hides what the script shows in a window (prompts, colours, messages)."

const handles = (list: readonly string[]): string => list.map((handle) => `@${handle}`).join(", ")

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
        ? `Command Prompt prints nothing at startup now. Antigravity's Novadeck plugin is installed ${later.join(" and ")}; a grant reaches an Antigravity started after that.`
        : "Command Prompt prints nothing at startup now."
    }
    case "applied-still-prints-hklm":
      return "The startup script's output is hidden, but Command Prompt still prints: the machine's startup script (HKLM) does, and Novadeck doesn't change it."
    case "rolled-back":
      return "That didn't stop Command Prompt printing, so Novadeck put it back."
    case "conflict":
      return "The startup script changed since this was shown, so nothing was written."
    case "failed":
      return `Not done: ${outcome.message}`
    case "undone":
      return "The startup script is back as it was."
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
      return "The startup script that prints is the machine's (HKLM), which needs an administrator."
    case "refused":
      return rule === null
        ? "Novadeck can't rewrite this startup script safely."
        : `Novadeck can't rewrite this startup script safely: ${rule}.`
    case "form":
      return "Novadeck can't read this startup script as plain text it could put back exactly."
    case "quiet":
      return "This startup script prints nothing on its own, so the output comes from somewhere else."
    case "unchecked":
      return "Novadeck couldn't tell whether this startup script prints."
  }
}
