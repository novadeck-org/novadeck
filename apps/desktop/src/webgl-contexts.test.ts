import { webglContextsOf } from "@novadeck/protocol/bridge"
import { describe, expect, it } from "vitest"

import { maxWebglContexts, raiseWebglContexts, webglContextsArgument } from "./main/webgl"

describe("a WebGL context limit", () => {
  it.each([3, 16, 64, 1024])("is %s, a whole number in range", (value) => {
    expect(webglContextsOf(value)).toBe(value)
  })

  it.each([
    ["too few", 2],
    ["too many", 1025],
    ["a fraction", 62.5],
    ["not finite", Number.NaN],
    ["text", "64"],
    ["nothing", undefined],
  ])("is nothing when %s", (_name, value) => {
    expect(webglContextsOf(value)).toBeUndefined()
  })
})

describe("raising Chromium's WebGL context limit", () => {
  const commandLine = (given?: string) => {
    const switches = new Map<string, string>(given === undefined ? [] : [[name, given]])
    return {
      switches,
      hasSwitch: (key: string) => switches.has(key),
      getSwitchValue: (key: string) => switches.get(key) ?? "",
      appendSwitch: (key: string, value = "") => void switches.set(key, value),
    }
  }
  const name = "max-active-webgl-contexts"

  it("sets the app's limit, 64, and says so", () => {
    const line = commandLine()
    expect(raiseWebglContexts(line)).toBe(maxWebglContexts)
    expect(maxWebglContexts).toBe(64)
    expect(line.switches.get(name)).toBe("64")
  })

  it("keeps a limit already given, and tells the page that one", () => {
    const line = commandLine("40")
    expect(raiseWebglContexts(line)).toBe(40)
    expect(line.switches.get(name)).toBe("40")
  })

  it.each(["lots", "0x40", "1e2", " 40", "40 ", "", "-5", "4.5"])(
    "replaces %j, which Chromium would not read as the page does, with the app's limit",
    (given) => {
      const line = commandLine(given)
      expect(raiseWebglContexts(line)).toBe(64)
      expect(line.switches.get(name)).toBe("64")
    },
  )

  it.each([
    ["0", 3],
    ["2", 3],
    ["2000", 1024],
    ["99999999999999999999", 1024],
  ])("clamps %s into the range the page can be told, in the switch too", (given, limit) => {
    const line = commandLine(given)
    expect(raiseWebglContexts(line)).toBe(limit)
    expect(line.switches.get(name)).toBe(String(limit))
  })

  it("names the limit in the window's arguments for the preload", () => {
    expect(webglContextsArgument(64)).toBe("--novadeck-webgl-contexts=64")
  })
})
