import { z } from "zod"

import { singleLine } from "./text.js"

// Devices with credentials of their own, which reach a standalone runner beside the owner's
// token (NOVADECK_TOKEN) and are revoked one at a time (dev-docs/backend-api.md, "Devices").

// How many devices a runner keeps credentials for at once; revoked ones don't count.
export const maxDevices = 64

/** A device's id: 16 random bytes in base64url, the public part of its credential. */
export const deviceId = z.string().regex(/^[A-Za-z0-9_-]{22}$/)

/** What the person calls a device, as "Phone": one line, 1 to 64 characters. */
export const deviceName = z.string().trim().min(1).max(64).regex(singleLine)

/** A device as the runner lists it; never its credential, which only `mint` answers, once. */
export const device = z.strictObject({
  id: deviceId,
  name: deviceName,
  // When it was minted, and when a session of it last proved itself or ended, in epoch ms.
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
  // Whether a session of it is open now.
  connected: z.boolean(),
})

/** A device just minted, with the credential it reaches the runner by: shown once, kept nowhere. */
export const mintedDevice = z.strictObject({
  device,
  // `ndd_<id>_<secret>`, given as the handshake's token.
  credential: z.string().min(1).max(512),
})

export type Device = z.infer<typeof device>
export type MintedDevice = z.infer<typeof mintedDevice>
