import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { screen } from "@novadeck/harness-core/testing/screens"
import type { AgentName } from "@novadeck/protocol"
import { afterEach, beforeEach, vi } from "vitest"

import { harnesses } from "../harnesses/registry.js"
import { describe, expect, it } from "../test.js"
import { adapterFolder } from "../testing/adapters.js"
import {
  freshTrack,
  lookAt,
  nextTrack,
  startupDelayMs,
  StartupWatch,
  type StartupLook,
  type WatchedRecord,
} from "./startup-watch.js"

const delayMs = 5_000

const shown = (rows: readonly string[], bracketedPaste = true): ScreenText =>
  screen({ rows, bracketedPaste })

// The looks at one screen, one a second, its text by look: the track after each.
const walk = (looks: readonly (readonly [StartupLook, string])[], start = freshTrack(0)) => {
  let track = start
  return looks.map(([look, text], index) => {
    track = nextTrack(track, look, text, (index + 1) * 1000, delayMs)
    return track.held
  })
}

const still = (count: number, text = "Trust?") =>
  Array.from({ length: count }, () => ["screen", text] as const)

describe("the startup watch", () => {
  describe("reading each harness's probed screens", () => {
    const probed: readonly (readonly [AgentName, readonly string[]])[] = [
      ["claude", ["trust", "onboarding", "resume", "signIn"]],
      ["codex", ["trust", "hooks", "signIn", "resume", "update"]],
      ["agy", ["trust", "onboarding", "signIn"]],
    ]

    it.each(probed)("finds %s's screens hold it, and its prompt doesn't", (agent, names) => {
      const screens = loadProbe<Record<string, ScreenText>>(
        adapterFolder(agent),
        "startup.probe.json",
      )
      const { box } = harnesses[agent]
      for (const name of names)
        expect([name, lookAt(screens[name]!, box)]).toEqual([name, "screen"])
      expect(lookAt(screens.prompt!, box)).toBe("box")
    })

    // What each probed screen's text names it; any other is only a startup screen.
    const named: readonly (readonly [AgentName, Record<string, string>])[] = [
      ["claude", { signIn: "sign-in" }],
      ["codex", { hooks: "hooks", signIn: "sign-in" }],
      ["agy", { signIn: "sign-in" }],
    ]

    it.each(named)("names %s's sign-in and hooks screens by their text", (agent, names) => {
      const screens = loadProbe<Record<string, ScreenText>>(
        adapterFolder(agent),
        "startup.probe.json",
      )
      const read = Object.fromEntries(
        Object.entries(screens).map(([name, one]) => [
          name,
          harnesses[agent].heldScreen?.(one.rows) ?? "startup",
        ]),
      )
      expect(read).toEqual(
        Object.fromEntries(Object.keys(screens).map((name) => [name, names[name] ?? "startup"])),
      )
    })

    it("reads Claude Code's prompt saying it isn't signed in", () => {
      const screens = loadProbe<Record<string, ScreenText>>(
        adapterFolder("claude"),
        "startup.probe.json",
      )
      const { signedOut } = harnesses.claude
      expect(signedOut?.(screens.signedOut!.rows)).toBe(true)
      expect(lookAt(screens.signedOut!, harnesses.claude.box)).toBe("box")
      for (const name of ["prompt", "trust", "onboarding", "resume", "signIn"])
        expect([name, signedOut?.(screens[name]!.rows)]).toEqual([name, false])
      // A reply quoting it, at the start of its row, is no footer.
      expect(signedOut?.(["⎿  Not logged in · Run /login"])).toBe(false)
    })
  })

  describe("before the agent takes the terminal", () => {
    const { box } = harnesses.claude

    it("counts nothing the shell printed, however long it stands", () => {
      expect(lookAt(shown(["See the sudo manual", "Loading"], false), box)).toBe("nothing")
    })

    it("counts no blank screen", () => {
      expect(lookAt(shown(["", "  ", ""]), box)).toBe("nothing")
    })
  })

  describe("following a screen", () => {
    it("holds its agent once it stood for the delay, not before", () => {
      expect(walk(still(7))).toEqual([false, false, false, false, false, true, true])
    })

    it("counts the delay again each time it changes", () => {
      const held = walk([...still(4, "one"), ...still(4, "two")])
      expect(held).toEqual(Array.from({ length: 8 }, () => false))
    })

    it("never holds on what isn't its agent's", () => {
      const nothing = Array.from({ length: 9 }, () => ["nothing", "Loading"] as const)
      expect(walk(nothing)).not.toContain(true)
    })

    it("ends at once at a box", () => {
      expect(walk([...still(7), ["box", "❯"]]).at(-1)).toBe(false)
    })

    const after = (looks: readonly (readonly [StartupLook, string])[]) => {
      let track = freshTrack(0)
      looks.forEach(([look, text], index) => {
        track = nextTrack(track, look, text, (index + 1) * 1000, delayMs)
      })
      return track
    }

    const prompt = (looks: number) => Array.from({ length: looks }, () => ["box", "❯"] as const)

    it("leaves an agent alone once its box stood for six delays", () => {
      expect(after(prompt(30)).prompted).toBe(false)
      expect(after(prompt(31)).prompted).toBe(true)
    })

    it("still sees a screen raised over a prompt that just drew, as Codex's hooks review", () => {
      expect(after([...prompt(5), ...still(7)])).toMatchObject({ held: true, prompted: false })
    })

    it("isn't fooled by a box that shows for a moment, as Codex's logo reads", () => {
      const track = after([["box", "logo"], ...still(7)])
      expect(track).toMatchObject({ held: true, prompted: false })
    })

    it("stays through a key the person presses at it", () => {
      const held = walk([...still(7, "❯ No"), ...still(1, "❯ Yes"), ...still(2, "❯ Yes")])
      expect(held.slice(6)).toEqual([true, true, true, true])
    })

    it("ends once it moved for as long as the delay", () => {
      const spinner = Array.from({ length: 7 }, (_, index) => ["screen", `${index}`] as const)
      expect(walk([...still(7), ...spinner]).slice(6)).toEqual([
        true,
        true,
        true,
        true,
        true,
        true,
        false,
        false,
      ])
    })

    it("waits longer on Windows", () => {
      expect(startupDelayMs("linux")).toBe(5_000)
      expect(startupDelayMs("darwin")).toBe(5_000)
      expect(startupDelayMs("win32")).toBe(15_000)
    })
  })

  describe("running", () => {
    const pollMs = 1000
    let clock = 0
    let expected: AgentName | null
    let drawn: ScreenText | undefined
    let changed: number
    let hooksOff: AgentName | undefined
    let stood: AgentName[]
    let answers: boolean
    const record: {
      summary: WatchedRecord["summary"]
      terminal: { run: number }
      startupScreen?: WatchedRecord["startupScreen"]
      bound: WatchedRecord["bound"]
      signedOut?: WatchedRecord["signedOut"]
    } = {
      summary: { id: "t", startup: null } as WatchedRecord["summary"],
      terminal: { run: 1 },
      bound: null,
    }
    let watch: StartupWatch<WatchedRecord>
    const claudeScreens = loadProbe<Record<string, ScreenText>>(
      adapterFolder("claude"),
      "startup.probe.json",
    )
    const watching = (screenNow: () => Promise<ScreenText | undefined>, delay: number) => {
      const started = new StartupWatch<WatchedRecord>(
        {
          stopping: () => false,
          records: () => [record],
          messaging: () => ({ expected: () => expected, untrustedAgent: () => hooksOff }),
          shown: () => ({
            boxStood: async (_record, agent) => {
              stood.push(agent)
              return answers
            },
          }),
          screen: screenNow,
          changed: () => {
            changed += 1
          },
        },
        pollMs,
        delay,
        () => clock,
      )
      started.start()
      return started
    }
    const pass = async (ms: number) => {
      for (let left = ms; left > 0; left -= pollMs) {
        clock += pollMs
        // eslint-disable-next-line no-await-in-loop -- One look at a time.
        await vi.advanceTimersByTimeAsync(pollMs)
      }
    }

    beforeEach(() => {
      vi.useFakeTimers()
      clock = 0
      changed = 0
      expected = "codex"
      drawn = shown(["Trust this folder?"])
      hooksOff = undefined
      stood = []
      answers = true
      record.summary = { ...record.summary, startup: null }
      record.terminal = { run: 1 }
      record.startupScreen = undefined
      record.bound = null
      record.signedOut = undefined
      watch = watching(async () => drawn, delayMs)
    })

    afterEach(() => {
      watch.stop()
      vi.useRealTimers()
    })

    it("marks a held terminal once, and tells of it", async () => {
      await pass(7000)
      expect(record.summary.startup).toEqual({ agent: "codex", screen: "startup" })
      expect(changed).toBe(1)
    })

    it("names the screen its agent says it is at, and follows it there", async () => {
      record.startupScreen = { screen: "sign-in", seq: 1 }
      await pass(7000)
      expect(record.summary.startup).toEqual({ agent: "codex", screen: "sign-in" })
      record.startupScreen = { screen: "startup", seq: 2 }
      await pass(1000)
      expect(record.summary.startup).toEqual({ agent: "codex", screen: "startup" })
      expect(changed).toBe(2)
    })

    it("lets go once the agent is no longer expected, and stops looking", async () => {
      await pass(7000)
      expected = null
      await pass(1000)
      expect(record.summary.startup).toBeNull()
      expect(changed).toBe(2)
      expect(vi.getTimerCount()).toBe(0)
    })

    it("doesn't mark again a terminal whose session bound during a look", async () => {
      watch.stop()
      // The look that would make it held is the one the session binds during.
      let looks = 0
      watch = watching(async () => {
        looks += 1
        if (looks === 6) expected = null
        return drawn
      }, delayMs)
      await pass(9000)
      expect(record.summary.startup).toBeNull()
      expect(changed).toBe(0)
    })

    it("lets go of a marked terminal whose expectation ended during a look", async () => {
      let ending = false
      watch.stop()
      watch = watching(async () => {
        if (ending) expected = null
        return drawn
      }, delayMs)
      await pass(7000)
      expect(record.summary.startup).not.toBeNull()
      ending = true
      await pass(1000)
      expect(record.summary.startup).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    })

    it("starts over for a restart's new shell", async () => {
      await pass(7000)
      expect(record.summary.startup).not.toBeNull()
      record.summary = { ...record.summary, startup: null }
      record.terminal = { run: 2 }
      drawn = shown(["Loading"], false)
      await pass(1000)
      expect(record.summary.startup).toBeNull()
    })

    it("never looks again at an agent past its box, as at a dialog it opens later", async () => {
      const { prompt } = loadProbe<Record<string, ScreenText>>(
        adapterFolder("codex"),
        "startup.probe.json",
      )
      drawn = prompt
      await pass(33_000)
      drawn = shown(["/model"])
      watch.start()
      await pass(9000)
      expect(record.summary.startup).toBeNull()
      expect(changed).toBe(0)
    })

    it("rests once every agent expected reached its box", async () => {
      drawn = loadProbe<Record<string, ScreenText>>(
        adapterFolder("codex"),
        "startup.probe.json",
      ).prompt
      await pass(33_000)
      expect(vi.getTimerCount()).toBe(0)
    })

    it("never marks a terminal it can't read", async () => {
      drawn = undefined
      await pass(7000)
      expect(record.summary.startup).toBeNull()
    })

    it("names a held screen its text tells, as Codex's hooks review", async () => {
      drawn = shown(["  Hooks need review", "  9 hooks are new or changed.", "› 1. Review hooks"])
      await pass(7000)
      expect(record.summary.startup).toEqual({ agent: "codex", screen: "hooks" })
    })

    it("asks once whether its hooks run, when its own box stood a delay", async () => {
      expected = "claude"
      drawn = claudeScreens.prompt
      await pass(4000)
      expect(stood).toEqual([])
      await pass(4000)
      expect(stood).toEqual(["claude"])
      await pass(10_000)
      expect(stood).toEqual(["claude"])
      expect(record.summary.startup).toBeNull()
    })

    it("asks again each delay while its harness can't answer, until it does", async () => {
      expected = "claude"
      drawn = claudeScreens.prompt
      answers = false
      await pass(7000)
      expect(stood).toEqual(["claude"])
      await pass(5000)
      expect(stood).toEqual(["claude", "claude"])
      answers = true
      await pass(5000)
      expect(stood).toEqual(["claude", "claude", "claude"])
      await pass(10_000)
      expect(stood).toEqual(["claude", "claude", "claude"])
    })

    it("marks an agent whose hooks are off at its prompt, until they no longer are", async () => {
      expected = "claude"
      drawn = claudeScreens.prompt
      await pass(6000)
      // Found off: nothing can deliver to it, so it is no longer expected.
      hooksOff = "claude"
      expected = null
      await pass(1000)
      expect(record.summary.startup).toEqual({ agent: "claude", screen: "hooks" })
      await pass(60_000)
      expect(record.summary.startup).toEqual({ agent: "claude", screen: "hooks" })
      expect(changed).toBe(1)
      // It left, or a session bound.
      hooksOff = undefined
      await pass(1000)
      expect(record.summary.startup).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    })

    describe("a bound session", () => {
      const binding = { agent: "claude", sessionId: "s" } as NonNullable<
        WatchedRecord["bound"]
      >["binding"]
      const signedOut = claudeScreens.signedOut
      const signedIn = claudeScreens.prompt

      beforeEach(() => {
        expected = null
        record.bound = { binding } as NonNullable<WatchedRecord["bound"]>
      })

      it("marks one whose prompt says it isn't signed in, until it is", async () => {
        drawn = signedOut
        await pass(2000)
        expect(record.summary.startup).toEqual({ agent: "claude", screen: "sign-in" })
        expect(record.signedOut).toBe(binding)
        await pass(60_000)
        expect(record.summary.startup).toEqual({ agent: "claude", screen: "sign-in" })
        drawn = signedIn
        await pass(2000)
        expect(record.summary.startup).toBeNull()
        expect(changed).toBe(2)
      })

      it("marks it again where it says so once more, after its footer was covered", async () => {
        drawn = signedOut
        await pass(20_000)
        expect(record.summary.startup).toEqual({ agent: "claude", screen: "sign-in" })
        // Its /login dialog covers the footer, and the person leaves it with Escape.
        drawn = shown(["  Select login method:", "  ❯ 1. Claude account with subscription"])
        await pass(2000)
        expect(record.summary.startup).toBeNull()
        drawn = signedOut
        await pass(2000)
        expect(record.summary.startup).toEqual({ agent: "claude", screen: "sign-in" })
      })

      it("looks at a signed-in prompt only a while after it binds", async () => {
        drawn = signedIn
        let looks = 0
        watch.stop()
        watch = watching(async () => {
          looks += 1
          return drawn
        }, delayMs)
        await pass(60_000)
        expect(record.summary.startup).toBeNull()
        expect(looks).toBeLessThanOrEqual(15)
        expect(vi.getTimerCount()).toBe(0)
      })

      it("leaves a session of a harness whose prompt never tells alone", async () => {
        record.bound = { binding: { ...binding, agent: "codex" } } as NonNullable<
          WatchedRecord["bound"]
        >
        let looks = 0
        watch.stop()
        watch = watching(async () => {
          looks += 1
          return signedOut
        }, delayMs)
        await pass(5000)
        expect(looks).toBe(0)
        expect(record.summary.startup).toBeNull()
      })
    })
  })
})
