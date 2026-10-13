import {
  conflictFailure,
  type ConflictReason,
  type Conversations,
  notCleared,
} from "../../../model/conversation"
import type { DemoAction } from "./types"

// The ways the runner turns a chat's send away, which the demo's agents never do of their
// own accord: one can be armed for the next send, which fails as the runner's would. The
// next Stop can be armed to fail as the runner's does when the queued words stay in the
// box, or when a request waits on the person.
const failures: readonly {
  // No reason: as an older runner, or one this client doesn't know, says nothing of why.
  readonly reason: ConflictReason | null
  readonly label: string
  readonly hint: string
}[] = [
  {
    reason: "draft",
    label: "Draft in the box",
    hint: "Words back in the box · Open terminal",
  },
  {
    reason: "shell",
    label: "Box in shell mode",
    hint: "Offers Open terminal",
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
    reason: "no-paste",
    label: "Screen not ready",
    hint: "Says to retry in a moment",
  },
  {
    reason: "ringing",
    label: "Doorbell ringing",
    hint: "Says to retry in a moment",
  },
  {
    reason: null,
    label: "No reason given",
    hint: "Says to check the terminal · Open terminal",
  },
]

// Wraps the demo's conversations so a failure armed from the panel meets the next send.
export const createDebugChat = (): {
  readonly wrap: (conversations: Conversations) => Conversations
  readonly actions: readonly DemoAction[]
} => {
  let armed: ConflictReason | null | undefined
  // How the next Stop fails: its queued words left in the box, or a request waiting.
  let stopping: "not-cleared" | "pending" | undefined
  return {
    wrap: (conversations) => ({
      ...conversations,
      send: async (key, text) => {
        const reason = armed
        armed = undefined
        if (reason !== undefined) throw conflictFailure(reason ?? undefined, "send")
        return conversations.send(key, text)
      },
      interrupt: async (key) => {
        const failing = stopping
        stopping = undefined
        if (failing === "not-cleared") throw notCleared()
        if (failing === "pending") throw conflictFailure("pending", "stop")
        return conversations.interrupt(key)
      },
    }),
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
