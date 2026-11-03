import { describe, expect, it } from "vitest"

import { shapes } from "./shapes.js"

const keys = (record: object) =>
  shapes(JSON.stringify(record)).map(({ key, verdict }) => `${key} ${verdict}`)
const said = (content: string) => keys({ type: "user", message: { role: "user", content } })

describe("Claude Code's shapes", () => {
  it("read a paste only where the decoder unwraps it", () => {
    expect(said('<pasted_content id="a">\nx\n</pasted_content id="a">\n')).toEqual([
      "block:user/text read",
      "tag:pasted_content read",
    ])
    expect(said('see: \n\n<pasted_content id="a">\nx\n</pasted_content id="a">\n')).toEqual([
      "block:user/text read",
      "wrap:pasted_content read",
    ])
    // A form the decoder doesn't unwrap shows raw, and is no shape it knows.
    expect(said('<pasted_content id="a" lines="1">x</pasted_content id="a">')).toEqual([
      "block:user/text read",
      "wrap:pasted_content/raw unknown",
    ])
  })

  it("key a queued prompt by who gave it and how, so the person's alone reads", () => {
    const queued = (attachment: object) =>
      keys({
        type: "attachment",
        attachment: { type: "queued_command", prompt: "go", ...attachment },
      })
    expect(queued({ origin: { kind: "human" }, commandMode: "prompt" })).toEqual([
      "attachment:queued_command/human/prompt read",
    ])
    expect(queued({ origin: { kind: "remote" }, commandMode: "prompt" })).toEqual([
      "attachment:queued_command/remote/prompt unknown",
    ])
    expect(queued({ origin: { kind: "human" }, commandMode: "bash" })).toEqual([
      "attachment:queued_command/human/bash unknown",
    ])
  })

  it("key what Claude Code writes for itself, and its queue, a level deeper", () => {
    expect(
      keys({
        type: "user",
        isMeta: true,
        message: { content: "<system-reminder>x</system-reminder>" },
      }),
    ).toEqual(["meta:user skipped", "meta:user/tag:system-reminder skipped"])
    expect(
      keys({ type: "attachment", isMeta: true, attachment: { type: "queued_command" } }),
    ).toEqual(["meta:attachment/queued_command unknown"])
    expect(keys({ type: "queue-operation", operation: "enqueue" })).toEqual([
      "record:queue-operation/enqueue skipped",
    ])
    expect(keys({ type: "queue-operation", operation: "absorb" })).toEqual([
      "record:queue-operation/absorb unknown",
    ])
  })
})
