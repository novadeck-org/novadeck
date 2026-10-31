import type {
  AgentFeedbackDraft,
  Feedback,
  FeedbackAbout,
  FeedbackKind,
} from "@novadeck/core/feedback"
import type { Backend, TerminalKey } from "@novadeck/core/port"
import { terminalKeyId } from "@novadeck/core/terminals/registry"
import type { Workspace } from "@novadeck/core/types"

import type { DemoTurns } from "./agents/turns"
import { demoHandle } from "./handles"
import { chatAgent, terminalSlot } from "./samples"
import { terminalOf } from "./workspace"

// The demo's feedback: what the footer's card and an agent window's "Ask @handle to write
// feedback…" and its drafts use where the backend has one. It sends nothing anywhere.

// The app version the demo's card says goes with a note, in the form of the real versions
// (`0.0.219`). A fixture, not `backend.version`, which the demo makes older than every update.
export const demoFeedbackVersion = "0.0.219"

// How many turns long the agent takes to write a draft, so the person sees it work.
const writingTurns = 3

// How long a simulated send takes.
export const feedbackSendMs = 400

// What the browser says of the computer, as `describeOs` reads it.
export type BrowserOs = {
  // `navigator.userAgentData.platform` and its high-entropy `architecture`,
  // where the browser gives them.
  readonly platform?: string | undefined
  readonly architecture?: string | undefined
  readonly userAgent: string
}

// The OS with its architecture, as the card shows it: `Linux x64`, `macOS arm64`,
// `Windows x64`. A browser that hides the architecture gets the usual one of its OS (a Mac's
// user agent says Intel whatever it runs on), and an OS it can't place is said so.
export const describeOs = ({ platform, architecture, userAgent }: BrowserOs): string => {
  const hint = `${platform ?? ""} ${userAgent}`
  const os = /mac/i.test(hint)
    ? "macOS"
    : /win/i.test(hint)
      ? "Windows"
      : /linux|cros|x11/i.test(hint) && !/android/i.test(hint)
        ? "Linux"
        : undefined
  if (!os) return "Unknown OS"
  const arm = /arm|aarch64/i
  const arch = architecture
    ? arm.test(architecture)
      ? "arm64"
      : "x64"
    : arm.test(userAgent) || os === "macOS"
      ? "arm64"
      : "x64"
  return `${os} ${arch}`
}

type UserAgentData = {
  readonly platform?: string
  readonly getHighEntropyValues?: (hints: string[]) => Promise<Record<string, string | undefined>>
}

const browserOs = async (): Promise<string> => {
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent
  const data = (typeof navigator === "undefined" ? undefined : navigator) as
    | { readonly userAgentData?: UserAgentData }
    | undefined
  const brands = data?.userAgentData
  let high: Record<string, string | undefined> = {}
  try {
    high = (await brands?.getHighEntropyValues?.(["architecture"])) ?? {}
  } catch {
    // A browser that won't say gets the usual architecture.
  }
  return describeOs({
    platform: brands?.platform,
    architecture: high.architecture,
    userAgent,
  })
}

// The kind an agent picks for a draft: a bug unless the person's hint is about an idea or
// something else.
export const draftKindOf = (hint: string): FeedbackKind =>
  /\b(idea|suggest\w*|wish|feature|would be nice|could be)\b/i.test(hint)
    ? "idea"
    : /\b(other|general|thoughts?|praise|love)\b/i.test(hint)
      ? "other"
      : "bug"

// A short report in the agent's voice, from the terminal's title and the person's hint; it
// names one path under the home folder, which the sheet strikes before sending.
export const draftTextOf = (
  kind: FeedbackKind,
  title: string,
  project: string,
  hint: string,
): string => {
  const path = `~/Workspace/${project}/src`
  const about = hint.trim()
  const body =
    kind === "idea"
      ? `While working on "${title}" I kept wishing for a quicker way to jump between the windows of one task.\n\nWhat I did: edited files under ${path} and switched windows by hand to check the results. A shortcut that cycles through the windows of the same task would have saved most of it.`
      : kind === "other"
        ? `Some thoughts after working on "${title}".\n\nWhat I did: edited files under ${path} and ran the checks from the window. It kept up with me, and the Inbox told me when something needed an answer, which is what I wanted.`
        : `While working on "${title}", something didn't behave as I expected.\n\nWhat I did: edited files under ${path} and ran the checks. The window took a few seconds to catch up with the output and its title lagged behind what I was doing.\n\nExpected it to keep up as I worked.`
  return about ? `${body}\n\nYou asked me to cover: ${about}` : body
}

// The demo's feedback, with the one thing only the demo does: `failNext`, so the next note is
// not sent, as when offline.
export type DemoFeedback = Required<Feedback> & {
  readonly failNext: () => void
  // The next `ask` rejects as if no agent ran there, so the agent card shows why.
  readonly failNextAsk: () => void
  // A draft the agent in a terminal wrote on its own, as after it hit a Novadeck bug: not
  // asked for. Rejects when no agent runs there.
  readonly draftUnasked: (terminal: TerminalKey) => Promise<void>
}

// Whether a backend's feedback is the demo's, which the debug panel can make fail.
export const isDemoFeedback = (feedback: Feedback | undefined): feedback is DemoFeedback =>
  feedback !== undefined && "failNext" in feedback

// How many drafts were made, for each one's own id.
let drafted = 0

// The demo's feedback over `turns`, whose agents write the drafts. `workspace` is the
// workspace as last committed.
export const createDemoFeedback = (
  turns: DemoTurns,
  workspace: () => Workspace | undefined,
): DemoFeedback => {
  let failing = false
  let failingAsk = false
  // The requests that wait for their agent's turn to end, by terminal: the doorbell rule,
  // an agent in a turn is not interrupted. Each yields one draft, in order.
  const waiting = new Map<string, { key: TerminalKey; hint: string }[]>()
  // The writing turns in flight, by terminal, with the agent's state when each began: one
  // another verb or the person's Stop cut short writes nothing.
  const writing = new Map<string, { hint: string; epoch: number }>()
  // The drafts waiting for the person, oldest first: one per terminal, a newer one taking the
  // place of an older one, as the runner holds them.
  let held: readonly AgentFeedbackDraft[] = []
  const listeners = new Set<(drafts: readonly AgentFeedbackDraft[]) => void>()
  const publish = (next: readonly AgentFeedbackDraft[]): void => {
    held = next
    for (const listener of listeners) listener(held)
  }

  const draft = (key: TerminalKey, hint: string, asked: boolean): void => {
    const current = workspace()
    const terminal = terminalOf(current, key)
    const agent = terminal && chatAgent(terminal)
    if (!terminal || !agent) return
    const kind = draftKindOf(hint)
    drafted += 1
    const id = terminalKeyId(key)
    publish([
      ...held.filter((each) => terminalKeyId(each.terminal) !== id),
      {
        id: `demo-feedback-draft-${drafted}`,
        terminal: key,
        handle: terminal.handle ?? demoHandle(Number(terminalSlot(terminal.id))),
        agent,
        kind,
        text: draftTextOf(kind, terminal.name, key.projectId, hint),
        asked,
        at: Date.now(),
      },
    ])
  }

  // The agent takes a turn to write it up, as when prompted; its draft comes when the turn ends.
  const write = (key: TerminalKey, hint: string): void => {
    const terminal = terminalOf(workspace(), key)
    if (!terminal) return
    turns.finish(key, terminal, "completed", {
      after: turns.turnMs * writingTurns,
      reply: "Drafted the feedback. It's in the feedback card to read, edit and send.",
    })
    writing.set(terminalKeyId(key), { hint, epoch: turns.epoch(key) })
  }

  turns.watch((event) => {
    const id = terminalKeyId(event.key)
    // Another turn begun over the one writing cuts it short, and it writes nothing.
    if (event.type === "begin" && writing.get(id)?.epoch !== turns.epoch(event.key))
      writing.delete(id)
    if (event.type !== "end" && event.type !== "rest") return
    const mine = writing.get(id)
    if (mine) {
      writing.delete(id)
      if (
        event.type === "end" &&
        event.outcome === "completed" &&
        turns.epoch(event.key) === mine.epoch
      )
        draft(event.key, mine.hint, true)
    }
    startNext(id)
  })

  // The next request in line takes its turn; each yields one draft, in order.
  const startNext = (id: string): void => {
    const [next, ...rest] = waiting.get(id) ?? []
    if (!next) return
    if (rest.length > 0) waiting.set(id, rest)
    else waiting.delete(id)
    write(next.key, next.hint)
  }

  // An answered request resumes its agent with no turn event, so a request queued behind the
  // dialog starts when the status clears. Deferred, so a turn's own end event goes first.
  turns.watchStatus((key, agent) => {
    const id = terminalKeyId(key)
    if (agent.working || agent.attention || !waiting.has(id)) return
    queueMicrotask(() => {
      const now = terminalOf(workspace(), key)
      const status = now?.state === "running" ? now.agent : undefined
      if (status?.working || status?.attention || turns.working(key) || writing.has(id)) return
      startNext(id)
    })
  })

  return {
    about: async (): Promise<FeedbackAbout> => ({
      version: demoFeedbackVersion,
      os: await browserOs(),
    }),
    send: (): Promise<void> =>
      new Promise((resolve, reject) => {
        const offline = failing
        failing = false
        setTimeout(
          () => (offline ? reject(new Error("Couldn't reach the network.")) : resolve()),
          feedbackSendMs,
        )
      }),
    ask: (key, hint): Promise<void> => {
      if (failingAsk) {
        failingAsk = false
        return Promise.reject(new Error("No agent runs in that window."))
      }
      const terminal = terminalOf(workspace(), key)
      if (!terminal || terminal.state !== "running" || !chatAgent(terminal))
        return Promise.reject(new Error("No agent runs in that window."))
      const id = terminalKeyId(key)
      // A status of working with no turn of the demo's behind it, as the seeds give some
      // agents, has no end to wait for: the writing turn takes the status over.
      const busy = terminal.agent?.attention || turns.working(key)
      if (busy || writing.has(id)) waiting.set(id, [...(waiting.get(id) ?? []), { key, hint }])
      else write(key, hint)
      return Promise.resolve()
    },
    failNext: () => {
      failing = true
    },
    failNextAsk: () => {
      failingAsk = true
    },
    draftUnasked: (key) => {
      const terminal = terminalOf(workspace(), key)
      if (!terminal || terminal.state !== "running" || !chatAgent(terminal))
        return Promise.reject(new Error("No agent runs in that window."))
      draft(key, "", false)
      return Promise.resolve()
    },
    drafts: {
      watch: (listener) => {
        listeners.add(listener)
        listener(held)
        return () => void listeners.delete(listener)
      },
      settle: (id) => {
        if (held.some((each) => each.id === id)) publish(held.filter((each) => each.id !== id))
        return Promise.resolve()
      },
    },
  }
}

// A backend with feedback: its agents write drafts for the person to send or discard. Not
// the visitor's: that build lists its fields.
export const withFeedback = (backend: Backend, turns: DemoTurns): Backend => {
  let latest: Workspace | undefined
  return {
    ...backend,
    commit: (workspace, actions) => {
      latest = workspace
      backend.commit(workspace, actions)
    },
    feedback: createDemoFeedback(turns, () => latest),
  }
}
