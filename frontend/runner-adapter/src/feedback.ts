import type { AgentFeedbackDraft, Feedback, FeedbackDrafts } from "@novadeck/core/feedback"
import type { FeedbackDraftEntry } from "@novadeck/protocol"
import { hasCode, type Runner } from "@novadeck/runner-client"

// The runner's side of feedback: the host's sender (the footer card's) with the runner's
// two routes beside it. `ask` relays the person's request to a terminal's agent, and `drafts`
// follows the drafts the agents write, to be sent through the host's `send` and then settled.
// Both exist only where the host can send, so an agent is asked only when its draft could go.

const draftOf = (entry: FeedbackDraftEntry): AgentFeedbackDraft => ({
  id: entry.id,
  terminal: {
    projectId: entry.projectId,
    workspaceSessionId: entry.workspaceSessionId,
    terminalId: entry.terminalId,
  },
  handle: entry.handle,
  agent: entry.agent,
  kind: entry.kind,
  text: entry.text,
  asked: entry.asked,
  at: entry.at,
})

// One stream of the runner's drafts, open while anyone listens and shared by all who do.
const followDrafts = (
  runner: Runner["feedback"],
  track: <T>(work: Promise<T>) => Promise<T>,
): FeedbackDrafts => {
  const listeners = new Set<(drafts: readonly AgentFeedbackDraft[]) => void>()
  let stream: AsyncIterableIterator<FeedbackDraftEntry[], undefined> | undefined
  // What the runner last listed, once it has.
  let latest: readonly AgentFeedbackDraft[] | undefined

  const publish = (drafts: readonly AgentFeedbackDraft[]): void => {
    latest = drafts
    for (const listener of listeners) listener(drafts)
  }

  const open = (): void => {
    const next = runner.watch()
    stream = next
    void (async () => {
      try {
        for await (const entries of next) {
          if (stream !== next) return
          publish(entries.map(draftOf))
        }
      } catch {
        // The client reconnects the subscription; one closed for good just ends.
      }
      if (stream !== next) return
      stream = undefined
      publish([])
    })()
  }

  const close = (): void => {
    const done = stream
    stream = undefined
    latest = undefined
    void done?.return?.()?.catch?.(() => {})
  }

  return {
    watch: (listener) => {
      listeners.add(listener)
      if (!stream) open()
      else if (latest) listener(latest)
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return
        close()
      }
    },
    settle: async (id, outcome) => {
      try {
        await track(runner.settle(id, outcome))
      } catch (error) {
        // A draft the runner no longer holds was replaced or settled elsewhere: done.
        if (!hasCode(error, "NOT_FOUND")) throw error
      }
    },
  }
}

// The host's feedback with the runner's routes added.
export const runnerFeedback = (
  host: Feedback,
  runner: Runner["feedback"],
  track: <T>(work: Promise<T>) => Promise<T>,
): Feedback => ({
  ...host,
  ask: (key, hint) => track(runner.ask(key.terminalId, hint)),
  drafts: followDrafts(runner, track),
})
