import type { Channel, MessagePortLike } from "./channel.js"

// Test support: channels held in memory, for tests of a client or a server that need no
// real socket or port.

/**
 * Two ends of a message channel held in memory: what one end posts, the other receives on
 * a microtask, cloned as a real port would. Nothing waits on a task queue, so a client and
 * the server it reaches trade messages in the same order every run. Closing either end
 * closes both, and tells both, as Chromium's and Node's ports do.
 */
export const memoryPorts = (): readonly [MessagePortLike, MessagePortLike] => {
  const ends = [0, 1].map(() => ({
    message: new Set<(event: { data: unknown }) => void>(),
    close: new Set<() => void>(),
    open: true,
  }))
  const port = (own: (typeof ends)[number], peer: (typeof ends)[number]): MessagePortLike => ({
    postMessage: (message) => {
      if (!own.open || !peer.open) return
      const data = structuredClone(message)
      queueMicrotask(() => {
        if (peer.open) for (const listener of peer.message) listener({ data })
      })
    },
    start: () => {},
    close: () => {
      if (!own.open) return
      own.open = false
      peer.open = false
      for (const listener of [...own.close, ...peer.close]) listener()
    },
    addEventListener: (type: "message" | "close", listener: never) => {
      own[type].add(listener)
    },
  })
  return [port(ends[0]!, ends[1]!), port(ends[1]!, ends[0]!)]
}

/** A channel whose far end is the test. */
export type FakeChannel = {
  readonly channel: Channel
  /** What was sent on the channel, in order. */
  readonly sent: readonly (string | Uint8Array<ArrayBuffer>)[]
  /** Delivers `data` to the channel's listener, as if the far end sent it. */
  receive(data: unknown): void
  /** Closes the channel from the far end. */
  drop(): void
  /** Makes every later send throw `error`, as a socket that broke without closing does. */
  failSends(error: unknown): void
}

export const fakeChannel = (): FakeChannel => {
  const sent: (string | Uint8Array<ArrayBuffer>)[] = []
  const listeners: ((data: unknown) => void)[] = []
  let open = true
  let failure: { readonly error: unknown } | undefined
  let settle: (() => void) | undefined
  const closed = new Promise<void>((resolve) => {
    settle = () => {
      open = false
      resolve()
    }
  })
  return {
    channel: {
      get open() {
        return open
      },
      send: (message) => {
        if (failure) throw failure.error
        sent.push(message)
      },
      listen: (receive) => void listeners.push(receive),
      closed,
      close: () => settle?.(),
    },
    sent,
    receive: (data) => {
      for (const listener of listeners) listener(data)
    },
    drop: () => settle?.(),
    failSends: (error) => {
      failure = { error }
    },
  }
}
