import {
  conflictFailure,
  type ConflictReason,
  type Conversations,
  notCleared,
  openQuestion,
} from "@novadeck/core/conversation"
import type { TerminalKey } from "@novadeck/core/types"

import type { DemoAction } from "./types"

// The ways the runner turns a chat's send away, which the demo's agents never do of their
// own accord: one can be armed for the next send, which fails as the runner's would. The
// next Stop can be armed to fail as the runner's does when the queued words stay in the
// box, or when a request waits on the person. A request armed as waiting is a permission's, as
// the runner refuses it; the person's own Send or Stop over a question the agent asks sets that
// aside (`setAside`) all the same, as the runner does.
const failures: readonly {
  // No reason: as an older runner, or one this client doesn't know, says nothing of why.
  readonly reason: ConflictReason | null
  readonly label: string
  readonly hint: string
}[] = [
  {
    reason: "draft",
    label: "Draft in the box",
    hint: "Words back in the box · Clear it above",
  },
  {
    reason: "shell",
    label: "Box in shell mode",
    hint: "Clear it above",
  },
  {
    reason: "too-tall",
    label: "Too tall for the box",
    hint: "Offers Open terminal",
  },
  {
    reason: "no-box",
    label: "No box on screen",
    hint: "Offers Open terminal",
  },
  {
    reason: "no-agent",
    label: "No agent running",
    hint: "Says no agent runs · Open terminal",
  },
  {
    reason: "pending",
    label: "Request waiting",
    hint: "Says to answer it first",
  },
  {
    reason: "question-words-only",
    label: "Question takes only words",
    hint: "Images over Antigravity's question · Remove them",
  },
  {
    reason: "no-paste",
    label: "Screen not ready",
    hint: "Says to retry in a moment",
  },
  {
    reason: "ringing",
    label: "Doorbell ringing",
    hint: "Waits behind the ring, then goes",
  },
  {
    reason: null,
    label: "No reason given",
    hint: "Says to check the terminal · Open terminal",
  },
]

// Wraps the demo's conversations so a failure armed from the panel meets the next send.
export const createChatFailures = (): {
  readonly wrap: (conversations: Conversations) => Conversations
  readonly actions: readonly DemoAction[]
} => {
  let armed: ConflictReason | null | undefined
  // How the next Stop fails: its queued words left in the box, or a request waiting.
  let stopping: "not-cleared" | "pending" | undefined
  return {
    wrap: (conversations) => {
      // Whether a request armed as waiting gives way: the person's own Send or Stop is over a
      // question the agent asks, which the runner sets aside.
      const givesWay = (key: TerminalKey, setAside?: readonly string[]): boolean =>
        conversations
          .conversation(key)
          .getSnapshot()
          .requests.some((request) => openQuestion(request) && setAside?.includes(request.id))
      return {
        ...conversations,
        send: async (key, text, options) => {
          const reason = armed
          armed = undefined
          if (reason !== undefined && !(reason === "pending" && givesWay(key, options?.setAside)))
            throw conflictFailure(reason ?? undefined, "send")
          return conversations.send(key, text, options)
        },
        interrupt: async (key, options) => {
          const failing = stopping
          stopping = undefined
          if (failing === "not-cleared") throw notCleared()
          if (failing === "pending" && !givesWay(key, options?.setAside))
            throw conflictFailure("pending", "stop")
          return conversations.interrupt(key, options)
        },
      }
    },
    actions: [
      ...failures.map(({ reason, label, hint }) => ({
        label,
        hint,
        run: () => {
          armed = reason
        },
      })),
      {
        label: "Stop: queued words stay",
        hint: "Queued words stay in the box · Open terminal",
        run: () => {
          stopping = "not-cleared"
        },
      },
      {
        label: "Stop: request waiting",
        hint: "Says to answer it first",
        run: () => {
          stopping = "pending"
        },
      },
    ],
  }
}
