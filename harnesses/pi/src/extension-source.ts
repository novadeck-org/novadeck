/**
 * The JavaScript of Novadeck's pi extension, as the shim has pi load it per launch (`-e <file>`):
 * pi keeps no hook commands of its own, only extensions, which run in its process and hear its
 * events. This one runs Novadeck's hook command for each event Novadeck reads, as the other
 * harnesses run theirs, so the relay and the runner see the same reports; and gives pi
 * Novadeck's tools as tools of its own (`model-only`), from Novadeck's MCP server, which it
 * speaks to as a client: pi's codemode "only" mode, a person's MCP replacement, `--no-mcp` and a
 * `--tools` list that filters `mcp__*` all leave such a tool declared (probed 2026-11-24, 1.6.0).
 * Nothing of the person's pi is written: their settings, extensions and sessions load as ever.
 *
 * It is data until rendered: `extensionSource` puts in the commands and settings of one platform.
 * Everything it does is guarded, as a handler that throws is reported on pi's screen.
 */

/** What one rendering of the extension holds. */
export type ExtensionConfig = {
  /** Novadeck's hook command for each event, in the platform's shell. */
  readonly hooks: Readonly<Record<string, string>>
  /** How long a hook may run before the extension stops waiting, in milliseconds. */
  readonly hookMs: number
  /** Novadeck's MCP server, as a stdio program: its program and arguments. */
  readonly mcp: readonly string[]
  /** The folder of agents' worktrees, whose project trust the extension may answer. */
  readonly worktrees: string | null
  /** The oldest pi the extension works with; older, it does nothing at all. */
  readonly minimum: string
  /** The first release it doesn't know (pi 2); from it on, it does nothing at all. */
  readonly unknownFrom: string
  /** The prefix of Novadeck's tools' names as pi declares them (`novadeck_send`). */
  readonly prefix: string
  /**
   * The folder beside the extension where it marks each run's end, a file per session
   * (`stopped/<session>.jsonl`), which pi's watch follows.
   */
  readonly stoppedFolder: string
  /**
   * The variable its hook commands are given pi's own pid in (the harness's `pidVariable`), as
   * Claude Code gives `CLAUDE_PID`: the relay names the agent that ran a hook by it, as on
   * Windows pi runs as `node.exe`, and its title (`process.title`) names no process.
   */
  readonly pidVariable: string
  /**
   * The most deliveries a run's Stops may continue it with, against a runaway; past them its Stop
   * asks for none (StopHeld).
   */
  readonly continueCap: number
  /**
   * The shipping gate (Experimental) is on: a shell call's PreToolUse waits for the runner's
   * answer, and is refused where it says so. Absent otherwise.
   */
  readonly gate?: boolean
}

/** The extension's module for `config`, as pi loads it (through jiti, which maps pi's packages). */
export const extensionSource = (config: ExtensionConfig): string =>
  `// Novadeck's extension for pi. Written by Novadeck into its own data directory and
// overwritten on each start; pi loads it only in Novadeck's terminals, for one launch.
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
// Imported whole, statically: pi maps these names to its own copies only for a static import
// (a dynamic one goes to Node's own loader, which can't find them), and a release that lacks a
// name leaves it undefined rather than failing the load.
import * as piAgent from "@earendil-works/pi-coding-agent"
import * as piAi from "@earendil-works/pi-ai"

const config = ${JSON.stringify(config)}
${body}`

// The extension's code, the same on every platform.
const body = String.raw`
const here = dirname(fileURLToPath(import.meta.url))

// Whether version a is older than b, by their numbers.
const older = (a, b) => {
  const parts = (v) => String(v).split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]
  return false
}

// A text cut to its first length characters, for what a payload only needs the start of.
const cut = (text, length) => (typeof text === "string" && text.length > length ? text.slice(0, length) : text)

// The text blocks of a message's content, together.
const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((part) => part && part.type === "text")
          .map((part) => part.text)
          .join("\n")
      : ""

// Runs Novadeck's hook command for event with payload on its input, and gives what it printed;
// nothing outside Novadeck's terminals, nor where it fails or runs past its time.
const hook = (event, payload) =>
  new Promise((done) => {
    const command = config.hooks[event]
    if (!command || !process.env.NOVADECK_HOOK) return done("")
    let out = ""
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(out)
    }
    let child
    try {
      child = spawn(command, {
        shell: true,
        // pi's own process, by which the relay names the agent that ran the hook.
        env: { ...process.env, [config.pidVariable]: String(process.pid) },
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      })
    } catch {
      return done("")
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      settle()
    }, config.hookMs)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      out += chunk
    })
    child.on("error", settle)
    child.on("close", settle)
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify({ hook_event_name: event, ...payload }))
  })

// The words pi was started with, for a SessionStart: it names its process "pi" (process.title),
// which leaves the relay none to read, while its own argv keeps them. Only while they reach the
// runner whole, as it keeps at most 50 of a list and may cut a text past 200 characters: past that,
// none, so the runner keeps what it had. An --api-key's value never leaves pi: it goes as "", as
// no flag a resume gives back needs it.
const argv = process.argv
  .slice(2)
  .map((word, at, words) =>
    words[at - 1] === "--api-key" ? "" : word.startsWith("--api-key=") ? "--api-key=" : word,
  )
const launch = argv.length <= 50 && argv.every((word) => word.length <= 200) ? { argv } : {}

// An answer's JSON, from the last line of what the hook printed that is JSON: the relay prints
// its answer as one line, last, and anything printed before it (a Windows shell's AutoRun, a
// profile) is not part of it, so it can't hide a deny.
const answerOf = (text) => {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (const line of lines.reverse()) {
    try {
      const found = JSON.parse(line)
      if (found && typeof found === "object") return found
    } catch {}
  }
  return {}
}

// The delivery an answer carries, where it carries one.
const delivery = (text) => {
  const answer = answerOf(text)
  return typeof answer.deliver === "string" && answer.deliver !== "" ? answer.deliver : undefined
}

// What an answer refuses a call with, where it does: the words the relay prints for a deny.
const refusal = (text) => {
  const answer = answerOf(text)
  return answer.decision === "deny" && typeof answer.reason === "string" && answer.reason !== ""
    ? answer.reason
    : undefined
}

// Reports one after another, in the order they came, as the relay stamps each as it starts.
let queue = Promise.resolve("")
const report = (event, payload) => {
  const next = queue.then(() => hook(event, payload))
  queue = next.catch(() => "")
  return next
}

// Novadeck's MCP server, spoken to over its stdio as an MCP client, one line of JSON-RPC each
// way. Started when a session lists its tools, stopped as the session's runtime ends (pi starts
// the extension again for each session: /new, /resume, /fork, /reload).
const mcpClient = () => {
  let child
  let buffer = ""
  let next = 1
  let ready
  const pending = new Map()
  const fail = () => {
    for (const waiter of pending.values()) waiter.reject(new Error("Novadeck's tools stopped"))
    pending.clear()
    child = undefined
    ready = undefined
  }
  const read = (chunk) => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = message.id === undefined ? undefined : pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message || "Novadeck's tool failed"))
      else waiter.resolve(message.result)
    }
  }
  const start = () => {
    buffer = ""
    child = spawn(config.mcp[0], config.mcp.slice(1), { stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", read)
    child.on("error", fail)
    child.on("close", fail)
    child.stdin.on("error", () => {})
  }
  const send = (message) => {
    try {
      child?.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
    } catch {}
  }
  const request = (method, params, signal) =>
    new Promise((resolve, reject) => {
      if (!child) start()
      const id = next++
      pending.set(id, { resolve, reject })
      send({ id, method, params })
      signal?.addEventListener(
        "abort",
        () => {
          if (!pending.has(id)) return
          pending.delete(id)
          send({ method: "notifications/cancelled", params: { requestId: id, reason: "aborted" } })
          reject(new Error("aborted"))
        },
        { once: true },
      )
    })
  const open = () =>
    (ready ??= request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "novadeck-pi", version: "1" },
    }).then(() => send({ method: "notifications/initialized" })))
  return {
    list: async () => {
      await open()
      return (await request("tools/list", {}))?.tools ?? []
    },
    call: async (name, args, signal) => {
      await open()
      return request("tools/call", { name, arguments: args ?? {} }, signal)
    },
    close: () => {
      try {
        child?.stdin.end()
        child?.kill()
      } catch {}
      fail()
    },
  }
}

// A content block of an MCP tool's result, as pi takes a tool's: text, or an image.
const blockOf = (block) =>
  block && block.type === "image" && typeof block.data === "string"
    ? { type: "image", data: block.data, mimeType: block.mimeType || "image/png" }
    : { type: "text", text: block && typeof block.text === "string" ? block.text : JSON.stringify(block) }

// Whether two paths name one folder, as pi compares them: without case on Windows.
const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b)

// Whether folder lies inside root, not at it.
const inside = (folder, root) => {
  const rel = relative(resolve(root), resolve(folder))
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

// A worktree's main checkout: its .git file names <main>/.git/worktrees/<name>.
const mainOf = (folder) => {
  try {
    const named = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(folder, ".git"), "utf8"))
    if (!named) return undefined
    return dirname(resolve(folder, named[1].trim(), "..", ".."))
  } catch {
    return undefined
  }
}

// A path as pi keys its trust decisions by: links resolved where it is there (its
// canonicalizePath, 1.6.0), else as written.
const real = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

// pi's own trust decisions (its trust.json), by their paths made real. Only read: Novadeck never
// writes it.
const trustStore = () => {
  try {
    const moved = process.env.PI_CODING_AGENT_DIR
    const agentDir = moved ? resolve(moved.replace(/^~(?=$|[\\/])/, homedir())) : join(homedir(), ".pi", "agent")
    const data = JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf8"))
    return Object.entries(data)
      .filter(([, value]) => value === true || value === false)
      .map(([key, value]) => [real(key), value])
  } catch {
    return []
  }
}

// The decision pi keeps for folder itself, if any.
const decisionOn = (store, folder) => store.find(([key]) => same(key, folder))?.[1]

// Whether pi trusts folder, as the nearest folder at or above it with a decision says (its
// trust-manager.ts, 1.6.0).
const trusts = (store, folder) => {
  let at = folder
  while (true) {
    const decided = decisionOn(store, at)
    if (decided !== undefined) return decided
    const up = dirname(at)
    if (up === at) return false
    at = up
  }
}

export default function novadeck(pi) {
  if (!process.env.NOVADECK_HOOK) return
  const version = typeof piAgent.VERSION === "string" ? piAgent.VERSION : undefined
  // Nothing to report: the runner reads the version itself (limited.ts) and says so.
  if (version !== undefined && (older(version, config.minimum) || !older(version, config.unknownFrom))) return

  const tools = mcpClient()
  // What the run so far said: its latest answer's words and error, whether its Stop was told,
  // and how many deliveries its Stop has continued it with.
  let reply = null
  let failure = null
  let stopped = false
  let continued = 0
  // The person's prompt pi is about to start a run with, as they gave it (before pi expands a
  // skill or template), told as that run starts (before_agent_start), so a delivery goes in with
  // that run alone: a prompt whose run never starts (no model or key, /new) asks for none.
  let given = null
  // Whether the latest prompt was an extension's own (pi.sendUserMessage), which is no person's.
  let fromExtension = false
  // Prompts the person gave while a run went on, told as given (queued): pi queues one only once
  // every extension's input handler returned, so while a person's own slow one runs nothing
  // shows queued. When an Escape stops the run first, such a prompt starts a run of its own once
  // its handlers are done; Novadeck gives it back to the box instead, as pi gives back what it
  // had queued (probed 2026-11-24, 1.6.0).
  const inFlight = []
  let abortedAt = 0
  // A run started only to be given back, whose end is no turn's.
  let givingBack = false
  // What such runs left in the session (the prompt and its aborted answer, by their times),
  // which the model reads no more.
  const givenBack = new Set()
  // Extension dialogs, numbered in this process: the one showing, if any.
  let dialogs = 0
  let dialog = null

  const where = (ctx) => {
    try {
      return {
        session_id: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        transcript_path: ctx.sessionManager.getSessionFile() ?? null,
      }
    } catch {
      return { session_id: null }
    }
  }
  const modelOf = (ctx) => {
    try {
      return { model: ctx.model ? ctx.model.provider + "/" + ctx.model.id : null, effort: ctx.thinkingLevel ?? null }
    } catch {
      return { model: null, effort: null }
    }
  }

  // A worktree of Novadeck's, of a project whose main checkout pi trusts already: trusted for
  // this process alone, never remembered. Any other folder is left to pi and the person.
  pi.on("project_trust", (event) => {
    try {
      if (config.worktrees && inside(real(event.cwd), real(config.worktrees))) {
        const main = mainOf(event.cwd)
        const store = trustStore()
        // Never over the person's own "do not trust" for this very worktree.
        if (main && decisionOn(store, real(event.cwd)) !== false && trusts(store, real(main)))
          return { trusted: "yes" }
      }
    } catch {}
    return { trusted: "undecided" }
  })

  pi.on("session_start", async (event, ctx) => {
    // A reload starts the extension again in the same session: nothing to bind anew.
    if (event.reason === "reload") return registerTools()
    try {
      const at = where(ctx)
      // At startup, a session whose file is there already was given to resume (--session,
      // --continue); a new one's file is written with its first message.
      const source =
        event.reason === "startup" ? (at.transcript_path && existsSync(at.transcript_path) ? "resume" : "startup") : event.reason
      reply = null
      failure = null
      stopped = false
      continued = 0
      await report("SessionStart", { ...at, source, version: version ?? null, ...modelOf(ctx), ...launch })
      writeModels(ctx)
    } catch {}
    await registerTools()
  })

  // The models pi can run here, with the efforts each takes, for Novadeck's model picker.
  const writeModels = (ctx) => {
    try {
      const levels = piAi.getSupportedThinkingLevels
      const models = ctx.modelRegistry.getAvailable().map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name || model.id,
        levels: typeof levels === "function" ? levels(model) : [],
      }))
      writeFileSync(join(here, "models.json"), JSON.stringify(models) + "\n")
    } catch {}
  }

  // Novadeck's tools, as its server lists them for this session, given to pi as its own.
  const registerTools = async () => {
    try {
      for (const tool of await tools.list()) {
        if (!tool || typeof tool.name !== "string") continue
        pi.registerTool({
          name: config.prefix + tool.name,
          label: tool.name,
          description: typeof tool.description === "string" ? tool.description : "",
          parameters: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
          // Declared to the model and called by it alone: codemode's "only" mode hides every tool
          // its scripts may call, never these.
          exposure: "model-only",
          async execute(_id, params, signal) {
            const result = await tools.call(tool.name, params, signal)
            const content = Array.isArray(result?.content) ? result.content.map(blockOf) : []
            // A failed call is the model's to read, as its error.
            if (result?.isError) throw new Error(textOf(result.content) || "Novadeck's " + tool.name + " failed")
            return { content, details: {} }
          },
        })
      }
    } catch {}
  }

  pi.on("session_compact", async (_event, ctx) => {
    try {
      await report("SessionStart", { ...where(ctx), source: "compact", version: version ?? null, ...launch })
    } catch {}
  })

  pi.on("session_shutdown", () => {
    tools.close()
  })

  const promptReport = (ctx, text, images, queued) =>
    report("UserPromptSubmit", {
      ...where(ctx),
      prompt: cut(text, 100000),
      images,
      // Given while a run goes on: queued, which the person may still take back (Alt+Up, or an
      // abort returns it to the box), so the runner delivers nothing with it.
      queued,
      ...modelOf(ctx),
    })

  pi.on("input", async (event, ctx) => {
    try {
      // The extensions' own prompts aren't the person's.
      fromExtension = event.source === "extension"
      if (fromExtension) return
      const text = event.text ?? ""
      const images = Array.isArray(event.images) ? event.images.length : 0
      if (!event.streamingBehavior) {
        given = { text, images }
        return
      }
      inFlight.push({ text, at: Date.now() })
      const delivered = delivery(await promptReport(ctx, text, images, event.streamingBehavior))
      // Queued after the prompt itself, which pi queues once the handlers return.
      if (delivered)
        setTimeout(() => {
          try {
            pi.sendMessage({ customType: "novadeck", content: delivered, display: true }, { deliverAs: event.streamingBehavior })
          } catch {}
        }, 0)
    } catch {}
  })

  // A run starting with the person's prompt: told now, its delivery going in with it, as a
  // message of Novadeck's after the person's.
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      // A run a custom message started (pi.sendMessage with triggerTurn, 1.2.0 on) is no prompt's;
      // before 1.2.0 the event has no messageType and fires for prompts alone.
      if (event.messageType !== undefined && event.messageType !== "user") return
      const text = typeof event.prompt === "string" ? event.prompt : ""
      const queued = inFlight.findIndex((one) => one.text === text)
      if (queued >= 0) {
        const [one] = inFlight.splice(queued, 1)
        // Given while a run went on that an Escape stopped before it went in: back to the box,
        // after what is there, as pi joins what it gives back. Its run stops before any model call.
        if (one.at < abortedAt) {
          givingBack = true
          ctx.abort()
          const box = ctx.ui?.getEditorText?.() ?? ""
          ctx.ui?.setEditorText?.([box, one.text].filter((part) => part.trim()).join("\n\n"))
        }
        // Told as it was queued.
        return
      }
      if (fromExtension) return
      const prompt = given ?? { text, images: Array.isArray(event.images) ? event.images.length : 0 }
      given = null
      const delivered = delivery(await promptReport(ctx, prompt.text, prompt.images, null))
      if (delivered) return { message: { customType: "novadeck", content: delivered, display: true } }
    } catch {}
  })

  // A queued prompt that went in: no longer waiting.
  pi.on("message_start", (event) => {
    const message = event.message
    if (!message) return
    // Its prompt and its aborted answer; never the system prompt pi writes beside them.
    if (givingBack && (message.role === "user" || message.role === "assistant") && typeof message.timestamp === "number") {
      givenBack.add(message.timestamp)
      return
    }
    if (message.role !== "user" || inFlight.length === 0) return
    const said = textOf(message.content)
    const at = inFlight.findIndex((one) => one.text === said)
    if (at >= 0) inFlight.splice(at, 1)
  })

  // What a run given back left in the session, out of what the model reads.
  pi.on("context", (event) => {
    if (givenBack.size === 0 || !Array.isArray(event.messages)) return
    const kept = event.messages.filter((message) => !givenBack.has(message?.timestamp))
    if (kept.length !== event.messages.length) return { messages: kept }
  })

  pi.on("agent_start", () => {
    stopped = false
  })

  pi.on("message_end", (event) => {
    const message = event.message
    if (!message || message.role !== "assistant") return
    const said = textOf(message.content)
    if (said) reply = cut(said, 2000)
    failure =
      message.stopReason === "error"
        ? { name: "error", message: cut(message.errorMessage || "error", 2000) }
        : message.stopReason === "aborted"
          ? { name: "aborted", message: null }
          : null
  })

  pi.on("tool_call", async (event, ctx) => {
    let refused
    try {
      const answer = report("PreToolUse", {
        ...where(ctx),
        tool_name: event.toolName,
        call_id: event.toolCallId,
        parent_call_id: event.parentToolCallId ?? null,
        tool_input: event.input,
      })
      // The gate judges each shell call, a codemode script's own ones too, and never a script's
      // text, which only names them.
      if (config.gate && (event.toolName === "bash" || event.toolName === "powershell")) refused = refusal(await answer)
    } catch {}
    // The reason is the call's result, which the model reads, and the run goes on.
    if (refused) return { block: true, reason: refused }
  })

  pi.on("tool_result", async (event, ctx) => {
    try {
      // A call a codemode script made asks for no delivery: it would wait for the whole script.
      const nested = Boolean(event.parentToolCallId)
      const answer = await report(nested ? "NestedToolUse" : "PostToolUse", {
        ...where(ctx),
        tool_name: event.toolName,
        call_id: event.toolCallId,
        parent_call_id: event.parentToolCallId ?? null,
        tool_input: event.input,
        is_error: event.isError === true,
      })
      const text = delivery(answer)
      if (text && !nested)
        pi.sendMessage({ customType: "novadeck", content: text, display: true }, { deliverAs: "steer" })
    } catch {}
  })

  // That a Stop was told, however its hook fared, in a file of Novadeck's own beside the
  // extension (never the person's session file, which keeps only what pi and they put there),
  // a line for each Stop, a continued one's too, as Claude Code writes a stop_hook_summary for
  // each: a turn whose report never reached Novadeck still ends (transcript-watch.ts reads it).
  const mark = (ctx, aborted) => {
    try {
      const id = ctx.sessionManager.getSessionId()
      if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(id)) return
      mkdirSync(join(here, config.stoppedFolder), { recursive: true })
      appendFileSync(
        join(here, config.stoppedFolder, id + ".jsonl"),
        JSON.stringify({
          type: "stopped",
          session_id: id,
          at: Date.now(),
          error: aborted ? "aborted" : failure ? failure.name : null,
        }) + "\n",
      )
    } catch {}
  }

  const stop = async (ctx, aborted, held = false) => {
    stopped = true
    let usage = null
    try {
      const used = ctx.getContextUsage()
      if (used) usage = { tokens: used.tokens ?? null, window: used.contextWindow ?? null, ...modelOf(ctx) }
    } catch {}
    // Past the cap, the Stop is told under a name the relay asks nothing at, so no message is
    // leased to it: what waits stays for the doorbell.
    const answer = await report(held ? "StopHeld" : "Stop", {
      ...where(ctx),
      last_assistant_message: reply,
      error: aborted ? { name: "aborted", message: null } : failure,
      usage,
      continued,
    })
    mark(ctx, aborted)
    return answer
  }

  // A run's end, while it can still go on: a delivery continues it, in the same run, as Claude
  // Code's Stop hook can. The runner leases each message once, so the next Stop brings nothing
  // new; past its cap (config.continueCap) the Stop asks for none, against a runaway.
  pi.on("agent_before_settle", async (event, ctx) => {
    try {
      const held = continued >= config.continueCap
      const text = delivery(await stop(ctx, false, held))
      if (!text || held) return
      continued++
      return {
        entries: [...event.entries, { type: "custom_message", customType: "novadeck", content: text, display: true }],
        continue: true,
      }
    } catch {}
  })

  pi.on("agent_settled", async (event, ctx) => {
    const aborted = event.aborted === true
    // A run started only to be given back ends no turn.
    if (givingBack) {
      givingBack = false
      stopped = false
      return
    }
    try {
      if (aborted) {
        abortedAt = Date.now()
        // What pi itself gave back (it had queued them) is in the box already; the prompts still
        // in a person's input handler come back as their runs start (before_agent_start). The
        // turn's end is told once they are back, so what reads the box then finds them.
        const box = ctx.ui?.getEditorText?.() ?? ""
        for (let at = inFlight.length - 1; at >= 0; at -= 1) if (box.includes(inFlight[at].text)) inFlight.splice(at, 1)
        const until = Date.now() + 10_000
        while (inFlight.some((one) => one.at < abortedAt) && Date.now() < until)
          await new Promise((done) => setTimeout(done, 50))
      }
      // An aborted run skips agent_before_settle: its Stop is told here, with nothing to deliver.
      if (!stopped) await stop(ctx, aborted)
    } catch {}
    reply = null
    failure = null
    continued = 0
  })

  // A dialog of an extension's (the person's own: pi has none of its own), shown and gone. Its
  // title alone comes with it; the screen holds its options. Nested ones come as one.
  pi.on("ui_prompt_start", async (event, ctx) => {
    try {
      if (event.kind === "custom") return
      dialog = { request_id: "ui-" + ++dialogs, kind: event.kind, title: cut(event.title ?? "", 2000) }
      await report("DialogShown", { ...where(ctx), ...dialog })
    } catch {}
  })

  pi.on("ui_prompt_end", async (_event, ctx) => {
    try {
      if (!dialog) return
      const ended = dialog
      dialog = null
      await report("DialogEnded", { ...where(ctx), ...ended })
    } catch {}
  })
}
`
