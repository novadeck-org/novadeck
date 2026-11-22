import { describe, expect, it, vi } from "vitest"

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
  }> = {},
) => {
  const used = vi.fn<() => void>()
  const release = vi.fn<() => void>()
  const answer = vi.fn<PermitAnswersHost["answer"]>(() => Promise.resolve())
  const autoAnswer = vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
    Promise.resolve(over.covered === false ? undefined : { note: "push", done: used, release }),
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

  it("gives the permit back where the answer failed", async () => {
    const { answers, answer, used, release } = setup()
    answer.mockRejectedValueOnce(new Error("dialog changed"))
    answers.changed("t")
    await settle()
    expect(used).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
  })
})
