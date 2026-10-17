import { createORPCClient } from "@orpc/client"
import { StandardRPCLink, type StandardLinkClient } from "@orpc/client/standard"
import type { AnyContractRouter, ContractRouterClient } from "@orpc/contract"
import { ClientPeer } from "@orpc/standard-server-peer"

import { portChannel, socketChannel, type Channel, type MessagePortLike } from "./channel.js"
import { WireError } from "./errors.js"

/** How a client reaches a server. See `websocket` and `messagePort`. */
export type Transport = {
  /** Sent in the handshake. Trusted transports omit it. */
  readonly token?: string
  /** Opens one channel. Rejects with `CLOSED` when the transport can never connect again. */
  connect(signal: AbortSignal): Promise<Channel>
}

const disconnected = () => new WireError("DISCONNECTED", "The connection is closed.")

/**
 * Speaks the oRPC peer protocol over a channel, as a client of contract `C`. Requests fail
 * and streams end once the channel closes.
 */
export const createWireClient = <C extends AnyContractRouter>(
  channel: Channel,
): ContractRouterClient<C> => {
  // oRPC 1.x's stock adapters can reject an async abort listener after a socket closes.
  // Keep oRPC's wire protocol; settle the peer instead of throwing from the send callback.
  const peer = new ClientPeer((message) => {
    if (!channel.open) {
      peer.close({ reason: disconnected() })
      return
    }
    try {
      channel.send(
        typeof message === "string"
          ? message
          : Uint8Array.from(message instanceof Uint8Array ? message : new Uint8Array(message)),
      )
    } catch (error) {
      // A channel that can't send is done for: close it, so its owner replaces it.
      peer.close({ reason: error })
      channel.close()
    }
  })
  let received = Promise.resolve()
  channel.listen((data) => {
    received = received
      .then(async () => {
        await peer.message(
          data instanceof Blob ? await data.arrayBuffer() : (data as string | ArrayBuffer),
        )
      })
      .catch((error: unknown) => peer.close({ reason: error }))
  })
  void channel.closed.then(() => peer.close({ reason: disconnected() }))

  const transport: StandardLinkClient<Record<never, never>> = {
    async call(request) {
      request.signal?.throwIfAborted()
      if (!channel.open) throw disconnected()
      const response = await peer.request(request)
      return { ...response, body: () => Promise.resolve(response.body) }
    },
  }
  return createORPCClient(new StandardRPCLink(transport, { url: "http://orpc" }))
}

/**
 * Reaches a separately deployed server. The token, if any, travels in the handshake, never
 * in the URL.
 */
export const websocket = (
  url: string | URL,
  options: { readonly token?: string } = {},
): Transport => ({
  ...(options.token !== undefined && { token: options.token }),
  async connect(signal) {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const settle = (error?: unknown) => {
        signal.removeEventListener("abort", abort)
        if (error === undefined) resolve()
        else reject(error)
      }
      const abort = () => {
        socket.close()
        settle(signal.reason)
      }
      signal.addEventListener("abort", abort, { once: true })
      socket.addEventListener("open", () => settle())
      socket.addEventListener("close", () =>
        settle(new WireError("DISCONNECTED", "Could not reach the server.")),
      )
    })
    return socketChannel(socket)
  },
})

/**
 * Reaches a server bundled with its host, such as an Electron utility process. Holding
 * the port is the credential. Pass a function to obtain a fresh port on reconnection;
 * it should give up when `signal` aborts. A single port can't reconnect once it closes.
 */
export const messagePort = (
  port: MessagePortLike | ((signal: AbortSignal) => Promise<MessagePortLike>),
): Transport => {
  let used = false
  return {
    async connect(signal) {
      if (typeof port === "function") return portChannel(await port(signal))
      if (used) throw new WireError("CLOSED", "The MessagePort has closed.")
      used = true
      return portChannel(port)
    },
  }
}
