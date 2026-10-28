import { readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach } from "vitest"

import { context, describe, expect, it } from "../test"
import { isNewerVersion } from "./applications-folder"
import { installOutcome, keepUpdateState, updateStateOf } from "./update-state"

let folder: string
let file: string

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "novadeck-update-state-"))
  file = join(folder, "update.json")
})
afterEach(() => rm(folder, { recursive: true, force: true }))

describe("what the host remembers about updating", () => {
  it("starts on the stable channel with nothing failed", () => {
    expect(keepUpdateState(file).read()).toEqual({
      channel: "stable",
      installFailedOn: undefined,
      installing: undefined,
      lastRunVersion: undefined,
      whatsNewPending: undefined,
      whatsNewFrom: undefined,
      whatsNewSettled: undefined,
      whatsNewCheckedAt: undefined,
    })
  })

  context("the channel", () => {
    it("persists across launches", () => {
      keepUpdateState(file).setChannel("experimental")
      expect(keepUpdateState(file).read().channel).toBe("experimental")
      keepUpdateState(file).setChannel("stable")
      expect(keepUpdateState(file).read().channel).toBe("stable")
    })

    it("falls back to stable for anything that is not a channel", () => {
      for (const channel of [
        "nightly",
        "toString",
        "__proto__",
        3,
        null,
        ["experimental"],
        { channel: "experimental" },
      ])
        expect(updateStateOf(JSON.stringify({ channel })).channel).toBe("stable")
    })

    it("falls back to the defaults for a damaged file, each field apart", () => {
      for (const text of ["", "{", "null", "[]", '"experimental"'])
        expect(updateStateOf(text).channel).toBe("stable")
      expect(
        updateStateOf('{"channel":"experimental","installFailedOn":7,"installing":[]}'),
      ).toEqual({
        channel: "experimental",
        installFailedOn: undefined,
        installing: undefined,
        lastRunVersion: undefined,
        whatsNewPending: undefined,
        whatsNewFrom: undefined,
        whatsNewSettled: undefined,
        whatsNewCheckedAt: undefined,
      })
    })

    it("keeps when a prerelease was last read, only for the notes still pending", () => {
      const state = keepUpdateState(file)
      state.recordLaunch("0.5.0-beta.1", "0.5.0-beta.1", undefined)
      state.recordWhatsNewCheck(5)
      state.recordLaunch("0.5.0-beta.1", "0.5.0-beta.1", undefined)
      expect(state.read().whatsNewCheckedAt).toBe(5)
      state.recordLaunch("0.5.0-beta.2", "0.5.0-beta.2", undefined)
      expect(state.read().whatsNewCheckedAt).toBeUndefined()
      state.recordWhatsNewCheck(7)
      state.settleWhatsNew("0.5.0-beta.2", isNewerVersion)
      expect(state.read().whatsNewCheckedAt).toBeUndefined()
      expect(updateStateOf('{"whatsNewCheckedAt":"5"}').whatsNewCheckedAt).toBeUndefined()
    })

    it("reads a version that is not a release's as unset, so a corrupt one silences nothing", () => {
      const state = updateStateOf(
        '{"lastRunVersion":"x","whatsNewPending":"1.2","whatsNewSettled":"99999999999.0.0"}',
      )
      expect(state).toMatchObject({
        lastRunVersion: undefined,
        whatsNewPending: undefined,
        whatsNewSettled: undefined,
      })
      expect(
        updateStateOf('{"whatsNewSettled":"0.5.0","lastRunVersion":"0.5.0-beta.1"}'),
      ).toMatchObject({ whatsNewSettled: "0.5.0", lastRunVersion: "0.5.0-beta.1" })
    })

    it("keeps where the pending notes start until they are settled", () => {
      const state = keepUpdateState(file)
      state.recordLaunch("0.5.0", "0.5.0", "0.4.2")
      expect(state.read().whatsNewFrom).toBe("0.4.2")
      state.settleWhatsNew("0.5.0", isNewerVersion)
      expect(state.read().whatsNewFrom).toBeUndefined()
      expect(updateStateOf('{"whatsNewFrom":"0.4"}').whatsNewFrom).toBeUndefined()
    })

    it("keeps the newest version settled, whatever order they are settled in", () => {
      const state = keepUpdateState(file)
      state.settleWhatsNew("0.6.0", isNewerVersion)
      state.settleWhatsNew("0.5.0", isNewerVersion)
      expect(state.read().whatsNewSettled).toBe("0.6.0")
      state.settleWhatsNew("0.7.0", isNewerVersion)
      expect(state.read().whatsNewSettled).toBe("0.7.0")
      expect(updateStateOf('{"whatsNewSettled":3}').whatsNewSettled).toBeUndefined()
    })

    it("keeps the launch's version and the notes still to show, each apart", () => {
      const state = keepUpdateState(file)
      state.setChannel("experimental")
      state.recordLaunch("0.5.0", "0.5.0", undefined)
      expect(state.read()).toMatchObject({
        channel: "experimental",
        lastRunVersion: "0.5.0",
        whatsNewPending: "0.5.0",
      })
      state.settleWhatsNew("0.5.0", isNewerVersion)
      expect(state.read()).toMatchObject({ lastRunVersion: "0.5.0", whatsNewPending: undefined })
      expect(updateStateOf('{"lastRunVersion":5,"whatsNewPending":{}}')).toMatchObject({
        lastRunVersion: undefined,
        whatsNewPending: undefined,
      })
    })
  })

  context("writing", () => {
    it("goes through a temporary file that is renamed over, leaving none behind", async () => {
      const state = keepUpdateState(file)
      state.setChannel("experimental")
      state.recordInstallFailure("0.4.2")
      expect(await readdir(folder)).toEqual(["update.json"])
    })

    it("is complete when the call returns, as the app may be exiting", () => {
      keepUpdateState(file).recordInstallFailure("0.4.2")
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
        installFailedOn: "0.4.2",
      })
    })

    it("merges with what another writer left in the file, never with a stale copy", () => {
      const state = keepUpdateState(file)
      state.setChannel("experimental")
      // Something else changed the file between two changes.
      writeFileSync(file, JSON.stringify({ channel: "stable" }))
      state.recordInstallFailure("0.4.2")
      expect(state.read()).toEqual({
        channel: "stable",
        installFailedOn: "0.4.2",
        installing: undefined,
      })
    })

    it("leaves the file whole and no temporary file when a write fails", async () => {
      const state = keepUpdateState(join(folder, "missing", "update.json"))
      expect(() => state.setChannel("experimental")).toThrow()
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

    it("is replaced by a later failure and keeps the channel", () => {
      const state = keepUpdateState(file)
      state.setChannel("experimental")
      state.recordInstallFailure("0.4.2")
      state.recordInstallFailure("0.5.0")
      expect(state.read()).toEqual({
        channel: "experimental",
        installFailedOn: "0.5.0",
        installing: undefined,
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
      state.setChannel("experimental")
      expect(state.read().installFailedOn).toBe("0.4.2")
    })
  })

  context("an install begun on quitting", () => {
    // Whether `a` is a newer version than `b`, for these tests' plain versions.
    const newer = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }) > 0

    it("is kept for the next launch, and cleared once it has looked", () => {
      const state = keepUpdateState(file)
      state.recordInstalling("0.5.0")
      expect(keepUpdateState(file).read().installing).toBe("0.5.0")
      state.clearInstalling()
      expect(state.read().installing).toBeUndefined()
    })

    it("is settled by a failure recorded for it", () => {
      const state = keepUpdateState(file)
      state.recordInstalling("0.5.0")
      state.recordInstallFailure("0.5.0")
      expect(state.read()).toMatchObject({ installFailedOn: "0.5.0", installing: undefined })
    })

    it("failed when the launch is still older than the version it put in place", () => {
      expect(installOutcome({ installing: "0.5.0" }, "0.4.2", newer)).toBe("failed")
    })

    it("is done when the launch is that version or newer", () => {
      expect(installOutcome({ installing: "0.5.0" }, "0.5.0", newer)).toBe("done")
      expect(installOutcome({ installing: "0.5.0" }, "0.5.1", newer)).toBe("done")
    })

    it("tells nothing when no install was begun", () => {
      expect(installOutcome({ installing: undefined }, "0.4.2", newer)).toBeUndefined()
    })
  })
})
