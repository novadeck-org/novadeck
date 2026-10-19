import { usePresence as useArkPresence } from "@ark-ui/react/presence"

export type Presence = {
  // Whether to render it: while present, and while its closing animation plays.
  readonly mounted: boolean
  // For the element that animates, whose animation ends the closing: its ref, and its
  // data-state, "open" or "closed", for CSS to key the animations on.
  readonly props: {
    readonly ref: (node: HTMLElement | null) => void
    readonly "data-state": string | undefined
  }
}

// Keeps something mounted until its closing CSS animation ends, or at once when it has
// none, as under reduced motion. What is already present when it mounts appears without
// animating, so a view switch or a restore doesn't replay it.
export const usePresence = (present: boolean): Presence => {
  const presence = useArkPresence({
    present,
    lazyMount: true,
    unmountOnExit: true,
    skipAnimationOnMount: true,
  })
  return {
    mounted: !presence.unmounted,
    props: { ref: presence.ref, "data-state": presence.getPresenceProps()["data-state"] },
  }
}
