import { ChatView } from "@novadeck/chat/ChatView"
import type { PeerLooks } from "@novadeck/chat/Transcript"
import type { MessagePeer } from "@novadeck/core/messages"
import { Avatar } from "@novadeck/items/Avatar"
import { hueOf } from "@novadeck/items/critters"
import { usePeers, type MessageLinks } from "@novadeck/items/messages"
import type { Mention } from "@novadeck/toolkit/mentions"
import { useMemo, type ComponentProps } from "react"

import { useWindowPhase } from "../terminals/window-phase"

// The chat's face, name and hue for another Novadeck agent, as the Messages pane draws it: its
// avatar (blinking at rest, hopping at work, dim once gone) in the gutter, and "program ·
// terminal" where it runs. An agent no terminal of the session answers to has no look.
export const peerLooksOf =
  (peers: Readonly<Record<string, MessagePeer>>): PeerLooks =>
  (handle) => {
    // An own key only: `constructor` and `toString` are no handles.
    const peer = Object.hasOwn(peers, handle) ? peers[handle] : undefined
    if (!peer) return null
    return {
      face: <Avatar handle={handle} size={24} live={peer.live} program={peer.program} />,
      where: [peer.program, peer.name].filter(Boolean).join(" · ") || null,
      hue: hueOf(handle),
    }
  }

// The hue of the agent a handle names in the words, where a terminal answers to it. Its identity
// changes only with the set of handles, not as agents start or stop work, so words that only
// name agents aren't drawn again for that.
export const usePeerMention = (links: MessageLinks): Mention => {
  const peers = usePeers(links)
  const key = Object.keys(peers).toSorted().join("\n")
  return useMemo(() => {
    const known = new Set(key.split("\n"))
    return (handle) => (known.has(handle) ? hueOf(handle) : null)
  }, [key])
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
}: Omit<
  ComponentProps<typeof ChatView>,
  "peerLooks" | "peerMention" | "personFace" | "windowPhase"
> & {
  readonly links: MessageLinks
}): React.JSX.Element => (
  <ChatView
    {...chat}
    peerLooks={usePeerLooks(links)}
    peerMention={usePeerMention(links)}
    personFace={personFace}
    windowPhase={useWindowPhase()}
  />
)
