// A device's own credential: `ndd_<id>_<secret>`, where `id` is 16 random bytes and `secret`
// 32, each in base64url. The id is public, the key the runner looks the device up by, so no
// comparison runs over every device; the secret is what proves it, of which the runner keeps
// only a hash.
//
// The hash is SHA-256, not a slow key derivation, and not keyed: the secret is 256 random
// bits, so no guess at it from a leaked hash can succeed, however fast each guess is, and a
// key kept apart from the database would guard nothing a leaked database doesn't already
// show. The id and a label go into it, so a hash proves only the one secret of the one device.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

const prefix = "ndd_"
const shape = /^ndd_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/

/** A credential as its parts. */
export type Credential = { readonly id: string; readonly secret: string }

/** A new device's credential, its id and its secret, from the system's random source. */
export const mintCredential = (): Credential & { readonly token: string } => {
  const id = randomBytes(16).toString("base64url")
  const secret = randomBytes(32).toString("base64url")
  return { id, secret, token: `${prefix}${id}_${secret}` }
}

/** The parts of a token that has a credential's shape, or `undefined` for any other. */
export const readCredential = (token: string | undefined): Credential | undefined => {
  const parts = token === undefined ? null : shape.exec(token)
  return parts ? { id: parts[1]!, secret: parts[2]! } : undefined
}

/** What the runner keeps of a credential: 32 bytes. */
export const secretHash = ({ id, secret }: Credential): Buffer =>
  createHash("sha256").update(`novadeck device credential\0${id}\0${secret}`).digest()

// Compared against when the id is unknown, so the answer takes as long either way.
const absent = Buffer.alloc(32)

/** Whether `credential` is the one `kept` is the hash of, in constant time. */
export const proves = (credential: Credential, kept: Uint8Array | undefined): boolean => {
  const given = secretHash(credential)
  const against = kept?.byteLength === 32 ? Buffer.from(kept) : absent
  return timingSafeEqual(given, against) && kept !== undefined
}
