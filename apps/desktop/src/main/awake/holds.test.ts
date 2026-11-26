import { spawn as spawnProcess, type ChildProcess } from "node:child_process"
import { once } from "node:events"

import type { Log } from "@novadeck/log"

import { context, describe, expect, it } from "../../test"
import { gnomeInhibit, systemHold, type Blocker, type Spawn } from "./holds"

// Electron's blocker, as the ids it started and stopped.
const blocker = () => {
  const ids = { started: [] as number[], stopped: [] as number[] }
  const fake: Blocker = {
    start: () => {
      ids.started.push(ids.started.length + 1)
      return ids.started.length
    },
    stop: (id) => void ids.stopped.push(id),
  }
  return { fake, ids }
}

// A log that keeps each line's event.
const lines = () => {
  const events: string[] = []
  const write = (event: string) => void events.push(event)
  const log: Log = { debug: write, info: write, warn: write, error: write, fatal: write }
  return { log, events }
}

// Stands in for gnome-session-inhibit as it runs `cat`: a process that ends when its stdin
// does. It records what it was asked to run.
const stand = () => {
  const asked: { file: string; args: readonly string[] }[] = []
  const children: ChildProcess[] = []
  const spawn: Spawn = (file, args, options) => {
    asked.push({ file, args })
    const child = spawnProcess(
      process.execPath,
      ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"],
      options,
    )
    children.push(child)
    return child
  }
  return { spawn, asked, children }
}

describe("the system's hold", () => {
  context("on macOS and Windows", () => {
    it("is Electron's, stopped on release, with nothing started beside it", () => {
      for (const platform of ["darwin", "win32"] as const) {
        const { fake, ids } = blocker()
        const { spawn, asked } = stand()
        const hold = systemHold({ platform, blocker: fake, spawn, env: {}, log: lines().log })()
        hold.release()
        expect(ids).toEqual({ started: [1], stopped: [1] })
        expect(asked).toEqual([])
      }
    })
  })

  context("on Linux", () => {
    it("also holds GNOME's suspend, which ends on release", async () => {
      const { fake, ids } = blocker()
      const { spawn, asked, children } = stand()
      const hold = systemHold({
        platform: "linux",
        blocker: fake,
        spawn,
        env: process.env,
        log: lines().log,
      })()
      expect(asked).toEqual([{ file: "gnome-session-inhibit", args: gnomeInhibit }])
      const ended = once(children[0]!, "exit")
      hold.release()
      await ended
      expect(ids).toEqual({ started: [1], stopped: [1] })
    })

    it("asks GNOME for suspend alone, so the screen still blanks, for as long as its pipe lasts", () => {
      expect(gnomeInhibit.slice(0, 2)).toEqual(["--inhibit", "suspend"])
      expect(gnomeInhibit).not.toContain("idle")
      expect(gnomeInhibit.at(-1)).toBe("cat")
    })

    it("still holds Electron's, and says why, where GNOME's can't be had", async () => {
      const { fake, ids } = blocker()
      const { log, events } = lines()
      const missing: Spawn = (_file, args, options) =>
        spawnProcess("novadeck-no-such-program", args, options)
      const hold = systemHold({
        platform: "linux",
        blocker: fake,
        spawn: missing,
        env: process.env,
        log,
      })()
      await expect.poll(() => events).toContain("awake.no-gnome")
      hold.release()
      expect(ids).toEqual({ started: [1], stopped: [1] })
    })
  })
})
