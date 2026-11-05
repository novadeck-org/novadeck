import { describe, expect, it } from "vitest"

import { conversational, shapes } from "./shapes.js"
import { transcripts } from "./transcripts.js"

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

  it("read a queued prompt as the decoder does, with no mode as a prompt and any other mode not", () => {
    const record = (attachment: object) => ({
      type: "attachment",
      timestamp: "2026-10-26T00:00:00.000Z",
      attachment: {
        type: "queued_command",
        prompt: "go",
        origin: { kind: "human" },
        ...attachment,
      },
    })
    for (const mode of [undefined, null, 1, "prompt", "bash"]) {
      const line = record(mode === undefined ? {} : { commandMode: mode })
      const read = keys(line).every((key) => key.endsWith(" read"))
      expect(read, String(mode)).toBe(transcripts.items(JSON.stringify(line)).length > 0)
    }
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

  it("count a prompt of the person's a turn took in some new way as the conversation's (#482)", () => {
    const queued = (commandMode: string) =>
      shapes(
        JSON.stringify({
          type: "attachment",
          attachment: {
            type: "queued_command",
            prompt: "hi",
            commandMode,
            origin: { kind: "human" },
          },
        }),
      )
    expect(queued("bash")).toEqual([
      { key: "attachment:queued_command/human/bash", verdict: "unknown" },
    ])
    expect(conversational("attachment:queued_command/human/bash")).toBe(true)
    // One marked meta is Claude Code's own, which the chat leaves out as it is.
    expect(conversational("attachment:queued_command/human/prompt/meta")).toBe(false)
    // Others' queued messages, and attachments of context, stay metadata.
    expect(conversational("attachment:queued_command/peer/prompt")).toBe(false)
    expect(conversational("attachment:brand_new_context")).toBe(false)
    expect(conversational("record:brand-new-record")).toBe(false)
    expect(conversational("block:assistant/hologram")).toBe(true)
  })
})
