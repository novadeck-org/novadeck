import { tourBrief } from "@novadeck/tour-runner/brief"
import { tourAgent, tourEffort, tourLaunch, tourModel } from "@novadeck/tour-runner/launch"

import { maxDeliveryBytes, novadeckSender, type Message } from "./messaging/messages.js"
import { deliveredBytes } from "./messaging/sending.js"
import { commandWords } from "./terminals/commands.js"
import { describe, expect, it } from "./test.js"

// The tour (@novadeck/tour-runner) as the runner takes it: the line that starts its agent, as
// the terminal's shell reads it, and its brief, as the doorbell delivers it.

describe("the tour's launch line", () => {
  it("starts Nova on GPT-6 Luna at medium, by its own word, with no prompt", () => {
    const launch = tourLaunch()
    expect(launch).toMatchObject({ brief: "doorbell", model: "nova/gpt-6-luna" })
    expect(commandWords(launch.command, "linux")).toEqual([
      "novadeck-nova",
      "--model",
      "nova/gpt-6-luna",
      "--thinking",
      "medium",
    ])
  })

  it("reads the same in Windows' shells", () => {
    expect(commandWords(tourLaunch().command, "win32")).toEqual(
      commandWords(tourLaunch().command, "linux"),
    )
  })
})

// A notice as the doorbell delivers it, to count its bytes against one delivery.
const noticeOf = (text: string): Message => ({
  id: "m1",
  projectId: "p1",
  thread: "t-notice-m1",
  hop: 1,
  from: novadeckSender,
  to: { terminalId: "t1", handle: "moth", agent: "claude", sessionId: null },
  text,
  sentAt: 0,
  state: "queued",
  deliveredAt: null,
  notified: true,
  stopped: false,
  fromLead: false,
  toLead: false,
})

// Sparks as long as any the runner draws (a setting, a mechanic and a mood).
const longSparks = Array.from(
  { length: 3 },
  () => "an underground mushroom realm; everything you shoot bounces; triumphant",
)

describe("the tour's brief to its lead", () => {
  // Delivered whole: wrapped as Novadeck's notice, in every harness, it fits one delivery, which
  // a harness takes no more than (a brief past it is rung but never handed over).
  it("fits one delivery, as a run rings it", () => {
    const text = tourBrief({
      lead: "@h-t1",
      mate: { agent: tourAgent, model: tourModel, effort: tourEffort },
      serving: { command: "node dev.mjs 5173", url: "http://127.0.0.1:5173/" },
      sparks: longSparks,
    })
    expect(deliveredBytes(noticeOf(text))).toBeLessThanOrEqual(maxDeliveryBytes)
  })

  it("fits on the longest harness and model names, as agy's, with the serving steps", () => {
    const longest = tourBrief({
      lead: "@a-twenty-char-name-x",
      mate: { agent: "agy", model: "gemini-3-flash-lite-preview", effort: "medium" },
      serving: { command: "python3 dev.py 65535", url: "http://127.0.0.1:65535/" },
      sparks: longSparks,
    })
    expect(deliveredBytes(noticeOf(longest))).toBeLessThanOrEqual(maxDeliveryBytes)
  })

  it("fits with Codex's longer model name", () => {
    const codex = tourBrief({
      lead: "@a-twenty-char-name-x",
      mate: { agent: "codex", model: "gpt-9.9-codex-max-luna", effort: "medium" },
      serving: { command: "python3 dev.py 65535", url: "http://127.0.0.1:65535/" },
      sparks: longSparks,
    })
    expect(deliveredBytes(noticeOf(codex))).toBeLessThanOrEqual(maxDeliveryBytes)
  })
})
