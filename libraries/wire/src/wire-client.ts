import { createORPCClient } from "@orpc/client"
import { StandardRPCLink, type StandardLinkClient } from "@orpc/client/standard"
import type { AnyContractRouter, ContractRouterClient } from "@orpc/contract"
import { ClientPeer } from "@orpc/standard-server-peer"

import type { Channel } from "./channel.js"
import { WireError } from "./errors.js"

const disconnected = () => new WireError("DISCONNECTED", "The connection is closed.")

/**
 * Speaks the oRPC peer protocol over a channel, as a client of contract `C`. Requests fail
 * and streams end once the channel closes.
 */
export const createWireClient = <C extends AnyContractRouter>(
  channel: Channel,
): ContractRouterClient<C> => {
  // Closes the channel first, so whoever reads the peer's failures finds it closed, then fails
  // what's in flight as a lost connection, with what broke it as the cause.
  const broken = (message: string) => (cause: unknown) => {
    channel.close()
    peer.close({ reason: new WireError("DISCONNECTED", message, { cause }) })
  }
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
      broken("The connection can't send.")(error)
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
      // A message it can't read leaves the stream out of step: end the channel, to be replaced.
      .catch(broken("The server sent a message the client couldn't read."))
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
