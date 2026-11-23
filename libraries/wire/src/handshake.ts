import { oc } from "@orpc/contract"
import { z } from "zod"

import { wireErrors } from "./errors.js"

/**
 * Opens a session: the first call on every connection, before any other is served. A server
 * may refuse it with a code of its own, after authenticating, as one that can't serve yet.
 *
 * Its two objects drop keys they don't know instead of refusing them, unlike the app's: the
 * handshake is what a client and server of different builds speak first, so either may add
 * to it. `protocolVersion` is each side's revision of the app's contract; the server refuses
 * a client older than it serves (`INCOMPATIBLE_PROTOCOL`, with its window as the data), and
 * the client one older than it works with.
 */
const handshake = oc
  .errors(wireErrors)
  .input(
    z.object({
      protocolVersion: z.number().int(),
      // Trusted transports, such as a MessagePort the app hands over, need no token.
      token: z.string().min(1).max(512).optional(),
      // Stable per client across reconnections. A new connection with the same client ID
      // takes over from the old one, even if that one is still half-open.
      clientId: z.uuid().optional(),
    }),
  )
  .output(
    z.object({
      // The server's lifetime: whatever a client resumes belongs to one epoch.
      epoch: z.string().min(1),
      protocolVersion: z.number().int(),
      // The device whose own credential the token was; none for the owner's, or a trusted
      // transport's.
      device: z
        .object({ id: z.string().min(1).max(64), name: z.string().min(1).max(64) })
        .optional(),
    }),
  )

/** The wire's own procedures, which an app spreads into its contract beside its own. */
export const wireContract = { wire: { handshake } }

export type WireContract = typeof wireContract
