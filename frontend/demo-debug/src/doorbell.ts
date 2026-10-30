import type { MessageWaits } from "@novadeck/core/messages"
import type { Backend } from "@novadeck/core/port"

import type { DemoActionGroup } from "./types"

const states: readonly {
  readonly label: string
  readonly waits: MessageWaits | null
  readonly hint: string
}[] = [
  {
    label: "Working",
    waits: "working",
    hint: "Messages pane says the agent is working, so its messages wait",
  },
  {
    label: "Prompt queued",
    waits: "queued",
    hint: "Messages pane says a prompt is queued in the agent, so its messages wait",
  },
  {
    label: "Shell mode",
    waits: "shell",
    hint: "Messages pane says the agent's box is in shell mode, so its messages wait",
  },
  {
    label: "Text in its box",
    waits: "draft",
    hint: "Messages pane says there's text in the agent's box, so its messages wait",
  },
  {
    label: "Dialog open",
    waits: "dialog",
    hint: "Messages pane says a dialog or picker is open, so its messages wait",
  },
  {
    label: "Asking the person",
    waits: "asking",
    hint: "Messages pane says the agent is asking you a question, so its messages wait",
  },
  {
    label: "Doorbell failed",
    waits: "failed",
    hint: "Messages pane says the doorbell failed three times, so its messages wait",
  },
  {
    label: "Terminal away from the prompt",
    waits: "away",
    hint: "Messages pane says the terminal isn't at the agent's prompt, so its messages wait",
  },
  {
    label: "Doorbell can ring",
    waits: null,
    hint: "The pane's note goes: nothing keeps the doorbell from ringing the agent",
  },
]

// The panel's group for why the doorbell can't ring the selected terminal's idle agent, shown
// in its Messages pane while messages wait for it. Only the demo's messages can be put there.
export const doorbellGroups = (messages: Backend["messages"]): readonly DemoActionGroup[] =>
  messages?.waits
    ? [
        {
          section: "Agents",
          title: "Doorbell",
          actions: states.map(({ label, waits, hint }) => ({
            label,
            hint,
            run: ({ selected, note }) => {
              const key = selected()
              if (!key || !messages.waits!(key, waits))
                note("Select a terminal in the messages demo first (?demo=messages).")
            },
          })),
        },
      ]
    : []
