import { describe, expect, it } from "../../test"
import { notQuitting, type Quitting } from "../quitting"
import {
  dropRestart,
  opensAfterQuit,
  opensCurrentAfterQuit,
  placedBy,
  rememberReopen,
  requestRestart,
  restartAllowed,
  swapsAtQuitStart,
} from "./quit-install"

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

describe("restarting into a waiting update", () => {
  const ask = { offer: "ready", mode: "install" as const, stopping: false }

  it("is carried out only for a ready offer in a copy that installs, with no quit under way", () => {
    expect(restartAllowed(ask)).toBe(true)
    for (const offer of ["downloading", "available", "retrying", undefined])
      expect(restartAllowed({ ...ask, offer })).toBe(false)
    expect(restartAllowed({ ...ask, mode: "tell" })).toBe(false)
    expect(restartAllowed({ ...ask, mode: undefined })).toBe(false)
    expect(restartAllowed({ ...ask, stopping: true })).toBe(false)
  })

  it("opens the current version when a restart's update was not put in place", () => {
    expect(opensCurrentAfterQuit({ restart: true, placed: false })).toBe(true)
    expect(opensCurrentAfterQuit({ restart: true, placed: true })).toBe(false)
  })

  it("never opens the current version on a plain quit", () => {
    for (const placed of [true, false])
      expect(opensCurrentAfterQuit({ restart: false, placed })).toBe(false)
  })

  it("reads each system's own sign that the update went in", () => {
    const none = { appImageSwapped: false, macPlaced: false, installerRan: false }
    for (const platform of ["linux", "darwin", "win32"] as const)
      expect(placedBy({ platform, ...none })).toBe(false)
    expect(placedBy({ platform: "linux", ...none, appImageSwapped: true })).toBe(true)
    expect(placedBy({ platform: "linux", ...none, macPlaced: true, installerRan: true })).toBe(
      false,
    )
    expect(placedBy({ platform: "darwin", ...none, macPlaced: true })).toBe(true)
    expect(placedBy({ platform: "darwin", ...none, appImageSwapped: true })).toBe(false)
    expect(placedBy({ platform: "win32", ...none, installerRan: true })).toBe(true)
    expect(placedBy({ platform: "win32", ...none, appImageSwapped: true })).toBe(false)
  })

  it("marks the quit before it quits, and a refused call touches nothing", () => {
    const quitting = notQuitting()
    let seen: Quitting | undefined
    expect(
      requestRestart({
        offer: "ready",
        mode: "install",
        quitting,
        quit: () => void (seen = { ...quitting }),
      }),
    ).toBe(true)
    expect(seen).toEqual({ stopping: false, orderly: true, reopenWanted: true, restart: true })

    for (const refused of [
      { offer: "available", mode: "install" as const },
      { offer: "ready", mode: "tell" as const },
    ]) {
      const untouched = notQuitting()
      let quit = 0
      expect(
        requestRestart({ ...refused, quitting: untouched, quit: () => void (quit += 1) }),
      ).toBe(false)
      expect(untouched).toEqual(notQuitting())
      expect(quit).toBe(0)
    }
    const stopping = { ...notQuitting(), stopping: true }
    expect(
      requestRestart({ offer: "ready", mode: "install", quitting: stopping, quit: () => {} }),
    ).toBe(false)
    expect(stopping).toEqual({ ...notQuitting(), stopping: true })
  })

  it("takes a restart back for a quit that must not open anything", () => {
    const quitting = { ...notQuitting(), orderly: true, restart: true, reopenWanted: true }
    dropRestart(quitting)
    expect(quitting).toEqual({ ...notQuitting(), orderly: true })
  })
})
