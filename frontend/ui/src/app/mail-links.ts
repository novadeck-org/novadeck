import { mailPeers } from "@novadeck/core/derivations"
import { letterItem } from "@novadeck/core/inbox"
import { samePeers, type MailPeer } from "@novadeck/core/messages"
import type { Store, WorkspaceStore } from "@novadeck/core/store"
import type { MailLinks } from "@novadeck/items/mail"
import { useMemo } from "react"

import { useInboxOpener } from "../inbox/InboxProvider"
import { useWorkspaceServices } from "./controller/context"
import { revealItem } from "./inbox-landing"

// The session's terminals as messages show them, a new value only when one of them shows
// differently, for the views that draw them to subscribe to.
const peersOf = (workspace: WorkspaceStore): Store<Readonly<Record<string, MailPeer>>> => {
  let last = mailPeers(workspace.getSnapshot())
  return {
    getSnapshot: () => {
      const next = mailPeers(workspace.getSnapshot())
      if (!samePeers(last, next)) last = next
      return last
    },
    subscribe: workspace.subscribe,
  }
}

// What a terminal's Messages pane knows of the session around it: the other terminals by
// handle, a way to each, and Answer on a letter, which opens the Inbox on its item.
export const useMailLinks = (): MailLinks => {
  const { commands, workspace, backend } = useWorkspaceServices()
  const openInbox = useInboxOpener()
  const peers = useMemo(() => peersOf(workspace), [workspace])
  return useMemo(
    () => ({
      peers,
      goTo: commands.reveal,
      answer: (letter) => {
        // The ask may be held back from the Inbox because this terminal is in view: asking
        // to answer it lands it.
        const held = letterItem(backend.inbox?.state.getSnapshot().items ?? [], letter)
        if (held) revealItem(backend.inbox, held.id)
        commands.showInbox()
        openInbox?.((items) => letterItem(items, letter))
      },
    }),
    [peers, commands, openInbox, backend],
  )
}
