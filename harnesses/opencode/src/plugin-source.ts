/**
 * The JavaScript of Novadeck's opencode plugin, as the shim has opencode load it per launch
 * (`OPENCODE_CONFIG_CONTENT`'s `plugin`, or a `plugins` folder in `OPENCODE_CONFIG_DIR`):
 * opencode keeps no hook commands of its own, only plugins, which run in its process and hear
 * its events. This one runs Novadeck's hook command for each event Novadeck reads, as the
 * other harnesses run theirs, so the relay and the runner see the same reports; writes the
 * session's transcript beside itself, from opencode's own records; and adds Novadeck's MCP
 * server, its tools allowed, to the configuration opencode loaded, never to a file of the
 * person's.
 *
 * It is data until rendered: `pluginSource` puts in the commands and settings of one platform.
 * Everything it does is guarded, as a plugin that throws takes opencode's hook with it.
 */

/** What one rendering of the plugin holds. */
export type PluginConfig = {
  /** Novadeck's hook command for each event, in the platform's shell. */
  readonly hooks: Readonly<Record<string, string>>
  /** How long a hook may run before the plugin stops waiting, in milliseconds. */
  readonly hookMs: number
  /** Novadeck's MCP server, as opencode starts a local one: its program and arguments. */
  readonly mcp: readonly string[]
  /** The folder of agents' worktrees, which a session may write in as in its own. */
  readonly worktrees: string | null
  /** The oldest opencode the plugin works with; older, it does nothing at all. */
  readonly minimum: string
  /** The first release it doesn't know (opencode 2); from it on, it does nothing at all. */
  readonly unknownFrom: string
}

/** The plugin's module for `config`, as opencode imports it. */
export const pluginSource = (config: PluginConfig): string =>
  `// Novadeck's plugin for opencode. Written by Novadeck into its own data directory and
// overwritten on each start; opencode loads it only in Novadeck's terminals, for one launch.
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const config = ${JSON.stringify(config)}
${body}`

// The plugin's code, the same on every platform.
const body = String.raw`
const sessions = join(dirname(fileURLToPath(import.meta.url)), "sessions")

// Whether version a is older than b, by their numbers.
const older = (a, b) => {
  const parts = (v) => String(v).split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]
  return false
}

// The folder opencode runs the session in, and its project's root ("/" outside a git
// repository), which every report names.
let folder = null
let root = null

// Runs Novadeck's hook command for event with payload on its input, and gives what it printed;
// nothing outside Novadeck's terminals, nor where it fails or runs past its time.
const hook = (event, payload) =>
  new Promise((resolve) => {
    const command = config.hooks[event]
    if (!command || !process.env.NOVADECK_HOOK) return resolve("")
    let out = ""
    let done = false
    const settle = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(out)
    }
    let child
    try {
      child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
    } catch {
      return resolve("")
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
    child.stdin.end(JSON.stringify({ hook_event_name: event, cwd: folder, worktree: root, ...payload }))
  })

// The delivery an answer carries, where it carries one.
const delivery = (text) => {
  try {
    const answer = JSON.parse(text.trim() || "{}")
    return typeof answer.deliver === "string" && answer.deliver !== "" ? answer.deliver : undefined
  } catch {
    return undefined
  }
}

// Reports one after another, in the order they came, as the relay stamps each as it starts.
let queue = Promise.resolve("")
const report = (event, payload) => {
  const next = queue.then(() => hook(event, payload))
  queue = next.catch(() => "")
  return next
}

// A text cut to its first length characters, for what a payload only needs the start of.
const cut = (text, length) => (typeof text === "string" && text.length > length ? text.slice(0, length) : text)

// Whether a part of a message is final: opencode updates a part as it streams, and the
// transcript keeps each once, whole.
const settled = (part) => {
  if (!part || typeof part !== "object") return false
  if (part.type === "text" || part.type === "reasoning") return !part.time || part.time.end !== undefined
  if (part.type === "tool") return part.state?.status === "completed" || part.state?.status === "error"
  return true
}

export const NovadeckPlugin = async ({ client, directory, worktree }) => {
  if (!process.env.NOVADECK_HOOK) return {}
  folder = directory ?? null
  root = worktree ?? null
  let version
  try {
    // The SDK a plugin is given has no call for it, but its client reaches the route.
    const health = await client._client.get({ url: "/global/health" })
    version = health?.data?.version
  } catch {}
  if (typeof version === "string" && (older(version, config.minimum) || !older(version, config.unknownFrom))) {
    report("Outdated", { version, minimum: config.minimum, unknown_from: config.unknownFrom })
    return {}
  }
  try {
    mkdirSync(sessions, { recursive: true })
  } catch {}

  // What the plugin knows of each session: its parent, for a subagent's; and of the root
  // turns, what the latest said.
  const parents = new Map()
  const bound = { root: null }
  const turns = new Map()
  const written = new Set()
  const backfilled = new Set()
  // A subagent's type, as the task call that starts it names it, by the parent session.
  const kinds = new Map()
  // Sessions whose next prompt is the plugin's own, a Stop's delivery.
  const continuing = new Set()
  // Sessions working since they last went idle.
  const busy = new Set()
  // The tool of each call, by its id, as a question names only the call that asks it.
  const calls = new Map()
  // The tool of each question waiting, by its id, for its reply.
  const asking = new Map()
  // Each session's latest answer's model and tokens, and each model's context window, as
  // opencode's providers list them, asked once.
  const usage = new Map()
  let windows
  const windowOf = async (provider, model) => {
    try {
      windows ??= client.config.providers().then((found) => {
        const sizes = new Map()
        for (const one of found?.data?.providers ?? [])
          for (const [id, info] of Object.entries(one.models ?? {})) sizes.set(one.id + "/" + id, info?.limit?.context ?? null)
        return sizes
      })
      return (await windows).get(provider + "/" + model) ?? null
    } catch {
      return null
    }
  }

  const transcript = (id) => join(sessions, id + ".jsonl")
  const write = (id, line) => {
    try {
      appendFileSync(transcript(id), JSON.stringify(line) + "\n")
    } catch {}
  }
  // Each message's author, which its parts don't name: its update comes before theirs.
  const roles = new Map()
  // A tool call is written as it starts running, then its part again once it ended, with
  // called saying the call was written already, so the chat shows a call while it runs.
  const keepPart = (part) => {
    const role = roles.get(part?.messageID) ?? null
    if (part?.type === "tool" && part.state?.status === "running") {
      if (written.has(part.id + ":call") || written.has(part.id)) return
      written.add(part.id + ":call")
      write(part.sessionID, { type: "part", role, part, call: true })
      return
    }
    if (!settled(part) || written.has(part.id)) return
    written.add(part.id)
    write(part.sessionID, { type: "part", role, part, ...(written.has(part.id + ":call") && { called: true }) })
  }
  // A prompt whole, its words and the files it carries on one line, as the chat shows them
  // together; its parts' own updates come after and are left out.
  const keepPrompt = (info, parts) => {
    if (!info?.id || written.has(info.id)) return
    written.add(info.id)
    roles.set(info.id, "user")
    for (const part of parts) if (part?.id) written.add(part.id)
    write(info.sessionID, { type: "prompt", info, parts })
  }
  const keepMessage = (info) => {
    if (info.id && info.role) roles.set(info.id, info.role)
    const done = info.role === "user" || info.time?.completed !== undefined || info.error !== undefined
    const key = info.id + (info.role === "user" ? "" : ":done")
    if (!done || written.has(key)) return
    written.add(key)
    write(info.sessionID, { type: "message", info })
  }

  // The session's parent, from the event that made it or, for one this process didn't make,
  // as a resumed one, from opencode.
  const parentOf = async (id) => {
    if (parents.has(id)) return parents.get(id)
    let parent = null
    try {
      const found = await client.session.get({ path: { id } })
      parent = found?.data?.parentID ?? null
    } catch {}
    parents.set(id, parent)
    return parent
  }
  const rootOf = async (id) => {
    let at = id
    for (let depth = 0; depth < 8; depth++) {
      const parent = await parentOf(at)
      if (!parent) return at
      at = parent
    }
    return at
  }

  // A session's records from before this process wrote any, as a resumed one's: whole, once.
  const backfill = async (id) => {
    if (backfilled.has(id)) return
    backfilled.add(id)
    if (existsSync(transcript(id))) return
    try {
      const found = await client.session.messages({ path: { id } })
      for (const { info, parts } of found?.data ?? []) {
        if (info?.role === "user") keepPrompt(info, parts ?? [])
        else {
          keepMessage(info)
          for (const part of parts ?? []) keepPart(part)
        }
      }
    } catch {}
  }

  // Tells Novadeck the root session that runs here, once for each it switches to.
  const bind = async (id, source) => {
    if (bound.root === id && source !== "compact") return
    const first = bound.root === null
    bound.root = id
    await backfill(id)
    report("SessionStart", {
      session_id: id,
      source: source ?? (first ? "startup" : "switch"),
      transcript_path: transcript(id),
    })
  }

  // A session opencode was started on, as the shim read its command line, which a plugin
  // can't (it runs in the TUI's worker, whose argv is the worker's): --session's, or
  // --continue's, the latest root session of this folder, unless --fork makes a new one.
  const started = async () => {
    const given = process.env.NOVADECK_OPENCODE_SESSION
    const fork = process.env.NOVADECK_OPENCODE_FORK === "1"
    if (given && !fork) return given
    if (process.env.NOVADECK_OPENCODE_CONTINUE !== "1" || fork) return undefined
    try {
      const listed = await client.session.list()
      const roots = (listed?.data ?? []).filter((one) => !one.parentID && (!one.directory || one.directory === directory))
      roots.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      return roots[0]?.id
    } catch {
      return undefined
    }
  }
  void started().then((id) => (id ? bind(id, "resume") : undefined))

  const turnOf = (id) => {
    let turn = turns.get(id)
    if (!turn) turns.set(id, (turn = { reply: null, plan: null, error: null, rejected: false, agent: null }))
    return turn
  }

  return {
    config: async (loaded) => {
      try {
        loaded.mcp = { ...(loaded.mcp ?? {}), novadeck: { type: "local", command: [...config.mcp], enabled: true } }
        const permission = loaded.permission
        const own = { "novadeck_*": "allow" }
        if (config.worktrees) own.external_directory = { [config.worktrees + "/*"]: "allow" }
        if (typeof permission === "string") loaded.permission = { "*": permission, ...own }
        else {
          const theirs = permission && typeof permission === "object" ? permission : {}
          const external = theirs.external_directory
          loaded.permission = {
            ...theirs,
            "novadeck_*": theirs["novadeck_*"] ?? "allow",
            ...(own.external_directory && {
              external_directory:
                typeof external === "string"
                  ? { "*": external, ...own.external_directory }
                  : { ...(external ?? {}), ...own.external_directory },
            }),
          }
        }
        // What a launch sets for itself, as a provider Novadeck pays for: a configuration
        // merged over the person's for this process alone.
        const extra = process.env.NOVADECK_OPENCODE_CONFIG
        if (extra) {
          const merge = (into, from) => {
            for (const [key, value] of Object.entries(from)) {
              if (value && typeof value === "object" && !Array.isArray(value) && into[key] && typeof into[key] === "object")
                merge(into[key], value)
              else into[key] = value
            }
          }
          const own = JSON.parse(extra)
          merge(loaded, own)
          // A launch that picks the model picks its titles' too: opencode sends a session's
          // title to its small_model, another vendor's where the person's default is. Its title
          // call turns reasoning off, which a model whose reasoning can't be (gemini-4-neon on
          // OpenRouter) refuses: the session runs untitled, so such a launch names its own.
          if (typeof own.model === "string" && own.small_model === undefined) loaded.small_model = own.model
        }
      } catch {}
    },

    event: async ({ event }) => {
      try {
        const props = event.properties ?? {}
        switch (event.type) {
          case "session.created": {
            const info = props.info ?? {}
            parents.set(info.id, info.parentID ?? null)
            if (info.parentID) {
              const root = await rootOf(info.parentID)
              report("SubagentStart", {
                session_id: root,
                agent_id: info.id,
                parent_id: info.parentID,
                agent_type: kinds.get(info.parentID) ?? null,
                title: cut(info.title, 200),
              })
            } else await bind(info.id)
            return
          }
          case "message.updated":
            if (!props.info) return
            keepMessage(props.info)
            if (props.info.role === "assistant" && props.info.tokens)
              usage.set(props.info.sessionID, {
                tokens: props.info.tokens,
                model: props.info.modelID ?? null,
                provider: props.info.providerID ?? null,
                variant: props.info.variant ?? null,
              })
            return
          case "message.part.updated":
            if (!props.part) return
            keepPart(props.part)
            // The agent's words alone: a prompt's text comes as a part too.
            if (
              props.part.type === "text" &&
              !props.part.synthetic &&
              roles.get(props.part.messageID) === "assistant" &&
              settled(props.part) &&
              props.part.text
            ) {
              const turn = turnOf(props.part.sessionID)
              turn.reply = cut(props.part.text, 2000)
              turn.plan = cut(props.part.text, 256 * 1024)
              turn.rejected = false
            }
            return
          case "session.error":
            if (props.sessionID) turnOf(props.sessionID).error = { name: props.error?.name ?? null, message: cut(props.error?.data?.message ?? null, 2000) }
            return
          case "session.status":
            if (props.status?.type === "busy" && props.sessionID) busy.add(props.sessionID)
            if (props.status?.type === "retry")
              report("Retry", { session_id: props.sessionID, attempt: props.status.attempt, message: cut(props.status.message, 2000), next: props.status.next })
            return
          case "session.compacted": {
            const id = props.sessionID
            if (id && !(await parentOf(id))) await bind(id, "compact")
            return
          }
          case "permission.asked":
            report("PermissionRequest", {
              session_id: props.sessionID,
              request_id: props.id,
              permission: props.permission,
              patterns: props.patterns,
              metadata: props.metadata,
              always: props.always,
              tool: props.tool,
              root: await rootOf(props.sessionID),
            })
            return
          case "permission.replied":
            // A rejection ends the turn with no error of its own: the Stop says so.
            if (props.reply === "reject" && props.sessionID) turnOf(props.sessionID).rejected = true
            report("PermissionReplied", { session_id: props.sessionID, request_id: props.requestID, reply: props.reply, root: await rootOf(props.sessionID) })
            return
          case "question.asked":
            report("QuestionRequest", {
              session_id: props.sessionID,
              request_id: props.id,
              questions: props.questions,
              tool: props.tool,
              tool_name: calls.get(props.tool?.callID) ?? null,
              root: await rootOf(props.sessionID),
            })
            asking.set(props.id, calls.get(props.tool?.callID) ?? null)
            return
          case "question.replied":
            report("QuestionReplied", {
              session_id: props.sessionID,
              request_id: props.requestID,
              answers: props.answers,
              tool_name: asking.get(props.requestID) ?? null,
              root: await rootOf(props.sessionID),
            })
            asking.delete(props.requestID)
            return
          case "question.rejected":
            // A dismissed question ends the turn as a refused permission does (probed
            // 2026-11-22, 1.19.6).
            if (props.sessionID) turnOf(props.sessionID).rejected = true
            report("QuestionReplied", {
              session_id: props.sessionID,
              request_id: props.requestID,
              rejected: true,
              tool_name: asking.get(props.requestID) ?? null,
              root: await rootOf(props.sessionID),
            })
            asking.delete(props.requestID)
            return
          case "session.idle": {
            const id = props.sessionID
            // Once a turn: an Escape makes opencode go idle twice (probed 2026-11-22, 1.19.6).
            if (!id || !busy.delete(id)) return
            const parent = await parentOf(id)
            const turn = turnOf(id)
            turns.delete(id)
            if (parent) {
              report("SubagentStop", { session_id: await rootOf(id), agent_id: id, last_assistant_message: turn.reply, error: turn.error })
              return
            }
            const used = usage.get(id)
            const answer = await report("Stop", {
              session_id: id,
              last_assistant_message: turn.reply,
              error: turn.error,
              rejected: turn.rejected,
              agent: turn.agent,
              // What its plan agent answered is its plan.
              plan: turn.agent === "plan" ? turn.plan : null,
              transcript_path: transcript(id),
              usage: used ? { ...used, window: await windowOf(used.provider, used.model) } : null,
            })
            const text = delivery(answer)
            if (!text) return
            continuing.add(id)
            try {
              await client.session.promptAsync({ path: { id }, body: { parts: [{ type: "text", text, synthetic: true }] } })
              report("Continued", { session_id: id })
            } catch {
              continuing.delete(id)
              report("Lapsed", { session_id: id })
            }
            return
          }
          default:
        }
      } catch {}
    },

    "chat.message": async (input, output) => {
      try {
        const id = input.sessionID
        if (await parentOf(id)) return
        await bind(id)
        const own = continuing.delete(id)
        if (!own && input.agent) turnOf(id).agent = input.agent
        const prompt = (output.parts ?? [])
          .filter((part) => part.type === "text" && !part.synthetic)
          .map((part) => part.text)
          .join("\n")
        const images = (output.parts ?? []).filter((part) => part.type === "file" && String(part.mime ?? "").startsWith("image/")).length
        const answer = await report("UserPromptSubmit", {
          session_id: id,
          prompt: cut(prompt, 100000),
          images,
          agent: input.agent ?? null,
          model: input.model ?? null,
          variant: input.variant ?? null,
          continuation: own,
          transcript_path: transcript(id),
        })
        const text = own ? undefined : delivery(answer)
        if (text)
          output.parts.push({
            id: "prt_novadeck" + Date.now().toString(36),
            sessionID: id,
            messageID: output.message?.id,
            type: "text",
            text,
            synthetic: true,
          })
        keepPrompt(output.message, output.parts ?? [])
      } catch {}
    },

    "tool.execute.before": async (input, output) => {
      try {
        if (input.tool === "task") kinds.set(input.sessionID, output.args?.subagent_type ?? null)
        if (input.callID) calls.set(input.callID, input.tool)
        report("PreToolUse", {
          session_id: input.sessionID,
          tool_name: input.tool,
          call_id: input.callID,
          tool_input: output.args,
          root: await rootOf(input.sessionID),
        })
      } catch {}
    },

    "tool.execute.after": async (input, output) => {
      try {
        const answer = await report("PostToolUse", {
          session_id: input.sessionID,
          tool_name: input.tool,
          call_id: input.callID,
          tool_input: input.args,
          title: cut(output.title, 500),
          exit: output.metadata?.exit ?? null,
          root: await rootOf(input.sessionID),
        })
        const text = delivery(answer)
        if (text && typeof output.output === "string") output.output = output.output + "\n\n" + text
      } catch {}
    },
  }
}

`
