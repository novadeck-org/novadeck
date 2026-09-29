import { connect } from "node:net"

import { describe, expect, it } from "../test.js"
import { listenForReports, type Report } from "./reports.js"

const send = (endpoint: string, line: string) =>
  new Promise<void>((resolve) => {
    const socket = connect(endpoint)
    socket.on("error", () => resolve())
    socket.on("close", () => resolve())
    socket.end(`${line}\n`)
  })

describe("the report endpoint", () => {
  it("takes only well-formed reports carrying a runner token", async ({ resources }) => {
    const received: Report[] = []
    const reports = await listenForReports((accepted) => received.push(accepted))
    resources.defer(() => reports.close())
    const base = { terminalId: "t", agent: "claude", sessionId: "a", seq: 1 }
    const token = "0123456789abcdef".repeat(3)
    // A token as long as a runner's, in characters but not in bytes, and others.
    const bad = ["ż".repeat(48), "short", token.toUpperCase(), 42]
    await Promise.all(
      bad.map((wrong) => send(reports.endpoint, JSON.stringify({ ...base, token: wrong }))),
    )
    await send(reports.endpoint, "not json")
    await send(reports.endpoint, JSON.stringify({ ...base, token }))
    expect(received).toEqual([{ ...base, token }])
  })
})
