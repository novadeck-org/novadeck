// PROBE, not a test of Novadeck: what a shell-mode `!sleep 30` looks like from outside the
// harness (Linux, /proc). Snapshots the process tree under this test process (the terminal's
// shell and the harness are its descendants), the pty's foreground group, each process's
// fds 0-2, start time and environment markers, the screen (screenRecord) and the activity
// summary, at idle, ~2 s and ~10 s into `!sleep 30`, after Esc, after `!sleep 5` ends, during
// a model turn, typed input during a `!` command, and a model Bash tool call for comparison.
// Linux only (it reads /proc; skipped elsewhere). Runs only with NOVADECK_E2E_PROBES=1, by
// path. Writes $PROBE_OUT/<agent>-tree.json; with PROBE_PART=typed it runs the typed-input
// part instead and writes <agent>-typed-tree.json, and with PROBE_PART=noise the noise part,
// <agent>-noise.json. Environment variables are recorded as set or not, never by value.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { setups } from "../agents/index.js"
import type { DeckTerminal } from "../deck.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, gate } from "../model/script.js"
import { start } from "../scenarios.js"
import { paste, sleep } from "./support.js"

type Proc = {
  pid: number
  ppid: number
  pgid: number
  sid: number
  ttyNr: number
  tpgid: number
  startTicks: number
  state: string
  comm: string
  exe: string | null
  cmdline: string
  fds: Record<string, string | null>
  env: Record<string, string>
}

const read = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

const link = (path: string): string | null => {
  try {
    return readlinkSync(path)
  } catch {
    return null
  }
}

/** Every process on the system, from /proc (Linux only). */
const listAll = (): Proc[] => {
  const out: Proc[] = []
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    const stat = read(`/proc/${pid}/stat`)
    if (stat === null) continue
    const close = stat.lastIndexOf(")")
    const comm = stat.slice(stat.indexOf("(") + 1, close)
    const f = stat.slice(close + 2).split(" ")
    const cmdRaw = read(`/proc/${pid}/cmdline`) ?? ""
    const envRaw = read(`/proc/${pid}/environ`) ?? ""
    const env: Record<string, string> = {}
    for (const pair of envRaw.split("\0")) {
      const eq = pair.indexOf("=")
      if (eq <= 0) continue
      const key = pair.slice(0, eq)
      // Only that a marker variable is set, never its value (a key could be one).
      if (
        /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_ENTRYPOINT|CODEX_[A-Z_]+|AGY_[A-Z_]+|NOVADECK_[A-Z_]+)$/.test(
          key,
        )
      )
        env[key] = "set"
    }
    out.push({
      pid,
      ppid: Number(f[1]),
      pgid: Number(f[2]),
      sid: Number(f[3]),
      ttyNr: Number(f[4]),
      tpgid: Number(f[5]),
      state: f[0] ?? "?",
      startTicks: Number(f[19]),
      comm,
      exe: link(`/proc/${pid}/exe`),
      cmdline: cmdRaw.split("\0").filter(Boolean).join(" ").slice(0, 400),
      fds: {
        0: link(`/proc/${pid}/fd/0`),
        1: link(`/proc/${pid}/fd/1`),
        2: link(`/proc/${pid}/fd/2`),
      },
      env,
    })
  }
  return out
}

/** The processes under `root`, root first, each with its depth. */
const tree = (root: number): Array<Proc & { depth: number }> => {
  const all = listAll()
  const byParent = new Map<number, Proc[]>()
  for (const p of all) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p])
  const out: Array<Proc & { depth: number }> = []
  const walk = (pid: number, depth: number) => {
    const me = all.find((p) => p.pid === pid)
    if (me) out.push({ ...me, depth })
    for (const child of byParent.get(pid) ?? []) walk(child.pid, depth + 1)
  }
  walk(root, 0)
  return out
}

const part = process.env.PROBE_PART

/** The clock ticks per second, to turn start times into seconds since boot. */
const hz = 100

const snapshot = async (label: string, t: DeckTerminal) => {
  const rows = tree(process.pid)
  return {
    label,
    at: Date.now(),
    rows: rows.map((p) => ({
      depth: p.depth,
      pid: p.pid,
      ppid: p.ppid,
      pgid: p.pgid,
      sid: p.sid,
      tty_nr: p.ttyNr,
      tpgid_seen: p.tpgid,
      state: p.state,
      start_s_since_boot: +(p.startTicks / hz).toFixed(2),
      comm: p.comm,
      exe: p.exe,
      cmdline: p.cmdline,
      fd: p.fds,
      env: p.env,
    })),
    screen: screenRecord(await t.screen()),
    activity: t.summary(),
  }
}

for (const setup of setups) {
  describe.skipIf(!supported || process.platform !== "linux")(
    `probe: ! sleep tree in ${setup.name}`,
    () => {
      const it = e2e(setup)
      it("tree, screen and activity while a ! command runs", async ({ e2e: run }) => {
        if (part === "typed" || part === "noise") return
        const held = gate()
        // The agent's own turns only: Codex asks for a title with the prompt in the request, with
        // no tools offered, and a tool call answered there is refused.
        run.model.use(
          async (call) => {
            if (call.side || !asked(call, "Hold on")) return undefined
            await held.opened
            return { text: "Held." }
          },
          (call) => {
            if (call.side || !asked(call, "Tool run")) return undefined
            if (call.turns.some((turn) => turn.role === "tool")) return { text: "Tool done." }
            return setup.shell?.run(call, "sleep 20")
          },
          (call) => (!call.side && asked(call, "After bang") ? { text: "After." } : undefined),
        )
        const out: Record<string, unknown> = { agent: setup.agent, hz, pid: process.pid }
        const t = await start(run, setup)
        const raw = (data: string) => run.deck.terminals.write({ terminalId: t.id, data }, "e2e")
        const snap = async (label: string) => {
          out[label] = await snapshot(label, t)
        }
        const dir = process.env.PROBE_OUT ?? join(run.sandbox.root, "probe-out")
        mkdirSync(dir, { recursive: true })
        const save = () =>
          writeFileSync(join(dir, `${setup.agent}-tree.json`), JSON.stringify(out, null, 2))
        const running = (cmd: string) =>
          tree(process.pid).some((p) => p.cmdline.includes(cmd) && p.comm === "sleep")
        const waitSleepEnd = async (cmd: string, ms: number) => {
          const until = Date.now() + ms
          while (running(cmd) && Date.now() < until) await sleep(500)
          return !running(cmd)
        }

        // 0. Idle, before any command.
        await sleep(3000)
        await snap("0-idle")

        // 1. `!sleep 30`: at 2 s, at 10 s, after Esc, after it ends on its own.
        raw(paste("!sleep 30"))
        await sleep(1000)
        raw("\r")
        await sleep(2000)
        await snap("1-bang-sleep30-2s")
        await sleep(8000)
        await snap("1-bang-sleep30-10s")
        await t.escape()
        await sleep(3000)
        await snap("1-after-esc-3s")
        out["1-sleep-still-running-after-esc"] = running("sleep 30")
        // Esc puts the command back in the box (seen with Claude Code): clear it before the next.
        raw("\x15")
        await sleep(600)
        out["1-sleep-end-wait"] = await waitSleepEnd("sleep 30", 32_000)
        await sleep(1500)
        await snap("1-after-sleep30-ends")
        save()

        // 2. `!sleep 5`, ending normally.
        raw("\x15")
        await sleep(600)
        raw(paste("!sleep 5"))
        await sleep(1000)
        raw("\r")
        await sleep(2000)
        await snap("2-bang-sleep5-2s")
        await sleep(6000)
        await snap("2-bang-sleep5-after-end")
        save()

        // 3. `!sleep 30` with text typed and Enter pressed while it runs.
        raw("\x15")
        await sleep(600)
        raw(paste("!sleep 30"))
        await sleep(1000)
        raw("\r")
        await sleep(2000)
        const callsBefore = run.model.mark()
        raw(paste("After bang"))
        await sleep(1000)
        raw("\r")
        await sleep(3000)
        await snap("3-typed-during-bang-3s")
        out["3-model-calls-while-running"] = run.model.mark() - callsBefore
        out["3-sleep-running-at-3s"] = running("sleep 30")
        await waitSleepEnd("sleep 30", 32_000)
        await sleep(4000)
        await snap("3-typed-after-bang-ends")
        out["3-model-calls-total"] = run.model.mark() - callsBefore
        save()

        // 4. `!sleep 30` while a model turn is in progress (the turn is held).
        raw("\x15")
        await sleep(600)
        await t.submit("Hold on")
        await sleep(2500)
        raw(paste("!sleep 30"))
        await sleep(1000)
        raw("\r")
        await sleep(2000)
        await snap("4-turn-plus-bang-2s")
        held.open()
        await t.until("Held.", 30_000).catch(() => undefined)
        await waitSleepEnd("sleep 30", 32_000)
        await sleep(2000)
        await snap("4-turn-done")
        save()

        // 5. A model Bash tool call (`sleep 20`) for comparison, the process tree at 4 s.
        await t.submit("Tool run")
        await sleep(4000)
        await snap("5-model-tool-4s")
        await t.until("Tool done.", 60_000).catch(() => undefined)
        await sleep(1500)
        await snap("5-model-tool-done")
        save()
      })
    },
  )
}

/** Every process on the system whose command line holds `needle`, with its ancestors up to pid 1. */
const globalChains = (needle: string) => {
  const all = listAll()
  const byPid = new Map(all.map((p) => [p.pid, p]))
  return all
    .filter((p) => p.comm === "sleep" && p.cmdline.includes(needle))
    .map((hit) => {
      const chain: Record<string, unknown>[] = []
      let cur: Proc | undefined = hit
      const seen = new Set<number>()
      while (cur && !seen.has(cur.pid)) {
        seen.add(cur.pid)
        chain.push({
          pid: cur.pid,
          ppid: cur.ppid,
          pgid: cur.pgid,
          sid: cur.sid,
          tty_nr: cur.ttyNr,
          tpgid: cur.tpgid,
          comm: cur.comm,
          cmdline: cur.cmdline.slice(0, 200),
        })
        if (cur.pid === 1) break
        cur = byPid.get(cur.ppid)
      }
      return chain
    })
}

for (const setup of setups) {
  describe.skipIf(
    !supported || process.platform !== "linux" || (part !== "typed" && part !== "noise"),
  )(`probe ${part}: ${setup.name}`, () => {
    const it = e2e(setup)
    it(`${part} run`, async ({ e2e: run }) => {
      const out: Record<string, unknown> = { agent: setup.agent }
      const t = await start(run, setup)
      const raw = (data: string) => run.deck.terminals.write({ terminalId: t.id, data }, "e2e")
      const dir = process.env.PROBE_OUT ?? join(run.sandbox.root, "probe-out")
      mkdirSync(dir, { recursive: true })
      const save = (name: string) => writeFileSync(join(dir, name), JSON.stringify(out, null, 2))
      const sleepUp = () =>
        listAll().some((p) => p.comm === "sleep" && p.cmdline.includes("sleep 30"))
      const waitGone = async (ms: number) => {
        const until = Date.now() + ms
        while (sleepUp() && Date.now() < until) await sleep(500)
        return !sleepUp()
      }

      if (part === "typed") {
        raw("!")
        await sleep(800)
        out["bash-mode-box"] = await snapshot("bash-mode", t)
        raw(paste("sleep 30"))
        await sleep(1000)
        raw("\r")
        await sleep(2000)
        out["2s"] = await snapshot("2s", t)
        out["2s-global-chains"] = globalChains("sleep 30")
        await sleep(8000)
        out["10s"] = await snapshot("10s", t)
        out["10s-global-chains"] = globalChains("sleep 30")
        await t.escape()
        await sleep(3000)
        out["after-esc"] = await snapshot("after-esc", t)
        out["sleep-alive-after-esc"] = sleepUp()
        save(`${setup.agent}-typed-tree.json`)
        // Clear whatever Esc left in the box, then a second run with a prompt typed mid-command.
        raw("\x15")
        await sleep(600)
        raw("!")
        await sleep(800)
        raw(paste("sleep 30"))
        await sleep(1000)
        raw("\r")
        await sleep(2000)
        const calls = run.model.mark()
        raw(paste("After bang"))
        await sleep(1000)
        raw("\r")
        await sleep(3000)
        out["typed-during-3s"] = await snapshot("typed-during-3s", t)
        out["typed-during-model-calls"] = run.model.mark() - calls
        out["typed-during-sleep-alive"] = sleepUp()
        out["typed-during-end-wait"] = await waitGone(32_000)
        await sleep(3000)
        out["typed-after-end"] = await snapshot("typed-after-end", t)
        out["typed-model-calls-total"] = run.model.mark() - calls
        save(`${setup.agent}-typed-tree.json`)
      }

      if (part === "noise") {
        const baseline = new Set(tree(process.pid).map((p) => p.pid))
        raw(paste("!sleep 30"))
        await sleep(1000)
        raw("\r")
        await sleep(2000)
        const seen = new Map<number, Record<string, unknown>>()
        const t0 = Date.now()
        for (let i = 0; i < 6; i++) {
          const now = Date.now() - t0
          for (const p of tree(process.pid)) {
            if (baseline.has(p.pid)) continue
            const e = seen.get(p.pid)
            if (e) e.last_ms = now
            else
              seen.set(p.pid, {
                pid: p.pid,
                ppid: p.ppid,
                comm: p.comm,
                cmdline: p.cmdline.slice(0, 200),
                first_ms: now,
                last_ms: now,
              })
          }
          await sleep(1000)
        }
        out["new-processes-window-6s"] = [...seen.values()]
        out["baseline-pids"] = baseline.size
        out["sleep-alive-end"] = sleepUp()
        out["activity-end"] = t.summary()
        save(`${setup.agent}-noise.json`)
      }
    })
  })
}
