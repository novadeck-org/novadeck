/**
 * The agent hook, run by the NovaDeck plugin of a connected agent through the launcher
 * on NovaDeck's own runtime, so it needs no bash or python3. It forwards the event its
 * agent reported, a bounded copy of the agent's payload, and which agent process ran it,
 * to the NovaDeck terminal it was started from; the runner decodes it (see
 * `harnesses/<id>/decode.ts`). It prints nothing, since Claude Code shows some hooks'
 * output to the model, except the JSON Antigravity expects: a PreToolUse answer must say
 * "ask" there, or Antigravity denies the tool. It exits at once outside NovaDeck's
 * terminals and gives up within two seconds.
 */
export const hookScript = `// NovaDeck agent hook. Written by NovaDeck into its own data directory, and
// overwritten on each start. Only agents started from NovaDeck's terminals run it.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { connect } from "node:net"
import { basename } from "node:path"

const [agent, event = ""] = process.argv.slice(2)
const env = process.env
const terminalId = env.NOVADECK_TERMINAL_ID
const endpoint = env.NOVADECK_REPORT
const token = env.NOVADECK_REPORT_TOKEN
let finished = false
const done = () => {
  if (finished) return
  finished = true
  if (agent !== "agy") return process.exit(0)
  const answer = event === "PreToolUse" ? { decision: "ask" } : {}
  process.stdout.write(JSON.stringify(answer) + "\\n", () => process.exit(0))
}
if (!terminalId || !endpoint || !token || !["claude", "codex", "agy"].includes(agent)) {
  done()
} else {
  setTimeout(done, 2000).unref()
  // Wall-clock time with sub-millisecond precision: a later hook reports a larger one.
  const seq = performance.timeOrigin + performance.now()

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
    }
    let line = JSON.stringify(report)
    if (line.length > 60_000) line = JSON.stringify({ ...report, payload: prune(payload, 0, 200) })
    if (line.length > 60_000) return done()
    const socket = connect(endpoint)
    socket.on("error", done)
    socket.on("close", done)
    socket.end(line + "\\n")
  })
}
`
