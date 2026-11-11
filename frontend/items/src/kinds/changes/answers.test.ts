import { describe, expect, it } from "vitest"

import { answersIn } from "./answers"

describe("answers, kept", () => {
  it("asks once for the same question, and keeps the latest answer of a family", async () => {
    const answers = answersIn<string>(4)({})
    let asked = 0
    const read = (value: string) => () => {
      asked += 1
      return Promise.resolve(value)
    }
    const [one, again] = await Promise.all([
      answers.load("f", "1", read("a")),
      answers.load("f", "1", read("b")),
    ])
    expect([one, again, asked]).toEqual(["a", "a", 1])

    await answers.load("f", "2", read("c"))
    expect(answers.peek("f", "1")).toBeUndefined()
    expect(answers.peek("f", "2")).toBe("c")
    expect(answers.latest("f")).toBe("c")
  })

  it("keeps the answer to the later question, whichever comes in last", async () => {
    const answers = answersIn<string>(4)({})
    let late: (value: string) => void = () => {}
    const first = answers.load("f", "1", () => new Promise((resolve) => (late = resolve)))
    await answers.load("f", "2", () => Promise.resolve("new"))
    late("old")
    await first
    expect(answers.latest("f")).toBe("new")
  })

  it("does not keep a failure, and lets the oldest family go past its limit", async () => {
    const answers = answersIn<string>(2)({})
    await expect(answers.load("f", "1", () => Promise.reject(new Error("no")))).rejects.toThrow(
      "no",
    )
    expect(answers.latest("f")).toBeUndefined()
    await answers.load("a", "1", async () => "a")
    await answers.load("b", "1", async () => "b")
    await answers.load("c", "1", async () => "c")
    expect(answers.latest("a")).toBeUndefined()
    expect(answers.latest("c")).toBe("c")
  })
})
