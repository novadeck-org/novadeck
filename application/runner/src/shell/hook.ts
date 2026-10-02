import { agents, harnesses } from "../harnesses/registry.js"

// The hook events that ask the runner what to print, by agent.
const asking = Object.fromEntries(
  agents.map((agent) => [agent, Object.keys(harnesses[agent].messaging.asks)]),
)

/**
 * The agent hook, run by the NovaDeck plugin of a connected agent through the launcher
 * on NovaDeck's own runtime, so it needs no bash or python3. It forwards the event its
 * agent reported, a bounded copy of the agent's payload, and which agent process ran it,
 * to the NovaDeck terminal it was started from; the runner decodes it (see
 * `harnesses/<id>/decode.ts`). A Stop or prompt-time hook asks instead, with its own
 * deadline: the runner answers one line, `{leaseId, stdout}`, the hook prints `stdout`,
 * which may deliver agents' messages, and then acknowledges the lease on a second short
 * connection, since Windows' pipes can't be half-closed (see docs/agent-messaging.md).
 * Otherwise it prints nothing, since Claude Code shows some hooks' output to the model,
 * except the JSON Antigravity expects: a PreToolUse answer must say "ask" there, or
 * Antigravity denies the tool, which it prints on any failure too. It exits at once
 * outside NovaDeck's terminals and gives up within two seconds, or four as it asks.
 */
export const hookScript = `// NovaDeck agent hook. Written by NovaDeck into its own data directory, and
// overwritten on each start. Only agents started from NovaDeck's terminals run it.
import { spawn, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { connect } from "node:net"
import { homedir } from "node:os"
import { basename, join } from "node:path"

const [agent, event = ""] = process.argv.slice(2)
const env = process.env
const terminalId = env.NOVADECK_TERMINAL_ID
const endpoint = env.NOVADECK_REPORT
const token = env.NOVADECK_REPORT_TOKEN
// Claude Code's status line runs through this hook in NovaDeck's shells, which then shows
// the person's own status line: its output is what this hook prints.
const statusLine = agent === "claude" && event === "StatusLine"
// Whether this hook asks the runner what to print, as it may deliver agents' messages.
const asks = (${JSON.stringify(asking)}[agent] ?? []).includes(event)
// How long it has before it gives up, in milliseconds.
const limit = statusLine ? 5000 : asks ? 4000 : 2000
let output = ""
// Whether the runner answered the ask, and the lease its answer delivers.
let answered = false
let lease
// The person's own status line, what it has printed so far, and whether its output ended.
let own
let printed = ""
let ownEnded = false
let finished = false
const exit = () => process.exit(0)
// Tells the runner the lease it answered with was printed, on a connection of its own.
const acknowledge = () => {
  const socket = connect(endpoint)
  socket.setTimeout(500, () => socket.destroy())
  socket.on("error", exit)
  socket.on("close", exit)
  socket.end(JSON.stringify({ ack: lease, terminalId, token }) + "\\n")
}
const done = () => {
  if (finished) return
  finished = true
  if (own && !ownEnded) {
    // Out of time, or a process it started still holds its output: show what it printed,
    // and end it with whatever it started.
    output = printed.slice(0, 65_536)
    try {
      process.kill(-own.pid, "SIGTERM")
    } catch {}
  }
  // The runner's answer is exactly what the agent expects, Antigravity's JSON included.
  if (answered) return process.stdout.write(output, () => (lease ? acknowledge() : exit()))
  if (agent !== "agy") {
    if (!output) return exit()
    return process.stdout.write(output, exit)
  }
  const answer = event === "PreToolUse" ? { decision: "ask" } : {}
  process.stdout.write(JSON.stringify(answer) + "\\n", exit)
}
if (!terminalId || !endpoint || !token || !["claude", "codex", "agy"].includes(agent)) {
  done()
} else {
  setTimeout(done, limit).unref()
  // When this process started, in wall-clock time with sub-millisecond precision, before
  // Node booted: a loaded machine may take seconds to reach this line. A later hook
  // reports a larger one.
  const seq = performance.timeOrigin

  // A copy small enough to send: text past a path's length cut short, deep or wide values
  // dropped.
  const prune = (value, depth, limit) => {
    if (typeof value === "string") return value.length > limit ? value.slice(0, limit) : value
    if (typeof value !== "object" || value === null) return value
    if (depth > 6) return null
    if (Array.isArray(value)) return value.slice(0, 50).map((each) => prune(each, depth + 1, limit))
    const copy = {}
    for (const [key, each] of Object.entries(value).slice(0, 100)) copy[key] = prune(each, depth + 1, limit)
    return copy
  }

  // A process's name and parent, where the platform tells.
  const parent = (pid) => {
    try {
      if (process.platform === "linux") {
        const stat = readFileSync("/proc/" + pid + "/stat", "utf8")
        const name = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"))
        return { name, ppid: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) }
      }
      if (process.platform === "darwin") {
        const out = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8", timeout: 500 })
        const match = /^\\s*(\\d+)\\s+(.+)$/.exec(out.stdout.trim())
        return match ? { name: basename(match[2]), ppid: Number(match[1]) } : undefined
      }
    } catch {}
    return undefined
  }

  // The agent process that ran this hook: Claude Code names itself; the others are the
  // nearest ancestor with the agent's own name. Unknown where the platform hides it.
  const instance = () => {
    if (agent === "claude" && env.CLAUDE_PID) return env.CLAUDE_PID
    let pid = process.ppid
    for (let step = 0; step < 8 && pid > 1; step += 1) {
      const found = parent(pid)
      if (!found) return null
      if (found.name === agent) return String(pid)
      pid = found.ppid
    }
    return null
  }

  // The person's own status line command, as Claude Code's settings name it: the project's
  // local settings, the project's, then the person's. NovaDeck's own settings, which name
  // this hook, never count.
  const ownStatusLine = (payload) => {
    const home = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
    const project = payload.workspace?.project_dir || payload.cwd
    const files = [join(home, "settings.json")]
    if (typeof project === "string")
      files.unshift(join(project, ".claude", "settings.local.json"), join(project, ".claude", "settings.json"))
    for (const file of files) {
      try {
        const line = JSON.parse(readFileSync(file, "utf8")).statusLine
        if (line?.type === "command" && typeof line.command === "string" && line.command && !line.command.includes("NOVADECK_HOOK"))
          return line.command
      } catch {}
    }
    return undefined
  }

  // Runs the person's status line with the same input, keeping at most 64 KiB it prints.
  // It runs in its own process group, as Claude Code runs a status line, so a deadline
  // ends everything it started.
  const runStatusLine = (command, input, finish) => {
    try {
      const child = spawn(command, {
        shell: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "ignore"],
      })
      own = child
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk) => {
        if (printed.length < 65_536) printed += chunk
      })
      child.on("error", () => {
        ownEnded = true
        finish("")
      })
      child.on("close", () => {
        ownEnded = true
        finish(printed.slice(0, 65_536))
      })
      child.stdin.on("error", () => {})
      child.stdin.end(input)
    } catch {
      finish("")
    }
  }

  let text = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => {
    text += chunk
    if (text.length > 1_000_000) done()
  })
  process.stdin.on("error", done)
  process.stdin.on("end", () => {
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      return done()
    }
    if (typeof payload !== "object" || payload === null) return done()
    // The report and the person's own status line both finish before the hook does.
    let pending = 1
    const settle = () => {
      pending -= 1
      if (pending === 0) done()
    }
    const command = statusLine ? ownStatusLine(payload) : undefined
    if (command) {
      pending += 1
      runStatusLine(command, text, (printed) => {
        output = printed
        settle()
      })
    }
    const report = {
      terminalId,
      token,
      agent,
      event: event || (typeof payload.hook_event_name === "string" ? payload.hook_event_name : ""),
      seq,
      instance: instance(),
      // Only what tells nested agents apart; nothing else of the environment leaves.
      env: { cursor: Boolean(env.CURSOR_VERSION), codexThread: env.CODEX_THREAD_ID || undefined },
      payload: prune(payload, 0, 4096),
      // An ask's deadline, in epoch milliseconds: the runner leases messages only with time
      // left before it to print them and acknowledge the lease.
      ...(asks && { deadline: Math.round(seq) + limit - 500 }),
    }
    let line = JSON.stringify(report)
    if (line.length > 60_000) line = JSON.stringify({ ...report, payload: prune(payload, 0, 200) })
    let sent = false
    const delivered = () => {
      if (sent) return
      sent = true
      settle()
    }
    if (line.length > 60_000) return delivered()
    const socket = connect(endpoint)
    socket.on("error", delivered)
    socket.on("close", delivered)
    if (!asks) return void socket.end(line + "\\n")
    // An ask keeps its side open for the answer: one line, after which the runner closes.
    let reply = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk) => {
      reply += chunk
      const end = reply.indexOf("\\n")
      if (end < 0) {
        if (reply.length > 1_000_000) socket.destroy()
        return
      }
      try {
        const answer = JSON.parse(reply.slice(0, end))
        if (typeof answer?.stdout === "string") {
          output = answer.stdout
          answered = true
          if (typeof answer.leaseId === "string") lease = answer.leaseId
        }
      } catch {}
      socket.destroy()
    })
    socket.write(line + "\\n")
  })
}
`
