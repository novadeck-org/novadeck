import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, onTestFinished, vi } from "vitest"

import { processListing, sharedListing } from "./descendants.js"
import { spawnPty, type Pty } from "./pty.js"

const noTrees = { read: () => Promise.resolve(undefined), end: () => Promise.resolve() }
// Fresh each time: these tests start and end processes faster than a shared one would show. And
// with time to spare, for a machine this busy: none of them is about a listing's limit.
const listing = processListing(process.platform, 0, 10_000)

const listed = async () => {
  const rows = await listing()
  if (!rows) throw new Error("The processes can't be listed")
  return rows
}

const running = async (pid: number): Promise<boolean> =>
  (await listed()).some((row) => row.pid === pid && !row.zombie)

const eventually = async (check: () => Promise<boolean>, what: string, ms = 10_000) => {
  const by = Date.now() + ms
  while (Date.now() < by) {
    // eslint-disable-next-line no-await-in-loop -- Waits for it.
    if (await check()) return
    // eslint-disable-next-line no-await-in-loop -- Waits for it.
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/** Ends `pid`, one of this test's own, by its exact pid, should it still run. */
const endAfter = (pid: number) =>
  onTestFinished(() => {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Ended, as it should have been.
    }
  })

// A stand-in for an agent: it ignores the hangup, and starts a tool in a group of its own that
// ignores it and SIGTERM, as every harness runs its tools. It says their pids once both are up.
const agent = `
import { spawn } from "node:child_process"
process.on("SIGHUP", () => {})
const tool = spawn(process.execPath, ["-e", \`
  for (const signal of ["SIGHUP", "SIGTERM"]) process.on(signal, () => {})
  console.log("up")
  setInterval(() => {}, 1000)
\`], { detached: true, stdio: ["ignore", "pipe", "ignore"] })
tool.stdout.once("data", () => console.log(\`AGENT=\${process.pid} TOOL=\${tool.pid}=\`))
setInterval(() => {}, 1000)
`

// One that leaves a daemon: a child starts it in a group of its own and exits, so it has left
// the tree before any hangup.
const daemonizing = `
import { spawn } from "node:child_process"
process.on("SIGHUP", () => {})
const starter = spawn(process.execPath, ["-e", \`
  const { spawn } = require("node:child_process")
  const daemon = spawn(process.execPath, ["-e", "process.on('SIGHUP', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" })
  console.log(daemon.pid)
  daemon.unref()
\`], { stdio: ["ignore", "pipe", "ignore"] })
let daemon = ""
starter.stdout.on("data", (data) => (daemon += data))
starter.once("exit", () => console.log(\`AGENT=\${process.pid} DAEMON=\${daemon.trim()}=\`))
setInterval(() => {}, 1000)
`

// One that stops itself some time after it hears the hangup, as a program does when it finishes
// restoring the terminal before bash's take-back stops it, and saves and exits once it runs
// again. The stop comes after the shell's forced end at 1 s, so a wake sent as the shell exits
// finds it still running and is lost; a wake that was stopped for is the only one it saves on.
const stopping = `
import { writeFileSync } from "node:fs"
let stopped = false
process.on("SIGHUP", () =>
  setTimeout(() => {
    stopped = true
    process.kill(process.pid, "SIGSTOP")
  }, 1700),
)
process.on("SIGCONT", () => {
  if (!stopped) return
  writeFileSync("saved", "saved")
  process.exit(0)
})
console.log(\`STOPPING=\${process.pid}=\`)
setInterval(() => {}, 1000)
`

const person = `
process.on("SIGHUP", () => {})
console.log(\`PERSON=\${process.pid}=\`)
setInterval(() => {}, 1000)
`

// A real shell on a real terminal, with job control, so each program holds its own group.
const shell = async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "terminal-follow-")))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  for (const [name, content] of Object.entries({ agent, daemonizing, person, stopping }))
    writeFileSync(join(root, `${name}.mjs`), content)
  const pty: Pty = spawnPty({
    file: "bash",
    args: ["--norc", "--noprofile", "-i"],
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, TERM: "dumb" },
    cols: 200,
    rows: 24,
  })
  let screen = ""
  pty.onData((data) => {
    screen += data
  })
  onTestFinished(() => {
    if (!pty.exited) void pty.end({ graceMs: 100, treeGraceMs: 100, trees: noTrees })
  })
  const said = async (pattern: RegExp): Promise<RegExpExecArray> => {
    await eventually(() => Promise.resolve(pattern.test(screen)), `${pattern} in: ${screen}`)
    return pattern.exec(screen)!
  }
  const run = (line: string) => pty.write(`${line}\r`)
  const end = (follow?: number, treeGraceMs = 200) =>
    pty.end({
      graceMs: 1000,
      treeGraceMs,
      trees: noTrees,
      follow: follow === undefined ? undefined : { agent: follow, listing },
    })
  return { pty, root, run, said, end }
}

describe.skipIf(process.platform === "win32")("a hangup followed through an agent", () => {
  it("ends the agent that ignores it and the tool it started", async () => {
    const { run, said, end } = await shell()
    run(`${process.execPath} agent.mjs`)
    const [, agentPid, toolPid] = (await said(/AGENT=(\d+) TOOL=(\d+)=/)).map(Number)
    endAfter(agentPid!)
    endAfter(toolPid!)
    expect(await running(agentPid!)).toBe(true)
    expect(await running(toolPid!)).toBe(true)
    await end(agentPid)
    await eventually(async () => !(await running(agentPid!)), "the agent to end")
    await eventually(async () => !(await running(toolPid!)), "the tool to end")
  })

  // A program's own exit can stop it: the shell it asks to take the terminal back has gone.
  it("wakes an agent stopped on its way out as soon as the shell has gone", async () => {
    const { root, run, said, end } = await shell()
    // A shell that outlasts the hangup, until its forced end a second on, by when the agent has
    // long stopped: Node runs its handler a moment after the signal, which the order would hang on.
    run(`trap '' HUP`)
    run(`${process.execPath} stopping.mjs`)
    const pid = Number((await said(/STOPPING=(\d+)=/))[1])
    endAfter(pid)
    const began = Date.now()
    await end(pid, 5_000)
    // Its save follows the wake by a moment, which on a loaded runner can outlast the end
    // when the agent isn't followed to its exit; killed at the bound, it never comes.
    await eventually(
      () => Promise.resolve(existsSync(join(root, "saved"))),
      "the agent to save",
      3_000,
    )
    expect(readFileSync(join(root, "saved"), "utf8")).toBe("saved")
    // Short of the 5 s bound it would otherwise be killed at, unsaved.
    expect(Date.now() - began).toBeLessThan(4_000)
  })

  it("leaves a nohup started before the agent", async () => {
    const { run, said, end } = await shell()
    run(`nohup sleep 60 >/dev/null 2>&1 & echo NOHUP=$!=`)
    const nohup = Number((await said(/NOHUP=(\d+)=/))[1])
    endAfter(nohup)
    run(`${process.execPath} agent.mjs`)
    const [, agentPid, toolPid] = (await said(/AGENT=(\d+) TOOL=(\d+)=/)).map(Number)
    endAfter(agentPid!)
    endAfter(toolPid!)
    await end(agentPid)
    await eventually(async () => !(await running(toolPid!)), "the tool to end")
    expect(await running(nohup)).toBe(true)
  })

  it("hangs up all the same where the processes can't be listed, and says so", async () => {
    const { pty, run, said } = await shell()
    run(`${process.execPath} person.mjs`)
    const program = Number((await said(/PERSON=(\d+)=/))[1])
    endAfter(program)
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    onTestFinished(() => void error.mockRestore())
    await pty.end({
      graceMs: 1000,
      treeGraceMs: 200,
      trees: noTrees,
      follow: { agent: program, listing: () => Promise.resolve(undefined) },
    })
    expect(pty.exited).toBe(true)
    expect(error.mock.calls.flat().join(" ")).toContain("won't be followed")
  })

  it("leaves a plain terminal's program, which ignores the hangup, as ever", async () => {
    const { run, said, end } = await shell()
    run(`${process.execPath} person.mjs`)
    const program = Number((await said(/PERSON=(\d+)=/))[1])
    endAfter(program)
    await end()
    expect(await running(program)).toBe(true)
  })

  it("leaves the person's own program once the bound agent has gone", async () => {
    const { run, said, end } = await shell()
    run(`${process.execPath} -e 'console.log("GONE=" + process.pid + "=")'`)
    const gone = Number((await said(/GONE=(\d+)=/))[1])
    await eventually(async () => !(await running(gone)), "the agent to leave")
    run(`${process.execPath} person.mjs`)
    const program = Number((await said(/PERSON=(\d+)=/))[1])
    endAfter(program)
    await end(gone)
    expect(await running(program)).toBe(true)
  })

  it("takes one listing for thirty terminals before their hangups, and few after", async () => {
    const shells = await Promise.all(Array.from({ length: 30 }, () => shell()))
    const stayer = `sh -c 'trap "" HUP TERM; echo STAYS=$$=; sleep 60'`
    for (const { run } of shells) run(stayer)
    const agents = await Promise.all(
      shells.map(async ({ said }) => Number((await said(/STAYS=(\d+)=/))[1])),
    )
    for (const pid of agents) endAfter(pid)
    let listings = 0
    let listingMs = 0
    const shared = sharedListing(async () => {
      listings += 1
      const began = performance.now()
      const rows = await listing()
      listingMs += performance.now() - began
      return rows
    })
    const began = performance.now()
    // One bound for all, as at a quit, wherever each one's hangup got to by then.
    const bound = Date.now() + 200
    await Promise.all(
      shells.map(({ pty }, at) =>
        pty.end({
          graceMs: 1000,
          treeGraceMs: 200,
          trees: noTrees,
          budget: { run: (usual) => usual, graceEnds: () => bound },
          follow: { agent: agents[at]!, listing: shared },
        }),
      ),
    )
    const tookMs = Math.round(performance.now() - began)
    console.log(
      `30 terminals: ${listings} listings, ${Math.round(listingMs)} ms of them, ${tookMs} ms in all`,
    )
    // Before the hangups, at the bound, and at SIGKILL; a poll may split one.
    expect(listings).toBeLessThanOrEqual(6)
    await eventually(
      async () => (await listed()).every((row) => row.zombie || !agents.includes(row.pid)),
      "all thirty to end",
    )
  }, 60_000)

  // Not what anyone wants: what the walk can't see. Its parent is gone before the hangup.
  it("leaves a daemon that left the tree before the hangup", async () => {
    const { run, said, end } = await shell()
    run(`${process.execPath} daemonizing.mjs`)
    const [, agentPid, daemon] = (await said(/AGENT=(\d+) DAEMON=(\d+)=/)).map(Number)
    endAfter(agentPid!)
    endAfter(daemon!)
    await end(agentPid)
    await eventually(async () => !(await running(agentPid!)), "the agent to end")
    expect(await running(daemon!)).toBe(true)
  })
})
