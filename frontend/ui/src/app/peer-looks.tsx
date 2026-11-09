import type { PeerLooks } from "@novadeck/chat/Transcript"
import type { MessagePeer } from "@novadeck/core/messages"
import { Avatar } from "@novadeck/items/Avatar"
import { hueOf } from "@novadeck/items/critters"
import { usePeers, type MessageLinks } from "@novadeck/items/messages"
import { useMemo } from "react"

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
