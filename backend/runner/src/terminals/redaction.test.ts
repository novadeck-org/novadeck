import { describe, expect, it } from "../test.js"
import { createTranscriptRedactor } from "./redaction.js"

const script = new URL("../testing/transcript-worker.mjs", import.meta.url)
const input = (text: string) => ({ text, cols: 80, rows: 6, lines: 6, maxChars: 1000 })

describe("masking a transcript in a thread", () => {
  it("answers with what the thread wrote", async ({ resources }) => {
    const redactor = createTranscriptRedactor({ script })
    resources.defer(() => redactor.close())

    expect(await redactor.redact(input("one"))).toBe("ONE")
    expect(await redactor.redact(input("two"))).toBe("TWO")
  })

  it(
    "masks a secret with the real thread, from source",
    { timeout: 20_000 },
    async ({ resources }) => {
      const redactor = createTranscriptRedactor()
      resources.defer(() => redactor.close())

      const result = await redactor.redact(
        input("$ echo ghp_abcdefghijklmnopqrstuvwxyz0123456789\r\nplain\r\n$ "),
      )

      expect(result).not.toContain("abcdefghij")
      expect(result).toContain("echo ****")
      expect(result).toContain("plain")
    },
  )

  it("is null when the thread fails on a transcript, and goes on", async ({ resources }) => {
    const redactor = createTranscriptRedactor({ script })
    resources.defer(() => redactor.close())

    expect(await redactor.redact(input("fail"))).toBeNull()
    expect(await redactor.redact(input("again"))).toBe("AGAIN")
  })

  it("is null when the thread takes too long, which ends it for another", async ({ resources }) => {
    const redactor = createTranscriptRedactor({ script, deadlineMs: 200 })
    resources.defer(() => redactor.close())
    expect(await redactor.redact(input("first"))).toBe("FIRST")

    expect(await redactor.redact(input("hang"))).toBeNull()

    expect(await redactor.redact(input("next"))).toBe("NEXT")
  })

  it("is null when no thread would start", async ({ resources }) => {
    const redactor = createTranscriptRedactor({ script: new URL("./missing.mjs", import.meta.url) })
    resources.defer(() => redactor.close())

    expect(await redactor.redact(input("one"))).toBeNull()
  })

  it("is undefined when its signal aborts, and ends the thread's work", async ({ resources }) => {
    const redactor = createTranscriptRedactor({ script, deadlineMs: 5000 })
    resources.defer(() => redactor.close())
    await redactor.redact(input("warm"))
    const controller = new AbortController()

    const job = redactor.redact(input("hang"), controller.signal)
    setTimeout(() => controller.abort(), 50)

    expect(await job).toBeUndefined()
    expect(await redactor.redact(input("next"))).toBe("NEXT")
  })

  it("is undefined once closed", async () => {
    const redactor = createTranscriptRedactor({ script })
    expect(await redactor.redact(input("one"))).toBe("ONE")

    await redactor.close()

    expect(await redactor.redact(input("two"))).toBeUndefined()
  })
})
