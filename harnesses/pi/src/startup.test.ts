import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { heldScreen, screenMarker, screenVersion, signedOut, title } from "./startup.js"

type Probe = { screens: { [name: string]: ScreenText } }

// Probed 2026-11-24, pi 1.6.0 (fixtures/*.probe.json).
const probes = ["startup", "dialogs", "input-box", "busy"].map(
  (name) => loadProbe<Probe>(import.meta.dirname, `${name}.probe.json`).screens,
)
const rows = (name: string): readonly string[] => {
  const found = probes.find((screens) => name in screens)?.[name]
  if (!found) throw new Error(`no state ${name}`)
  return found.rows
}

describe("pi's startup", () => {
  it("names its trust prompt as a screen of its own holding it", () => {
    expect(heldScreen(rows("trust"))).toBe("startup")
    expect(heldScreen(rows("trustDown"))).toBe("startup")
    for (const name of ["empty", "ready", "trustedReady", "login"])
      expect(heldScreen(rows(name)), name).toBeUndefined()
  })

  it("says it is signed out where its footer names no model", () => {
    expect(signedOut(rows("empty"))).toBe(true)
    expect(signedOut(rows("emptyEnter"))).toBe(true)
    expect(signedOut(rows("loginEscaped"))).toBe(true)
    for (const name of ["ready", "answered", "busy", "ready60", "trustedReady"])
      expect(signedOut(rows(name)), name).toBe(false)
  })

  it("takes a reply that says unknown for no footer", () => {
    expect(
      signedOut(["the answer is unknown", "", "~/project", "0.0%/200k (auto)    fake • medium"]),
    ).toBe(false)
  })

  it("takes its title for its prompt showing", () => {
    expect(title("π - project", 5)).toEqual({
      type: "prompt-shown",
      agent: "pi",
      instance: null,
      startedAt: 5,
    })
    expect(title("π - probe session - project", 5)).toBeDefined()
    expect(title("pi", 5)).toBeUndefined()
    expect(title("bash", 5)).toBeUndefined()
  })

  it("reads its version off its header", () => {
    expect(screenVersion(rows("ready"))).toBe("1.6.0")
    expect(screenVersion(rows("empty"))).toBe("1.6.0")
    expect(screenVersion(rows("trust"))).toBeUndefined()
    const line = rows("ready").find((row) => row.includes(screenMarker.text))!
    expect(line.indexOf(screenMarker.text)).toBeLessThan(screenMarker.columns)
  })
})
