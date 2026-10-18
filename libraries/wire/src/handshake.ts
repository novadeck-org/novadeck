import { oc } from "@orpc/contract"
import { z } from "zod"

import { wireErrors } from "./errors.js"

/**
 * Opens a session: the first call on every connection, before any other is served. A server
 * may refuse it with a code of its own, after authenticating, as one that can't serve yet.
 */
export const handshake = oc
  .errors(wireErrors)
  .input(
    z.strictObject({
      protocolVersion: z.number().int(),
      // Trusted transports, such as a host-provided MessagePort, need no token.
      token: z.string().min(1).max(512).optional(),
      // Stable per client across reconnections. A new connection with the same client ID
      // takes over from the old one, even if that one is still half-open.
      clientId: z.uuid().optional(),
    }),
  )
  .output(
    z.strictObject({
      // The server's lifetime: whatever a client resumes belongs to one epoch.
      epoch: z.string().min(1),
      protocolVersion: z.number().int(),
    }),
  )

/** The wire's own procedures, which an app spreads into its contract beside its own. */
export const wireContract = { wire: { handshake } }

export type WireContract = typeof wireContract
