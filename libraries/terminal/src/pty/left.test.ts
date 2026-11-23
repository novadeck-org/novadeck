import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { describe as context, describe, expect, it, onTestFinished } from "vitest"

import { processListing } from "./descendants.js"
import { spawnPty, type Pty } from "./pty.js"
import { UserScopes, userScopes, type Scopes } from "./scopes.js"
import { parseLstart } from "./spawned.js"
import { TaggedScopes } from "./tagged.js"
import type { RunRelay } from "./trees.js"

const macOS = process.platform === "darwin"
// Real shells in real systemd scopes of their own, named apart from the app's own terminals;
// on macOS, each named in its environment, as the runner names every terminal.
const prefix = `app-novadeck-lefttest${process.pid}`
const variable = "NOVADECK_TERMINAL_ID"

/**
 * The relay's `tagged`, played by `ps -E`, which shows the environment each of the user's
 * processes started with as the relay reads it, but its start only to the second: so on macOS
 * what is told apart by its start is a second apart. The relay's own reading is its test's.
 */
const psTagged: RunRelay = async (_relay, args) => {
  const name = args[1]!
  const { stdout } = await promisify(execFile)("ps", ["-axEww", "-o", "pid=,lstart=,command="], {
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/.exec(line)
      const value = match && new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(match[3]!)?.[1]
      const started = match && parseLstart(match[2]!)
      return value && started !== undefined && started !== null
        ? [JSON.stringify({ pid: Number(match[1]), startedUs: started * 1000, value })]
        : []
    })
    .join("\n")
}

/** How long apart two starts are to be told apart: Linux's clock ticks, macOS's `ps` seconds. */
const distinct = macOS ? 1_100 : 50
/** Detaches a command into a session of its own: macOS has no `setsid` program. */
const setsid = macOS ? `perl -MPOSIX -e 'fork and exit; POSIX::setsid(); exec @ARGV'` : "setsid"
const noTrees = { read: () => Promise.resolve(undefined), end: () => Promise.resolve() }
const listing = processListing(process.platform, 0, 10_000)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const eventually = async (check: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const by = Date.now() + ms
  while (Date.now() < by) {
    // eslint-disable-next-line no-await-in-loop -- Waits for it.
    if (await check()) return
    // eslint-disable-next-line no-await-in-loop -- Waits for it.
    await sleep(20)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

const running = async (pid: number): Promise<boolean> =>
  (await listing())!.some((row) => row.pid === pid && !row.zombie)

/** Which of `servers` still run, by name. */
const stillRunning = async (servers: ReadonlyMap<string, number>): Promise<readonly string[]> => {
  const states = await Promise.all(
    [...servers].map(async ([name, pid]) => [name, await running(pid)] as const),
  )
  return states.flatMap(([name, up]) => (up ? [name] : []))
}

/** A program that runs until ended and says its pid, by the name it's given. */
const server = `
import { appendFileSync } from "node:fs"
process.on("SIGHUP", () => {})
appendFileSync("pids.txt", process.argv[2] + " " + process.pid + "\\n")
setInterval(() => {}, 1000)
`

// Each way a program leaves its shell's tree, as an agent's tool starts it.
const variants: Record<string, string> = {
  subshell: `(${process.execPath} server.mjs subshell >/dev/null 2>&1 &)`,
  nohup: `nohup ${process.execPath} server.mjs nohup >/dev/null 2>&1 &`,
  setsid: `${setsid} ${process.execPath} server.mjs setsid >/dev/null 2>&1 &`,
  disown: `${process.execPath} server.mjs disown >/dev/null 2>&1 & disown`,
}

// A stand-in for an agent: it ignores the hangup and runs each variant as a tool of its own, in
// a group of its own, as every harness runs its tools; it says its pid once they are up.
const agent = `
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
process.on("SIGHUP", () => {})
const commands = JSON.parse(readFileSync("variants.json", "utf8"))
for (const command of commands) spawn("bash", ["-c", command], { detached: true, stdio: "ignore" }).unref()
const up = setInterval(() => {
  const told = existsSync("pids.txt") ? readFileSync("pids.txt", "utf8").trim().split("\\n") : []
  if (told.length < commands.length) return
  clearInterval(up)
  console.log("AGENT=" + process.pid + "=")
}, 20)
setInterval(() => {}, 1000)
`

/** The servers' pids by name, as they told them. */
const told = (root: string): Map<string, number> =>
  new Map(
    (existsSync(join(root, "pids.txt")) ? readFileSync(join(root, "pids.txt"), "utf8") : "")
      .trim()
      .split("\n")
      .map((line) => {
        const [name, pid] = line.split(" ")
        return [name!, Number(pid)]
      }),
  )

/** The state of systemd's unit `unit`: `active`, `inactive`, and so on. */
const unitState = async (unit: string): Promise<string> =>
  (
    await promisify(execFile)("systemctl", ["--user", "show", "-p", "ActiveState", "--value", unit])
  ).stdout.trim()

// A real shell on a real terminal, with job control, in a scope of its own once it is there.
const terminal = async (
  scopes: Scopes = macOS
    ? new TaggedScopes(() => Promise.resolve("ps"), variable, psTagged)
    : new UserScopes(prefix),
) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "terminal-left-")))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, "server.mjs"), server)
  writeFileSync(join(root, "agent.mjs"), agent)
  const pty: Pty = spawnPty({
    file: "bash",
    args: ["--norc", "--noprofile", "-i"],
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, TERM: "dumb", [variable]: `left-${randomUUID()}` },
    cols: 200,
    rows: 24,
    scopes,
    listing,
  })
  let screen = ""
  pty.onData((data) => {
    screen += data
  })
  const ended: number[] = []
  // Whatever is left of this test's own servers, should it fail.
  onTestFinished(async () => {
    if (!pty.exited) await pty.end({ graceMs: 100, treeGraceMs: 100, trees: noTrees })
    for (const pid of ended)
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // Gone, as it should be.
      }
  })
  const unit = `${prefix}-term${pty.pid}.scope`
  if (!macOS)
    await eventually(
      () => readFileSync(`/proc/${pty.pid}/cgroup`, "utf8").includes(unit),
      "the shell to be in its scope",
    )
  const run = (line: string) => pty.write(`${line}\r`)
  const said = async (pattern: RegExp): Promise<RegExpExecArray> => {
    await eventually(() => pattern.test(screen), `${pattern} in: ${screen}`)
    return pattern.exec(screen)!
  }
  // Starts the stand-in agent with `names`' variants, told to the pty as the runner tells it.
  const startAgent = async (names: readonly string[] = Object.keys(variants)) => {
    writeFileSync(join(root, "variants.json"), JSON.stringify(names.map((name) => variants[name])))
    run(`${process.execPath} agent.mjs`)
    const pid = Number((await said(/AGENT=(\d+)=/))[1])
    pty.agentStarted(pid)
    const servers = told(root)
    ended.push(pid, ...servers.values())
    // The agent's own start, read back by a listing.
    await sleep(macOS ? 500 : 100)
    return { pid, servers }
  }
  const end = (
    agentPid?: number,
    { by, apart }: { by?: number; apart?: readonly { pid: number; start: string }[] } = {},
  ) =>
    pty.end({
      graceMs: 1000,
      treeGraceMs: 300,
      trees: noTrees,
      ...(by !== undefined && {
        budget: { run: (usual) => usual, graceEnds: (began) => began + 300, by: () => by },
      }),
      follow: agentPid === undefined ? undefined : { agent: agentPid, listing },
      left: { listing, ...(apart && { apart }) },
    })
  const own = (pid: number) => ended.push(pid)
  return { pty, root, unit, run, said, startAgent, end, own }
}

const scoped = (process.platform === "linux" && userScopes() !== undefined) || macOS

describe.skipIf(!scoped)("what an agent left in its terminal's scope", () => {
  it.skipIf(macOS)("is in the scope, though it has left the shell's tree", async () => {
    const { pty, startAgent } = await terminal()
    const { servers } = await startAgent()
    const scope = readFileSync(`/proc/${pty.pid}/cgroup`, "utf8")
    for (const pid of servers.values())
      expect(readFileSync(`/proc/${pid}/cgroup`, "utf8")).toBe(scope)
  })

  it.runIf(macOS)("names its terminal, though it has left the shell's tree", async () => {
    const scopes = new TaggedScopes(() => Promise.resolve("ps"), variable, psTagged)
    const { pty, startAgent } = await terminal(scopes)
    const { servers } = await startAgent()
    const members = await pty.leftovers({ listing })
    expect(members?.map(({ pid }) => pid).toSorted()).toEqual([...servers.values()].toSorted())
  })

  context("as its terminal closes", () => {
    for (const name of Object.keys(variants))
      it(`ends a program the agent started by ${name}`, async () => {
        const { startAgent, end } = await terminal()
        const { pid, servers } = await startAgent([name])
        await end(pid)
        await expect.poll(() => stillRunning(servers), { timeout: 3_000 }).toEqual([])
      })

    it("ends them once the agent has left, the shell still at its prompt", async () => {
      const { pty, startAgent, run, said, end } = await terminal()
      const { pid, servers } = await startAgent()
      process.kill(pid, "SIGKILL")
      pty.agentEnded()
      run("echo BACK=$((40+2))=")
      await said(/BACK=42=/)
      await end()
      await expect.poll(() => stillRunning(servers), { timeout: 3_000 }).toEqual([])
    })

    it("ends them in a terminal whose shell has exited by itself", async () => {
      const { pty, startAgent, run, said } = await terminal()
      const { pid, servers } = await startAgent()
      process.kill(pid, "SIGKILL")
      pty.agentEnded()
      run("echo BACK=$((40+2))=")
      await said(/BACK=42=/)
      run("exit")
      await eventually(() => pty.exited, "the shell to exit")
      expect(await Promise.all([...servers.values()].map(running))).not.toContain(false)
      await pty.endLeft({ listing })
      await expect.poll(() => stillRunning(servers), { timeout: 3_000 }).toEqual([])
    })

    it("spares what the person started before the agent, and after it left", async () => {
      const { pty, root, run, said, startAgent, end, own } = await terminal()
      run(`nohup ${process.execPath} server.mjs before >/dev/null 2>&1 &`)
      await eventually(() => told(root).has("before"), "the person's first server")
      own(told(root).get("before")!)
      // In the clock's own ticks, it started before the agent.
      await sleep(distinct)
      const { pid } = await startAgent(["setsid"])
      process.kill(pid, "SIGKILL")
      pty.agentEnded()
      await sleep(distinct)
      run("echo BACK=$((40+2))=")
      await said(/BACK=42=/)
      run(`${setsid} ${process.execPath} server.mjs after >/dev/null 2>&1 &`)
      await eventually(() => told(root).has("after"), "the person's second server")
      const servers = told(root)
      own(servers.get("after")!)
      await end()
      await eventually(async () => !(await running(servers.get("setsid")!)), "the agent's to end")
      expect(await running(servers.get("before")!)).toBe(true)
      expect(await running(servers.get("after")!)).toBe(true)
    })

    it("leaves what the harness runs apart from the terminal, with all under it", async () => {
      const { startAgent, end } = await terminal()
      const { pid, servers } = await startAgent(["setsid", "nohup"])
      // The setsid one plays Claude Code's background service, as its lock names it.
      const service = servers.get("setsid")!
      const { started } = (await listing())!.find((one) => one.pid === service)!
      await end(pid, { apart: [{ pid: service, start: started }] })
      await eventually(async () => !(await running(servers.get("nohup")!)), "the other to end")
      expect(await running(service)).toBe(true)
    })

    it("leaves a plain terminal's as it was: no agent ran there", async () => {
      const { root, run, end, own } = await terminal()
      run(`${setsid} ${process.execPath} server.mjs plain >/dev/null 2>&1 &`)
      await eventually(() => told(root).has("plain"), "the person's server")
      const plain = told(root).get("plain")!
      own(plain)
      await end()
      await sleep(700)
      expect(await running(plain)).toBe(true)
    })
  })

  it("ends them by a quit's bound, however they take SIGTERM", async () => {
    const stubborn = `
      process.on("SIGTERM", () => {})
      require("node:fs").appendFileSync("pids.txt", "stubborn " + process.pid + "\\n")
      setInterval(() => {}, 1000)`
    const { root, startAgent, end } = await terminal()
    writeFileSync(join(root, "stubborn.cjs"), stubborn)
    variants.stubborn = `${setsid} ${process.execPath} stubborn.cjs >/dev/null 2>&1 &`
    onTestFinished(() => {
      delete (variants as { stubborn?: string }).stubborn
    })
    const { pid, servers } = await startAgent(["stubborn"])
    const began = Date.now()
    await end(pid, { by: began + 600 })
    await eventually(async () => !(await running(servers.get("stubborn")!)), "it to end", 3_000)
    expect(Date.now() - began).toBeLessThan(2_000)
  })
})

describe.skipIf(!scoped || macOS)("a terminal's scope once its program has exited", () => {
  it("never stays behind empty, however soon the program ended", async () => {
    const scopes = new UserScopes(prefix)
    const units: string[] = []
    // Each ends some milliseconds in, while systemd may be moving it: 8 of 60 such moves left
    // a scope behind for good, and 42 of 60 of a plain child killed as late.
    for (let at = 0; at < 30; at += 1) {
      const pty = spawnPty({
        file: "sleep",
        args: [String(0.004 + (at % 10) * 0.002)],
        cwd: tmpdir(),
        env: { PATH: process.env.PATH },
        cols: 80,
        rows: 24,
        scopes,
      })
      units.push(`${prefix}-term${pty.pid}.scope`)
      // eslint-disable-next-line no-await-in-loop -- One at a time, as terminals open.
      await new Promise((resolve) => pty.onExit(resolve))
    }
    await eventually(
      async () => (await Promise.all(units.map(unitState))).every((state) => state !== "active"),
      "every scope to go",
      15_000,
    )
    expect(await Promise.all(units.map(unitState))).not.toContain("active")
  })
})
