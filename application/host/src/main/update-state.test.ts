import { readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach } from "vitest"

import { context, describe, expect, it } from "../test"
import { keepUpdateState, updateStateOf } from "./update-state"

let folder: string
let file: string

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "novadeck-update-state-"))
  file = join(folder, "update.json")
})
afterEach(() => rm(folder, { recursive: true, force: true }))

describe("what the host remembers about updating", () => {
  it("starts on the stable channel with nothing failed or declined", () => {
    expect(keepUpdateState(file).read()).toEqual({
      channel: "stable",
      installFailedOn: undefined,
      moveDeclined: false,
    })
  })

  context("the channel", () => {
    it("persists across launches", () => {
      keepUpdateState(file).setChannel("early")
      expect(keepUpdateState(file).read().channel).toBe("early")
      keepUpdateState(file).setChannel("stable")
      expect(keepUpdateState(file).read().channel).toBe("stable")
    })

    it("falls back to stable for anything that is not a channel", () => {
      for (const channel of ["nightly", 3, null, ["early"], { channel: "early" }])
        expect(updateStateOf(JSON.stringify({ channel })).channel).toBe("stable")
    })

    it("falls back to the defaults for a damaged file, each field apart", () => {
      for (const text of ["", "{", "null", "[]", '"early"'])
        expect(updateStateOf(text).channel).toBe("stable")
      expect(updateStateOf('{"channel":"early","installFailedOn":7}')).toEqual({
        channel: "early",
        installFailedOn: undefined,
        moveDeclined: false,
      })
    })
  })

  context("writing", () => {
    it("goes through a temporary file that is renamed over, leaving none behind", async () => {
      const state = keepUpdateState(file)
      state.setChannel("early")
      state.recordInstallFailure("0.4.2")
      expect(await readdir(folder)).toEqual(["update.json"])
    })

    it("is complete when the call returns, as the app may be exiting", () => {
      keepUpdateState(file).recordInstallFailure("0.4.2")
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ installFailedOn: "0.4.2" })
    })

    it("merges with what another writer left in the file, never with a stale copy", () => {
      const state = keepUpdateState(file)
      state.setChannel("early")
      // Something else changed the file between two changes.
      writeFileSync(file, JSON.stringify({ channel: "early", moveDeclined: true }))
      state.recordInstallFailure("0.4.2")
      expect(state.read()).toEqual({
        channel: "early",
        installFailedOn: "0.4.2",
        moveDeclined: true,
      })
    })

    it("leaves the file whole and no temporary file when a write fails", async () => {
      const state = keepUpdateState(join(folder, "missing", "update.json"))
      expect(() => state.setChannel("early")).toThrow()
      expect(await readdir(folder)).toEqual([])
    })
  })

  context("a failed install", () => {
    it("is marked with the running version and read back for that version alone", () => {
      const state = keepUpdateState(file)
      state.recordInstallFailure("0.4.2")
      const kept = state.read().installFailedOn
      expect(kept).toBe("0.4.2")
      // A build of a newer version does not see its own version in the mark.
      expect(kept === "0.5.0").toBe(false)
    })

    it("is replaced by a later failure and keeps the channel and the move choice", () => {
      const state = keepUpdateState(file)
      state.setChannel("early")
      state.declineMove()
      state.recordInstallFailure("0.4.2")
      state.recordInstallFailure("0.5.0")
      expect(state.read()).toEqual({
        channel: "early",
        installFailedOn: "0.5.0",
        moveDeclined: true,
      })
    })

    it("is written even when the file is damaged", async () => {
      await writeFile(file, "{")
      const state = keepUpdateState(file)
      state.recordInstallFailure("0.4.2")
      expect(state.read().installFailedOn).toBe("0.4.2")
    })

    it("is kept when the channel changes afterwards", () => {
      const state = keepUpdateState(file)
      state.recordInstallFailure("0.4.2")
      state.setChannel("early")
      expect(state.read().installFailedOn).toBe("0.4.2")
    })
  })

  it("remembers that the person declined the move to Applications", () => {
    keepUpdateState(file).declineMove()
    expect(keepUpdateState(file).read().moveDeclined).toBe(true)
  })
})
