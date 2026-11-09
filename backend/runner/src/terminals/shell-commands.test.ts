/* eslint-disable no-await-in-loop -- Each case runs on its own fake clock, one after another. */
import { processesUnder, startResolutionMs, type Member, type Spawn } from "@novadeck/terminal/pty"
import type { BoxProfile, InputBox } from "@novadeck/tui-input/box"
import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../test.js"
import {
  lookMs,
  pollMs,
  ShellCommands,
  type ShellCommandsHost,
  type ShellRecord,
} from "./shell-commands.js"

const SHELL = 100

type Fake = ShellRecord & { box: InputBox | undefined; overlay: boolean }

const record = (): Fake => {
  const fake = {
    box: undefined as InputBox | undefined,
    overlay: false,
    hibernating: undefined,
    closed: false,
    summary: { shellCommand: null },
    terminal: {
      run: 1,
      exit: null,
      exiting: false,
      pty: { pid: SHELL },
      // The screen stands for the box as it was read.
      readScreen: () => Promise.resolve({} as never),
    },
  }
  return fake as unknown as Fake
}

const shellBox = (text: string): InputBox => ({ text, mode: "shell", first: 0, last: 0 })

const spawn = (pid: number, startedMs: number, parent = SHELL - 1, name = "sleep"): Spawn => ({
  key: `${pid}:${startedMs}`,
  pid,
  parent,
  name,
  startedMs,
})

type Setup = {
  readonly shells: ShellCommands<Fake>
  readonly rec: Fake
  readonly announced: () => number
  readonly processes: { current: readonly Spawn[] | undefined }
  readonly lookups: () => number
  readonly press: (box?: InputBox) => Promise<void>
}

const setup = (options: { resolutionMs?: number; profile?: boolean } = {}): Setup => {
  const rec = record()
  rec.box = shellBox("sleep 15")
  const processes: { current: readonly Spawn[] | undefined } = { current: [] }
  let announces = 0
  let lookups = 0
  const profile = {
    read: () => rec.box,
    overlay: () => rec.overlay,
  } as unknown as BoxProfile
  const host: ShellCommandsHost<Fake> = {
    profile: () => (options.profile === false ? undefined : profile),
    announce: () => {
      announces += 1
    },
    under: async () => {
      lookups += 1
      return processes.current
    },
    resolutionMs: () => options.resolutionMs ?? 10,
    trees: () => ({ read: async () => undefined }),
    stopping: () => false,
  }
  const shells = new ShellCommands<Fake>(host)
  return {
    shells,
    rec,
    processes,
    announced: () => announces,
    lookups: () => lookups,
    press: async (box) => {
      if (box) rec.box = box
      shells.entered(rec)
      await vi.advanceTimersByTimeAsync(0)
    },
  }
}

describe("shell commands", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("shows the process a shell-mode Enter started, then clears when it ends", async () => {
    const s = setup()
    await s.press()
    const at = Date.now()
    s.processes.current = [spawn(7, at + 5)]
    await vi.advanceTimersByTimeAsync(lookMs[0]!)
    expect(s.rec.summary.shellCommand).toEqual({ command: "sleep 15", since: at })
    expect(s.announced()).toBe(1)
    // Held: still alive a second later.
    await vi.advanceTimersByTimeAsync(pollMs)
    expect(s.rec.summary.shellCommand).not.toBeNull()
    s.processes.current = []
    await vi.advanceTimersByTimeAsync(pollMs)
    expect(s.rec.summary.shellCommand).toBeNull()
    expect(s.announced()).toBe(2)
    await vi.advanceTimersByTimeAsync(10 * pollMs)
    expect(s.shells.watching).toBe(0)
  })

  it("finds a slow command at the second look", async () => {
    const s = setup()
    await s.press()
    await vi.advanceTimersByTimeAsync(lookMs[0]!)
    expect(s.rec.summary.shellCommand).toBeNull()
    s.processes.current = [spawn(7, Date.now())]
    await vi.advanceTimersByTimeAsync(lookMs[1]! - lookMs[0]!)
    expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
  })

  it("reads a command only from a shell-mode box that holds one", async () => {
    for (const box of [
      { text: "hello", mode: "prompt" as const, first: 0, last: 0 },
      shellBox(""),
      undefined,
    ]) {
      const s = setup()
      s.rec.box = box
      s.processes.current = [spawn(7, Date.now() + 5)]
      s.shells.entered(s.rec)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(s.rec.summary.shellCommand).toBeNull()
      expect(s.lookups()).toBe(0)
      expect(s.shells.watching).toBe(0)
    }
    const overlaid = setup()
    overlaid.rec.overlay = true
    await overlaid.press()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(overlaid.lookups()).toBe(0)
    const none = setup({ profile: false })
    await none.press()
    expect(none.shells.watching).toBe(0)
  })

  describe("while a turn works", () => {
    const working = async (): Promise<{ s: Setup; t: number }> => {
      const s = setup()
      ;(s.rec.summary as { activity: unknown }).activity = { state: "working" }
      await s.press()
      return { s, t: Date.now() }
    }
    const ends = async (s: Setup): Promise<number> => {
      ;(s.rec.summary as { activity: unknown }).activity = { state: "idle" }
      s.shells.changed(s.rec)
      return Date.now()
    }

    it("looks at nothing until the turn ends, and keeps no timer", async () => {
      const { s, t } = await working()
      s.processes.current = [spawn(7, t + 5)]
      await vi.advanceTimersByTimeAsync(30_000)
      expect(s.lookups()).toBe(0)
      expect(s.rec.summary.shellCommand).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    })

    it("finds a command the harness queued, started after the turn's end", async () => {
      const { s } = await working()
      await vi.advanceTimersByTimeAsync(20_000)
      const e = await ends(s)
      s.processes.current = [spawn(7, e + 100)]
      await vi.advanceTimersByTimeAsync(lookMs[0]!)
      expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
    })

    it("finds a command run at once, started right after the Enter and alive at the end", async () => {
      const { s, t } = await working()
      s.processes.current = [spawn(7, t + 50)]
      await vi.advanceTimersByTimeAsync(20_000)
      await ends(s)
      await vi.advanceTimersByTimeAsync(lookMs[0]!)
      expect(s.rec.summary.shellCommand).toEqual({ command: "sleep 15", since: t })
    })

    it("drops the attempt when neither look finds anything", async () => {
      const { s } = await working()
      await vi.advanceTimersByTimeAsync(5_000)
      await ends(s)
      await vi.advanceTimersByTimeAsync(lookMs[1]!)
      expect(s.rec.summary.shellCommand).toBeNull()
      expect(s.shells.watching).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      // A later end finds nothing pending.
      const lookups = s.lookups()
      await ends(s)
      await vi.advanceTimersByTimeAsync(lookMs[1]!)
      expect(s.lookups()).toBe(lookups)
    })

    it("takes neither a tool process that ended before the turn's end nor a background one outside the windows", async () => {
      const { s, t } = await working()
      await vi.advanceTimersByTimeAsync(20_000)
      await ends(s)
      // Gone by the end: not listed. A background server started mid-turn, well after the
      // Enter and before the end, lives on.
      s.processes.current = [spawn(8, t + 10_000)]
      await vi.advanceTimersByTimeAsync(lookMs[1]!)
      expect(s.rec.summary.shellCommand).toBeNull()
    })

    it("drops a pending attempt with the terminal", async () => {
      const { s } = await working()
      ;(s.rec.terminal as { exit: unknown }).exit = { code: 0 }
      s.shells.end(s.rec, false)
      expect(s.shells.watching).toBe(0)
      s.processes.current = [spawn(7, Date.now() + 10)]
      await ends(s)
      await vi.advanceTimersByTimeAsync(lookMs[1]!)
      expect(s.lookups()).toBe(0)
    })

    it("shows the latest of two Enters mid-turn", async () => {
      const { s } = await working()
      await vi.advanceTimersByTimeAsync(1_000)
      await s.press(shellBox("sleep 30"))
      const t2 = Date.now()
      await vi.advanceTimersByTimeAsync(1_000)
      const e = await ends(s)
      s.processes.current = [spawn(7, e + 100)]
      await vi.advanceTimersByTimeAsync(lookMs[0]!)
      expect(s.rec.summary.shellCommand).toEqual({ command: "sleep 30", since: t2 })
    })
  })

  it("leaves out Novadeck's helpers and the wrappers they run under", async () => {
    const s = setup()
    await s.press()
    const at = Date.now()
    s.processes.current = [
      spawn(20, at + 1, 5, "sh"),
      spawn(21, at + 2, 20, "novadeck-relay"),
      spawn(22, at + 3, 5, "novadeck-relay.exe"),
    ]
    await vi.advanceTimersByTimeAsync(lookMs[1]!)
    expect(s.rec.summary.shellCommand).toBeNull()
    expect(s.announced()).toBe(0)
  })

  it("holds the top of a command beside the helpers", async () => {
    const s = setup()
    await s.press()
    const at = Date.now()
    // Claude's bash wrapper with sleep under it, and a status line's wrapper with the relay.
    s.processes.current = [
      spawn(20, at + 1, 5, "sh"),
      spawn(21, at + 2, 20, "novadeck-relay"),
      spawn(30, at + 4, 5, "bash"),
      spawn(31, at + 5, 30, "sleep"),
    ]
    await vi.advanceTimersByTimeAsync(lookMs[0]!)
    expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
    // The top is the hold: its child alone, or the helpers alone, are not the command.
    s.processes.current = [spawn(30, at + 4, 5, "bash"), spawn(31, at + 5, 30, "sleep")]
    await vi.advanceTimersByTimeAsync(pollMs)
    expect(s.rec.summary.shellCommand).not.toBeNull()
    s.processes.current = [spawn(20, at + 1, 5, "sh"), spawn(21, at + 2, 20, "novadeck-relay")]
    await vi.advanceTimersByTimeAsync(pollMs)
    expect(s.rec.summary.shellCommand).toBeNull()
  })

  it("ignores processes that started before the Enter", async () => {
    const s = setup()
    await s.press()
    s.processes.current = [spawn(5, Date.now() - 60_000)]
    await vi.advanceTimersByTimeAsync(lookMs[1]!)
    expect(s.rec.summary.shellCommand).toBeNull()
  })

  it("counts a process started within macOS's whole second before the Enter", async () => {
    const mac = setup({ resolutionMs: 1000 })
    await mac.press()
    // `ps` truncates the start to whole seconds: up to 999 ms before the Enter.
    mac.processes.current = [spawn(7, Date.now() - 900)]
    await vi.advanceTimersByTimeAsync(lookMs[0]!)
    expect(mac.rec.summary.shellCommand).not.toBeNull()
    const linux = setup({ resolutionMs: 10 })
    await linux.press()
    linux.processes.current = [spawn(7, Date.now() - 900)]
    await vi.advanceTimersByTimeAsync(lookMs[0]!)
    expect(linux.rec.summary.shellCommand).toBeNull()
  })

  it("finds the command through the relay's tree on Windows", async () => {
    const rec = record()
    rec.box = shellBox("timeout 15")
    let tree: readonly Member[] | undefined
    const shells = new ShellCommands<Fake>({
      profile: () => ({ read: () => rec.box, overlay: () => false }) as unknown as BoxProfile,
      announce: () => undefined,
      trees: () => ({ read: async () => tree }),
      under: (pid) => processesUnder(pid, { platform: "win32", trees: { read: async () => tree } }),
      resolutionMs: () => startResolutionMs("win32"),
      stopping: () => false,
    })
    shells.entered(rec)
    await vi.advanceTimersByTimeAsync(0)
    const at = Date.now()
    tree = [
      { pid: SHELL, startedAt: at - 9_000, name: "pwsh.exe" },
      { pid: 8, startedAt: at - 8_000, name: "claude.exe", parent: SHELL },
      { pid: 9, startedAt: at + 20, name: "timeout.exe", parent: 8 },
      { pid: 10, startedAt: at + 25, name: "novadeck-relay.exe", parent: 8 },
    ]
    await vi.advanceTimersByTimeAsync(lookMs[0]!)
    expect(rec.summary.shellCommand).toEqual({ command: "timeout 15", since: at })
    tree = [
      { pid: SHELL, startedAt: at - 9_000, name: "pwsh.exe" },
      { pid: 8, startedAt: at - 8_000, name: "claude.exe", parent: SHELL },
    ]
    await vi.advanceTimersByTimeAsync(pollMs)
    expect(rec.summary.shellCommand).toBeNull()
    shells.stop()
  })

  it("clears when the system can't tell twice in a row, not once", async () => {
    const s = setup()
    await s.press()
    s.processes.current = [spawn(7, Date.now() + 5)]
    await vi.advanceTimersByTimeAsync(lookMs[0]!)
    expect(s.rec.summary.shellCommand).not.toBeNull()
    s.processes.current = undefined
    await vi.advanceTimersByTimeAsync(pollMs)
    expect(s.rec.summary.shellCommand).not.toBeNull()
    // A look that could tell resets the count.
    s.processes.current = [spawn(7, Date.now() - 1000)]
    await vi.advanceTimersByTimeAsync(pollMs)
    s.processes.current = undefined
    await vi.advanceTimersByTimeAsync(pollMs)
    expect(s.rec.summary.shellCommand).not.toBeNull()
    await vi.advanceTimersByTimeAsync(pollMs)
    expect(s.rec.summary.shellCommand).toBeNull()
  })

  it("claims nothing when the first looks can't tell", async () => {
    const s = setup()
    await s.press()
    s.processes.current = undefined
    await vi.advanceTimersByTimeAsync(lookMs[1]!)
    expect(s.rec.summary.shellCommand).toBeNull()
    expect(s.shells.watching).toBe(0)
  })

  it("polls nothing for a terminal with no candidate", async () => {
    const s = setup()
    await s.press()
    await vi.advanceTimersByTimeAsync(lookMs[1]!)
    const looked = s.lookups()
    expect(looked).toBe(lookMs.length)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(s.lookups()).toBe(looked)
    expect(s.shells.watching).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("shows the latest command when a second Enter starts another", async () => {
    const s = setup()
    await s.press()
    const first = Date.now()
    s.processes.current = [spawn(7, first + 5)]
    await vi.advanceTimersByTimeAsync(lookMs[0]!)
    expect(s.rec.summary.shellCommand).toEqual({ command: "sleep 15", since: first })
    await vi.advanceTimersByTimeAsync(3_000)
    const second = Date.now()
    await s.press(shellBox("sleep 30"))
    s.processes.current = [spawn(7, first + 5), spawn(8, second + 5)]
    await vi.advanceTimersByTimeAsync(lookMs[0]!)
    expect(s.rec.summary.shellCommand).toEqual({ command: "sleep 30", since: second })
    // The first ending leaves it shown while the second runs; both over, it clears.
    s.processes.current = [spawn(8, second + 5)]
    await vi.advanceTimersByTimeAsync(pollMs)
    expect(s.rec.summary.shellCommand).not.toBeNull()
    s.processes.current = []
    await vi.advanceTimersByTimeAsync(pollMs)
    expect(s.rec.summary.shellCommand).toBeNull()
  })

  it("keeps a second Enter's looks when the first command ended meanwhile", async () => {
    const s = setup()
    await s.press()
    s.processes.current = [spawn(7, Date.now() + 5)]
    await vi.advanceTimersByTimeAsync(lookMs[0]!)
    await vi.advanceTimersByTimeAsync(pollMs - lookMs[0]! + 100)
    await vi.advanceTimersByTimeAsync(0)
    const second = Date.now()
    await s.press(shellBox("sleep 30"))
    // The first ends at the poll just before the second's look.
    s.processes.current = []
    await vi.advanceTimersByTimeAsync(300)
    s.processes.current = [spawn(9, second + 5)]
    await vi.advanceTimersByTimeAsync(lookMs[0]!)
    expect(s.rec.summary.shellCommand).toEqual({ command: "sleep 30", since: second })
  })

  it("ends and stops every timer when the agent leaves, the terminal exits or restarts, or it rests", async () => {
    const cases: [string, (rec: Fake) => void][] = [
      ["exit", (rec) => ((rec.terminal as { exit: unknown }).exit = { code: 0 })],
      ["restart", (rec) => ((rec.terminal as { run: number }).run = 2)],
      ["rest", (rec) => ((rec as { hibernating?: true }).hibernating = true)],
      ["closed", (rec) => ((rec as { closed: boolean }).closed = true)],
    ]
    for (const [, change] of cases) {
      const s = setup()
      await s.press()
      s.processes.current = [spawn(7, Date.now() + 5)]
      await vi.advanceTimersByTimeAsync(lookMs[0]!)
      expect(s.rec.summary.shellCommand).not.toBeNull()
      change(s.rec)
      await vi.advanceTimersByTimeAsync(pollMs)
      expect(s.rec.summary.shellCommand).toBeNull()
      expect(s.shells.watching).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it("ends at once on `end`, and `stop` leaves no timer", async () => {
    const s = setup()
    await s.press()
    s.processes.current = [spawn(7, Date.now() + 5)]
    await vi.advanceTimersByTimeAsync(lookMs[0]!)
    s.shells.end(s.rec)
    expect(s.rec.summary.shellCommand).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    const t = setup()
    await t.press()
    t.shells.stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.lookups()).toBe(0)
  })
})
