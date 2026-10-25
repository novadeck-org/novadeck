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
      appendSwitch: (key: string, value = "") =>
        void (switches.has(key) || switches.set(key, value)),
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

  it("tells the page Chromium's default when the given limit is no valid one", () => {
    expect(raiseWebglContexts(commandLine("lots"))).toBe(16)
  })

  it("names the limit in the window's arguments for the preload", () => {
    expect(webglContextsArgument(64)).toBe("--novadeck-webgl-contexts=64")
  })
})
