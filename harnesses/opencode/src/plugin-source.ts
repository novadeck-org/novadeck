/**
 * The JavaScript of Novadeck's opencode plugin, as the shim has opencode load it per launch
 * (`OPENCODE_CONFIG_CONTENT`'s `plugin`, or a configuration file of Novadeck's in `OPENCODE_CONFIG`):
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
  /**
   * The shipping gate (Experimental) is on: a shell command's PreToolUse waits for the runner's
   * answer, and is refused where it says so, and the plugin answers the permission dialog of a
   * command the runner permits, for that call alone. Absent otherwise, and the plugin is as it
   * always was.
   */
  readonly gate?: boolean
}

/** The plugin's module for `config`, as opencode imports it. */
export const pluginSource = (config: PluginConfig): string =>
  `// Novadeck's plugin for opencode. Written by Novadeck into its own data directory and
// overwritten on each start; opencode loads it only in Novadeck's terminals, for one launch.
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const config = ${JSON.stringify(config)}
${body}`

// The plugin's code, the same on every platform.
const body = String.raw`
const sessions = join(dirname(fileURLToPath(import.meta.url)), "sessions")
// Sessions the person left for its home, as Novadeck's TUI plugin marks them (tui-plugin-source.ts).
const leftFolder = join(dirname(fileURLToPath(import.meta.url)), "left")

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

// An answer's JSON, from the last line of what the hook printed that is JSON: the relay prints
// its answer as one line, last, and anything printed before it (a Windows shell's AutoRun, a
// profile) is not part of it, so it can't hide a deny.
const answerOf = (text) => {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
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
  try {
    const answer = answerOf(text)
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

// What an answer refuses a call with, where it does: the words the relay prints for a deny
// (Antigravity's form too), whose reason opencode gives the model as the call's result.
const refusal = (text) => {
  try {
    const answer = answerOf(text)
    return answer.decision === "deny" && typeof answer.reason === "string" && answer.reason !== ""
      ? answer.reason
      : undefined
  } catch {
    return undefined
  }
}

// Whether an answer lets the plugin reply "once" to the permission it asked about.
const replies = (text) => {
  try {
    return answerOf(text).reply === "once"
  } catch {
    return false
  }
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
    // Not waited on for long: it may wait for this very plugin to load.
    const health = await Promise.race([
      client._client.get({ url: "/global/health" }),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ])
    version = health?.data?.version
  } catch {}
  if (typeof version === "string" && (older(version, config.minimum) || !older(version, config.unknownFrom))) {
    // Nothing to report: the runner reads the version itself (limited.ts) and says so.
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
  // The text of the prompt each session's Stop delivery started its next turn with, which tells
  // that prompt apart from the person's, as it comes back through chat.message.
  const continuing = new Map()
  // What each root session's last prompt of the person's went with: the turn a Stop's delivery
  // starts goes on in it, as opencode would otherwise take its default agent (session/prompt.ts,
  // createUserMessage) and leave a person on its plan agent building.
  const chosen = new Map()
  // Sessions working since they last went idle.
  const busy = new Set()
  // The tool of each call, by its id, as a question names only the call that asks it.
  const calls = new Map()
  // The tool of each question waiting, by its id, for its reply.
  const asking = new Map()
  // The permission requests already answered, by id, as opencode's permission.replied said: a
  // dialog that is gone is never reported again.
  const answered = new Set()
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
  // The messages that are a compaction's summary, whose words the chat shows as the note's.
  const summaries = new Set()
  // A tool call is written as it starts running, then its part again once it ended, with
  // called saying the call was written already, so the chat shows a call while it runs.
  const keepPart = (part) => {
    const role = roles.get(part?.messageID) ?? null
    // A root session's prompt is written whole by its chat.message hook (keepPrompt), which a prompt
    // given mid-turn reaches after its parts were stored (probed 2026-11-22, 1.19.6: its text
    // part came first, ahead of the tool's result): its parts are not written on their own.
    if (role === "user" && parents.get(part.sessionID) === null) return
    if (part?.type === "tool" && part.state?.status === "running") {
      if (written.has(part.id + ":call") || written.has(part.id)) return
      written.add(part.id + ":call")
      write(part.sessionID, { type: "part", role, part, call: true })
      return
    }
    if (!settled(part) || written.has(part.id)) return
    written.add(part.id)
    if (part.type === "text" && role === "assistant") release(part.sessionID)
    write(part.sessionID, {
      type: "part",
      role,
      part,
      ...(written.has(part.id + ":call") && { called: true }),
      ...(summaries.has(part.messageID) && { summary: true }),
    })
    if (part.type === "tool") release(part.sessionID)
  }
  // A prompt whole, its words and the files it carries on one line, as the chat shows them
  // together; its parts' own updates come after and are left out.
  const keepPrompt = (info, parts) => {
    if (!info?.id || written.has(info.id)) return
    written.add(info.id)
    roles.set(info.id, "user")
    for (const part of parts) if (part?.id) written.add(part.id)
    // When it was written, which is when the model could read it (a prompt held back: see
    // waiting), not when it was given.
    write(info.sessionID, { type: "prompt", info, parts, at: Date.now() })
  }
  // A prompt the person gave while a turn ran: opencode puts it into the session at once, but
  // its model reads it only at its next step, after the tool the turn waits on, which the chat
  // shows in that order (probed 2026-11-22, 1.19.6: the prompt's message came while the tool
  // ran, and the next answer's message began before the tool's result was written, so that
  // message can't say when). It is written after the result of the tool the turn waits on, or
  // before the next answer's words, or when the turn ends.
  const waiting = new Map()
  const release = (id) => {
    const held = waiting.get(id)
    if (!held) return
    waiting.delete(id)
    for (const { info, parts } of held) keepPrompt(info, parts)
  }
  const keepMessage = (info) => {
    if (info.id && info.role) roles.set(info.id, info.role)
    if (info.id && info.summary === true) summaries.add(info.id)
    const done = info.role === "user" || info.time?.completed !== undefined || info.error !== undefined
    // Its own key, apart from the prompt's (keepPrompt): a prompt given mid-turn has its message
    // update before its chat.message hook, which must still write it.
    const key = info.id + (info.role === "user" ? ":info" : ":done")
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
    // A session the person left for opencode's home (/new), as the TUI plugin marks it, is bound
    // again when they go back to it: the runner ended its binding then.
    const mark = join(leftFolder, String(id))
    const back = bound.root === id && existsSync(mark)
    if (back) {
      try {
        rmSync(mark, { force: true })
      } catch {}
    }
    if (bound.root === id && source !== "compact" && !back) return
    const first = bound.root === null
    bound.root = id
    await backfill(id)
    report("SessionStart", {
      session_id: id,
      source: source ?? (first ? "startup" : "switch"),
      transcript_path: transcript(id),
      version,
    })
  }

  // A session opencode was started on, as the shim read its command line, which a plugin
  // can't (it runs in the TUI's worker, whose argv is the worker's): --session's, or
  // --continue's, the latest root session of this folder, unless --fork makes a new one.
  const started = async () => {
    const given = process.env.NOVADECK_OPENCODE_SESSION
    const fork = process.env.NOVADECK_OPENCODE_FORK === "1"
    // Only one that is there: opencode exits at a missing one ("Session not found"), but its
    // plugins start first, and a bind reported before that exit would claim the resume worked.
    if (given && !fork) {
      try {
        const found = await client.session.get({ path: { id: given } })
        return found?.data?.id === given ? given : undefined
      } catch {
        return undefined
      }
    }
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
            return
          case "session.compacted": {
            const id = props.sessionID
            if (id && !(await parentOf(id))) await bind(id, "compact")
            return
          }
          case "permission.asked": {
            const asked = {
              session_id: props.sessionID,
              request_id: props.id,
              permission: props.permission,
              patterns: props.patterns,
              metadata: props.metadata,
              always: props.always,
              tool: props.tool,
              root: await rootOf(props.sessionID),
            }
            if (!config.gate || props.permission !== "bash" || !props.tool?.callID) {
              report("PermissionRequest", asked)
              return
            }
            // A shell command's permission, with the shipping gate on: Novadeck says whether this
            // is the very call its hook let through under a permit, and then the reply is "once",
            // never "always" (which would approve its patterns for the session: permission/index.ts,
            // 1.19.6). Where it says nothing, the person's dialog is as it was.
            const answer = await report("PermissionRequest", asked)
            // The person answered while it was asked: nothing is left to answer or to show.
            if (answered.has(props.id)) return
            let replied = false
            if (replies(answer)) {
              try {
                const sent = await client.postSessionIdPermissionsPermissionId({
                  path: { id: props.sessionID, permissionID: props.id },
                  body: { response: "once" },
                })
                replied = sent?.data === true
              } catch {}
            }
            // A dialog nothing answered (no answer in time, an empty one, a reply that failed) is
            // reported once more: the runner skips the card of a report it answered, and its note
            // is spent by the first, so it answers nothing the second time and the card and the
            // bell show. Not for one the person answered meanwhile (its reply may have made a
            // reply fail), whose report would be a card for a dialog that is gone.
            if (!replied && !answered.has(props.id)) report("PermissionRequest", asked)
            return
          }
          case "permission.replied":
            answered.add(props.requestID)
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
            release(id)
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
            // That its Stop's hooks ran, however Novadeck's own fared: the transcript says it too,
            // so a turn whose report never came still ends.
            write(id, { type: "stopped", at: Date.now(), error: turn.error?.name ?? null, rejected: turn.rejected })
            const text = delivery(answer)
            if (!text) return
            continuing.set(id, text)
            try {
              const { agent, model, variant } = chosen.get(id) ?? {}
              await client.session.promptAsync({
                path: { id },
                body: {
                  ...(agent && { agent }),
                  ...(model && { model }),
                  ...(variant && { variant }),
                  parts: [{ type: "text", text, synthetic: true }],
                },
              })
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
        const pending = continuing.get(id)
        const own =
          pending !== undefined &&
          (output.parts ?? []).some((part) => part.type === "text" && part.synthetic === true && part.text === pending)
        if (own) continuing.delete(id)
        else chosen.set(id, { agent: input.agent, model: input.model, variant: input.variant })
        if (input.agent) turnOf(id).agent = input.agent
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
        if (busy.has(id) && !own) {
          const held = waiting.get(id) ?? []
          held.push({ info: output.message, parts: output.parts ?? [] })
          waiting.set(id, held)
        } else keepPrompt(output.message, output.parts ?? [])
      } catch {}
    },

    "tool.execute.before": async (input, output) => {
      let refused
      try {
        if (input.tool === "task") kinds.set(input.sessionID, output.args?.subagent_type ?? null)
        if (input.callID) calls.set(input.callID, input.tool)
        const answer = report("PreToolUse", {
          session_id: input.sessionID,
          tool_name: input.tool,
          call_id: input.callID,
          tool_input: output.args,
          root: await rootOf(input.sessionID),
        })
        // A shell command, with the shipping gate on: waits for Novadeck's answer, bound by its
        // hook's own time (a hook that failed or ran past it answers nothing).
        if (config.gate && input.tool === "bash") refused = refusal(await answer)
      } catch {}
      // A throw is the call's result: opencode gives its message to the model as the tool's output
      // and the turn goes on (probed 2026-11-22, 1.19.6).
      if (refused) throw new Error(refused)
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
        // A built-in tool's result is a string; an MCP tool's is blocks of content (probed
        // 2026-11-22, 1.19.6: an object with a content array of text blocks), which the model reads.
        if (text && typeof output.output === "string") output.output = output.output + "\n\n" + text
        else if (text && Array.isArray(output.content)) output.content.push({ type: "text", text })
      } catch {}
    },
  }
}

`
