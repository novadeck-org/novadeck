/* eslint-disable no-await-in-loop -- Each case runs on its own fake clock, one after another. */
import { processesUnder, startResolutionMs, type Member, type Spawn } from "@novadeck/terminal/pty"
import type { BoxProfile, InputBox } from "@novadeck/tui-input/box"
import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../test.js"
import {
  findMs,
  lookEveryMs,
  pollMs,
  ShellCommands,
  unknownMs,
  type ShellCommandsHost,
  type ShellRecord,
} from "./shell-commands.js"

const SHELL = 100
const AGENT = 50

type Fake = ShellRecord & { box: InputBox | undefined; overlay: boolean }

const record = (instance: string | null = null): Fake => {
  const fake = {
    box: undefined as InputBox | undefined,
    overlay: false,
    hibernating: undefined,
    closed: false,
    bound: instance === null ? null : { binding: { instance } },
    summary: { shellCommand: null, activity: null },
    terminal: {
      run: 1,
      exit: null,
      exiting: false,
      pty: { pid: SHELL },
      readScreen: () => Promise.resolve({} as never),
    },
  }
  return fake as unknown as Fake
}

const shellBox = (text: string): InputBox => ({ text, mode: "shell", first: 0, last: 0 })

const spawn = (pid: number, startedMs: number, parent = AGENT, name = "sleep"): Spawn => ({
  key: `${pid}:${startedMs}`,
  pid,
  parent,
  name,
  startedMs,
})

const activity = (rec: Fake, state: "working" | "idle"): void => {
  ;(rec.summary as { activity: unknown }).activity = { state }
}

type Setup = {
  readonly shells: ShellCommands<Fake>
  readonly rec: Fake
  readonly announced: () => number
  readonly processes: { current: readonly Spawn[] | undefined }
  readonly lookups: () => number
  readonly press: (box?: InputBox) => Promise<number>
  readonly ends: () => Promise<number>
}

const setup = (
  options: {
    resolutionMs?: number
    profile?: boolean
    midTurn?: "queues" | "runs"
    agent?: boolean
    delay?: number
    /** Tests: whether the next listing fails. */
    unlisted?: () => boolean
  } = {},
): Setup => {
  const rec = record(options.agent ? String(AGENT) : null)
  rec.box = shellBox("sleep 15")
  const processes: { current: readonly Spawn[] | undefined } = { current: [] }
  let announces = 0
  let lookups = 0
  const profile = {
    read: () => rec.box,
    overlay: () => rec.overlay,
    shell: { midTurn: options.midTurn ?? "queues" },
  } as unknown as BoxProfile
  const host: ShellCommandsHost<Fake> = {
    profile: () => (options.profile === false ? undefined : profile),
    announce: () => {
      announces += 1
    },
    under: async () => {
      lookups += 1
      if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay))
      if (options.unlisted?.()) return undefined
      return processes.current
    },
    trees: () => ({ read: async () => undefined }),
    resolutionMs: () => options.resolutionMs ?? 10,
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
      const at = Date.now()
      shells.entered(rec)
      await vi.advanceTimersByTimeAsync(0)
      return at
    },
    ends: async () => {
      activity(rec, "idle")
      shells.changed(rec)
      return Date.now()
    },
  }
}

const settle = (ms: number) => vi.advanceTimersByTimeAsync(ms)

describe("shell commands", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("shows the process a shell-mode Enter started once seen live a second apart, then clears", async () => {
    const s = setup()
    const at = await s.press()
    s.processes.current = [spawn(7, at + 5)]
    await settle(lookEveryMs)
    expect(s.rec.summary.shellCommand).toBeNull()
    await settle(lookEveryMs * 2)
    expect(s.rec.summary.shellCommand).toEqual({ command: "sleep 15", since: at })
    expect(s.announced()).toBe(1)
    await settle(pollMs)
    expect(s.rec.summary.shellCommand).not.toBeNull()
    s.processes.current = []
    await settle(pollMs)
    expect(s.rec.summary.shellCommand).toBeNull()
    expect(s.announced()).toBe(2)
    await settle(findMs + 5 * pollMs)
    expect(s.shells.watching).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("never shows a command that ends within a second", async () => {
    const s = setup()
    const at = await s.press()
    s.processes.current = [spawn(7, at + 5)]
    await settle(lookEveryMs * 2 - 100)
    s.processes.current = []
    await settle(findMs)
    expect(s.announced()).toBe(0)
  })

  it("still shows a command first seen late in the window", async () => {
    const s = setup()
    const at = await s.press()
    s.processes.current = []
    await settle(3_900)
    s.processes.current = [spawn(7, at + 3_950)]
    await settle(findMs - 3_900)
    expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
  })

  it("tolerates timer jitter: a gap of 990 ms between sightings counts", async () => {
    const s = setup()
    const at = await s.press()
    s.processes.current = [spawn(7, at + 5)]
    await settle(lookEveryMs)
    // The clock steps back a little between looks, so the sightings are 495 ms apart each.
    vi.setSystemTime(Date.now() - 5)
    await settle(lookEveryMs)
    expect(s.rec.summary.shellCommand).toBeNull()
    await settle(lookEveryMs)
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
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toBeNull()
      expect(s.lookups()).toBe(0)
      expect(s.shells.watching).toBe(0)
    }
    const overlaid = setup()
    overlaid.rec.overlay = true
    await overlaid.press()
    await settle(findMs)
    expect(overlaid.lookups()).toBe(0)
    const none = setup({ profile: false })
    await none.press()
    expect(none.shells.watching).toBe(0)
  })

  it("ignores processes that started before the Enter", async () => {
    const s = setup()
    await s.press()
    s.processes.current = [spawn(5, Date.now() - 60_000)]
    await settle(findMs + 1_000)
    expect(s.rec.summary.shellCommand).toBeNull()
  })

  it("counts a process started within macOS's whole second before the Enter", async () => {
    const mac = setup({ resolutionMs: startResolutionMs("darwin") })
    await mac.press()
    mac.processes.current = [spawn(7, Date.now() - 900)]
    await settle(findMs)
    expect(mac.rec.summary.shellCommand).not.toBeNull()
    const linux = setup({ resolutionMs: startResolutionMs("linux") })
    await linux.press()
    linux.processes.current = [spawn(7, Date.now() - 900)]
    await settle(findMs)
    expect(linux.rec.summary.shellCommand).toBeNull()
  })

  it("finds the command through the relay's tree on Windows, with a console host beside it", async () => {
    const rec = record()
    rec.box = shellBox("timeout 15")
    let tree: readonly Member[] | undefined
    const shells = new ShellCommands<Fake>({
      profile: () =>
        ({ read: () => rec.box, overlay: () => false, shell: {} }) as unknown as BoxProfile,
      announce: () => undefined,
      trees: () => ({ read: async () => tree }),
      under: (pid) => processesUnder(pid, { platform: "win32", trees: { read: async () => tree } }),
      resolutionMs: () => startResolutionMs("win32"),
      stopping: () => false,
    })
    shells.entered(rec)
    await settle(0)
    const at = Date.now()
    // The command is the one process, with its console host under it: the host alone is left out.
    tree = [
      { pid: SHELL, startedAt: at - 9_000, name: "pwsh.exe" },
      { pid: 8, startedAt: at - 8_000, name: "claude.exe", parent: SHELL },
      { pid: 9, startedAt: at + 20, name: "timeout.exe", parent: 8 },
      { pid: 11, startedAt: at + 22, name: "conhost.exe", parent: 9 },
      { pid: 10, startedAt: at + 25, name: "novadeck-relay.exe", parent: 8 },
    ]
    await settle(findMs)
    expect(rec.summary.shellCommand).toEqual({ command: "timeout 15", since: at })
    tree = [
      { pid: SHELL, startedAt: at - 9_000, name: "pwsh.exe" },
      { pid: 8, startedAt: at - 8_000, name: "claude.exe", parent: SHELL },
    ]
    await settle(pollMs)
    expect(rec.summary.shellCommand).toBeNull()
    shells.stop()
  })

  describe("helpers", () => {
    it("leaves out the relay, the hook launcher, what they run and the shell wrapper above", async () => {
      const s = setup()
      const at = await s.press()
      s.processes.current = [
        // A status line: sh -c wrapper, the relay, and the person's own command under it.
        spawn(20, at + 1, 5, "sh"),
        spawn(21, at + 2, 20, "novadeck-relay"),
        spawn(22, at + 3, 21, "starship"),
        // A hook launcher's fallback and what it starts.
        spawn(23, at + 4, 5, "hook"),
        spawn(24, at + 5, 23, "node"),
        // A console host with nothing under it.
        spawn(25, at + 6, 5, "conhost.exe"),
      ]
      await settle(findMs + 1_000)
      expect(s.rec.summary.shellCommand).toBeNull()
      expect(s.announced()).toBe(0)
    })

    it("keeps a nested agent's command, whose relay is under a program that is no shell", async () => {
      const s = setup()
      const at = await s.press()
      s.processes.current = [
        spawn(30, at + 1, 5, "claude"),
        spawn(31, at + 2, 30, "novadeck-relay"),
        spawn(32, at + 3, 30, "sh"),
      ]
      await settle(findMs)
      expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
    })

    it("holds the top of a command beside the helpers", async () => {
      const s = setup()
      const at = await s.press()
      s.processes.current = [
        spawn(20, at + 1, 5, "sh"),
        spawn(21, at + 2, 20, "novadeck-relay"),
        spawn(30, at + 4, 5, "bash"),
        spawn(31, at + 5, 30, "sleep"),
      ]
      await settle(findMs)
      expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
      s.processes.current = [spawn(30, at + 4, 5, "bash"), spawn(31, at + 5, 30, "sleep")]
      await settle(pollMs)
      expect(s.rec.summary.shellCommand).not.toBeNull()
      s.processes.current = [spawn(20, at + 1, 5, "sh"), spawn(21, at + 2, 20, "novadeck-relay")]
      await settle(pollMs)
      expect(s.rec.summary.shellCommand).toBeNull()
    })
  })

  describe("the bound agent", () => {
    it("takes only a top process whose parent is the agent", async () => {
      const s = setup({ agent: true })
      const at = await s.press()
      // A dev server's watcher restarting its own child after the Enter.
      const server = [spawn(40, at - 60_000, AGENT, "node"), spawn(41, at + 100, 40, "node")]
      s.processes.current = server
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toBeNull()
      // The command, in a window of its own.
      const second = await s.press()
      s.processes.current = [...server, spawn(42, second + 200, AGENT, "bash")]
      await settle(findMs)
      expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
      // It ends with its own process, though the server's child lives on.
      s.processes.current = server
      await settle(pollMs)
      expect(s.rec.summary.shellCommand).toBeNull()
    })

    it("applies no parent rule to an agent not bound yet", async () => {
      const s = setup()
      const at = await s.press()
      s.processes.current = [spawn(41, at + 100, 40, "node")]
      await settle(findMs)
      expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
    })
  })

  it("claims nothing when the looks can't tell, and treats a failing look as one that can't", async () => {
    const s = setup()
    await s.press()
    s.processes.current = undefined
    await settle(findMs + 1_000)
    expect(s.rec.summary.shellCommand).toBeNull()
    expect(s.shells.watching).toBe(0)

    const rec = record()
    rec.box = shellBox("sleep 15")
    let fail = false
    const started = Date.now() + 5
    const shells = new ShellCommands<Fake>({
      profile: () =>
        ({ read: () => rec.box, overlay: () => false, shell: {} }) as unknown as BoxProfile,
      announce: () => undefined,
      trees: () => ({ read: async () => undefined }),
      under: async () => {
        if (fail) throw new Error("relay gone")
        return [spawn(7, started)]
      },
      resolutionMs: () => 10,
      stopping: () => false,
    })
    shells.entered(rec)
    await settle(findMs)
    expect(rec.summary.shellCommand).not.toBeNull()
    fail = true
    await settle(unknownMs - pollMs)
    expect(rec.summary.shellCommand).not.toBeNull()
    await settle(2 * pollMs)
    expect(rec.summary.shellCommand).toBeNull()
    shells.stop()
  })

  it("hides a command only after about five seconds of polls that can't tell", async () => {
    const s = setup()
    const at = await s.press()
    const started = at + 5
    s.processes.current = [spawn(7, started)]
    await settle(findMs)
    expect(s.rec.summary.shellCommand).not.toBeNull()
    s.processes.current = undefined
    await settle(unknownMs - pollMs)
    expect(s.rec.summary.shellCommand).not.toBeNull()
    // One look that could tell starts the count again.
    s.processes.current = [spawn(7, started)]
    await settle(pollMs)
    s.processes.current = undefined
    await settle(unknownMs - pollMs)
    expect(s.rec.summary.shellCommand).not.toBeNull()
    await settle(2 * pollMs)
    expect(s.rec.summary.shellCommand).toBeNull()
  })

  it("polls every shown command from one tick, so their listings coincide", async () => {
    const recs = [record(), record()]
    recs.forEach((rec, index) => {
      rec.box = shellBox("sleep 15")
      ;(rec.terminal.pty as { pid: number }).pid = 200 + index
    })
    const calls: { pid: number; at: number }[] = []
    const shells = new ShellCommands<Fake>({
      profile: () =>
        ({ read: () => recs[0]!.box, overlay: () => false, shell: {} }) as unknown as BoxProfile,
      announce: () => undefined,
      trees: () => ({ read: async () => undefined }),
      under: async (pid) => {
        calls.push({ pid, at: Date.now() })
        return [spawn(pid, pid === 200 ? 1_000_005 : 1_000_310, 10)]
      },
      resolutionMs: () => 10,
      stopping: () => false,
    })
    shells.entered(recs[0]!)
    await settle(0)
    await settle(300)
    shells.entered(recs[1]!)
    await settle(findMs)
    expect(recs.map((rec) => rec.summary.shellCommand !== null)).toEqual([true, true])
    calls.length = 0
    await settle(3 * pollMs)
    // Each tick lists for both at the same moment.
    const ticks = new Map<number, number>()
    for (const { at } of calls) ticks.set(at, (ticks.get(at) ?? 0) + 1)
    expect([...ticks.values()]).toEqual([2, 2, 2])
    shells.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("starts the next command's unknown count afresh after one was hidden", async () => {
    const s = setup()
    const first = await s.press()
    s.processes.current = [spawn(7, first + 5)]
    await settle(2_000)
    expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
    // The relay fails; a second Enter keeps the watch open past the first command's hide.
    s.processes.current = undefined
    await settle(3_500)
    const second = await s.press(shellBox("sleep 30"))
    await settle(2_400)
    expect(s.rec.summary.shellCommand).toBeNull()
    // The system recovers, and the second command shows; one failed poll must not hide it.
    s.processes.current = [spawn(8, Date.now())]
    await settle(1_500)
    expect(s.rec.summary.shellCommand).toEqual({ command: "sleep 30", since: second })
    s.processes.current = undefined
    await settle(pollMs + 100)
    expect(s.rec.summary.shellCommand).not.toBeNull()
  })

  it("keeps no timer for a terminal with no candidate", async () => {
    const s = setup()
    await s.press()
    await settle(findMs + 500)
    const looked = s.lookups()
    await settle(30_000)
    expect(s.lookups()).toBe(looked)
    expect(s.shells.watching).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  describe("two Enters", () => {
    it("shows the latest command when a second Enter starts another", async () => {
      const s = setup()
      const first = await s.press()
      s.processes.current = [spawn(7, first + 5)]
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toEqual({ command: "sleep 15", since: first })
      const second = await s.press(shellBox("sleep 30"))
      s.processes.current = [spawn(7, first + 5), spawn(8, second + 5)]
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toEqual({ command: "sleep 30", since: second })
      s.processes.current = [spawn(8, second + 5)]
      await settle(pollMs)
      expect(s.rec.summary.shellCommand).not.toBeNull()
      s.processes.current = []
      await settle(pollMs)
      expect(s.rec.summary.shellCommand).toBeNull()
    })

    it("keeps a second Enter's looks when the first command ended meanwhile", async () => {
      const s = setup()
      const first = await s.press()
      s.processes.current = [spawn(7, first + 5)]
      await settle(findMs)
      const second = await s.press(shellBox("sleep 30"))
      s.processes.current = [spawn(9, second + 5)]
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toEqual({ command: "sleep 30", since: second })
    })

    it("gives each attempt its own cutoff and first-seen times", async () => {
      const s = setup()
      // A's window sees a turn start, which cuts A off; its tool's process is not A's.
      await s.press()
      await settle(1_200)
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      await settle(100)
      activity(s.rec, "idle")
      s.shells.changed(s.rec)
      // B comes after that turn: A's cutoff is not B's, and B's sighting is not reset by A's looks.
      const second = await s.press(shellBox("sleep 30"))
      s.processes.current = [spawn(8, second + 5)]
      await settle(lookEveryMs * 3)
      expect(s.rec.summary.shellCommand).toEqual({ command: "sleep 30", since: second })
    })
  })

  describe("while a turn works", () => {
    const working = async (options: Parameters<typeof setup>[0] = {}) => {
      const s = setup(options)
      activity(s.rec, "working")
      const t = await s.press()
      return { s, t }
    }

    it("looks at nothing until the turn ends, and keeps no timer", async () => {
      const { s, t } = await working()
      s.processes.current = [spawn(7, t + 5)]
      await settle(30_000)
      expect(s.lookups()).toBe(0)
      expect(s.rec.summary.shellCommand).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    })

    it("finds a command the harness queued, started after the turn's end", async () => {
      const { s } = await working()
      await settle(20_000)
      const e = await s.ends()
      s.processes.current = [spawn(7, e + 100)]
      await settle(findMs)
      expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
    })

    it("finds a Codex command run at once, started right after the Enter, still alive at the end", async () => {
      const { s, t } = await working({ midTurn: "runs" })
      s.processes.current = [spawn(7, t + 50)]
      await settle(20_000)
      await s.ends()
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toEqual({ command: "sleep 15", since: t })
    })

    it("takes no turn's background tool started right after the Enter where the harness queues", async () => {
      const { s, t } = await working({ midTurn: "queues" })
      s.processes.current = [spawn(7, t + 50)]
      await settle(20_000)
      await s.ends()
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toBeNull()
    })

    it("drops the attempt when neither look finds anything", async () => {
      const { s } = await working()
      await settle(5_000)
      await s.ends()
      await settle(findMs + 500)
      expect(s.rec.summary.shellCommand).toBeNull()
      expect(s.shells.watching).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    })

    it("takes neither a tool process that ended before the turn's end nor one outside the windows", async () => {
      const { s, t } = await working({ midTurn: "runs" })
      await settle(20_000)
      await s.ends()
      s.processes.current = [spawn(8, t + 10_000)]
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toBeNull()
    })

    it("takes no tool of a turn that started after the held command's turn ended", async () => {
      const { s } = await working()
      await settle(5_000)
      await s.ends()
      await settle(lookEveryMs)
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      await settle(10)
      s.processes.current = [spawn(7, Date.now())]
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toBeNull()
    })

    it("takes no tool of a turn that a ring started after an idle Enter", async () => {
      const s = setup()
      await s.press()
      await settle(lookEveryMs)
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      await settle(10)
      s.processes.current = [spawn(7, Date.now())]
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toBeNull()
    })

    it("shows the latest of two Enters mid-turn", async () => {
      const { s } = await working()
      await settle(1_000)
      const t2 = await s.press(shellBox("sleep 30"))
      await settle(1_000)
      const e = await s.ends()
      s.processes.current = [spawn(7, e + 100)]
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toEqual({ command: "sleep 30", since: t2 })
    })
  })

  describe("turns around an Enter", () => {
    it("finds a queued command after a continued Stop: idle, working again, the real end", async () => {
      const s = setup()
      activity(s.rec, "working")
      await s.press()
      await settle(2_000)
      const e = await s.ends()
      await settle(1_200)
      // The doorbell continues the turn: the first Stop was not the end.
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      await settle(10)
      s.processes.current = [spawn(8, Date.now() + 5)]
      await settle(20_000)
      expect(s.rec.summary.shellCommand).toBeNull()
      s.processes.current = []
      const end = await s.ends()
      expect(end).toBeGreaterThan(e)
      s.processes.current = [spawn(7, end + 100)]
      await settle(findMs)
      expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
    })

    it("finds a queued command when the turn it waited for was reported late", async () => {
      const s = setup()
      await s.press()
      // The harness was already in a turn; its working report comes after the Enter.
      await settle(300)
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      await settle(30_000)
      const e = await s.ends()
      s.processes.current = [spawn(7, e + 100)]
      await settle(findMs)
      expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
    })

    it("still finds a command already running when a ring starts a turn beside it", async () => {
      const s = setup()
      const at = await s.press()
      s.processes.current = [spawn(7, at + 5)]
      await settle(300)
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toEqual({ command: "sleep 15", since: at })
      // Later turns change nothing for a confirmed attempt.
      s.processes.current = [spawn(7, at + 5), spawn(9, Date.now())]
      await s.ends()
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toEqual({ command: "sleep 15", since: at })
    })

    it("waits out a long turn without looking, and takes no timer", async () => {
      const s = setup()
      await s.press()
      await settle(300)
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      await settle(findMs + 1_000)
      const looked = s.lookups()
      await settle(60_000)
      expect(s.lookups()).toBe(looked)
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  describe("looks", () => {
    it("shows the newest of two Enters confirmed in the same look, announcing once", async () => {
      const s = setup()
      const first = await s.press()
      await settle(600)
      const second = await s.press(shellBox("sleep 30"))
      // Both processes appear together, so both confirm in one look.
      s.processes.current = [spawn(7, first + 100), spawn(8, second + 5)]
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toEqual({ command: "sleep 30", since: second })
      expect(s.announced()).toBe(1)
    })

    it("runs one look at a time, whatever begins meanwhile", async () => {
      const rec = record()
      rec.box = shellBox("sleep 15")
      const waiting: (() => void)[] = []
      let calls = 0
      const shells = new ShellCommands<Fake>({
        profile: () =>
          ({ read: () => rec.box, overlay: () => false, shell: {} }) as unknown as BoxProfile,
        announce: () => undefined,
        trees: () => ({ read: async () => undefined }),
        under: () => {
          calls += 1
          return new Promise((resolve) => waiting.push(() => resolve([])))
        },
        resolutionMs: () => 10,
        stopping: () => false,
      })
      shells.entered(rec)
      await settle(lookEveryMs)
      expect(calls).toBe(1)
      shells.entered(rec)
      await settle(5 * lookEveryMs)
      expect(calls).toBe(1)
      waiting.shift()!()
      await settle(lookEveryMs)
      expect(calls).toBe(2)
      shells.stop()
    })
  })

  describe("after a command is found", () => {
    it("adopts no later process: not a tool started while it runs, nor after it ended", async () => {
      const s = setup()
      const at = await s.press()
      s.processes.current = [spawn(7, at + 5)]
      await settle(2_000)
      expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
      // A turn's tool, started inside the window while the command runs.
      s.processes.current = [spawn(7, at + 5), spawn(9, Date.now() + 5)]
      await settle(findMs)
      s.processes.current = [spawn(9, Date.now() - 1_000)]
      await settle(pollMs)
      expect(s.rec.summary.shellCommand).toBeNull()
      // Nor does it come back for the tool once the command's attempt is over.
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toBeNull()
      expect(s.shells.watching).toBe(0)
    })

    it("closes a confirmed attempt's interval when a turn starts", async () => {
      const s = setup()
      const at = await s.press()
      s.processes.current = [spawn(7, at + 5)]
      await settle(2_000)
      s.processes.current = []
      await settle(pollMs)
      expect(s.rec.summary.shellCommand).toBeNull()
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      s.processes.current = [spawn(9, Date.now() + 5)]
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toBeNull()
    })

    it("shows the newest Enter, though an older one confirms in a later look", async () => {
      const s = setup()
      const first = await s.press()
      await settle(600)
      const second = await s.press(shellBox("sleep 30"))
      s.processes.current = [spawn(8, second + 5)]
      await settle(1_100)
      s.processes.current = [spawn(8, second + 5), spawn(7, first + 100)]
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toEqual({ command: "sleep 30", since: second })
    })
  })

  it("gives up on a held command that never runs after the turns chained around it", async () => {
    const s = setup()
    activity(s.rec, "working")
    await s.press()
    // Turn ends, and the turn goes on, three times over: Esc on the queued command took it out.
    for (let turn = 0; turn < 3; turn += 1) {
      await settle(1_000)
      await s.ends()
      await settle(100)
      activity(s.rec, "working")
      s.shells.changed(s.rec)
    }
    await settle(1_000)
    const end = await s.ends()
    s.processes.current = [spawn(7, end + 100)]
    await settle(findMs + 1_000)
    expect(s.rec.summary.shellCommand).toBeNull()
    expect(s.shells.watching).toBe(0)
  })

  describe("at macOS's resolution", () => {
    const mac = () => setup({ resolutionMs: 1_000 })

    it("keeps a queued command started just after the end, whose working report comes first, if a look saw it", async () => {
      const s = mac()
      activity(s.rec, "working")
      await s.press()
      await settle(20_000)
      const e = await s.ends()
      // Truncated to the second, it reads up to a second early.
      s.processes.current = [spawn(7, e - 700)]
      await settle(lookEveryMs)
      // A look saw it; then the turn's working report lands.
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      await settle(findMs)
      expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
    })

    it("judges one no look saw by its latest possible start", async () => {
      const s = mac()
      activity(s.rec, "working")
      await s.press()
      await settle(20_000)
      const e = await s.ends()
      // Reads 700 ms early: started at the latest 300 ms after the end, before the report at 400.
      await settle(400)
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      const w = Date.now()
      s.processes.current = [spawn(7, e - 700)]
      expect(e - 700 + 1_000).toBeLessThan(w)
      await settle(findMs)
      expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
    })

    // A queued command really starts 100 ms after the turn's end, and reads truncated to the
    // second; a working report follows at `report` ms after the end, at several clock fractions.
    for (const fraction of [0, 250, 950]) {
      for (const report of [300, 450, 500, 600, 900]) {
        it(`keeps a queued command whose turn is reported working ${report} ms after the end (clock at .${fraction})`, async () => {
          vi.setSystemTime(1_000_000 + fraction)
          const s = mac()
          activity(s.rec, "working")
          await s.press()
          await settle(20_000)
          const e = await s.ends()
          await settle(100)
          s.processes.current = [spawn(7, Math.floor((e + 100) / 1000) * 1000)]
          await settle(report - 100)
          activity(s.rec, "working")
          s.shells.changed(s.rec)
          await settle(findMs + 2_000)
          expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
        })
      }
    }

    it("finds a Codex command started up to 2 s after a mid-turn Enter, at 1 s resolution", async () => {
      for (const delay of [200, 1_300, 1_800]) {
        for (const fraction of [0, 500]) {
          vi.setSystemTime(1_000_000 + fraction)
          const s = setup({ resolutionMs: 1_000, midTurn: "runs" })
          activity(s.rec, "working")
          const at = await s.press()
          await settle(delay)
          s.processes.current = [spawn(7, Math.floor((at + delay) / 1000) * 1000)]
          await settle(10_000 - delay)
          await s.ends()
          await settle(findMs)
          expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
        }
      }
    })

    it("keeps a command a look saw before the report when the look at the report could not list", async () => {
      let fail = false
      const s = setup({ resolutionMs: 1_000, unlisted: () => fail })
      activity(s.rec, "working")
      await s.press()
      await settle(20_000)
      const e = await s.ends()
      // Real start 100 ms after the end, read exactly: no floor bound reaches it.
      s.processes.current = [spawn(7, e + 100)]
      await settle(lookEveryMs)
      // The report comes in the very moment of that look, whose sighting counts as before it.
      fail = true
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      await settle(0)
      fail = false
      await settle(findMs + 2_000)
      expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
    })

    it("keeps a command the look at the report listed, though its listing was slow", async () => {
      const s = setup({ resolutionMs: 1_000, delay: 300 })
      activity(s.rec, "working")
      await s.press()
      await settle(20_000)
      const e = await s.ends()
      s.processes.current = [spawn(7, e + 100)]
      await settle(300)
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      await settle(findMs + 3_000)
      expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
    })

    it("takes no tool started after the working report", async () => {
      const s = mac()
      activity(s.rec, "working")
      await s.press()
      await settle(20_000)
      await s.ends()
      await settle(100)
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      const w = Date.now()
      // The look taken at the report's moment ran first; the tool comes after it.
      await settle(0)
      // Truncated to the second, it reads up to 800 ms early, so no earlier than the report.
      s.processes.current = [spawn(9, w - 800)]
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toBeNull()
    })
  })

  describe("the look at a turn's start", () => {
    const tool = (at: number) => spawn(9, at, AGENT, "node")

    it("takes a turn's long tool for no command, however many reports come while the Enter waits", async () => {
      const s = setup({ agent: true })
      await s.press()
      await settle(300)
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      await settle(findMs + 1_000)
      s.processes.current = [tool(Date.now())]
      for (let report = 0; report < 3; report += 1) {
        await settle(500)
        s.shells.changed(s.rec)
      }
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toBeNull()
    })

    it("takes a mid-turn tool for no command while the window is open and reports come every 400 ms", async () => {
      const s = setup({ agent: true })
      await s.press()
      await settle(100)
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      await settle(1_000)
      s.processes.current = [tool(Date.now())]
      for (let report = 0; report < 8; report += 1) {
        await settle(400)
        s.shells.changed(s.rec)
      }
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toBeNull()
    })

    it("admits nothing started after the report when the listing is slow", async () => {
      const s = setup({ agent: true, delay: 1_000 })
      await s.press()
      await settle(100)
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      s.processes.current = [tool(Date.now() + 50)]
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toBeNull()
    })

    it("admits nothing a tool started during a look already under way at the report", async () => {
      const s = setup({ agent: true, delay: 700 })
      await s.press()
      await settle(lookEveryMs + 100)
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      s.processes.current = [tool(Date.now() + 300)]
      await settle(findMs)
      expect(s.rec.summary.shellCommand).toBeNull()
    })

    it("takes no look for the reports of a long turn once the one at its start has run", async () => {
      const s = setup({ agent: true })
      await s.press()
      await settle(100)
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      await settle(findMs + 500)
      const before = s.lookups()
      for (let report = 0; report < 100; report += 1) {
        await settle(100)
        s.shells.changed(s.rec)
      }
      expect(s.lookups()).toBe(before)
      expect(vi.getTimerCount()).toBe(0)
    })

    // `!ls` ends at once; a message starts turn 1, whose tool lives on, and the turn goes on.
    const chained = async (gap: number) => {
      const s = setup({ agent: true })
      await s.press()
      await settle(300)
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      await settle(200)
      s.processes.current = [tool(Date.now())]
      await settle(3_000)
      await s.ends()
      await settle(gap)
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      return s
    }

    it("takes no tool of the first turn at a second turn's start, however soon it follows", async () => {
      for (const gap of [50, 2_000]) {
        const s = await chained(gap)
        await settle(3_000)
        expect(s.rec.summary.shellCommand).toBeNull()
      }
    })

    it("does not carry the first turn's listing into the window after the second", async () => {
      const s = await chained(50)
      await settle(10)
      const kept = s.processes.current
      s.processes.current = []
      await settle(findMs + 500)
      s.processes.current = kept
      await s.ends()
      await settle(3_000)
      expect(s.rec.summary.shellCommand).toBeNull()
    })

    it("admits nothing that started a moment after the report, where start times are precise", async () => {
      for (const res of [10, 16]) {
        const s = setup({ agent: true, resolutionMs: res })
        await s.press()
        await settle(100)
        activity(s.rec, "working")
        s.shells.changed(s.rec)
        s.processes.current = [tool(Date.now() + 30)]
        await settle(findMs)
        expect(s.rec.summary.shellCommand).toBeNull()
      }
    })

    it("confirms with two real sightings, not on the one its slow listing made", async () => {
      const s = setup({ delay: 1_000 })
      const at = await s.press()
      s.processes.current = [spawn(7, at + 5, AGENT, "bash")]
      await settle(100)
      activity(s.rec, "working")
      s.shells.changed(s.rec)
      // The look at the report lists after a second; that is a first sighting, not a second.
      await settle(1_150)
      expect(s.rec.summary.shellCommand).toBeNull()
      await settle(findMs)
      expect(s.rec.summary.shellCommand?.command).toBe("sleep 15")
    })
  })

  it("ends and stops every timer when the agent leaves, the terminal exits or restarts, or it rests", async () => {
    const cases: ((rec: Fake) => void)[] = [
      (rec) => ((rec.terminal as { exit: unknown }).exit = { code: 0 }),
      (rec) => ((rec.terminal as { run: number }).run = 2),
      (rec) => ((rec as { hibernating?: true }).hibernating = true),
      (rec) => ((rec as { closed: boolean }).closed = true),
    ]
    for (const change of cases) {
      const s = setup()
      const at = await s.press()
      s.processes.current = [spawn(7, at + 5)]
      await settle(findMs)
      expect(s.rec.summary.shellCommand).not.toBeNull()
      change(s.rec)
      await settle(pollMs)
      expect(s.rec.summary.shellCommand).toBeNull()
      expect(s.shells.watching).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it("ends at once on `end`, and `stop` leaves no timer", async () => {
    const s = setup()
    const at = await s.press()
    s.processes.current = [spawn(7, at + 5)]
    await settle(findMs)
    s.shells.end(s.rec)
    expect(s.rec.summary.shellCommand).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    const t = setup()
    await t.press()
    t.shells.stop()
    expect(vi.getTimerCount()).toBe(0)
    await settle(5_000)
    expect(t.lookups()).toBe(0)
  })

  it("still ends a command shown when a look finishes while a poll is in flight", async () => {
    const rec = record()
    rec.box = shellBox("sleep 15")
    const started = Date.now() + 5
    const waiting: ((spawns: readonly Spawn[]) => void)[] = []
    let hold = false
    const shells = new ShellCommands<Fake>({
      profile: () =>
        ({ read: () => rec.box, overlay: () => false, shell: {} }) as unknown as BoxProfile,
      announce: () => undefined,
      trees: () => ({ read: async () => undefined }),
      under: (): Promise<readonly Spawn[]> =>
        hold
          ? new Promise((resolve) => waiting.push(resolve))
          : Promise.resolve([spawn(7, started)]),
      resolutionMs: () => 10,
      stopping: () => false,
    })
    shells.entered(rec)
    // Shown at the third look; the poll is armed a second out, and the window's last look
    // comes at the same moment.
    await settle(1_500)
    expect(rec.summary.shellCommand).not.toBeNull()
    hold = true
    await settle(findMs)
    // Every look of the window and the poll: answer them, the poll's last, saying it ended.
    const polls = waiting.splice(0)
    expect(polls.length).toBeGreaterThan(0)
    const last = polls.pop()!
    for (const answer of polls) answer([spawn(7, started)])
    await settle(0)
    last([])
    await settle(0)
    hold = false
    await settle(findMs)
    expect(rec.summary.shellCommand).toBeNull()
    expect(shells.watching).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
