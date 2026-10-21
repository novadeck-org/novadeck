import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Log } from "@novadeck/log"
import { afterEach, beforeEach } from "vitest"

import { context, describe, expect, it } from "../test"
import { loadTranscriptKey, type KeyStorage } from "./transcript-key"

const silent = new Proxy({} as Log, { get: () => () => {} })

// A secret store that "wraps" by reversing the text, which is enough to tell wrapped from not.
// Tagged `v11` as a Linux keyring's ciphertext is.
const wrap = (text: string) => Buffer.from(`v11${text.split("").toReversed().join("")}`)
const unwrap = (data: Buffer) => data.toString().slice(3).split("").toReversed().join("")

const storeWith = (options: Partial<KeyStorage> = {}): KeyStorage => ({
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (text) => wrap(text),
  decryptStringAsync: async (data) => ({ result: unwrap(data), shouldReEncrypt: false }),
  getSelectedStorageBackend: () => "gnome_libsecret",
  ...options,
})

let directory: string
let file: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "novadeck-transcript-key-"))
  file = join(directory, "transcript-key")
})
afterEach(() => rm(directory, { recursive: true, force: true }))

const load = (storage: KeyStorage, platform: NodeJS.Platform = "linux") =>
  loadTranscriptKey({ storage, platform, file, log: silent })

const isKey = (key: string | null) => key !== null && Buffer.from(key, "base64").length === 32

describe("the transcript key", () => {
  it("is made on the first run and kept wrapped", async () => {
    const key = await load(storeWith())
    expect(isKey(key)).toBe(true)
    const kept = await readFile(file)
    expect(kept.toString()).not.toContain(key as string)
    expect(unwrap(kept)).toBe(key)
    expect(await readdir(directory)).toEqual(["transcript-key"])
  })

  it("is the same on the next run", async () => {
    const first = await load(storeWith())
    expect(await load(storeWith())).toBe(first)
  })

  it.skipIf(process.platform === "win32")("is kept readable by its owner alone", async () => {
    await load(storeWith())
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it("is wrapped again when the store asks, and stays the same", async () => {
    const first = await load(storeWith())
    const rewrapped = (text: string) => Buffer.from(`v11new:${text}`)
    const key = await load(
      storeWith({
        encryptStringAsync: async (text) => rewrapped(text),
        decryptStringAsync: async (data) => ({ result: unwrap(data), shouldReEncrypt: true }),
      }),
    )
    expect(key).toBe(first)
    expect(await readFile(file)).toEqual(rewrapped(first as string))
  })

  context("when the file holds no key", () => {
    it("is replaced with a new key when it does not decrypt to one", async () => {
      await writeFile(file, wrap("not a key"))
      const key = await load(storeWith())
      expect(isKey(key)).toBe(true)
      expect(unwrap(await readFile(file))).toBe(key)
    })

    it("is replaced when it cannot be decrypted, if the new key can be wrapped", async () => {
      const first = await load(storeWith())
      const key = await load(
        storeWith({
          decryptStringAsync: async () => {
            throw new Error("reset")
          },
        }),
      )
      expect(isKey(key)).toBe(true)
      expect(key).not.toBe(first)
      expect(unwrap(await readFile(file))).toBe(key)
    })

    it("is null, with the file untouched, when a new key cannot be wrapped either", async () => {
      await writeFile(file, "old wrapped key")
      const key = await load(
        storeWith({
          decryptStringAsync: async () => {
            throw new Error("reset")
          },
          encryptStringAsync: async () => {
            throw new Error("refused")
          },
        }),
      )
      expect(key).toBeNull()
      expect(await readFile(file, "utf8")).toBe("old wrapped key")
      expect(await readdir(directory)).toEqual(["transcript-key"])
    })

    it("is null, with the file untouched and nothing wrapped, when the file cannot be read", async () => {
      await writeFile(file, wrap("kept"))
      let wrapped = 0
      const key = await loadTranscriptKey(
        {
          storage: storeWith({
            encryptStringAsync: async (text) => {
              wrapped += 1
              return wrap(text)
            },
          }),
          platform: "linux",
          file,
          log: silent,
        },
        {
          readFile: async () => {
            throw Object.assign(new Error("denied"), { code: "EACCES" })
          },
          writeFile,
          rename,
          rm,
        },
      )
      expect(key).toBeNull()
      expect(wrapped).toBe(0)
      expect(await readFile(file)).toEqual(wrap("kept"))
      expect(await readdir(directory)).toEqual(["transcript-key"])
    })

    it("is null on a first run that cannot wrap, and leaves no file", async () => {
      const key = await load(
        storeWith({
          encryptStringAsync: async () => {
            throw new Error("cancelled")
          },
        }),
      )
      expect(key).toBeNull()
      expect(await readdir(directory)).toEqual([])
    })
  })

  context("on Linux when the keyring fell back to a hard-coded password", () => {
    const fallback = (text: string) => Buffer.from(`v10${text}`)

    it("is null, with no file, when the key is wrapped as v10", async () => {
      const key = await load(storeWith({ encryptStringAsync: async (text) => fallback(text) }))
      expect(key).toBeNull()
      expect(await readdir(directory)).toEqual([])
    })

    it("does not reuse a kept key that is not v11, and makes a new one", async () => {
      await writeFile(file, fallback("whatever"))
      const decrypted = { result: Buffer.alloc(32).toString("base64"), shouldReEncrypt: false }
      const key = await load(storeWith({ decryptStringAsync: async () => decrypted }))
      expect(key).not.toBe(decrypted.result)
      expect(isKey(key)).toBe(true)
      expect(unwrap(await readFile(file))).toBe(key)
    })

    it("keeps the v11 file when a rewrap comes back v10, and still uses the key", async () => {
      const first = await load(storeWith())
      const before = await readFile(file)
      const key = await load(
        storeWith({
          encryptStringAsync: async (text) => fallback(text),
          decryptStringAsync: async (data) => ({ result: unwrap(data), shouldReEncrypt: true }),
        }),
      )
      expect(key).toBe(first)
      expect(await readFile(file)).toEqual(before)
    })

    it.each<NodeJS.Platform>(["darwin", "win32"])("works with v10 on %s", async (platform) => {
      const key = await load(
        storeWith({
          encryptStringAsync: async (text) =>
            Buffer.from(`v10${text.split("").toReversed().join("")}`),
          decryptStringAsync: async (data) => ({
            result: data.toString().slice(3).split("").toReversed().join(""),
            shouldReEncrypt: false,
          }),
        }),
        platform,
      )
      expect(isKey(key)).toBe(true)
      expect(
        await load(
          storeWith({
            decryptStringAsync: async (data) => ({
              result: data.toString().slice(3).split("").toReversed().join(""),
              shouldReEncrypt: false,
            }),
          }),
          platform,
        ),
      ).toBe(key)
    })
  })

  context("where the system keeps nothing safe", () => {
    it("is null and untouched when encryption is unavailable", async () => {
      expect(await load(storeWith({ isAsyncEncryptionAvailable: async () => false }))).toBeNull()
      expect(await readdir(directory)).toEqual([])
    })

    it("is null on a Linux with no keyring behind it", async () => {
      const keys = await Promise.all(
        ["basic_text", "unknown"].map((backend) =>
          load(storeWith({ getSelectedStorageBackend: () => backend })),
        ),
      )
      expect(keys).toEqual([null, null])
      expect(await readdir(directory)).toEqual([])
    })

    it.each(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"])(
      "is kept behind the keyring %s",
      async (backend) => {
        expect(isKey(await load(storeWith({ getSelectedStorageBackend: () => backend })))).toBe(
          true,
        )
      },
    )

    it("does not ask for a Linux backend elsewhere", async () => {
      const key = await load(
        storeWith({
          getSelectedStorageBackend: () => {
            throw new Error("Linux only")
          },
        }),
        "darwin",
      )
      expect(isKey(key)).toBe(true)
    })
  })
})
