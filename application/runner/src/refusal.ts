import { contract, protocolVersion } from "@novadeck/protocol"
import { implement } from "@orpc/server"

import type { Connection } from "./router.js"

/**
 * The router of a runner that cannot open its workspace because a newer Novadeck wrote it:
 * a client that proves itself is told so, and nothing else is served. The runner stays up,
 * so a client that retries is told again instead of finding a process that crashed.
 */
export const createRefusal = () => {
  const api = implement({ runner: contract.runner }).$context<{ connection: Connection }>()
  return api.router({
    runner: {
      handshake: api.runner.handshake.handler(({ input, context, errors }) => {
        const connection = context.connection
        if (connection.closed || !connection.verify(input.token)) throw errors.UNAUTHORIZED()
        if (input.protocolVersion !== protocolVersion) throw errors.INCOMPATIBLE_PROTOCOL()
        throw errors.WORKSPACE_TOO_NEW()
      }),
    },
  })
}
