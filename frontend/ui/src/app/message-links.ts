import { messagePeers } from "@novadeck/core/derivations"
import { entryRow } from "@novadeck/core/inbox"
import { samePeers, type MessagePeer } from "@novadeck/core/messages"
import type { Store, WorkspaceStore } from "@novadeck/core/store"
import type { MessageLinks } from "@novadeck/items/messages"
import { useMemo } from "react"

import { useInboxOpener } from "../inbox/InboxProvider"
import { useWorkspaceServices } from "./controller/context"

// The session's terminals as messages show them, a new value only when one of them shows
// differently, for the views that draw them to subscribe to.
const peersOf = (workspace: WorkspaceStore): Store<Readonly<Record<string, MessagePeer>>> => {
  let last = messagePeers(workspace.getSnapshot())
  return {
    getSnapshot: () => {
      const next = messagePeers(workspace.getSnapshot())
      if (!samePeers(last, next)) last = next
      return last
    },
    subscribe: workspace.subscribe,
  }
}

// What a terminal's Messages pane knows of the session around it: the other terminals by
// handle, a way to each, and Answer on an entry, which opens the Inbox on its item.
export const useMessageLinks = (): MessageLinks => {
  const { commands, workspace, backend, landing } = useWorkspaceServices()
  const openInbox = useInboxOpener()
  const peers = useMemo(() => peersOf(workspace), [workspace])
  return useMemo(
    () => ({
      peers,
      goTo: commands.reveal,
      answer: (entry) => {
        // The ask may be held back from the Inbox because this terminal is in view: asking
        // to answer it lands it.
        const held = entryRow(backend.inbox?.state.getSnapshot().items ?? [], entry)
        if (held) landing.reveal(held.id)
        commands.showInbox()
        openInbox?.((items) => entryRow(items, entry))
      },
    }),
    [peers, commands, openInbox, backend, landing],
  )
}
