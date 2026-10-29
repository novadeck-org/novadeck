import { describe, expect, it } from "../test"
import { opensAfterQuit, rememberReopen, swapsAtQuitStart } from "./quit-install"

describe("a quit that puts an update in place", () => {
  it("swaps at its start only for the person's quit on Linux", () => {
    const quit = { platform: "linux" as const, orderly: true, stopping: false }
    expect(swapsAtQuitStart(quit)).toBe(true)
    expect(swapsAtQuitStart({ ...quit, orderly: false })).toBe(false)
    expect(swapsAtQuitStart({ ...quit, stopping: true })).toBe(false)
    expect(swapsAtQuitStart({ ...quit, platform: "darwin" })).toBe(false)
    expect(swapsAtQuitStart({ ...quit, platform: "win32" })).toBe(false)
  })

  it("remembers a launch only while the app is quitting", () => {
    expect(rememberReopen(false, false)).toBe(false)
    expect(rememberReopen(false, true)).toBe(true)
    expect(rememberReopen(true, false)).toBe(true)
  })

  it("never opens the app again on a plain quit", () => {
    expect(opensAfterQuit({ placed: false, wanted: false })).toBe(false)
    expect(opensAfterQuit({ placed: true, wanted: false })).toBe(false)
    expect(opensAfterQuit({ placed: false, wanted: true })).toBe(false)
    expect(opensAfterQuit({ placed: true, wanted: true })).toBe(true)
  })
})
