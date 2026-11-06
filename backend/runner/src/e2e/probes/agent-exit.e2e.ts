// PROBE, not a test of Novadeck (#721): how long each agent takes to exit once the runner
// hangs up its terminal, and what of it is left behind. For Claude Code, Codex and
// Antigravity, idle and mid-turn, closing the terminal and shutting the runner down, calm
// and with every core busy, it times the hangup to the agent's exit and to the last
// descendant's, each process with its group, so whether MCP servers and helpers share the
// agent's group shows, and on Linux its cgroup, whether a scope would hold it. A stand-in
// that ignores SIGHUP and has a child is the control; a tool that ignores SIGHUP and SIGTERM
// shows what an agent leaves of what won't end. Then it ends the agent forcibly a moment
// after the hangup and resumes its session, to see whether a kill during its save breaks
// that, calm and with every core busy, and kills the agent's group and then shuts down, to
// see what neither reaches. Its stopwatch is its own, as the sandbox's reap kills at 3 s and
// would hide the real time, and starts as the close is called: a `ps` comes before the hangup.
//
// On Windows, which hangs up no group, the number is the tree's exit, from a clock that also
// holds the relay's read before the console closes (the shell's own row tells how long),
// and it can't pass the runner's own end of what is left: `atRunnerEnd` marks a row the
// runner ended, which says that much and no more of how long the tree would have run. Rows
// of a quit with terminals of every harness have no such mark: they share one return.
//
// Runs only with NOVADECK_E2E_PROBES=1, by path; PROBE_RUNS is each case's repeats (3
// unless set). Writes $PROBE_OUT/<agent>-exit-<platform>.json after every case, and logs
// its summary. On Linux a shell gets its scope only with the user's bus in the environment
// and some milliseconds after it starts, and what it started by then stays behind:
// PROBE_RC_SLEEP is seconds its .bashrc sleeps, to see a scope hold what a slower shell starts.
// A row says `scoped` where its shell had its own, and `scopeEnd` what ending it took.
/* eslint-disable no-await-in-loop -- A probe's runs go one at a time, each watched to its end. */
import { execFile, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { relayPath } from "@novadeck/relay"
import { anyRunning, terminalForeground, Trees } from "@novadeck/terminal/pty"

import type { AgentSetup } from "../agents/agent.js"
import { setups } from "../agents/index.js"
import type { DeckTerminal } from "../deck.js"
import { describe, e2e, supported, type E2E } from "../fixture.js"
import { asked, gate, type Call } from "../model/script.js"
import { nestedRuns, own, prompted, replies, result, start, turn } from "../scenarios.js"
import { probing, sleep } from "./support.js"

const windows = process.platform === "win32"
/** How often each known process is asked after; `lookMs`, how often new ones are looked for. */
const pollMs = 10
const lookMs = 100
/** How long an agent may take before it counts as having outlived the probe, and is ended. */
const agentCapMs = 20_000
/** The same for the stand-in, which never exits by itself. */
const controlCapMs = 8_000
/** The moments after the hangup at which the resume cases end the agent forcibly. */
const killDelays = [0, 5, 10, 20, 50, 100, 200]
// With every core busy: agents then take longer to exit, on Windows past a second.
const busyKillDelays = [100, 300, 600, 800]
// What the agent was on when killed, to see whether a resume still holds it.
const inFlightPrompts: Record<string, string | undefined> = {
  "mid-turn": "Hold on",
  "mid-tool": "Run the nested agent",
}
const repeats = Number(process.env.PROBE_RUNS ?? 3)

const agentNames: { readonly [agent in AgentSetup["agent"]]: RegExp } = {
  claude: /claude/i,
  codex: /codex/i,
  agy: /agy|antigravity/i,
}

/** When the runner ends what is left of a Windows tree, closed or quitting (manager.ts). */
const runnerEndMs = { close: 3000, quit: 1000 }

/** A process of the terminal, as first seen, and when it went. */
type Watched = {
  readonly pid: number
  readonly startedAt?: number
  readonly parent?: number
  readonly group?: number
  readonly name: string
  /** On Linux, its cgroup when first seen, which a scope of the terminal's would hold it by. */
  readonly cgroup?: string
  goneMs?: number
}

type Census = {
  /** Every process of the terminal seen so far, by pid. */
  readonly watched: Map<number, Watched>
  /** Adds what the terminal's processes have started since, and marks zombies gone. */
  readonly look: (now: () => number) => Promise<void>
  /** Ends these forcibly: never the group's signal here, as each was seen by itself. */
  readonly end: (ones: readonly Watched[]) => Promise<void>
}

const answers = (pid: number): boolean => anyRunning([{ pid, startedAt: 0 }])

const shown = (run: E2E, line: string): string =>
  line.replaceAll(run.sandbox.root, "<sandbox>").slice(0, 200)

const cgroupOf = (pid: number): { readonly cgroup?: string } => {
  if (process.platform !== "linux") return {}
  try {
    return { cgroup: readFileSync(`/proc/${pid}/cgroup`, "utf8").trim() }
  } catch {
    return {}
  }
}

// Linux and macOS: from one `ps` of every process, those under the shell or in the group
// of one that is, however it was orphaned on its way out.
const posixCensus = (run: E2E, shell: number): Census => {
  const watched = new Map<number, Watched>([[shell, { pid: shell, name: "shell" }]])
  const look: Census["look"] = async (now) => {
    const { stdout } = await promisify(execFile)(
      "ps",
      ["-axww", "-o", "pid=,ppid=,pgid=,stat=,args="],
      { maxBuffer: 64 * 1024 * 1024 },
    )
    const rows = stdout.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
      if (!match) return []
      const [, pid, parent, group, state, args] = match
      return [
        {
          pid: Number(pid),
          parent: Number(parent),
          group: Number(group),
          zombie: state!.includes("Z"),
          name: shown(run, args!),
        },
      ]
    })
    for (let grown = true; grown;) {
      grown = false
      const groups = new Set([...watched.values()].map((one) => one.group))
      for (const { zombie, ...row } of rows)
        if (
          !zombie &&
          row.pid > 1 &&
          !watched.has(row.pid) &&
          (row.pid === shell || watched.has(row.parent) || (row.group > 1 && groups.has(row.group)))
        ) {
          watched.set(row.pid, { ...row, ...cgroupOf(row.pid) })
          grown = true
        }
    }
    const shellRow = rows.find((row) => row.pid === shell)
    if (shellRow && watched.get(shell)?.group === undefined)
      watched.set(shell, { ...shellRow, name: "shell", ...cgroupOf(shell) })
    for (const { pid, zombie } of rows) {
      const one = watched.get(pid)
      if (zombie && one && one.goneMs === undefined) one.goneMs = now()
    }
  }
  const end: Census["end"] = async (ones) => {
    for (const { pid } of ones)
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // Gone meanwhile.
      }
  }
  return { watched, look, end }
}

// Windows: the shell's tree through the relay, as the runner reads it, and from each
// process seen since, by its start, which holds once it has ended.
const windowsCensus = async (run: E2E, shell: number): Promise<Census> => {
  const trees = new Trees(async () => relayPath)
  const watched = new Map<number, Watched>()
  const add = (found: Awaited<ReturnType<Trees["read"]>>) => {
    for (const { pid, startedAt, name } of found ?? [])
      if (!watched.has(pid))
        watched.set(pid, {
          pid,
          startedAt,
          name: pid === shell ? "shell" : shown(run, name ?? "?"),
        })
  }
  add(await trees.read(shell))
  return {
    watched,
    look: async () => {
      const roots = [...watched.values()].map(({ pid, startedAt }) => ({
        pid,
        startedAt: startedAt ?? 0,
      }))
      for (const found of await Promise.all(roots.map((root) => trees.read(root)))) add(found)
    },
    end: (ones) =>
      trees.end(ones.map(({ pid, startedAt }) => ({ pid, startedAt: startedAt ?? 0 }))),
  }
}

/** The terminal's shell, and the census of its processes now. */
const census = async (run: E2E, terminal: Pick<DeckTerminal, "id">) => {
  const inside = run.deck.terminals as unknown as {
    records: Map<string, { terminal: { pty: { pid: number | undefined } } }>
  }
  const shell = inside.records.get(terminal.id)?.terminal.pty.pid
  if (shell === undefined) throw new Error("The terminal has no shell")
  const found = windows ? await windowsCensus(run, shell) : posixCensus(run, shell)
  await found.look(() => 0)
  if (!found.watched.has(shell)) throw new Error("The terminal's process tree can't be read")
  return { ...found, shell, group: await terminalForeground(shell) }
}

type Taken = Awaited<ReturnType<typeof census>>

/**
 * Ends all of `cgroup`'s scope at once, as a shutdown could, and says how that went for
 * those of `ones` it holds: `ms` until none answers, or why it failed. Those outside it are
 * counted, and are nothing to go by: only what the scope holds was tried.
 */
const endScope = async (cgroup: string, ones: readonly Watched[]) => {
  const held = ones.filter((one) => one.cgroup === cgroup)
  const counts = { inScope: held.length, outside: ones.length - held.length }
  if (held.length === 0) return counts
  const began = performance.now()
  const failed = await promisify(execFile)("busctl", [
    "--user",
    "call",
    "org.freedesktop.systemd1",
    "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager",
    "KillUnit",
    "ssi",
    cgroup.split("/").at(-1)!,
    "all",
    "9",
  ]).then(
    () => undefined,
    (error: unknown) => String(error),
  )
  if (failed !== undefined) return { ...counts, failed }
  while (performance.now() - began < 1000) {
    if (!held.some((one) => answers(one.pid)))
      return { ...counts, ms: Math.round(performance.now() - began) }
    await sleep(pollMs)
  }
  return { ...counts, failed: "still answering a second on" }
}

/**
 * Every core busy twice over until the returned function ends it, by exact pid, or a
 * minute on, should this process die first.
 */
const load = (): (() => void) => {
  const burners = Array.from({ length: availableParallelism() * 2 }, () =>
    spawn(process.execPath, ["-e", "const end = Date.now() + 60_000; while (Date.now() < end);"], {
      stdio: "ignore",
    }),
  )
  return () => {
    for (const burner of burners) burner.kill("SIGKILL")
  }
}

/** The agent among what was seen: the terminal's foreground group, or by its name. */
const leadOf = (all: readonly Watched[], { shell, group }: Taken, agent: RegExp) =>
  all.find((one) => one.pid === group && group !== shell) ??
  all.find((one) => one.pid !== shell && agent.test(one.name))

/**
 * Runs `end`, which hangs the terminal up, and watches until the terminal's processes have
 * gone, or until `capMs`, when what is left is ended and named as having outlived it. Times
 * in ms from the call of `end`; `closedMs` is when it returned, what the runner waited.
 */
const stopwatch = async (taken: Taken, end: () => Promise<void>, capMs: number, agent: RegExp) => {
  const { watched, look, end: endThem, shell, group } = taken
  // What one more walk of the processes costs just now, as under load, on the way to a hangup.
  const walking = performance.now()
  await look(() => 0).catch(() => {})
  const walkMs = Math.round(performance.now() - walking)
  const began = performance.now()
  const now = () => Math.round(performance.now() - began)
  let closedMs: number | undefined
  let failure: unknown
  const closing = end()
    .catch((error: unknown) => {
      failure = error
    })
    .finally(() => {
      closedMs = now()
    })
  let looks = 0
  const finished = new AbortController()
  const looking = (async () => {
    while (!finished.signal.aborted) {
      await look(now).catch(() => {})
      looks += 1
      await sleep(lookMs)
    }
  })()
  const left = () => [...watched.values()].filter((one) => one.goneMs === undefined)
  // Nothing left and two looks since found nothing new: one may have been under way.
  let quiet: number | undefined
  for (;;) {
    for (const one of left()) if (!answers(one.pid)) one.goneMs = now()
    const done = closedMs !== undefined && left().length === 0
    quiet = done ? (quiet ?? looks) : undefined
    if (quiet !== undefined && looks >= quiet + 2) break
    if (closedMs !== undefined && now() >= capMs) break
    await sleep(pollMs)
  }
  finished.abort()
  await looking
  await closing
  // The last look may have found one no poll has asked after.
  for (const one of left()) if (!answers(one.pid)) one.goneMs = now()
  const outlived = left()
  const shellGroup = watched.get(shell)?.cgroup
  const scoped = shellGroup?.endsWith(`-term${shell}.scope`)
  const scopeEnd = scoped && outlived.length > 0 ? await endScope(shellGroup!, outlived) : undefined
  await endThem(outlived.filter((one) => answers(one.pid)))
  if (failure !== undefined) throw failure
  const all = [...watched.values()]
  const inGroup = group === undefined ? [] : all.filter((one) => one.group === group)
  const lead = leadOf(all, taken, agent)
  const latest = (ones: readonly Watched[]) =>
    ones.length === 0 ? undefined : Math.max(...ones.map((one) => one.goneMs ?? capMs))
  return {
    ...(!windows && { walkMs }),
    closedMs,
    agentMs: lead?.goneMs ?? (lead ? capMs : undefined),
    groupMs: latest(inGroup),
    lastMs: latest(all),
    outlived: outlived.map((one) => one.name),
    // Linux only. `escaped` says something of scopes only where `scoped` holds: the shell has
    // one of its own, which takes the user's bus. Without it they all share the runner's cgroup.
    ...(shellGroup !== undefined && {
      scoped,
      ...(scopeEnd && { scopeEnd }),
      escaped: all
        .filter((one) => one.cgroup !== undefined && one.cgroup !== shellGroup)
        .map((one) => one.name),
    }),
    apart: all
      .filter((one) => one.pid !== shell && group !== undefined && one.group !== group)
      .map((one) => one.name),
    processes: all,
  }
}

type Timed = Awaited<ReturnType<typeof stopwatch>> & {
  readonly harness: string
  readonly atRunnerEnd?: boolean
}
type Row = { readonly case: string } & Partial<Timed> & { readonly error?: string }
type Resume = {
  readonly case: string
  readonly resumed?: boolean
  readonly agentMet?: boolean
  readonly sameSession?: boolean
  readonly kept?: boolean
  readonly inFlightKept?: boolean
}

const percentile = (values: readonly number[], at: number): number | undefined =>
  values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * at)]

/** Each case's median and worst, by what was timed, and how many left something behind. */
/** What a resume after a forced end says: only those whose kill met the agent test one. */
const resumeSummary = (resumes: readonly Resume[]) => {
  const met = resumes.filter((one) => one.agentMet)
  const whole = (one: Resume) => one.resumed && one.sameSession && one.kept
  const inFlight = met.filter((one) => one.inFlightKept !== undefined)
  return {
    records: resumes.length,
    broken: resumes.filter((one) => !whole(one)).length,
    agentMet: met.length,
    brokenWhereMet: met.filter((one) => !whole(one)).length,
    inFlight: inFlight.length,
    inFlightLost: inFlight.filter((one) => !one.inFlightKept).length,
  }
}

const summary = (rows: readonly Row[]) =>
  [...new Set(rows.map((row) => row.case))].map((name) => {
    const runs = rows.filter((row) => row.case === name)
    const of = (field: "agentMs" | "groupMs" | "lastMs" | "closedMs") => {
      const values = runs.flatMap((row) => row[field] ?? [])
      return `${percentile(values, 0.5) ?? "-"}/${percentile(values, 1) ?? "-"}`
    }
    return {
      case: name,
      runs: runs.length,
      errors: runs.filter((row) => row.error).length,
      "agent ms (median/worst)": of("agentMs"),
      "group ms": of("groupMs"),
      "last ms": of("lastMs"),
      "closed ms": of("closedMs"),
      outlived: runs.filter((row) => (row.outlived ?? []).length > 0).length,
    }
  })

/** Whether the call is a nested run's own, the command a held tool is waiting on. */
const nested = (call: Call): boolean =>
  !call.side &&
  call.turns.some((one) => one.role === "user" && one.text.includes(nestedRuns.inTurn))

const standIn = `import { spawn } from "node:child_process"
process.on("SIGHUP", () => {})
spawn(process.execPath, ["-e", "process.on('SIGHUP', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })
console.log("stand-in ready")
setInterval(() => {}, 1000)
`

/** What the cases share for one test: its model's rules, its findings and how it hangs up. */
const lab = (run: E2E, file: string) => {
  let held = gate()
  run.model.use(
    replies("Which word", "The word was heron."),
    replies("Remember the word heron", "Heron noted."),
    replies("Say ok", "Okay then."),
    async (call) => {
      if (call.side || !asked(call, "Hold on")) return undefined
      await held.opened
      return { text: "Held." }
    },
    own(async (call) => {
      if (!nested(call)) return undefined
      await held.opened
      return { text: "The nested run is done." }
    }),
    own((call) => (result(call) !== undefined ? { text: "Done." } : undefined)),
  )
  // Whether the harness asked before it ran the stubborn tool, which may then run differently.
  let toolAsked: boolean | undefined
  const rows: Row[] = []
  const resumes: Resume[] = []
  // The terminals open now, for a case that fails before it closes its own.
  const open = new Set<string>()
  const opened = <T extends { readonly id: string }>(terminal: T): T => {
    open.add(terminal.id)
    return terminal
  }
  // Leaves the deck as a case found it, whatever that case left: a restart that threw has
  // stopped the runner, and with nothing left to reap the next one starts.
  const recover = async () => {
    held.open()
    held = gate()
    const terminals = [...open]
    open.clear()
    await run.model.ending(async () => {
      await Promise.all(
        terminals.map((terminalId) => run.deck.terminals.close({ terminalId }).catch(() => {})),
      )
    })
    // A first that finds a leftover ends it and throws, before it starts a runner.
    await run.deck.restart().catch(() => run.deck.restart())
  }
  if (process.env.PROBE_RC_SLEEP)
    writeFileSync(join(run.sandbox.home, ".bashrc"), `sleep ${process.env.PROBE_RC_SLEEP}\n`)
  const save = () => {
    const dir = process.env.PROBE_OUT ?? join(run.sandbox.root, "probe-out")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${file}-exit-${process.platform}.json`),
      JSON.stringify(
        {
          platform: process.platform,
          cores: availableParallelism(),
          harness: process.env.NOVADECK_E2E_HARNESS ?? "pinned",
          runs: repeats,
          rcSleep: process.env.PROBE_RC_SLEEP ?? null,
          summary: summary(rows),
          resumeSummary: resumeSummary(resumes),
          resumes,
          rows,
        },
        null,
        1,
      ),
    )
  }
  return {
    resumes,
    save,
    opened,
    /** Lets go of what the model holds for a terminal that has gone, for the next run. */
    release: (terminal: { readonly id: string }) => {
      held.open()
      held = gate()
      open.delete(terminal.id)
    },
    /** Runs `work`, and however it fails puts the deck back, so the next case still runs. */
    guarded: async <T>(work: () => Promise<T>, failed: (why: string) => T): Promise<T> => {
      try {
        return await work()
      } catch (error) {
        await recover().catch(() => {})
        return failed(String(error))
      }
    },
    /** Records the rows of a case's run, each named with its harness where several ran. */
    record: (name: string, found: readonly Omit<Row, "case">[]) => {
      rows.push(
        ...found.map((row) => ({
          case: file === "mixed" && row.harness ? `${name}, ${row.harness}` : name,
          ...row,
        })),
      )
      save()
    },
    /** A terminal running the agent, past a first turn, at `moment`. */
    ready: async (
      setup: AgentSetup,
      moment: string,
      first: string,
      shows: string,
    ): Promise<DeckTerminal> => {
      toolAsked = undefined
      const terminal = opened(await start(run, setup))
      await turn(terminal, first, shows)
      if (moment === "idle") return terminal
      const mark = terminal.mark()
      const after = run.model.mark()
      if (moment === "stubborn tool") {
        rmSync(join(run.sandbox.project, "exit-tool.ready"), { force: true })
        await terminal.prompt("Run the stubborn tool")
        const running = () => {
          if (existsSync(join(run.sandbox.project, "exit-tool.ready"))) return true
          // The tool's end, as its harness's sandbox refusing it, ends the wait, in its words.
          const ended = run.model.calls.slice(after).map(result).find(Boolean)
          if (ended) throw new Error(`The stubborn tool ended: ${ended.slice(0, 500)}`)
          return false
        }
        // A command no seed allows: the chat allows it, as the person would, where the harness
        // asks; Codex's sandbox runs it unasked.
        const asking = await terminal.poll(
          async () => {
            if (running()) return "running"
            const [request] = (await terminal.detail()).requests
            return request?.dialog?.type === "choices"
              ? { ref: request.ref, dialog: request.dialog }
              : undefined
          },
          "its tool to run or ask",
          60_000,
        )
        toolAsked = asking !== "running"
        if (asking === "running") return terminal
        const { ref, dialog } = asking
        const yes = dialog.options.find(
          (each) => each.label.startsWith("Yes") && each.text === null,
        )
        if (!yes) throw new Error(`No yes in ${JSON.stringify(dialog)}`)
        await terminal.answer(ref, { dialog: dialog.id, type: "choice", option: yes.id })
        await terminal.poll(() => (running() ? true : undefined), "its tool to start", 60_000)
        return terminal
      }
      await terminal.prompt(moment === "mid-tool" ? "Run the nested agent" : "Hold on")
      await run.model.waitFor(
        (call) => (moment === "mid-tool" ? nested(call) : !call.side && asked(call, "Hold on")),
        { after },
      )
      await terminal.reached("working", { after: mark })
      return terminal
    },
    /**
     * Hangs up as `kind` says, with every core busy if `busy`, timing each terminal, and
     * leaves the deck able to open terminals again.
     */
    hangUp: async (
      kind: "close" | "quit" | "group",
      terminals: readonly {
        readonly id: string
        readonly taken: Taken
        readonly agent: RegExp
        readonly harness: string
      }[],
      capMs: number,
      busy: boolean,
    ): Promise<readonly Omit<Row, "case">[]> => {
      let measured: Timed[] = []
      const calm = busy ? load() : () => {}
      try {
        if (busy) await sleep(500)
        await run.model.ending(async () => {
          measured = await Promise.all(
            terminals.map(async ({ id, taken, agent, harness }) => {
              const timed = await stopwatch(
                taken,
                () => {
                  if (kind === "close") return run.deck.terminals.close({ terminalId: id })
                  if (kind === "group") process.kill(-taken.group!, "SIGKILL")
                  return run.deck.terminals.shutdown()
                },
                capMs,
                agent,
              )
              const ending = runnerEndMs[kind === "close" ? "close" : "quit"]
              return {
                ...timed,
                harness,
                ...(toolAsked !== undefined && { toolAsked }),
                // It ends what is left past its bound, from past the relay's read, then waits
                // 200 ms; with what is gone by itself it returns at once.
                ...(windows &&
                  terminals.length === 1 && {
                    atRunnerEnd:
                      (timed.lastMs ?? 0) >= ending - 150 &&
                      (timed.closedMs ?? 0) - (timed.lastMs ?? 0) >= 150,
                  }),
              }
            }),
          )
        })
      } finally {
        calm()
      }
      held.open()
      held = gate()
      for (const { id } of terminals) open.delete(id)
      if (kind === "close") return measured
      // A leftover is a finding too, kept beside what was timed; `guarded` is for the rest.
      const left = await run.deck.restart().catch(async (error: unknown) => {
        await recover()
        return String(error)
      })
      return left === undefined ? measured : measured.map((row) => ({ ...row, error: left }))
    },
    /** Logs the findings so far, where a job's log shows them. */
    report: (name: string) => {
      save()
      console.log(
        `${name} on ${process.platform}, ${availableParallelism()} cores:\n${JSON.stringify({ summary: summary(rows), resumeSummary: resumeSummary(resumes), resumes }, null, 1)}`,
      )
    },
  }
}

// A tool that outstays its agent: it ignores SIGHUP and SIGTERM, as does its child, and
// says so by a file once its child, the last to start, has its handlers.
const stubbornTool = `import { spawn } from "node:child_process"
const stay = "for (const signal of ['SIGHUP', 'SIGTERM']) process.on(signal, () => {}); require('node:fs').writeFileSync('exit-tool.ready', ''); setInterval(() => {}, 1000)"
for (const signal of ["SIGHUP", "SIGTERM"]) process.on(signal, () => {})
spawn(process.execPath, ["-e", stay], { stdio: "ignore" })
setInterval(() => {}, 1000)
`

for (const setup of setups) {
  describe.skipIf(!supported || !probing)(`probe: exit after a hangup in ${setup.name}`, () => {
    const it = e2e(setup)
    // Dozens of runs, each a harness started, a turn taken and an exit watched.
    it("each case", { timeout: 2_700_000 }, async ({ e2e: run }) => {
      const { guarded, hangUp, opened, ready, record, release, report, resumes, save } = lab(
        run,
        setup.agent,
      )
      const agent = agentNames[setup.agent]
      const harness = setup.agent
      const failed = (error: string) => [{ error }]
      const attempt = async (
        name: string,
        work: () => Promise<readonly Omit<Row, "case">[]>,
      ): Promise<void> => record(name, await guarded(work, failed))
      const { shell } = setup
      if (!shell) throw new Error(`${setup.name} has no shell tool for the mid-tool cases`)
      run.model.use(
        own((call) =>
          asked(call, "Run the nested agent")
            ? shell.run(call, shell.nested(nestedRuns.inTurn))
            : undefined,
        ),
        own((call) =>
          asked(call, "Run the stubborn tool") ? shell.run(call, "node exit-tool.mjs") : undefined,
        ),
      )
      for (const pressure of ["calm", "load"])
        for (const moment of ["idle", "mid-turn", "mid-tool"])
          for (const kind of ["close", "quit"] as const)
            for (let index = 0; index < repeats; index += 1)
              await attempt(`${kind} ${moment} ${pressure}`, async () => {
                const terminal = await ready(setup, moment, "Say ok", "Okay then.")
                const taken = await census(run, terminal)
                const one = { id: terminal.id, taken, agent, harness }
                return hangUp(kind, [one], agentCapMs, pressure === "load")
              })

      writeFileSync(join(run.sandbox.project, "exit-stand-in.mjs"), standIn)
      for (const kind of ["close", "quit"] as const)
        await attempt(`control ignoring SIGHUP, ${kind}`, async () => {
          const terminal = opened(await run.deck.open("node exit-stand-in.mjs"))
          await terminal.until("stand-in ready")
          // Its child may start a moment after the line.
          await sleep(500)
          const taken = await census(run, terminal)
          const one = { id: terminal.id, taken, agent: /node/i, harness }
          return hangUp(kind, [one], controlCapMs, false)
        })

      // The agent exits, promptly or not: what of a tool that doesn't is left behind?
      writeFileSync(join(run.sandbox.project, "exit-tool.mjs"), stubbornTool)
      for (const kind of ["close", "quit"] as const)
        for (let index = 0; index < repeats; index += 1)
          await attempt(`${kind} stubborn tool`, async () => {
            const terminal = await ready(setup, "stubborn tool", "Say ok", "Okay then.")
            const taken = await census(run, terminal)
            const one = { id: terminal.id, taken, agent, harness }
            return hangUp(kind, [one], agentCapMs, false)
          })

      // What neither a kill of the agent's group nor the shutdown after it reaches. The gate
      // holds a nested run's reply until the cap, so what is left is alive, as a tool would be
      // that isn't done, and `lastMs` is the cap, no exit time. Windows ends trees, which have
      // no such gap.
      if (!windows)
        for (const moment of ["mid-turn", "mid-tool"])
          await attempt(`group killed ${moment}`, async () => {
            const terminal = await ready(setup, moment, "Say ok", "Okay then.")
            const taken = await census(run, terminal)
            const one = { id: terminal.id, taken, agent, harness }
            return hangUp("group", [one], controlCapMs, false)
          })

      const forced = async (moment: string, delayMs: number, busy: boolean) => {
        const name = `forced ${moment} +${delayMs} ms${busy ? " load" : ""}`
        const outcome = await guarded<object>(
          async () => {
            const terminal = await ready(setup, moment, "Remember the word heron", "Heron noted.")
            const before = (await terminal.detail()).sessionId
            const taken = await census(run, terminal)
            const lead = leadOf([...taken.watched.values()], taken, agent)
            let killed: readonly string[] = []
            let agentMet = false
            const calm = busy ? load() : () => {}
            try {
              if (busy) await sleep(500)
              await run.model.ending(async () => {
                const closing = run.deck.terminals.shutdown()
                // The console closes after the relay's read, which may take longer than these.
                const closes = windows ? performance.now() + 5000 : 0
                while (performance.now() < closes && answers(taken.shell)) await sleep(1)
                await sleep(delayMs)
                const others = [...taken.watched.values()].filter((one) => one.pid !== taken.shell)
                // What the kill really met: past the agent's exit, this case tests nothing.
                const met = others.filter((one) => answers(one.pid))
                killed = met.map((one) => one.name)
                agentMet = met.some((one) => one === lead)
                await taken.end(met)
                await closing
              })
            } finally {
              calm()
            }
            release(terminal)
            await run.deck.restart()
            const resumed = opened(await run.deck.restore(terminal, { resume: setup.agent }))
            await resumed.reached("ready", { timeoutMs: 60_000 })
            await prompted(resumed, setup)
            const after = run.model.mark()
            await resumed.prompt("Which word")
            const asking = await run.model.waitFor(
              (call) => !call.side && asked(call, "Which word"),
              { after },
            )
            await resumed.until("The word was heron.")
            const said = (words: string) =>
              asking.turns.some((one) => one.role === "user" && one.text.includes(words))
            const session = (await resumed.detail()).sessionId
            const inFlight = inFlightPrompts[moment]
            const row = {
              resumed: true,
              killed,
              agentMet,
              before,
              sameSession: before !== null && session === before,
              kept: said("Remember the word heron"),
              ...(inFlight && { inFlightKept: said(inFlight) }),
            }
            const again = await census(run, resumed)
            const one = { id: resumed.id, taken: again, agent, harness }
            await hangUp("close", [one], agentCapMs, false).catch(() => {})
            return row
          },
          (error) => ({ resumed: false, error }),
        )
        resumes.push({ case: name, ...outcome })
        save()
      }
      for (const moment of ["idle", "mid-turn", "mid-tool"])
        for (const delayMs of killDelays) await forced(moment, delayMs, false)
      for (const moment of ["idle", "mid-turn"])
        for (const delayMs of busyKillDelays) await forced(moment, delayMs, true)
      report(setup.name)
    })
  })
}

// Every harness at once, as the Mixed job ran when Claude Code outlived its deck by more
// than 3 s: a quit that hangs them all up together, each timed by itself.
describe.skipIf(!supported || !probing)("probe: exit after a hangup, every harness at once", () => {
  const it = e2e(...setups)
  it("each case", { timeout: 2_700_000 }, async ({ e2e: run }) => {
    const { guarded, hangUp, ready, record, report } = lab(run, "mixed")
    for (const pressure of ["calm", "load"])
      for (const moment of ["idle", "mid-turn"])
        for (let index = 0; index < repeats; index += 1)
          record(
            `quit ${moment} ${pressure}`,
            await guarded<readonly Omit<Row, "case">[]>(
              async () => {
                const terminals = []
                for (const setup of setups) {
                  const terminal = await ready(setup, moment, "Say ok", "Okay then.")
                  const taken = await census(run, terminal)
                  terminals.push({
                    id: terminal.id,
                    taken,
                    agent: agentNames[setup.agent],
                    harness: setup.agent,
                  })
                }
                return hangUp("quit", terminals, agentCapMs, pressure === "load")
              },
              (error) => [{ error }],
            ),
          )
    report("Every harness")
  })
})
