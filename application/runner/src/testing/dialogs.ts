import type { DialogAdapter, DialogRead, KeyStep } from "../harnesses/dialogs.js"
import type { ScreenText } from "../terminals/screen.js"
import { screen } from "./screens.js"

/**
 * A made-up TUI for the answer driver's and the dialogs tracker's tests, which know no
 * harness: a permission dialog for a command, with `1. Yes`, `2. No` and `3. Tell it what
 * to do`, which opens a text field. `fakeAdapter` reads it as a harness's adapter would.
 */
export type FakeState = "ask" | "field" | "gone" | "other"

export class FakeTui {
  state: FakeState = "ask"
  /** The command the dialog asks about. */
  command = "ls"
  /** What was pressed, and what was typed into its field. */
  readonly written: string[] = []
  field = ""
  /** Keys that take no effect, as a TUI that ignores them. */
  ignores = false
  /** Whether the screen takes pastes bracketed. */
  bracketed = true
  /** A transcript row above the dialog, which changes with `tick`. */
  noise = 0

  rows(): string[] {
    const top = `transcript ${this.noise}`
    switch (this.state) {
      case "ask":
        return [top, `FAKE ASK ${this.command}`, "1. Yes", "2. No", "3. Tell it what to do"]
      case "field":
        return [top, `FAKE ASK ${this.command}`, "FAKE FIELD", `> ${this.field}`]
      case "other":
        return [top, "FAKE ELSEWHERE", "nothing to answer here"]
      case "gone":
        return [top, "> "]
    }
  }

  screen(): ScreenText {
    return screen({ rows: this.rows(), bracketedPaste: this.bracketed })
  }

  /** Keys written to the terminal. */
  write(data: string): void {
    this.written.push(data)
    if (this.ignores) return
    // eslint-disable-next-line no-control-regex -- The paste's own escapes.
    const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data)
    if (this.state === "field") {
      if (data === "\r") this.state = "gone"
      else this.field += pasted ? pasted[1] : data
      return
    }
    if (this.state !== "ask") return
    if (data === "1" || data === "2") this.state = "gone"
    if (data === "3") this.state = "field"
  }
}

/** Reads the fake dialog for a request whose input names its command. */
export const fakeAdapter = (): DialogAdapter => ({
  read: (rows, facts): DialogRead | undefined => {
    const command = (facts.input as { command?: string } | undefined)?.command
    if (command === undefined || !rows.includes(`FAKE ASK ${command}`)) return undefined
    // The field is the dialog's third option, open.
    const field = rows.includes("FAKE FIELD")
    if (!field && !rows.includes("1. Yes")) return undefined
    return {
      dialog: {
        type: "choices",
        title: command,
        detail: command,
        options: [
          { id: "1", label: "Yes", text: null },
          { id: "2", label: "No", text: null },
          { id: "3", label: "Tell it what to do", text: "field" },
        ],
      },
      keys: (answer): readonly KeyStep[] | undefined => {
        if (answer.type !== "choice") return undefined
        if (answer.option === "3") {
          if (!answer.text) return undefined
          return [
            { press: "3" },
            {
              until: (now) => now.includes("FAKE FIELD"),
              timeoutMs: 500,
              why: "the text field",
            },
            { type: answer.text },
            { press: "\r" },
          ]
        }
        return answer.option === "1" || answer.option === "2"
          ? [{ press: answer.option }]
          : undefined
      },
      answered: (now) => !now.some((row) => row.startsWith("FAKE ASK")),
    }
  },
})
