import { ChatView } from "@novadeck/chat/ChatView"
import type { PeerLooks } from "@novadeck/chat/Transcript"
import type { MessagePeer } from "@novadeck/core/messages"
import { Avatar } from "@novadeck/items/Avatar"
import { hueOf } from "@novadeck/items/critters"
import { usePeers, type MessageLinks } from "@novadeck/items/messages"
import { useMemo, type ComponentProps } from "react"

import { useWindowPhase } from "../terminals/window-phase"

// The chat's face, name and hue for another Novadeck agent, as the Messages pane draws it: its
// avatar (blinking at rest, hopping at work, dim once gone) in the gutter, and "program ·
// terminal" where it runs. An agent no terminal of the session answers to has no look.
export const peerLooksOf =
  (peers: Readonly<Record<string, MessagePeer>>): PeerLooks =>
  (handle) => {
    const peer = peers[handle]
    if (!peer) return null
    return {
      face: <Avatar handle={handle} size={24} live={peer.live} program={peer.program} />,
      where: [peer.program, peer.name].filter(Boolean).join(" · ") || null,
      hue: hueOf(handle),
    }
  }

export const usePeerLooks = (links: MessageLinks): PeerLooks => {
  const peers = usePeers(links)
  return useMemo(() => peerLooksOf(peers), [peers])
}

// The person's own face at their answers through the Inbox, as Messages draws them: the backlit
// imp, in their hue.
const personFace = <Avatar handle="you" person size={24} />

// The chat with other agents' looks and the person's own face. Only a chat on screen follows the
// peers, which change as any agent starts or stops work: a terminal showing its emulator doesn't
// render again for it.
export const ChatWithPeers = ({
  links,
  ...chat
}: Omit<ComponentProps<typeof ChatView>, "peerLooks" | "personFace" | "windowPhase"> & {
  readonly links: MessageLinks
}): React.JSX.Element => (
  <ChatView
    {...chat}
    peerLooks={usePeerLooks(links)}
    personFace={personFace}
    windowPhase={useWindowPhase()}
  />
)
