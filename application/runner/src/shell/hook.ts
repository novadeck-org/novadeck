/**
 * The agent hook, run by the NovaDeck plugin of a connected agent (Claude Code's and
 * Codex's SessionStart, Antigravity's PreInvocation) through the launcher on NovaDeck's
 * own runtime, so it needs no bash or python3. It reports which agent session runs in
 * the NovaDeck terminal it was started from, and nothing else. It prints nothing, since
 * Claude Code shows a SessionStart hook's output to the model, except the empty JSON
 * object Antigravity expects; it exits at once outside NovaDeck's terminals and gives
 * up within two seconds.
 */
export const hookScript = `// NovaDeck agent hook. Written by NovaDeck into its own data directory, and
// overwritten on each start. Only agents started from NovaDeck's terminals run it.
import { connect } from "node:net"

const agent = process.argv[2]
const env = process.env
const terminalId = env.NOVADECK_TERMINAL_ID
const endpoint = env.NOVADECK_REPORT
const token = env.NOVADECK_REPORT_TOKEN
// Antigravity reads a hook's answer as JSON; the others show nothing.
let finished = false
const done = () => {
  if (finished) return
  finished = true
  if (agent === "agy") process.stdout.write("{}\\n", () => process.exit(0))
  else process.exit(0)
}
if (!terminalId || !endpoint || !token || !["claude", "codex", "agy"].includes(agent)) {
  done()
} else {
  setTimeout(done, 2000).unref()
  // Wall-clock time with sub-millisecond precision: a later hook reports a larger one.
  const seq = performance.timeOrigin + performance.now()

  // The session the payload names, unless it is not this terminal's own: a Claude Code
  // subagent's, Claude Code running inside Cursor, or a Codex started by another Codex.
  const sessionOf = (payload) => {
    if (typeof payload !== "object" || payload === null) return undefined
    const id = agent === "agy" ? payload.conversationId : payload.session_id
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) return undefined
    if (payload.hook_event_name !== undefined && payload.hook_event_name !== "SessionStart")
      return undefined
    if (agent === "claude" && (payload.agent_id !== undefined || payload.cursor_version !== undefined || env.CURSOR_VERSION))
      return undefined
    if (agent === "codex" && env.CODEX_THREAD_ID && env.CODEX_THREAD_ID !== id) return undefined
    return id
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
    const sessionId = sessionOf(payload)
    if (!sessionId) return done()
    const source = typeof payload.source === "string" ? payload.source.slice(0, 32) : undefined
    const where = agent === "agy" ? payload.workspacePaths?.[0] : payload.cwd
    const cwd = typeof where === "string" ? where : undefined
    const socket = connect(endpoint)
    socket.on("error", done)
    socket.on("close", done)
    socket.end(JSON.stringify({ terminalId, token, agent, sessionId, source, seq, cwd }) + "\\n")
  })
}
`
