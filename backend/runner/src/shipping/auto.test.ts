import { describe, expect, it, vi } from "vitest"

import { PermitAnswers, type PermitAnswersHost } from "./auto.js"

const command = "git push origin feat/x"
const dialog = (
  detail: string,
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
    cwd: string | null
    covered: boolean
  }> = {},
) => {
  const used = vi.fn<() => void>()
  const answer = vi.fn<PermitAnswersHost["answer"]>(() => Promise.resolve())
  const autoAnswer = vi.fn<() => Promise<{ note: string; used: () => void } | undefined>>(() =>
    Promise.resolve(over.covered === false ? undefined : { note: "push", used }),
  )
  const host: PermitAnswersHost = {
    shipping: () => ({ enabled: () => true, autoAnswer }) as never,
    pending: () => ({
      agent: over.agent ?? "agy",
      cwd: over.cwd === undefined ? "/repo" : over.cwd,
      requests: [
        {
          ref: "r1",
          actor: over.actor === undefined ? null : over.actor,
          kind: "permission",
          tool: over.tool ?? "confirmation",
          input:
            "input" in over ? over.input : { name: "run_command", args: { CommandLine: command } },
        },
      ],
    }),
    dialog: () => ("shown" in over ? over.shown : dialog(command)) as never,
    answer,
  }
  return { answers: new PermitAnswers(host), answer, autoAnswer, used }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("answering Antigravity's confirmation of a permitted command", () => {
  it("presses the run-once option, then uses the permit", async () => {
    const { answers, answer, used } = setup()
    answers.changed("t")
    await settle()
    expect(answer).toHaveBeenCalledWith("t", "r1", { type: "choice", dialog: "d1", option: "1" })
    expect(used).toHaveBeenCalledTimes(1)
    // Decided once: a later change of the screen answers nothing again.
    answers.changed("t")
    await settle()
    expect(answer).toHaveBeenCalledTimes(1)
  })

  it("answers nothing in any doubt", async () => {
    const cases: Record<string, Parameters<typeof setup>[0]> = {
      "no permit": { covered: false },
      "another harness": { agent: "claude" },
      "a subagent's": { actor: "sub-1" },
      "another tool": { tool: "ask_question" },
      "a file confirmation": { input: { name: "write_file", args: { Path: "a" } } },
      "a command the dialog cut short": { shown: dialog("git push origin feat/…") },
      "a tail the dialog shows": { shown: dialog(`${command} && touch x`) },
      "no option worded run once": { shown: dialog(command, ["Yes, and always allow", "No"]) },
      "two such options": { shown: dialog(command, ["Yes, run command", "Yes, run command"]) },
      "no recorded call": { input: null },
      "no folder": { cwd: null },
      "no dialog read": { shown: null },
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

  it("leaves a permit unused where the answer failed", async () => {
    const { answers, answer, used } = setup()
    answer.mockRejectedValueOnce(new Error("dialog changed"))
    answers.changed("t")
    await settle()
    expect(used).not.toHaveBeenCalled()
  })

  it("reads a covered command from the call the hook recorded, never from screen text alone", async () => {
    // The screen shows what the recorded call says, in full; a different recorded call is not it.
    const { answers, autoAnswer, answer } = setup({
      input: { name: "run_command", args: { CommandLine: "git push origin main" } },
    })
    answers.changed("t")
    await settle()
    expect(autoAnswer).not.toHaveBeenCalled()
    expect(answer).not.toHaveBeenCalled()
  })
})
