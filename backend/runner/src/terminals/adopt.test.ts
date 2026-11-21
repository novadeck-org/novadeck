import { describe, expect, it } from "../test.js"
import { adoptTeammate, promptWait } from "./adopt.js"
import type { CallsHost } from "./calls.js"

// A host with two records, whose shell `member` shows its first prompt when a test sets `promptedAt`.
const hostOf = () => {
  const events: string[] = []
  const member = { promptedAt: null as number | null, summary: { handle: "moth", title: "t" } }
  const lead = { summary: { handle: "fox" } }
  const host = {
    records: () =>
      new Map([
        ["member", member],
        ["lead", lead],
      ]),
    bindings: () => ({ setLead: () => void events.push("led") }),
    messaging: () => ({ notice: () => void events.push("notice") }),
    peers: () => ({ introduce: () => void events.push("introduced") }),
  } as unknown as Pick<CallsHost, "records" | "bindings" | "messaging" | "peers">
  return { host, member, events }
}

describe("adopting the person's terminal as a teammate", () => {
  it("waits for the shell's first prompt, then runs what is asked before it joins", async () => {
    const { host, member, events } = hostOf()
    const done = adoptTeammate(host, "member", "lead", () => void events.push("before"))
    await new Promise((resolve) => setTimeout(resolve, promptWait.pollMs * 3))
    expect(events).toEqual([])
    member.promptedAt = Date.now()
    await done
    expect(events).toEqual(["before", "led", "notice", "introduced"])
  })

  it("goes on after the wait where the shell never reports a prompt", async () => {
    const was = { ...promptWait }
    Object.assign(promptWait, { ms: 100, pollMs: 10 })
    try {
      const { host, events } = hostOf()
      await adoptTeammate(host, "member", "lead", () => void events.push("before"))
      expect(events[0]).toBe("before")
    } finally {
      Object.assign(promptWait, was)
    }
  })

  it("joins nothing where what runs before it refuses", async () => {
    const { host, member, events } = hostOf()
    member.promptedAt = Date.now()
    await expect(
      adoptTeammate(host, "member", "lead", () => {
        throw new Error("no")
      }),
    ).rejects.toThrow("no")
    expect(events).toEqual([])
  })
})
