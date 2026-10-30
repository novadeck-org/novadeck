import { terminalKeyPath } from "@novadeck/core/items"
import type { Backend, TerminalKey } from "@novadeck/core/port"
import { isDemoMessages, type DemoMessages } from "@novadeck/demo/messages"

import type { DemoActionGroup } from "./types"

// Has `from` write to the selected terminal, by handle; false where it has no messages, or
// none from a peer when `from` is left to it.
const writeTo = (
  messages: DemoMessages,
  key: TerminalKey | undefined,
  from: (handle: string, peers: readonly string[]) => string | undefined,
  text: string,
): boolean => {
  const terminalMessages = key && messages.state.getSnapshot().terminals[terminalKeyPath(key)]
  if (!key || !terminalMessages) return false
  const peers = terminalMessages.threads.flatMap((thread) =>
    thread.peer.kind === "person" ? [] : [thread.peer.handle],
  )
  const sender = from(terminalMessages.handle, peers)
  return Boolean(
    sender &&
    messages.send(
      { projectId: key.projectId, workspaceSessionId: key.workspaceSessionId },
      sender,
      terminalMessages.handle,
      text,
    ),
  )
}

// The panel's group for what a terminal's Messages pane shows that the demo's agents don't
// send by themselves: news from a peer since the person last opened its conversation, and
// a handle a later round gave again, with its number. Only the demo's messages can be sent.
export const messageGroups = (messages: Backend["messages"]): readonly DemoActionGroup[] =>
  isDemoMessages(messages)
    ? [
        {
          section: "Agents",
          title: "Messages",
          actions: [
            {
              label: "News from a peer",
              hint: "The selected terminal's latest peer writes to it: its row in Messages says Unread until opened",
              run: ({ selected, note }) => {
                if (
                  !writeTo(
                    messages,
                    selected(),
                    (_, peers) => peers[0],
                    "Done on my side. Anything else before I move on?",
                  )
                )
                  note("Select a terminal with messages from a peer first (?demo=messages).")
              },
            },
            {
              label: "News from a repeated handle",
              hint: "A terminal whose word came round again (its handle ends in z) writes to the selected one: its critter in Messages is its word's",
              run: ({ selected, note }) => {
                if (
                  !writeTo(
                    messages,
                    selected(),
                    (handle) => `${handle === "moth" ? "fox" : "moth"}z`,
                    "Picked up where the last round left off.",
                  )
                )
                  note("Select a terminal in the messages demo first (?demo=messages).")
              },
            },
          ],
        },
      ]
    : []
