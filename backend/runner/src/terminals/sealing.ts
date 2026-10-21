// A saved transcript is masked, then sealed: encrypted with a key the host keeps in the
// system's keychain, so the database file alone, or a backup of it, shows nothing of what a
// terminal printed. The key is the host's to find; where it finds none, no transcript is saved.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

/** What every sealed transcript starts with, and no plain one does; the store tells them apart by it. */
export const sealedPrefix = "v1."

const keyBytes = 32
const nonceBytes = 12
const tagBytes = 16

export type TranscriptSealer = {
  /** Settles once the key came (true) or it is known there is none (false). */
  readonly ready: Promise<boolean>
  /** The text sealed to its terminal; null while there is no key. */
  seal(text: string, terminalId: string): string | null
  /**
   * The text of a sealed value, or null for anything that is not one sealed here for this
   * terminal: another key's, another terminal's, a tampered one, a plain one.
   */
  open(value: string, terminalId: string): string | null
}

/**
 * Seals with AES-256-GCM under `key`: a fresh random nonce each time, and the terminal's id
 * as associated data, so a value moved to another terminal's row does not open. The value is
 * `v1.` and the base64 of nonce, tag, then ciphertext. A key that fails to come, or is not
 * 32 bytes, counts as none.
 */
export const createTranscriptSealer = (
  key: Promise<Uint8Array | null> | undefined,
): TranscriptSealer => {
  let held: Buffer | null = null
  const ready = (key ?? Promise.resolve(null)).then(
    (bytes) => {
      if (bytes?.length !== keyBytes) return false
      held = Buffer.from(bytes)
      return true
    },
    () => false,
  )
  return {
    ready,
    seal(text, terminalId) {
      if (!held) return null
      const nonce = randomBytes(nonceBytes)
      const cipher = createCipheriv("aes-256-gcm", held, nonce)
      cipher.setAAD(Buffer.from(terminalId))
      const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()])
      return sealedPrefix + Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64")
    },
    open(value, terminalId) {
      if (!held || !value.startsWith(sealedPrefix)) return null
      const bytes = Buffer.from(value.slice(sealedPrefix.length), "base64")
      if (bytes.length < nonceBytes + tagBytes) return null
      try {
        const decipher = createDecipheriv("aes-256-gcm", held, bytes.subarray(0, nonceBytes))
        decipher.setAAD(Buffer.from(terminalId))
        decipher.setAuthTag(bytes.subarray(nonceBytes, nonceBytes + tagBytes))
        return Buffer.concat([
          decipher.update(bytes.subarray(nonceBytes + tagBytes)),
          decipher.final(),
        ]).toString("utf8")
      } catch {
        return null
      }
    },
  }
}

/**
 * Whether transcripts can be kept, as a client is told: false once it is known there is no
 * key; true when it came, and while it is still awaited past `waitMs`, as a keychain prompt
 * the person has yet to answer usually ends in one.
 */
export const transcriptsAvailable = async (
  sealer: TranscriptSealer,
  waitMs = 1_000,
): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const waiting = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), waitMs)
  })
  try {
    return await Promise.race([sealer.ready, waiting])
  } finally {
    clearTimeout(timer)
  }
}
