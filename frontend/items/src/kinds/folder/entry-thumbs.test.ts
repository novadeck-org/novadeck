import type { FilePart } from "@novadeck/core/items"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import { entryThumbRenderer, registerEntryThumb, unregisterEntryThumb } from "./entry-thumbs"
import { createQueue, hasNoThumb, holdThumb, loadThumb } from "./thumbs"

// URLs as the page makes them, and which were revoked.
let made = 0
const urls = () => {
  const revoked: string[] = []
  vi.stubGlobal("URL", {
    createObjectURL: () => `blob:${(made += 1)}`,
    revokeObjectURL: (url: string) => revoked.push(url),
  })
  return revoked
}

const read = async (offset: number): Promise<FilePart> => ({
  state: "part",
  bytes: new Uint8Array([offset, 7]),
})

const load = (index: number, signal = new AbortController().signal) =>
  loadThumb({ key: `model:${index}`, kind: "audio", name: `${index}.glb`, size: 2, read, signal })

describe("what a kind registers to draw its files in a folder's grid", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    // What a test registered is not another's.
    unregisterEntryThumb("audio")
  })

  context("a registered renderer", () => {
    it("is given the file, its box and a way to read it, and its picture is kept as a URL with its length", async () => {
      urls()
      const asked: unknown[] = []
      registerEntryThumb("audio", async (file, box, _signal) => {
        const part = await file.read(0, new AbortController().signal)
        asked.push([file.name, file.size, box, part])
        return { blob: new Blob(["drawn"]), duration: 12 }
      })
      const thumb = await load(1)
      expect(thumb).toEqual({ url: expect.stringMatching(/^blob:/), duration: 12 })
      expect(asked).toEqual([
        ["1.glb", 2, { width: 320, height: 200 }, { state: "part", bytes: new Uint8Array([0, 7]) }],
      ])
    })

    it("shows the kind's icon where it answers null", async () => {
      const revoked = urls()
      registerEntryThumb("audio", async () => null)
      expect(await load(2)).toBeUndefined()
      expect(revoked).toEqual([])
    })

    it("shows the icon of a kind that registered none", async () => {
      expect(entryThumbRenderer("other")).toBeUndefined()
      expect(
        await loadThumb({
          key: "none",
          kind: "other",
          name: "x",
          size: 1,
          read,
          signal: new AbortController().signal,
        }),
      ).toBeUndefined()
    })

    it("is stopped when its picture is no longer wanted, and makes no URL", async () => {
      urls()
      let seen: AbortSignal | undefined
      registerEntryThumb("audio", (_file, _box, signal) => {
        seen = signal
        return new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve({ blob: new Blob(["late"]) })),
        )
      })
      const stop = new AbortController()
      const loading = load(3, stop.signal)
      stop.abort()
      expect(await loading).toBeUndefined()
      expect(seen?.aborted).toBe(true)
    })

    it("is asked once for a file as its stamp names it, whether it drew a picture or not", async () => {
      urls()
      let asked = 0
      registerEntryThumb("audio", async () => {
        asked += 1
        return null
      })
      const key = "once:1"
      const ask = () =>
        loadThumb({
          key,
          kind: "audio",
          name: "a.glb",
          size: 2,
          read,
          signal: new AbortController().signal,
        })
      expect(hasNoThumb(key)).toBe(false)
      expect(await ask()).toBeUndefined()
      // What the grid does on each scroll back: it looks before it asks.
      expect(hasNoThumb(key)).toBe(true)
      expect(asked).toBe(1)
      // A file that changed has another key, and is asked.
      expect(hasNoThumb("once:2")).toBe(false)
    })

    it("is not remembered as having no picture where it was only stopped", async () => {
      urls()
      registerEntryThumb("audio", () => new Promise(() => {}))
      const stop = new AbortController()
      const loading = loadThumb({
        key: "stopped:1",
        kind: "audio",
        name: "a.glb",
        size: 2,
        read,
        signal: stop.signal,
      })
      stop.abort()
      expect(await loading).toBeUndefined()
      expect(hasNoThumb("stopped:1")).toBe(false)
    })

    it("is stopped at its deadline, which frees the queue whatever it does", async () => {
      urls()
      const signals: AbortSignal[] = []
      // Three that never settle and ignore their signal, as a loader stuck on WebGL does.
      registerEntryThumb("audio", (_file, _box, signal) => {
        signals.push(signal)
        return new Promise(() => {})
      })
      const queue = createQueue(3)
      const ran: string[] = []
      const job = (name: string) => (signal: AbortSignal) =>
        loadThumb({
          key: `hung:${name}`,
          kind: "audio",
          name,
          size: 2,
          read,
          signal,
          deadline: 50,
        }).then(() => void ran.push(name))
      for (const name of ["a", "b", "c", "d", "e"]) queue.want(() => 0, job(name))
      await vi.waitFor(() => expect(ran).toHaveLength(5))
      expect(signals.slice(0, 3).every((signal) => signal.aborted)).toBe(true)
      // What it never drew is not asked for again.
      expect(hasNoThumb("hung:a")).toBe(true)
    })

    context(
      "waiting its turn outside the file, as a 3D model's still in the frame every still shares",
      () => {
        afterEach(() => vi.useRealTimers())

        // A renderer that works `before`, waits its turn in a line the test lets go of, then
        // draws, or never settles where `stalls`.
        const queuedRenderer = ({ before = 0, stalls = false } = {}) => {
          const line: { go?: () => void; signal?: AbortSignal } = {}
          registerEntryThumb("audio", async (file, _box, signal) => {
            line.signal = signal
            await new Promise((resolve) => setTimeout(resolve, before))
            const turn = file.queued()
            await new Promise<void>((resolve) => (line.go = resolve))
            turn()
            return stalls ? new Promise(() => {}) : { blob: new Blob(["drawn"]) }
          })
          return line
        }
        const loadQueued = (key: string, signal = new AbortController().signal) =>
          loadThumb({ key, kind: "audio", name: "a.glb", size: 2, read, signal })

        it("gets its picture though its wait ran past the deadline", async () => {
          urls()
          vi.useFakeTimers()
          const line = queuedRenderer({ before: 5_000 })
          const loading = loadQueued("queued:1")
          await vi.advanceTimersByTimeAsync(5_000 + 60_000)
          expect(line.signal?.aborted).toBe(false)
          line.go!()
          expect(await loading).toEqual({
            url: expect.stringMatching(/^blob:/),
            duration: undefined,
          })
          expect(hasNoThumb("queued:1")).toBe(false)
        })

        it("is stopped where it stalls once its turn comes, at the deadline less what it worked before", async () => {
          urls()
          vi.useFakeTimers()
          const line = queuedRenderer({ before: 5_000, stalls: true })
          let result: unknown = "pending"
          void loadQueued("queued:2").then((thumb) => (result = thumb))
          await vi.advanceTimersByTimeAsync(5_000 + 60_000)
          line.go!()
          await vi.advanceTimersByTimeAsync(9_999)
          expect(line.signal?.aborted).toBe(false)
          expect(result).toBe("pending")
          await vi.advanceTimersByTimeAsync(1)
          expect(line.signal?.aborted).toBe(true)
          expect(result).toBeUndefined()
          // As any renderer that stalls with no read on its way: not asked again.
          expect(hasNoThumb("queued:2")).toBe(true)
        })

        it("is stopped at once where it is no longer wanted while it waits", async () => {
          urls()
          const line = queuedRenderer()
          const stop = new AbortController()
          const loading = loadQueued("queued:3", stop.signal)
          await vi.waitFor(() => expect(line.go).toBeDefined())
          stop.abort()
          expect(await loading).toBeUndefined()
          expect(line.signal?.aborted).toBe(true)
          expect(hasNoThumb("queued:3")).toBe(false)
        })
      },
    )

    it("passes its signal on to its reads, which a stopped renderer's end", async () => {
      urls()
      let reads: AbortSignal | undefined
      registerEntryThumb("audio", async (file, _box, signal) => {
        await file.read(0, signal)
        return { blob: new Blob(["x"]) }
      })
      await loadThumb({
        key: "reads:1",
        kind: "audio",
        name: "a.glb",
        size: 2,
        read: async (offset, signal) => {
          reads = signal
          return read(offset)
        },
        signal: new AbortController().signal,
      })
      expect(reads).toBeInstanceOf(AbortSignal)
    })

    it("is asked again where a read failed, or was still on its way at its deadline", async () => {
      urls()
      registerEntryThumb("audio", async (file, _box, signal) => {
        await file.read(0, signal)
        return { blob: new Blob(["x"]) }
      })
      const failing = await loadThumb({
        key: "dropped:1",
        kind: "audio",
        name: "a.glb",
        size: 2,
        read: async () => {
          throw new Error("the link dropped")
        },
        signal: new AbortController().signal,
      })
      expect(failing).toBeUndefined()
      expect(hasNoThumb("dropped:1")).toBe(false)
      const unreadable = await loadThumb({
        key: "dropped:2",
        kind: "audio",
        name: "a.glb",
        size: 2,
        read: async () => ({ state: "unavailable", reason: "unreadable" }),
        signal: new AbortController().signal,
      })
      expect(unreadable).toEqual({ url: expect.stringMatching(/^blob:/), duration: undefined })
      unregisterEntryThumb("audio")
      registerEntryThumb("audio", async (file, _box, signal) => {
        const part = await file.read(0, signal)
        return part.state === "part" ? { blob: new Blob(["x"]) } : null
      })
      await loadThumb({
        key: "dropped:3",
        kind: "audio",
        name: "a.glb",
        size: 2,
        read: async () => ({ state: "unavailable", reason: "unreadable" }),
        signal: new AbortController().signal,
      })
      expect(hasNoThumb("dropped:3")).toBe(false)
      const slow = await loadThumb({
        key: "slow:1",
        kind: "audio",
        name: "a.glb",
        size: 2,
        read: () => new Promise(() => {}),
        signal: new AbortController().signal,
        deadline: 20,
      })
      expect(slow).toBeUndefined()
      expect(hasNoThumb("slow:1")).toBe(false)
    })

    it("revokes a picture a second load of the same file replaced", async () => {
      const revoked = urls()
      registerEntryThumb("audio", async () => ({ blob: new Blob(["drawn"]) }))
      const twice = () =>
        loadThumb({
          key: "twice:1",
          kind: "audio",
          name: "a.glb",
          size: 2,
          read,
          signal: new AbortController().signal,
        })
      const [first, second] = await Promise.all([twice(), twice()])
      expect(first!.url).not.toBe(second!.url)
      expect(revoked).toEqual([first!.url])
    })

    it("shows the icon where it fails", async () => {
      registerEntryThumb("audio", async () => {
        throw new Error("no webgl")
      })
      expect(await load(4)).toBeUndefined()
    })

    it("has its picture's URL revoked once the cache lets go of it and no tile shows it", async () => {
      const revoked = urls()
      registerEntryThumb("audio", async () => ({ blob: new Blob(["drawn"]) }))
      const one = (index: number) =>
        loadThumb({
          key: `many:${index}`,
          kind: "audio",
          name: `${index}.glb`,
          size: 2,
          read,
          signal: new AbortController().signal,
        })
      const shown = await one(0)
      const release = holdThumb(shown!.url)
      for (let index = 1; index < 400; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- Each is kept in the order it is loaded.
        await one(index)
      }
      // The cache let go of it long ago, but a tile still shows it.
      expect(revoked.length).toBeGreaterThanOrEqual(99)
      expect(revoked).not.toContain(shown!.url)
      release()
      expect(revoked.length).toBeGreaterThanOrEqual(100)
      expect(revoked).toContain(shown!.url)
    })
  })
})
