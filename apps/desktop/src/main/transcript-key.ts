import { randomBytes, randomUUID } from "node:crypto"
import { readFile, rename, rm, writeFile } from "node:fs/promises"

import type { Log } from "@novadeck/log"

/** The part of Electron's `safeStorage` the key needs: its asynchronous API, and Linux's backend. */
export type KeyStorage = {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plainText: string): Promise<Buffer>
  decryptStringAsync(
    encrypted: Buffer,
  ): Promise<{ readonly result: string; readonly shouldReEncrypt: boolean }>
  getSelectedStorageBackend(): string
}

type Files = {
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, data: Buffer, options: { mode: number }): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(path: string, options: { force: true }): Promise<void>
}

/** The Linux backends that keep a secret behind the person's keyring; any other keeps it in the clear. */
const keyrings: ReadonlySet<string> = new Set([
  "gnome_libsecret",
  "kwallet",
  "kwallet5",
  "kwallet6",
])

const keyBytes = 32

// On Linux, Chromium's async encryption quietly falls back to a provider with a hard-coded
// password when the keyring fails (no service, an unlock prompt dismissed), while
// `isAsyncEncryptionAvailable()` stays true and the backend still names the keyring. The
// only sign is the tag at the start of the ciphertext: `v10` from that fallback, `v11` from
// the Secret Service (GNOME Keyring, or KWallet where it offers the Secret Service). This
// rests on Chromium's internal provider tags, so it must be checked again whenever
// Electron is upgraded. Elsewhere `v10` is the real Keychain or DPAPI key, and the tag
// says nothing.
const keyringTag = Buffer.from("v11")
const behindKeyring = (platform: NodeJS.Platform, wrapped: Buffer): boolean =>
  platform !== "linux" || wrapped.subarray(0, keyringTag.length).equals(keyringTag)

/** Whether `text` is the base64 of a 32-byte key. */
const isKey = (text: string): boolean =>
  /^[A-Za-z0-9+/]{43}=$/.test(text) && Buffer.from(text, "base64").length === keyBytes

/**
 * The key saved transcripts are encrypted with, base64, or null where none can be kept safe:
 * the system's secret store (the Keychain, DPAPI, or a Linux keyring) wraps it, and `file`
 * holds only the wrapped key. A file that is missing, unreadable or no longer decrypts
 * (the store was reset) gets a new key, as the transcripts it protected are then out of
 * reach anyway. A new key that cannot be wrapped, as when a prompt is refused, leaves the
 * file as it was, and the answer is null. A Linux without a keyring, which Electron would
 * wrap with a hard-coded password, is null too. The key is never logged.
 */
export const loadTranscriptKey = async (
  host: {
    readonly storage: KeyStorage
    readonly platform: NodeJS.Platform
    readonly file: string
    readonly log: Log
  },
  files: Files = { readFile, writeFile, rename, rm },
): Promise<string | null> => {
  const { storage, platform, file, log } = host
  if (platform === "linux") {
    const backend = storage.getSelectedStorageBackend()
    if (!keyrings.has(backend)) {
      log.warn(
        "transcript-key.no-keyring",
        "Transcripts are not kept: no keyring protects a key.",
        {
          data: { backend },
        },
      )
      return null
    }
  }
  let failure: unknown
  const available = await storage.isAsyncEncryptionAvailable().catch((error: unknown) => {
    failure = error
    return false
  })
  if (!available) {
    log.warn(
      "transcript-key.unavailable",
      "Transcripts are not kept: the system cannot wrap a key.",
      failure === undefined ? undefined : { err: failure },
    )
    return null
  }
  // Wrapped into a temporary file beside `file`, renamed over it, so a failed write leaves
  // the wrapped key that was there whole.
  const keep = async (key: string): Promise<void> => {
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const wrapped = await storage.encryptStringAsync(key)
      if (!behindKeyring(platform, wrapped))
        throw new Error("The key was not wrapped by a keyring.")
      await files.writeFile(temporary, wrapped, { mode: 0o600 })
      await files.rename(temporary, file)
    } catch (error) {
      await files.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }
  // Only a missing file starts a new key: a file that cannot be read may hold the key every
  // sealed transcript needs, so this launch keeps none and leaves it be.
  let wrapped: Buffer | undefined
  try {
    wrapped = await files.readFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(
        "transcript-key.read-failed",
        "Transcripts are not kept: the wrapped key could not be read.",
        { err: error },
      )
      return null
    }
  }
  let reason: string | undefined = wrapped === undefined ? "missing" : undefined
  try {
    if (wrapped === undefined) throw new Error("No key is kept yet.")
    // A key not wrapped by the keyring is as good as in the clear: not trusted.
    if (!behindKeyring(platform, wrapped)) throw new Error("The kept key is not behind a keyring.")
    const { result, shouldReEncrypt } = await storage.decryptStringAsync(wrapped)
    if (isKey(result)) {
      if (shouldReEncrypt)
        await keep(result).then(
          () => log.info("transcript-key.rewrapped", "The transcript key was wrapped again."),
          (error: unknown) =>
            log.warn("transcript-key.rewrap-failed", "The transcript key was not wrapped again.", {
              err: error,
            }),
        )
      log.info("transcript-key.loaded", "The transcript key was loaded.")
      return result
    }
    reason = "invalid"
  } catch {
    reason ??= "unreadable"
  }
  const key = randomBytes(keyBytes).toString("base64")
  try {
    await keep(key)
  } catch (error) {
    log.warn(
      "transcript-key.not-kept",
      "Transcripts are not kept: a new key could not be wrapped.",
      {
        data: { after: reason },
        err: error,
      },
    )
    return null
  }
  log.info("transcript-key.created", "A new transcript key was made.", { data: { after: reason } })
  return key
}
