import { randomUUID } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"
import { vi } from "vitest"

import { handleWords } from "../terminals/handles.js"
import { Terminals } from "../terminals/index.js"
import { expect } from "../test.js"
import { bash, type Fixture, create, toolCall } from "./integration.test-support.js"

// A command starting an agent with a doorbell line as its prompt.
export const quoted = (start: string) =>
  new RegExp(
    `^${start} "\\[Novadeck: automatic notice, agent messages waiting, [A-Za-z0-9]{6}\\]"$`,
  )

// A stand-in agent with Novadeck's plugin connected: `agent <name> <session> <steps>` runs
// the real hook for its SessionStart, says it is ready, then runs each step written to its
// `steps` folder, in order: a hook, as its harness would run it, keeping what the hook
// printed; or a tool call, as Novadeck's MCP server would send it, keeping the answer.
// Each says when it is done. Steps come through a folder, not the terminal, since what is
// typed there is the person's input.
export const standIn = (home: string): string => {
  const bin = join(home, "bin")
  mkdirSync(bin, { recursive: true })
  const script = join(bin, "agent.cjs")
  writeFileSync(
    script,
    [
      'const { spawn } = require("node:child_process")',
      'const fs = require("node:fs")',
      'const net = require("node:net")',
      "const [agent, session, steps] = process.argv.slice(2)",
      "const { NOVADECK_REPORT_TOKEN: token } = process.env",
      "const hook = (event, payload, done) => {",
      "  const child = spawn(process.env.NOVADECK_HOOK, [agent, event], { stdio: ['pipe', 'pipe', 'inherit'] })",
      '  let printed = ""',
      '  child.stdout.on("data", (chunk) => (printed += chunk))',
      '  child.on("close", () => done(printed))',
      "  child.stdin.end(JSON.stringify(payload))",
      "}",
      toolCall,
      "const call = (type, request, done) => toolCall(type, request, token, (answer) => done(JSON.stringify(answer)))",
      // Antigravity names no start: its first invocation binds the conversation.
      "const agy = agent === 'agy'",
      "const named = (event, fields) => agy ? { conversationId: session, workspacePaths: [process.cwd()], ...fields } : { hook_event_name: event, session_id: session, ...fields }",
      "const start = agy ? named('PreInvocation', { invocationNum: 0 }) : { hook_event_name: 'SessionStart', source: 'startup', session_id: session, cwd: process.cwd() }",
      // What the start hook printed (Antigravity's invocation takes its messages) is kept.
      "hook(agy ? 'PreInvocation' : 'SessionStart', start, (printed) => {",
      "  fs.writeFileSync(steps + '.start', printed)",
      '  console.log(agent + " ready")',
      "  next()",
      "})",
      "const next = () => {",
      "  const [name] = fs.readdirSync(steps).filter((file) => file.endsWith('.json')).sort()",
      "  if (!name) return setTimeout(next, 20)",
      "  const step = JSON.parse(fs.readFileSync(steps + '/' + name, 'utf8'))",
      "  fs.rmSync(steps + '/' + name)",
      "  const finish = (output) => {",
      "    fs.writeFileSync(step.out, output)",
      '    console.log("done " + require("node:path").basename(step.out))',
      "    next()",
      "  }",
      "  if (step.hook) hook(step.hook, named(step.hook, step.payload), finish)",
      "  else call(step.call, step.request, finish)",
      "}",
      "process.stdin.resume()",
    ].join("\n"),
  )
  writeFileSync(join(bin, "agent"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(join(bin, "agent"), 0o755)
  return bin
}

/**
 * Drives stand-in agents in a manager's terminals: `start` runs one there, and `queue`
 * gives it a step, whose output `step` also waits for and reads.
 */
export const driver = (shell: Fixture, manager: Terminals) => {
  const folder = (terminalId: string) => join(shell.home, `steps-${terminalId}`)
  let taken = 0
  const queue = (terminalId: string, fields: object): { name: string; out: string } => {
    const name = `step-${randomUUID().slice(0, 8)}`
    const out = join(shell.home, name)
    taken += 1
    const file = join(folder(terminalId), `${String(taken).padStart(4, "0")}.json`)
    writeFileSync(`${file}.tmp`, JSON.stringify({ ...fields, out }))
    renameSync(`${file}.tmp`, file)
    return { name, out }
  }
  return {
    queue,
    prepare: (terminalId: string) => mkdirSync(folder(terminalId), { recursive: true }),
    start: async (terminalId: string, agent: AgentName, session: string) => {
      mkdirSync(folder(terminalId), { recursive: true })
      manager.write(
        { terminalId, data: `agent ${agent} ${session} '${folder(terminalId)}'\r` },
        "owner",
      )
      await shell.until(manager, terminalId, `${agent} ready`)
    },
    step: async (terminalId: string, fields: object): Promise<string> => {
      const { name, out } = queue(terminalId, fields)
      await shell.until(manager, terminalId, `done ${name}`)
      return readFileSync(out, "utf8")
    },
  }
}

/** What a tool call told the agent: its text, or on a failure why. */
export type Told = { readonly ok: boolean; readonly text?: string; readonly reason?: string }

/** The id of the message a send told the agent it sent. */
export const messageId = (answer: Told): string | undefined =>
  /^Message (\S+) to /.exec(answer.text ?? "")?.[1]

/** What a send tells the agent of how its message reaches the recipient. */
export const reaches = (route: string) => expect.stringContaining(`it reaches them ${route}.`)

// A call to close a terminal, as Novadeck's MCP server sends it.
export const close = (to: string) => ({ type: "close" as const, request: { to } })

// What a close of the terminal in this place of a fresh session's list tells the agent.
export const closed = (number: number) => ({
  ok: true,
  text: `Closed @${handleWords[number - 1]} · Terminal.`,
})

/** What a prompt-time hook added to what Claude Code or Codex sees; nothing when it printed nothing. */
export const context = (printed: string): string =>
  printed
    ? (JSON.parse(printed) as { hookSpecificOutput: { additionalContext: string } })
        .hookSpecificOutput.additionalContext
    : ""

/**
 * A stand-in agent with a TUI of its own, run as `tui <agent> <session> <received> <raw>
 * [mode]`: an input box that takes typing (even while it works, as real TUIs keep
 * type-ahead) and bracketed pastes, submits on Enter when idle, and fires its hooks as a
 * harness does. It writes each prompt and what its prompt-time hook printed to
 * `received`, and every input it got to `raw` (one JSON line each); once a turn's Stop hook
 * returned, how many turns it finished to `<raw>.finished`. A signal starts a
 * turn by itself, as a background task's result does. `menu` opens a menu after its
 * first turn that swallows pastes; `perm` asks a permission in its second turn, then runs
 * the tool for a while; `bg` runs it in the background, starting a turn by itself;
 * `mouse` turns on mouse and focus reporting, as a fullscreen TUI does. It skips mouse and
 * focus reports, as such a TUI does. `named` is the same TUI under its harness's name, so
 * its hooks find its instance. `askafter` asks a permission after its first turn's Stop;
 * `askpaste` asks one as a paste comes after it, drawing the paste once told to; `asking`
 * puts a question in the Inbox after its first turn's Stop, `askbox` too, with Codex's own box
 * marker, so a prompt the runner gives it finds its box. `donecall` reports its task done after
 * its first turn's Stop. `askinglost` asks as `asking` does, and loses the answer of its second
 * turn's prompt hook (its output pipe closed before the relay prints), then makes a call of the
 * turn, whose hook's output goes to `<raw>.later`, unless `<raw>.nolater` exists.
 */
export const standInTui = (home: string): string => {
  const bin = join(home, "bin")
  mkdirSync(bin, { recursive: true })
  const script = join(bin, "tui.cjs")
  writeFileSync(
    script,
    String.raw`
const { spawn, spawnSync } = require("node:child_process")
const fs = require("node:fs")
const net = require("node:net")
${toolCall}
const [agent, session, received, raw, mode] = process.argv.slice(2)
// Capture job-control state only on failure: probing before raw mode changes the race.
const startupFailed = (error) => {
  const groups = spawnSync("ps", ["-o", "pid=,ppid=,pgid=,sess=,tpgid=,tty=,stat=", "-p", process.pid + "," + process.ppid], { encoding: "utf8", timeout: 1000 })
  const tty = spawnSync("stty", ["-a"], { stdio: [0, "pipe", "pipe"], encoding: "utf8", timeout: 1000 })
  fs.writeSync(2, "stand-in TUI startup failed: " + JSON.stringify({
    message: error.message, code: error.code, pid: process.pid, ppid: process.ppid,
    stdinTTY: process.stdin.isTTY, groups: groups.stdout, groupsError: groups.stderr,
    tty: tty.stdout, ttyError: tty.stderr,
  }) + "\n")
  process.exit(1)
}
// The session it runs, which /clear replaces with a new one.
let current = session
// The thread locks it holds open, as Codex does.
const held = []
fs.writeFileSync(raw + ".pid", String(process.pid))
// Claude Code names itself to its hooks, whatever an outer one left in the environment.
if (agent === "claude") process.env.CLAUDE_PID = String(process.pid)
const hook = (event, payload, done, lost = false) => {
  const child = spawn(process.env.NOVADECK_HOOK, [agent, event], { stdio: ["pipe", "pipe", "inherit"] })
  let printed = ""
  child.stdout.on("data", (chunk) => (printed += chunk))
  child.on("close", () => done(printed))
  // The answer lost: the relay finds nowhere to print it, so it never acknowledges it.
  if (lost) child.stdout.destroy()
  child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: current, cwd: process.cwd(), ...rollout, ...payload }))
}
// Asks a permission whose dialog Enter allows from the moment it is asked, as a TUI shows
// its dialog then, however long the request's hook takes to return; the tool's result
// follows the request's hook.
const ask = (input) => {
  const asked = new Promise((resolve) => hook("PermissionRequest", input, resolve))
  dialog = () => asked.then(() => hook("PostToolUse", { ...input, tool_response: {} }, () => {}))
}
// With "subabort" or "subagain", Codex's hooks name its rollout, filed by day as Codex files it.
const rollout =
  mode === "subabort" || mode === "subagain"
    ? { transcript_path: received + ".sessions/2026/10/03/rollout-2026-10-03T00-00-00-" + session + ".jsonl" }
    : {}
let box = ""
let last = ""
let dialog = null
let busy = true
let menu = false
let turns = 0
let pasteAsked = false
// With "askbox", Codex draws its own box marker, so a prompt given through the runner finds it.
const marker = mode === "askbox" && agent === "codex" ? "\u203a " : "> "
const draw = () => process.stdout.write(menu ? "\r\x1b[2K  [menu] pick an item" : "\r\x1b[2K" + marker + box)
// Antigravity's hooks name no prompt: it records what was typed in its transcript, as a
// USER_EXPLICIT USER_INPUT step, and what woke it by itself as a SYSTEM_MESSAGE one.
const transcript = received + ".transcript.jsonl"
let steps = 0
const step = (fields) =>
  fs.appendFileSync(
    transcript,
    JSON.stringify({ ...fields, step_index: steps++, created_at: new Date().toISOString() }) + "\n",
  )
const agy = { transcriptPath: transcript, workspacePaths: [process.cwd()] }
// With "shown" or "resumed", Codex announces its session only with its first prompt, as
// it does; Claude Code at its start.
const showing = mode === "shown" || mode === "shownbusy" || mode === "resumed"
let announced = !showing || agent === "claude"
const started = (prompt, typed, done) => {
  const lost = mode === "askinglost" && turns === 2
  if (agent !== "agy" && !announced) {
    announced = true
    const source = current !== session ? "clear" : mode === "resumed" ? "resume" : "startup"
    return hook("SessionStart", { source }, () =>
      hook("UserPromptSubmit", { prompt }, done),
    )
  }
  if (agent !== "agy") return hook("UserPromptSubmit", { prompt }, done, lost)
  if (typed) step({ source: "USER_EXPLICIT", type: "USER_INPUT", content: "<USER_REQUEST>\n" + prompt + "\n</USER_REQUEST>" })
  else step({ source: "SYSTEM", type: "SYSTEM_MESSAGE", content: prompt })
  hook("PreInvocation", { ...agy, conversationId: current, invocationNum: 0 }, done, lost)
}
const turn = (prompt, typed = true) => {
  dialog = null
  busy = true
  turns += 1
  const perm = mode === "perm" && turns === 2
  // With "slowhook", its second turn's hook reports after the doorbell's confirmation lapsed.
  const slow = mode === "slowhook" && turns === 2
  // With "latehook", its second turn's hook reports 1.5 s after the Enter, well within the
  // doorbell's confirmation.
  const latehook = mode === "latehook" && turns === 2
  // With "slowkick", a turn it starts by itself reports a while after it began, as a
  // loaded machine's hook does: it is busy, and ignores Enter, before Novadeck knows.
  const late = mode === "slowkick" && !typed
  setTimeout(() => started(prompt, typed, (printed) => {
    fs.appendFileSync(received, JSON.stringify({ prompt, printed }) + "\n")
    // With "shownbusy", each turn after its first keeps working.
    if (mode === "shownbusy" && turns > 1) return
    const finish = () => {
      process.stdout.write("\r\x1b[2Kworked on it\r\n")
      hook("Stop", agent === "agy" ? { ...agy, conversationId: current, fullyIdle: true } : {}, () => {
        busy = false
        menu = mode === "menu"
        draw()
        // Back at its prompt once its Stop hook returned, which may be well after Novadeck
        // heard the Stop: the turns it finished so, for the test to wait on.
        fs.writeFileSync(raw + ".finished", String(turns))
        // With "asking", its agent puts a question in the person's Inbox after its first
        // turn's Stop, and writes what Novadeck answered to <raw>.asked.
        if ((mode === "asking" || mode === "askbox" || mode === "askinglost") && turns === 1) {
          const request = { subject: "Which colour?", body: "Blue or green for the heading." }
          toolCall("ask", request, process.env.NOVADECK_REPORT_TOKEN, (answer) =>
            fs.writeFileSync(raw + ".asked", JSON.stringify(answer)),
          )
        }
        // With "donecall", its agent reports its task done after its first turn's Stop.
        if (mode === "donecall" && turns === 1)
          toolCall("done", { subject: "Shipped it", body: "All done." }, process.env.NOVADECK_REPORT_TOKEN, () => {})
        // With "askafter", a call asks a permission after its first turn's Stop, as a
        // background task's may: its dialog draws nothing, and Enter allows it, so only the
        // request's own resolution tells Novadeck it no longer waits.
        if (mode === "askafter" && turns === 1) {
          ask({ tool_name: "Bash", tool_input: { command: "ls" } })
        }
        // With "subabort", a spawned agent asks a permission after its first turn's Stop;
        // Esc on it fires no hook, and only its own rollout records the turn aborted.
        if (mode === "subabort" && turns === 1) {
          const spawned = { agent_id: "a1", agent_type: "default" }
          hook("SubagentStart", spawned, () =>
            hook("PermissionRequest", { ...spawned, tool_name: "Bash", tool_input: { command: "ls" } }, () => {}),
          )
        }
        // With "subagain", it asks again after each later turn's Stop, its thread still open
        // (no new SubagentStart): Enter allows that one.
        if (mode === "subagain") {
          const spawned = { agent_id: "a1", agent_type: "default" }
          const input = { ...spawned, tool_name: "Bash", tool_input: { command: "ls " + turns } }
          if (turns === 1)
            hook("SubagentStart", spawned, () => hook("PermissionRequest", input, () => {}))
          else ask(input)
        }
        // Antigravity's status line, which keeps running, names the conversation idle.
        if (agent === "agy" && showing)
          hook("StatusLine", { conversation_id: current, agent_state: "idle" }, () => {})
      })
    }
    if (mode === "perm2" && turns === 2) {
      // One tool runs, approved, while a second asks: a dialog Enter answers.
      const a = { command: "npm test" }
      const b = { command: "npm run lint" }
      return hook("PermissionRequest", { tool_name: "Bash", tool_input: a }, () => {
        process.stdout.write("\r\x1b[2Kapproved; running npm test\r\n")
        setTimeout(() =>
          hook("PermissionRequest", { tool_name: "Bash", tool_input: b }, () => {
            dialog = () => {
              process.stdout.write("\r\x1b[2Klint approved\r\n")
              hook("PostToolUse", { tool_name: "Bash", tool_input: b, tool_response: {} }, () =>
                hook("PostToolUse", { tool_name: "Bash", tool_input: a, tool_response: {} }, finish),
              )
            }
            process.stdout.write("\r\x1b[2K[dialog] allow npm run lint? (Enter)\r\n")
          }),
        1200)
      })
    }
    if (mode === "askinglost" && turns === 2 && !fs.existsSync(raw + ".nolater")) {
      // A call of the turn, after the lost answer: a tool's result, or Antigravity's next model call.
      const call = agent === "agy"
        ? ["PreInvocation", { ...agy, conversationId: current, invocationNum: 1 }]
        : ["PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: {} }]
      return setTimeout(() => hook(call[0], call[1], (printed) => {
        fs.writeFileSync(raw + ".later", printed)
        finish()
      }), 300)
    }
    if (!perm) return finish()
    const input = { command: "npm test" }
    hook("PermissionRequest", { tool_name: "Bash", tool_input: input }, () => {
      process.stdout.write("\r\x1b[2Kapproved; running npm test\r\n")
      setTimeout(() => hook("PostToolUse", { tool_name: "Bash", tool_input: input, tool_response: {} }, finish), 1500)
    })
  }), slow ? 6_000 : latehook ? 1_500 : late ? 800 : 0)
}
process.on("SIGUSR1", () => turn("background result", false))
// It exits by itself, as an agent that ends without a key from the person.
process.on("SIGUSR2", () => process.exit(0))
// It shows a thread it just started and locked other than its root, as a spawned agent's.
process.on("SIGURG", () => {
  // A title changed without a hook or key, as when Codex stops showing its prompt.
  if (fs.existsSync(raw + ".title"))
    return process.stdout.write("\x1b]0;" + fs.readFileSync(raw + ".title", "utf8") + "\x07")
  const agent = "0a6e0700" + current.slice(8)
  if (process.env.CODEX_HOME) {
    fs.mkdirSync(process.env.CODEX_HOME + "/thread-writer-locks", { recursive: true })
    held.push(fs.openSync(process.env.CODEX_HOME + "/thread-writer-locks/" + agent + ".lock", "w"))
  }
  process.stdout.write("\x1b]0;Ready | " + agent.slice(0, 29) + "...\x07")
})
if (mode !== "bg") {
  process.stdin.once("error", startupFailed)
  try { process.stdin.setRawMode(true) } catch (error) { startupFailed(error) }
  process.stdin.setEncoding("utf8")
  // One key at a time, as a terminal may hand over several in one read.
  const key = (data) => {
    // A mouse or focus report scrolls or moves; it types nothing.
    if (/^\x1b\[(?:<|[IO]$)/.test(data)) return
    if (menu) {
      if (data === "\r") fs.appendFileSync(received, JSON.stringify({ picked: true }) + "\n")
      return
    }
    // With "askfirst", a key answers its dialog, as a hotkey does.
    if (dialog && mode === "askfirst") {
      const answer = dialog
      dialog = null
      return answer()
    }
    // Ctrl-D quits, as an agent's exit does.
    if (data === "\x04") process.exit(0)
    // With "askpaste", a paste after its first turn's Stop makes it ask a permission, as a
    // background task's may, and the paste draws only once "<raw>.go" exists: the request
    // comes between a ring's test paste and its Enter, which its dialog would take.
    if (data.startsWith("\x1b[200~") && mode === "askpaste" && turns === 1 && !pasteAsked) {
      pasteAsked = true
      const pasted = data.slice(6, -6)
      const input = { tool_name: "Bash", tool_input: { command: "ls" } }
      return hook("PermissionRequest", input, () => {
        const go = () => {
          if (!fs.existsSync(raw + ".go")) return setTimeout(go, 20)
          box += pasted
          dialog = () => hook("PostToolUse", { ...input, tool_response: {} }, () => {})
          draw()
        }
        go()
      })
    }
    if (data.startsWith("\x1b[200~")) box += data.slice(6, -6)
    else if (data === "\r") {
      // A dialog takes Enter; a backslash before it makes it a newline in the box.
      if (dialog) {
        const answer = dialog
        dialog = null
        return answer()
      }
      if (box.endsWith("\\")) {
        box = box.slice(0, -1) + "\n"
        return draw()
      }
      // Busy, or an empty box: Enter submits nothing.
      if (busy || !box) return
      const prompt = box
      last = box
      box = ""
      process.stdout.write("\r\n")
      // With "askfirst", its second prompt asks a permission before its turn starts, and
      // the person's answer lets it start: the request clears with the turn.
      if (mode === "askfirst" && turns === 1) {
        busy = true
        return hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "ls" } }, () => {
          dialog = () => turn(prompt)
          process.stdout.write("\r\x1b[2K[dialog] allow ls? (1/2)\r\n")
        })
      }
      if (prompt === "/clear") return clear()
      // A /side conversation, which Codex forks without a writer lock, its title naming it.
      if (prompt === "/side") {
        draw()
        return process.stdout.write("\x1b]0;Ready | 0d1de200" + current.slice(8, 29) + "...\x07")
      }
      return turn(prompt)
    } else if (data === "\x1b\r") box += "\n"
    else if (data === "\x15") box = ""
    // Up recalls the last prompt, as a prompt's history does.
    else if (data === "\x1b[A") box = last
    else box += data
    draw()
  }
  process.stdin.on("data", (data) => {
    fs.appendFileSync(raw, JSON.stringify({ data, busy }) + "\n")
    for (const each of data.match(/\x1b\[200~[\s\S]*?\x1b\[201~|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[IO]|\x1b\r|\x1b\[A|[\s\S]/g) ?? []) key(each)
  })
}
// Mouse reporting of every motion, in SGR form, and focus reporting.
const reporting = mode === "mouse" ? "\x1b[?1003h\x1b[?1006h\x1b[?1004h" : ""
process.stdout.write("\x1b[?2004h" + reporting + agent + " tui\r\n\r\n")
const ready = () => {
  busy = false
  process.stdout.write(agent + " ready\r\n")
  draw()
  if (mode === "bg") setTimeout(() => turn("self-started", false), 300)
}
// /clear starts a new session at the prompt, which each harness tells its own way.
const clear = () => {
  current = "0c1ea200" + current.slice(8)
  draw()
  if (agent === "agy") return hook("StatusLine", { conversation_id: current, agent_state: "idle" }, () => {})
  if (agent === "codex" && showing) {
    announced = false
    // Codex writes and holds a lock for each thread it starts, as at /clear.
    if (process.env.CODEX_HOME) {
      fs.mkdirSync(process.env.CODEX_HOME + "/thread-writer-locks", { recursive: true })
      held.push(fs.openSync(process.env.CODEX_HOME + "/thread-writer-locks/" + current + ".lock", "w"))
    }
    return process.stdout.write("\x1b]0;Ready | " + current.slice(0, 29) + "...\x07")
  }
  hook("SessionStart", { source: "clear" }, () => {})
}
// With "shown", its prompt tells Novadeck it shows, before any session: Codex's title says
// Ready, Antigravity's status line says idle with no conversation yet.
if (showing && agent !== "claude") {
  ready()
  // A resumed conversation is named at once; a new one only with its first prompt.
  const conversation = mode === "resumed" ? current : ""
  if (agent === "agy") hook("StatusLine", { conversation_id: conversation, agent_state: "idle" }, () => {})
  else process.stdout.write("\x1b]0;Ready | " + session.slice(0, 29) + "...\x07")
}
// Claude Code resumed announces the session it resumes at once.
else if (mode === "resumed") hook("SessionStart", { source: "resume" }, ready)
// Antigravity has no SessionStart hook: its first model call binds it.
else if (agent === "agy") ready()
else hook("SessionStart", { source: "startup" }, ready)
`,
  )
  writeFileSync(join(bin, "tui"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(join(bin, "tui"), 0o755)
  // The same TUI under Codex's name, the program its hooks look for, and Antigravity's.
  const named = join(home, "named")
  mkdirSync(named, { recursive: true })
  // A real program of the harness's name, as Codex's native one under its npm wrapper and
  // Antigravity's are, running the TUI as its child: bash through a link named so, as a
  // script shows under its interpreter's name on macOS and Node renames its own process.
  // Both systems name a process after the path it was run by, link or not; a copy would
  // do too, but macOS kills a copy of its own signed /bin/bash. Its command doesn't end
  // the line, so bash runs it as a child rather than exec it.
  for (const agent of ["codex", "agy"]) {
    symlinkSync(bash, join(named, agent))
    const launcher = join(bin, agent === "codex" ? "named" : "named-agy")
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec "${join(named, agent)}" -c '"$0" "$@"; exit $?' "${process.execPath}" "${script}" "$@"\n`,
    )
    chmodSync(launcher, 0o755)
  }
  return bin
}

/** One JSON object per line of a file the stand-in TUI writes; none before it does. */
export const lines = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T)
    : []

/** A sender and an idle stand-in TUI, in a manager whose doorbell rings soon. */
export const ringing = async (
  shell: Fixture,
  mode = "",
  program = "tui",
  agent: AgentName = "codex",
  session = `s-${agent}`,
  hooksTrusted: boolean | (() => Promise<boolean | undefined>) = true,
  // A command the idle terminal runs first, as a nested shell.
  first?: string,
  // A command it runs after the TUI exits, with no shell prompt between them.
  after?: string,
) => {
  const bin = standIn(shell.home)
  standInTui(shell.home)
  const manager = shell.manager({
    env: {
      HOME: shell.home,
      PS1: "$ ",
      PATH: `${bin}:${process.env.PATH}`,
      CODEX_HOME: join(shell.home, ".codex"),
    },
    doorbell: { calmMs: 200, settleMs: 300, watchMs: 100, boxCheck: false },
    hooksTrusted:
      typeof hooksTrusted === "boolean" ? () => Promise.resolve(hooksTrusted) : hooksTrusted,
  })
  const sender = await create(manager, shell)
  const idle = await create(manager, shell)
  const { start, step } = driver(shell, manager)
  await start(sender.id, "claude", "s-claude")
  const received = join(shell.home, "received.jsonl")
  const raw = join(shell.home, "raw.jsonl")
  const type = (data: string) => manager.write({ terminalId: idle.id, data }, "owner")
  if (first) type(`${first}\r`)
  type(
    `${program} ${agent} ${session} '${received}' '${raw}' ${mode}${mode === "bg" ? " &" : ""}${after ? `; ${after}` : ""}\r`,
  )
  await shell.until(manager, idle.id, `${agent} ready`)
  const finished = () =>
    existsSync(`${raw}.finished`) ? Number(readFileSync(`${raw}.finished`, "utf8")) : 0
  // Novadeck hears a Stop as its hook starts, but the TUI takes keys again only once the
  // hook returned, Novadeck's answer printed, and a loaded machine may take a while for
  // that: an Enter typed before then submits nothing.
  const back = (turns: number) =>
    vi.waitFor(() => expect(finished()).toBeGreaterThanOrEqual(turns), { timeout: 10_000 })
  return {
    manager,
    idle,
    type,
    received: () => lines<{ prompt: string; printed: string; picked?: true }>(received),
    // What the TUI got, after its first prompt.
    raw: () => lines<{ data: string; busy: boolean }>(raw).map(({ data }) => data),
    delivery: () => manager.messages(idle.id).delivery,
    send: (text: string) =>
      step(sender.id, { call: "send", request: { to: idle.handle, text } }).then(
        (answer) => JSON.parse(answer) as Told,
      ),
    // Starts a turn by itself, as a background task's result does.
    kick: () => process.kill(Number(readFileSync(`${raw}.pid`, "utf8")), "SIGUSR1"),
    // It exits by itself.
    leave: () => process.kill(Number(readFileSync(`${raw}.pid`, "utf8")), "SIGUSR2"),
    // Waits until it is back at its prompt, `turns` turns finished in all.
    back,
    // It shows another thread it just started, as a spawned agent's.
    spawn: () => process.kill(Number(readFileSync(`${raw}.pid`, "utf8")), "SIGURG"),
    title: (title: string) => {
      writeFileSync(`${raw}.title`, title)
      process.kill(Number(readFileSync(`${raw}.pid`, "utf8")), "SIGURG")
    },
    // The person's own first prompt, which settles it.
    first: async () => {
      const turns = finished()
      type("hello")
      await shell.until(manager, idle.id, "> hello")
      type("\r")
      // The turn's hooks may take a while on a loaded machine (macOS CI).
      await expect
        .poll(() => manager.messages(idle.id).delivery, { timeout: 10_000 })
        .toBe("settled")
      await back(turns + 1)
    },
  }
}

/**
 * Antigravity's first turn, one it started by itself: Novadeck reads its transcript there,
 * so the person's next typed entry is told new by its step, not by its time.
 */
export const agyStarted = async (tui: Awaited<ReturnType<typeof ringing>>) => {
  tui.kick()
  await vi.waitFor(() => expect(tui.received()).toHaveLength(1), { timeout: 10_000 })
  await expect.poll(tui.delivery, { timeout: 10_000 }).toBe("settled")
  await tui.back(1)
}
