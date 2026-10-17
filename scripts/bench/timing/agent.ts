import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"

// A fake Claude Code for the timing run, started as `claude` in a sandboxed terminal. It draws as
// Ink does, redrawing 34 lines in place (on a screen shorter than that, as Grid's tiles are, the
// cursor stops at the top and each frame scrolls on), and reports to Novadeck as Claude Code's
// hooks and status line do: each event goes to `$NOVADECK_HOOK claude <Event>` with the hook's
// JSON on stdin and CLAUDE_PID set to this process, so the runner binds the session to it.
// Whether it's busy is the word in `$TIMING_AGENT_CONTROL` ("on" is busy). Busy, it runs a turn
// (UserPromptSubmit to Stop, a new one every 20 s), a tool call about every 2 s and a status line
// every 300 ms with a growing context; idle, it sends Stop once and a status line every 5 s.
// `$TIMING_AGENT_SEED` seeds what it draws, and every line carries `[T<seed>]`, which the run
// looks for on screen.

const control = process.env.TIMING_AGENT_CONTROL
const seed = Number(process.env.TIMING_AGENT_SEED ?? 1)
const lines = 34
const hook = process.env.NOVADECK_HOOK
const session = randomUUID()
const cwd = process.cwd()
const transcript = `${cwd}/.fake-claude/${session}.jsonl`

const report = (event: string, payload: Record<string, unknown> = {}) => {
  if (!hook) return
  const body = JSON.stringify({
    session_id: session,
    cwd,
    transcript_path: transcript,
    hook_event_name: event,
    ...payload,
  })
  const child = spawn(hook, ["claude", event], {
    stdio: ["pipe", "ignore", "ignore"],
    env: { ...process.env, CLAUDE_PID: String(process.pid) },
  })
  child.on("error", () => {})
  child.stdin.on("error", () => {})
  child.stdin.end(body)
}

const isBusy = () => {
  try {
    return control !== undefined && readFileSync(control, "utf8").trim() === "on"
  } catch {
    return false
  }
}

const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const colors = [31, 32, 33, 34, 35, 36, 91, 92, 93]
const words =
  "reading parsing editing running tests diff plan search index compile lint cache token stream render agent patch file module".split(
    " ",
  )
const tools = ["Read", "Grep", "Edit", "Bash", "Glob"]
// The same draws every run for a seed.
let state = seed * 7919 + 13
const random = (n: number) => (state = (state * 1103515245 + 12345) & 0x7fffffff) % n
const pick = <T>(items: readonly T[]): T => items[random(items.length)]!

let tick = 0
let drawn = false
let busy = false
let turnStarted = 0
let context = 40_000
let lastTool = 0
let lastStatus = 0
let lastIdleStatus = 0
let toolInFlight: Record<string, unknown> | undefined

// Each frame overwrites the last, as Ink redraws in place.
const draw = (text: string) => {
  process.stdout.write(`${drawn ? `\x1b[${lines}A` : ""}${text}`)
  drawn = true
}

const statusLine = () => {
  context += 200 + random(800)
  if (context > 150_000) context = 40_000
  const now = Math.floor(Date.now() / 1000)
  report("StatusLine", {
    model: { display_name: "Opus" },
    effort: { level: "high" },
    context_window: {
      context_window_size: 200_000,
      current_usage: {
        input_tokens: Math.round(context * 0.6),
        cache_creation_input_tokens: Math.round(context * 0.1),
        cache_read_input_tokens: Math.round(context * 0.3),
      },
    },
    rate_limits: {
      five_hour: { used_percentage: 12 + (tick % 40) / 10, resets_at: now + 3600 },
      seven_day: { used_percentage: 30, resets_at: now + 86_400 },
    },
  })
}

const startTurn = () => {
  turnStarted = Date.now()
  report("UserPromptSubmit", { prompt: `fake task ${seed}: refactor module ${random(99)}` })
}

const endTurn = () => {
  if (toolInFlight) report("PostToolUse", toolInFlight)
  toolInFlight = undefined
  report("Stop", { stop_hook_active: false, last_assistant_message: "Done with this step." })
}

const idleFrame = () => {
  if (tick % 25 !== 0) return
  const middle = Math.floor(lines / 2)
  let text = ""
  for (let line = 0; line < lines; line += 1)
    text += `\r\x1b[2K\x1b[90m${line === middle ? `[T${seed}] ❯ ready` : ""}\x1b[0m\n`
  draw(text)
}

const busyFrame = () => {
  let text = ""
  // A step done takes the last line, so every frame is the same height to redraw.
  const done = tick % 25 === 24
  for (let line = 0; line < lines; line += 1) {
    const color = colors[(line + tick) % colors.length]
    const spin = spinner[(tick + line) % spinner.length]
    text +=
      done && line === lines - 1
        ? `\r\x1b[2K\x1b[32m✓\x1b[0m step ${tick} done: ${pick(words)}\n`
        : `\r\x1b[2K[T${seed}] \x1b[${color}m${spin}\x1b[0m \x1b[1m${pick(words)}\x1b[22m ${pick(words)} ${tick}.${line} ${"x".repeat(random(40))}\x1b[90m (${random(9999)}ms)\x1b[0m\n`
  }
  draw(text)
  const now = Date.now()
  if (now - lastTool > 2000) {
    lastTool = now
    if (toolInFlight) report("PostToolUse", toolInFlight)
    const tool = pick(tools)
    const input =
      tool === "Bash" ? { command: "npm test" } : { file_path: `${cwd}/src/file${random(40)}.ts` }
    toolInFlight = { tool_name: tool, tool_input: input, tool_response: {} }
    report("PreToolUse", { tool_name: tool, tool_input: input })
  }
  if (now - lastStatus > 300) {
    lastStatus = now
    statusLine()
  }
  if (now - turnStarted > 20_000) {
    endTurn()
    startTurn()
  }
}

const frame = () => {
  const wanted = isBusy()
  if (wanted !== busy) {
    busy = wanted
    if (busy) startTurn()
    else endTurn()
  }
  if (busy) busyFrame()
  else idleFrame()
  tick += 1
}

report("SessionStart", { source: "startup" })
process.stdout.write(`\x1b[1mClaude Code\x1b[0m · fake agent ${seed}\r\n`)
// Claude Code sends its status line as its state changes; idle, that's now and then.
setInterval(() => {
  if (busy || Date.now() - lastIdleStatus < 5000) return
  lastIdleStatus = Date.now()
  statusLine()
}, 1000)
setInterval(frame, 80)
process.on("SIGTERM", () => process.exit(0))
process.on("SIGINT", () => process.exit(0))
