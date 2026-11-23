import { describe, expect, it, vi } from "vitest"

import { DomainError } from "../errors.js"
import { PermitAnswers, type PermitAnswersHost } from "./auto.js"

const command = "git push origin feat/x"
const dialog = (
  detail: string | null,
  labels = ["Yes, run command", "Yes, and always allow", "No, cancel"],
) =>
  ({
    type: "choices",
    id: "d1",
    title: "Run this command?",
    detail,
    options: labels.map((label, at) => ({ id: String(at + 1), label, text: null })),
  }) as never

const setup = (
  over: Partial<{
    agent: string
    actor: string | null
    tool: string
    shown: unknown
    input: unknown
    covered: boolean
    screen: string[]
  }> = {},
) => {
  const used = vi.fn<() => void>()
  const release = vi.fn<() => void>()
  const answer = vi.fn<PermitAnswersHost["answer"]>(() => Promise.resolve())
  const autoAnswer = vi.fn<(...args: any[]) => Promise<unknown>>((...args) =>
    Promise.resolve(
      over.covered === false || !args[2].whole ? undefined : { note: "push", done: used, release },
    ),
  )
  const looked = new Set<string>()
  const shipping = {
    enabled: () => true,
    autoAnswer,
    firstLook: (_terminal: string, ref: string) => !looked.has(ref) && !!looked.add(ref),
  }
  const host: PermitAnswersHost = {
    shipping: () => shipping as never,
    pending: () => ({
      agent: over.agent ?? "agy",
      cwd: "/repo",
      requests: [
        {
          ref: "r1",
          actor: over.actor === undefined ? null : over.actor,
          kind: "permission",
          tool: over.tool ?? "confirmation",
          askedAt: 7,
          requestId: "confirmation:run_command:3",
          input:
            "input" in over ? over.input : { name: "run_command", args: { CommandLine: command } },
        },
      ],
    }),
    dialog: () => ("shown" in over ? over.shown : dialog(command)) as never,
    answer,
    screen: () =>
      Promise.resolve(
        over.screen === undefined
          ? ["Requesting permission for:", `   ${command}`, "", "Run this command?"]
          : over.screen,
      ),
  }
  return { answers: new PermitAnswers(host), answer, autoAnswer, used, release }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("answering Antigravity's confirmation of a permitted command", () => {
  it("presses the run-once option, then uses the permit", async () => {
    const { answers, answer, autoAnswer, used } = setup()
    answers.changed("t")
    await settle()
    // Asked what the dialog shows, the call the request names, and when it was asked.
    expect(autoAnswer).toHaveBeenCalledWith("t", "agy", {
      whole: true,
      detail: command,
      requestId: "confirmation:run_command:3",
      call: command,
      askedAt: 7,
    })
    expect(answer).toHaveBeenCalledWith("t", "r1", { type: "choice", dialog: "d1", option: "1" })
    expect(used).toHaveBeenCalledTimes(1)
    // Decided once: a later change of the screen answers nothing again.
    answers.changed("t")
    await settle()
    expect(answer).toHaveBeenCalledTimes(1)
  })

  it("answers nothing in any doubt", async () => {
    const cases: Record<string, Parameters<typeof setup>[0]> = {
      "no recorded permitted command": { covered: false },
      "another harness": { agent: "claude" },
      "another tool": { tool: "ask_question" },
      "no option worded run once": { shown: dialog(command, ["Yes, and always allow", "No"]) },
      "two such options": { shown: dialog(command, ["Yes, run command", "Yes, run command"]) },
      "a screen that cuts the command": {
        screen: ["Requesting permission for:", "   git push origin", "   ...", "Run this command?"],
      },
      "no dialog read": { shown: null },
      "no detail": { shown: dialog(null) },
      "another dialog": {
        shown: { ...(dialog(command) as object), title: "Allow creation of this file?" },
      },
    }
    for (const [name, over] of Object.entries(cases)) {
      const { answers, answer } = setup(over)
      answers.changed("t")
      // eslint-disable-next-line no-await-in-loop -- One case after another.
      await settle()
      expect(answer, name).not.toHaveBeenCalled()
    }
  })

  it("gives the permit back only where no key was pressed", async () => {
    // Pressed nothing: the dialog changed, or wasn't there.
    for (const code of ["CONFLICT", "DIALOG_CHANGED"] as const) {
      const { answers, answer, used, release } = setup()
      answer.mockRejectedValueOnce(new DomainError(code, "no"))
      answers.changed("t")
      // eslint-disable-next-line no-await-in-loop -- One case after another.
      await settle()
      expect(used, code).not.toHaveBeenCalled()
      expect(release, code).toHaveBeenCalledTimes(1)
    }
    // Keys went and the answer then failed (or anything else): the permit is used.
    for (const error of [new DomainError("ANSWER_FAILED", "no"), new Error("odd")]) {
      const { answers, answer, used, release } = setup()
      answer.mockRejectedValueOnce(error)
      answers.changed("t")
      // eslint-disable-next-line no-await-in-loop -- As above.
      await settle()
      expect(release).not.toHaveBeenCalled()
      expect(used).toHaveBeenCalledTimes(1)
    }
  })
})
