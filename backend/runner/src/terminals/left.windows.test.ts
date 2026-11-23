import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { relayPath } from "@novadeck/relay"
import { spawnPty, Trees, WindowsJobs, type Pty } from "@novadeck/terminal/pty"
import { describe, expect, it, onTestFinished } from "vitest"

// Real cmd shells in real job objects, kept by the relay this repository built.
const relay = relayPath
const supported = process.platform === "win32" && existsSync(relay)
const trees = new Trees(async () => relay)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const eventually = async (check: () => boolean | Promise<boolean>, what: string, ms = 15_000) => {
  const by = Date.now() + ms
  while (Date.now() < by) {
    // eslint-disable-next-line no-await-in-loop -- Waits for it.
    if (await check()) return
    // eslint-disable-next-line no-await-in-loop -- Waits for it.
    await sleep(50)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** A program that runs until ended and says its pid, by the name it's given. */
const server = `
import { appendFileSync } from "node:fs"
appendFileSync("pids.txt", process.argv[2] + " " + process.pid + "\\n")
setInterval(() => {}, 1000)
`

const node = process.execPath

// Each way a program leaves its starter's tree on Windows: its starter exits at once, and the
// parent it records leads nowhere.
const variants: Record<string, readonly [string, readonly string[]]> = {
  start: ["cmd.exe", ["/d", "/c", `start "" /b "${node}" server.mjs start`]],
  startProcess: [
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Start-Process -WindowStyle Hidden -FilePath '${node}' -ArgumentList 'server.mjs','startProcess'`,
    ],
  ],
  detached: [
    node,
    [
      "-e",
      "require('child_process').spawn(process.execPath, ['server.mjs', 'detached'], { detached: true, stdio: 'ignore' }).unref()",
    ],
  ],
}

// A stand-in for an agent: it runs each variant as a tool of its own, and says its pid once
// they are up.
const agent = `
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
const commands = JSON.parse(readFileSync("variants.json", "utf8"))
for (const [file, args] of commands)
  spawn(file, args, { stdio: "ignore", windowsHide: true, windowsVerbatimArguments: file === "cmd.exe" })
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
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name, pid] = line.split(" ")
        return [name!, Number(pid)]
      }),
  )

const stillRunning = (servers: ReadonlyMap<string, number>): readonly string[] =>
  [...servers].flatMap(([name, pid]) => (running(pid) ? [name] : []))

// A real cmd on a real console, in a job of its own once that has settled.
const terminal = async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "terminal-left-")))
  writeFileSync(join(root, "server.mjs"), server)
  writeFileSync(join(root, "agent.mjs"), agent)
  const scopeFile = join(root, "held")
  const pty: Pty = spawnPty({
    file: "cmd.exe",
    args: "/d /q",
    cwd: root,
    env: { ...process.env, PROMPT: "$G" },
    cols: 200,
    rows: 24,
    scopes: new WindowsJobs(async () => relay),
    scopeFile,
  })
  let screen = ""
  pty.onData((data) => {
    // The bundled console host asks its terminal what it is, and holds the shell back until
    // it hears (see native.test.ts); this test has no terminal to answer.
    if (data.includes("[c")) pty.write("[?1;2c")
    screen += data
  })
  const ended: number[] = []
  onTestFinished(async () => {
    if (!pty.exited) await pty.end({ graceMs: 100, treeGraceMs: 100, trees })
    for (const pid of [...ended, ...told(root).values()])
      try {
        process.kill(pid)
      } catch {
        // Gone, as it should be.
      }
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  })
  await eventually(() => existsSync(scopeFile), "the shell's job to settle")
  await eventually(() => pty.drawn, "the shell to draw")
  const run = (line: string) => pty.write(`${line}\r`)
  const said = async (pattern: RegExp): Promise<RegExpExecArray> => {
    await eventually(() => pattern.test(screen), `${pattern} in: ${screen}`)
    return pattern.exec(screen)!
  }
  /** Starts the stand-in agent with `names`' variants, told to the pty as the runner tells it. */
  const startAgent = async (names: readonly string[] = Object.keys(variants)) => {
    const before = told(root).size
    writeFileSync(join(root, "variants.json"), JSON.stringify(names.map((name) => variants[name])))
    run(`"${node}" agent.mjs`)
    const pid = Number((await said(/AGENT=(\d+)=/))[1])
    pty.agentStarted(pid)
    ended.push(pid)
    await eventually(() => told(root).size >= before + names.length, "the agent's servers")
    // Its run counts from its own start once the job's listing shows it, as it may have
    // started its servers before it told its pid.
    const theirs = names.map((name) => told(root).get(name))
    await eventually(async () => {
      const left = await pty.leftovers({
        listing: () => Promise.resolve(undefined),
      })
      return theirs.every((one) => left?.some((each) => each.pid === one))
    }, "the agent's servers to count as its")
    return pid
  }
  /**
   * A program the person leaves detached, as the agent's are, outside any agent's run, on no
   * console: one on the terminal's console ends as it closes, whoever started it.
   */
  const leaveOwn = async (name: string) => {
    run(
      `cmd /d /c start "" /b "${node}" -e "require('child_process').spawn(process.execPath, ['server.mjs', '${name}'], { detached: true, stdio: 'ignore' }).unref()"`,
    )
    await eventually(() => told(root).has(name), `${name} to start`)
  }
  const close = () =>
    pty.end({
      graceMs: 2_000,
      treeGraceMs: 500,
      trees,
      left: { listing: () => Promise.resolve(undefined) },
    })
  return { root, pty, startAgent, leaveOwn, close, servers: () => told(root) }
}

describe.skipIf(!supported)("what an agent left detached in a Windows terminal's job", () => {
  it("is found while the agent runs, and ends with the terminal's close", async () => {
    const { startAgent, close, servers, pty } = await terminal()
    await startAgent()
    const left = await pty.leftovers({
      listing: () => Promise.resolve(undefined),
    })
    const pids = [...servers().values()]
    expect(left?.map((one) => one.pid).toSorted()).toEqual(expect.arrayContaining(pids.toSorted()))
    await close()
    await eventually(() => stillRunning(servers()).length === 0, "the leftovers to end")
  }, 60_000)

  it("spares what the person left there before the agent and after its session", async () => {
    const { startAgent, leaveOwn, close, servers, pty } = await terminal()
    await leaveOwn("before")
    const agentPid = await startAgent(["start"])
    // Its session over, the person has the prompt back.
    process.kill(agentPid)
    pty.agentEnded()
    await sleep(50)
    await leaveOwn("after")
    await close()
    await eventually(() => !stillRunning(servers()).includes("start"), "the agent's to end")
    expect(stillRunning(servers())).toEqual(["before", "after"])
  }, 60_000)

  it("leaves a plain terminal's detached programs as they were", async () => {
    const { leaveOwn, close, servers, pty } = await terminal()
    await leaveOwn("own")
    expect(pty.agentRan).toBe(false)
    await close()
    await sleep(500)
    expect(stillRunning(servers())).toEqual(["own"])
  }, 60_000)

  it("ends them once the shell has exited by itself, as the terminal closes", async () => {
    const { startAgent, servers, pty } = await terminal()
    const agentPid = await startAgent(["detached"])
    // The agent is done; then its shell.
    process.kill(agentPid)
    pty.agentEnded()
    pty.write("exit\r")
    await eventually(() => pty.exited, "the shell to exit")
    expect(stillRunning(servers())).toEqual(["detached"])
    await pty.endLeft({ listing: () => Promise.resolve(undefined) })
    await eventually(() => stillRunning(servers()).length === 0, "the leftover to end")
  }, 60_000)
})
