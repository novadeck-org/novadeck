import { mailPeers } from "@novadeck/core/derivations"
import { letterItem } from "@novadeck/core/inbox"
import { samePeers } from "@novadeck/core/messages"
import type { MailLinks } from "@novadeck/items/mail"
import { useMemo } from "react"

import { useInboxOpener } from "../inbox/InboxProvider"
import { useWorkspaceServices, useWorkspaceState } from "./controller/context"

// What a terminal's Messages pane knows of the session around it: the other terminals by
// handle, a way to each, and Answer on a letter, which opens the Inbox on its item.
export const useMailLinks = (terminalId: string): MailLinks => {
  const { commands } = useWorkspaceServices()
  const peers = useWorkspaceState(mailPeers, samePeers)
  const openInbox = useInboxOpener()
  return useMemo(
    () => ({
      peer: (handle) => peers[handle],
      goTo: commands.reveal,
      answer: (letter) => {
        commands.showInbox()
        openInbox?.((items) => letterItem(items, letter, terminalId))
      },
    }),
    [peers, commands, openInbox, terminalId],
  )
}
