import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { VoiceState } from "@novadeck/protocol"
import { maxVoiceSeconds, voiceSampleRate } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import type { Resources } from "../testing/resources.js"
import { engineArchive, fakeLaunch, folder, modelCatalog } from "../testing/voice.js"
import { WorkspaceStore } from "../workspaces/store.js"
import type { Catalog } from "./catalog.js"
import { updateRetryMs, Voice } from "./service.js"

const pcm = (bytes: number) => Buffer.alloc(bytes).toString("base64")

const setup = async (
  resources: Resources,
  options: {
    catalog?: Catalog
    // The manifest of an engine an earlier setup made; a fresh archive would differ from
    // it by its files' times, and so would be another engine.
    engine?: false | string
    store?: WorkspaceStore
    directory?: string
    checkMs?: number
    now?: () => number
  } = {},
) => {
  const store = options.store ?? new WorkspaceStore()
  if (!options.store) resources.defer(() => store.close())
  const directory = options.directory ?? (await folder(resources))
  const manifest =
    options.engine === false ? undefined : (options.engine ?? (await engineArchive(resources)))
  const voice = new Voice(store, {
    engine: manifest,
    directory,
    catalog: options.catalog ?? (await modelCatalog(resources)),
    launch: fakeLaunch,
    ...(options.checkMs !== undefined && { checkMs: options.checkMs }),
    ...(options.now && { now: options.now }),
  })
  resources.defer(() => voice.close())
  await voice.refresh()
  return { voice, store, directory, manifest }
}

/** The states a watch shows, up to the first the test is waiting for. */
const watchUntil = async (voice: Voice, done: (state: VoiceState) => boolean) => {
  const states: VoiceState[] = []
  const controller = new AbortController()
  for await (const state of voice.watch("owner", controller.signal)) {
    states.push(state)
    if (done(state)) break
  }
  controller.abort()
  return states
}

const installed = async (resources: Resources, model: "small" | "turbo" = "small") => {
  const context = await setup(resources)
  await context.voice.install(model)
  await context.voice.settled()
  return context
}

describe("voice input without an engine", () => {
  it("is unavailable and refuses to install", async ({ resources }) => {
    const { voice } = await setup(resources, { engine: false })

    expect(voice.state()).toMatchObject({ available: false, installed: [], enabled: false })
    expect(voice.state().sizes.engine).toBe(0)
    await expect(voice.install("small")).rejects.toMatchObject({ code: "VOICE_UNAVAILABLE" })
  })
})

describe("installing voice input", () => {
  it("fetches the engine and the model, checks them, and turns voice input on", async ({
    resources,
  }) => {
    const { voice, store } = await setup(resources)
    const watching = watchUntil(voice, (state) => state.installing === null && state.check !== null)
    // Let the watch show the state before the install begins.
    await new Promise((resolve) => setTimeout(resolve, 50))

    await voice.install("small")
    const states = await watching

    const steps = states.flatMap((state) => (state.installing ? [state.installing.step] : []))
    expect([...new Set(steps)]).toEqual(["engine", "model", "check"])
    expect(states[0]).toMatchObject({ available: true, installed: [], enabled: false })
    expect(states.at(-1)).toMatchObject({
      installed: ["small"],
      enabled: true,
      model: "small",
      installing: null,
      failure: null,
      check: { model: "small", gpu: false, recommended: "small" },
    })
    expect(store.voiceSettings()).toMatchObject({ enabled: true, model: "small" })
  })

  it("recommends turbo when a GPU does the test clip quickly", async ({ resources }) => {
    const { voice } = await installed(resources, "turbo")

    expect(voice.state().check).toMatchObject({ model: "turbo", gpu: true, recommended: "turbo" })
    expect(voice.state().model).toBe("turbo")
  })

  it("sizes the downloads", async ({ resources }) => {
    const catalog = await modelCatalog(resources)
    const { voice } = await setup(resources, { catalog })

    expect(voice.state().sizes).toEqual({
      engine: expect.any(Number),
      turbo: catalog.models.turbo.size + catalog.vad.size,
      small: catalog.models.small.size + catalog.vad.size,
    })
    expect(voice.state().sizes.engine).toBeGreaterThan(0)
  })

  it("refuses a second install while one runs", async ({ resources }) => {
    const { voice } = await setup(resources)

    await voice.install("small")

    await expect(voice.install("turbo")).rejects.toMatchObject({ code: "CONFLICT" })
    await voice.settled()
  })

  it("fails in words for a damaged model, keeping the engine it fetched", async ({ resources }) => {
    const catalog = await modelCatalog(resources)
    const { voice, directory } = await setup(resources, {
      catalog: {
        ...catalog,
        models: { ...catalog.models, small: { ...catalog.models.small, sha256: "0".repeat(64) } },
      },
    })

    await voice.install("small")
    await voice.settled()

    expect(voice.state()).toMatchObject({ installing: null, enabled: false, installed: [] })
    expect(voice.state().failure).toContain("damaged")
    expect(await readdir(`${directory}/engine`)).toHaveLength(1)
    expect(await readdir(`${directory}/models`)).toEqual([])
  })

  it("fails when the engine says nothing of the test clip", async ({ resources }) => {
    const { voice } = await setup(resources, {
      catalog: await modelCatalog(resources, { small: "small mute" }),
    })

    await voice.install("small")
    await voice.settled()

    expect(voice.state().failure).toContain("heard nothing")
    expect(voice.state().enabled).toBe(false)
  })

  it("gives up on a check too slow to finish, keeping the model to turn on", async ({
    resources,
  }) => {
    const { voice } = await setup(resources, {
      catalog: await modelCatalog(resources, { small: "small slow" }),
      checkMs: 300,
    })

    await voice.install("small")
    await voice.settled()

    expect(voice.state().failure).toContain("did not transcribe a short test clip within")
    expect(voice.state()).toMatchObject({ installed: ["small"], enabled: false, installing: null })
    expect(() => voice.set({ enabled: true })).not.toThrow()
    expect(voice.state().enabled).toBe(true)
  })

  it("keeps the model in use when another fails its check or is cancelled", async ({
    resources,
  }) => {
    const { voice } = await setup(resources, {
      catalog: await modelCatalog(resources, { turbo: "turbo slow" }),
      checkMs: 300,
    })
    await voice.install("small")
    await voice.settled()
    expect(voice.state()).toMatchObject({ enabled: true, model: "small" })

    await voice.install("turbo")
    await voice.settled()
    expect(voice.state().failure).toContain("did not transcribe")
    expect(voice.state()).toMatchObject({
      installed: ["turbo", "small"],
      enabled: true,
      model: "small",
    })

    const checking = watchUntil(voice, (state) => state.installing?.step === "check")
    await new Promise((resolve) => setTimeout(resolve, 50))
    await voice.install("turbo")
    await checking
    await voice.cancel()
    expect(voice.state()).toMatchObject({ enabled: true, model: "small", failure: null })
  })

  it("turns voice input on for a first install, but leaves a later one's switch as it was", async ({
    resources,
  }) => {
    const { voice } = await installed(resources)
    expect(voice.state().enabled).toBe(true)
    voice.set({ enabled: false })

    await voice.install("turbo")
    await voice.settled()

    expect(voice.state()).toMatchObject({ model: "turbo", enabled: false, failure: null })
  })

  it("turns voice input on when a first install that failed its check is tried again", async ({
    resources,
  }) => {
    const catalog = await modelCatalog(resources, { small: "small slow" })
    const first = await setup(resources, { catalog, checkMs: 300 })
    await first.voice.install("small")
    await first.voice.settled()
    expect(first.voice.state()).toMatchObject({ installed: ["small"], enabled: false })

    const again = await setup(resources, {
      catalog,
      store: first.store,
      directory: first.directory,
      ...(first.manifest && { engine: first.manifest }),
      checkMs: 5000,
    })
    await again.voice.install("small")
    await again.voice.settled()

    expect(again.voice.state()).toMatchObject({ failure: null, enabled: true, model: "small" })
  })

  it("turns voice input on again for an install after an uninstall, whatever its switch was", async ({
    resources,
  }) => {
    const { voice } = await installed(resources)
    voice.set({ enabled: false })
    await voice.uninstall()

    await voice.install("small")
    await voice.settled()

    expect(voice.state()).toMatchObject({ enabled: true, model: "small" })
  })

  it("keeps an unchecked model off when the one chosen had gone missing", async ({ resources }) => {
    const { voice, directory } = await setup(resources, {
      catalog: await modelCatalog(resources, { small: "small slow" }),
      checkMs: 300,
    })
    await voice.install("turbo")
    await voice.settled()
    expect(voice.state()).toMatchObject({ model: "turbo", enabled: true })
    await rm(join(directory, "models", "ggml-turbo.bin"))

    await voice.install("small")
    await voice.settled()

    expect(voice.state().failure).toContain("did not transcribe")
    expect(voice.state()).toMatchObject({ installed: ["small"], model: "small", enabled: false })
  })

  it("stops on cancel without a failure, keeping what it fetched", async ({ resources }) => {
    const { voice, directory } = await setup(resources, {
      catalog: await modelCatalog(resources, { small: "small slow" }),
    })
    const checking = watchUntil(voice, (state) => state.installing?.step === "check")
    await new Promise((resolve) => setTimeout(resolve, 50))
    await voice.install("small")
    await checking

    await voice.cancel()

    expect(voice.state()).toMatchObject({ installing: null, failure: null, enabled: false })
    expect(await readdir(`${directory}/models`)).toHaveLength(2)
  })

  it("is quick to finish when its engine and model are there already", async ({ resources }) => {
    const { voice } = await installed(resources)

    await voice.install("small")
    await voice.settled()

    expect(voice.state()).toMatchObject({ installed: ["small"], failure: null })
  })
})

describe("voice input settings", () => {
  it("refuses a model, or turning on, that is not installed", async ({ resources }) => {
    const { voice } = await setup(resources)

    expect(() => voice.set({ model: "turbo" })).toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    )
    expect(() => voice.set({ enabled: true })).toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    )
    expect(() => voice.set({ language: "pl" })).not.toThrow()
    expect(voice.state()).toMatchObject({ language: "pl", enabled: false })
  })

  it("turns off and on, and chooses among installed models", async ({ resources }) => {
    const { voice } = await installed(resources)

    voice.set({ enabled: false })
    expect(voice.state().enabled).toBe(false)
    voice.set({ enabled: true, language: "de" })
    expect(voice.state()).toMatchObject({ enabled: true, language: "de", model: "small" })
    expect(() => voice.set({ model: "small" })).not.toThrow()
  })

  it("survive the runner, with what is installed", async ({ resources }) => {
    const first = await installed(resources)
    first.voice.set({ language: "pl" })

    const second = await setup(resources, {
      store: first.store,
      directory: first.directory,
      ...(first.manifest && { engine: first.manifest }),
      catalog: await modelCatalog(resources),
    })

    expect(second.voice.state()).toMatchObject({
      installed: ["small"],
      enabled: true,
      language: "pl",
    })
  })
})

describe("transcribing a recording", () => {
  it("returns what the engine heard of the clip, after the prompt", async ({ resources }) => {
    const { voice } = await installed(resources)
    voice.record("owner", "clip", 0, pcm(32_000))
    voice.record("owner", "clip", 32_000, pcm(32_000))

    const transcript = await voice.transcribe("owner", "clip", "README.md")

    expect(transcript.language).toBe("pl")
    expect(JSON.parse(transcript.text)).toMatchObject({ prompt: "README.md", bytes: 44 + 64_000 })
    await expect(voice.transcribe("owner", "clip")).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("has the engine in the language chosen", async ({ resources }) => {
    const { voice } = await installed(resources)
    voice.set({ language: "pl" })
    voice.record("owner", "clip", 0, pcm(3200))

    const transcript = await voice.transcribe("owner", "clip")

    expect(transcript.language).toBe("pl")
  })

  it("names the language the engine heard when detecting it", async ({ resources }) => {
    const { voice } = await installed(resources)
    voice.set({ language: "auto" })
    voice.record("owner", "clip", 0, pcm(3200))

    await expect(voice.transcribe("owner", "clip")).resolves.toMatchObject({ language: "pl" })
  })

  it("is empty for a clip with no audio, without the engine", async ({ resources }) => {
    const { voice } = await installed(resources)
    voice.record("owner", "clip", 0, "")

    await expect(voice.transcribe("owner", "clip")).resolves.toEqual({ text: "", language: "" })
  })

  it("refuses audio past the longest clip", async ({ resources }) => {
    const { voice } = await installed(resources)
    const whole = maxVoiceSeconds * voiceSampleRate * 2
    voice.record("owner", "clip", 0, pcm(2))
    voice.record("owner", "clip", whole - 2, pcm(2))

    expect(() => voice.record("owner", "clip", whole - 1, pcm(2))).toThrowError(
      expect.objectContaining({ code: "UPLOAD_TOO_LARGE" }),
    )
  })

  it("forgets a discarded clip", async ({ resources }) => {
    const { voice } = await installed(resources)
    voice.record("owner", "clip", 0, pcm(3200))
    voice.discard("owner", "clip")
    voice.discard("owner", "never-recorded")

    await expect(voice.transcribe("owner", "clip")).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("is unavailable while voice input is off, or not installed", async ({ resources }) => {
    const bare = await setup(resources)
    const { voice } = await installed(resources)
    voice.set({ enabled: false })

    expect(() => bare.voice.record("owner", "clip", 0, pcm(2))).toThrowError(
      expect.objectContaining({ code: "VOICE_UNAVAILABLE" }),
    )
    expect(() => voice.record("owner", "clip", 0, pcm(2))).toThrowError(
      expect.objectContaining({ code: "VOICE_UNAVAILABLE" }),
    )
    await expect(voice.transcribe("owner", "clip")).rejects.toMatchObject({
      code: "VOICE_UNAVAILABLE",
    })
  })

  it("fails with the reason when the engine does, and recovers on the next clip", async ({
    resources,
  }) => {
    const { voice, directory } = await installed(resources)
    const model = `${directory}/models/ggml-small.bin`
    await writeFile(model, "small crash")
    // Choosing a model ends the engine, which the next clip starts again from the file.
    voice.set({ model: "small" })
    voice.record("owner", "clip", 0, pcm(3200))

    await expect(voice.transcribe("owner", "clip")).rejects.toMatchObject({
      code: "VOICE_FAILED",
      message: expect.stringContaining("out of memory"),
    })
    expect(voice.state().failure).toContain("out of memory")

    await writeFile(model, "small")
    voice.record("owner", "clip", 0, pcm(3200))
    await expect(voice.transcribe("owner", "clip")).resolves.toMatchObject({ language: "pl" })
    expect(voice.state().failure).toBeNull()
  })
})

describe("uninstalling voice input", () => {
  it("removes the engine and models and turns voice input off", async ({ resources }) => {
    const { voice, directory } = await installed(resources)

    await voice.uninstall()

    expect(voice.state()).toMatchObject({ installed: [], enabled: false, check: null })
    expect(await readdir(directory)).toEqual([])
  })
})

describe("uninstalling voice input while it is used", () => {
  it("refuses an install, a recording and a setting until it is done", async ({ resources }) => {
    const { voice, store } = await installed(resources)
    voice.record("owner", "clip", 0, pcm(3200))

    const removing = voice.uninstall()

    await expect(voice.install("small")).rejects.toMatchObject({ code: "CONFLICT" })
    expect(() => voice.record("owner", "clip", 0, pcm(2))).toThrowError(
      expect.objectContaining({ code: "VOICE_UNAVAILABLE" }),
    )
    await expect(voice.transcribe("owner", "clip")).rejects.toMatchObject({
      code: "VOICE_UNAVAILABLE",
    })
    expect(() => voice.set({ enabled: true })).toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    )
    await removing
    expect(store.voiceSettings().enabled).toBe(false)
    // And installs again afterwards.
    await voice.install("small")
    await voice.settled()
    expect(voice.state().enabled).toBe(true)
  })

  it("stays off, and says why, when files cannot be removed", async ({ resources }) => {
    // A folder nobody may change keeps its file, unless the tests run as root.
    if (process.platform === "win32" || process.getuid?.() === 0) return
    const { voice, store, directory } = await installed(resources)
    const stuck = join(directory, "stuck")
    await mkdir(stuck)
    await writeFile(join(stuck, "file"), "x")
    await chmod(stuck, 0o500)
    resources.defer(async () => {
      await chmod(stuck, 0o700).catch(() => {})
    })

    await expect(voice.uninstall()).rejects.toMatchObject({
      code: "VOICE_FAILED",
      message: expect.stringContaining("could not be removed"),
    })

    expect(store.voiceSettings().enabled).toBe(false)
    expect(voice.state().enabled).toBe(false)
    await chmod(stuck, 0o700)
    await voice.uninstall()
    expect(await readdir(directory)).toEqual([])
  })
})

describe("recordings", () => {
  it("belong to the connection that made them, which goes with them", async ({ resources }) => {
    const { voice } = await installed(resources)
    voice.record("one", "clip", 0, pcm(3200))

    await expect(voice.transcribe("two", "clip")).rejects.toMatchObject({ code: "NOT_FOUND" })
    voice.release("one")

    await expect(voice.transcribe("one", "clip")).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("are limited for each connection", async ({ resources }) => {
    const { voice } = await installed(resources)
    for (const id of ["a", "b", "c", "d"]) voice.record("one", id, 0, pcm(2))

    expect(() => voice.record("one", "e", 0, pcm(2))).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT" }),
    )
    expect(() => voice.record("two", "e", 0, pcm(2))).not.toThrow()
  })
})

describe("voice input after the app brings a new engine", () => {
  const updated = async (resources: Resources, now?: () => number) => {
    const first = await installed(resources)
    const next = await engineArchive(resources, "2")
    const second = await setup(resources, {
      store: first.store,
      directory: first.directory,
      engine: next,
      catalog: await modelCatalog(resources),
      ...(now && { now }),
    })
    return { ...second, next, first }
  }

  it("keeps models installed and voice input on, and fetches the engine alone", async ({
    resources,
  }) => {
    const { voice, directory, first } = await updated(resources)
    expect(voice.state()).toMatchObject({ installed: ["small"], enabled: true })
    const before = await readdir(join(directory, "engine"))

    const states = watchUntil(voice, (state) => state.installing === null && state.failure === null)
    await voice.settled()
    const watched = await states

    expect(watched.flatMap((state) => (state.installing ? [state.installing.step] : []))).toEqual(
      expect.arrayContaining(["engine"]),
    )
    expect(watched.every((state) => state.installing?.step !== "model")).toBe(true)
    const after = await readdir(join(directory, "engine"))
    expect(after).toHaveLength(1)
    expect(after).not.toEqual(before)
    expect(voice.state()).toMatchObject({ installed: ["small"], enabled: true, failure: null })
    voice.record("owner", "clip", 0, pcm(3200))
    await expect(voice.transcribe("owner", "clip")).resolves.toMatchObject({ language: "pl" })
    await first.voice.close()
  })

  it("keeps dictating with the older engine while the new one downloads", async ({ resources }) => {
    const { voice } = await updated(resources)

    expect(() => voice.record("owner", "clip", 0, pcm(3200))).not.toThrow()
    expect(voice.state().installing).toMatchObject({ step: "engine" })
    await voice.settled()

    // The next clip starts the new engine, the old one's folder being gone.
    await expect(voice.transcribe("owner", "clip")).resolves.toMatchObject({ language: "pl" })
    expect(voice.state()).toMatchObject({ installing: null, failure: null, enabled: true })
  })

  it("tells a dictation that no engine is there that it is updating", async ({ resources }) => {
    const { voice, directory } = await updated(resources)
    await rm(join(directory, "engine"), { recursive: true })
    await voice.refresh()

    expect(() => voice.record("owner", "clip", 0, pcm(2))).toThrowError(
      expect.objectContaining({
        code: "VOICE_UNAVAILABLE",
        message: expect.stringContaining("Updating the voice engine"),
      }),
    )
    expect(voice.state().installing).toMatchObject({ step: "engine" })
    await voice.settled()
  })

  it("shows a failed update as a failure, keeping the older engine in use", async ({
    resources,
  }) => {
    const { voice, next } = await updated(resources)
    await rm(join(next, "..", "engine.tar.gz"))

    expect(() => voice.record("owner", "clip", 0, pcm(3200))).not.toThrow()
    await voice.settled()

    expect(voice.state()).toMatchObject({ installed: ["small"], enabled: true, installing: null })
    expect(voice.state().failure).toEqual(expect.any(String))
    await expect(voice.transcribe("owner", "clip")).resolves.toMatchObject({ language: "pl" })
  })

  it("is tried again by a clip a minute later, as once the network is back", async ({
    resources,
  }) => {
    let time = 1_000_000
    const { voice, next } = await updated(resources, () => time)
    const archive = join(next, "..", "engine.tar.gz")
    const kept = await readFile(archive)
    await rm(archive)
    voice.record("owner", "clip", 0, pcm(2))
    await voice.settled()
    expect(voice.state().failure).toEqual(expect.any(String))

    await writeFile(archive, kept)
    time += updateRetryMs - 1
    voice.record("owner", "clip", 0, pcm(2))
    expect(voice.state().installing).toBeNull()

    time += 2
    voice.record("owner", "clip", 0, pcm(2))
    expect(voice.state().installing).toMatchObject({ step: "engine" })
    await voice.settled()
    expect(voice.state()).toMatchObject({ failure: null, installing: null, enabled: true })
  })
})

describe("voice input after the runner restarts", () => {
  it("dictates before anything watches, once the saved state is loaded", async ({ resources }) => {
    const first = await installed(resources)
    const restarted = new Voice(first.store, {
      engine: first.manifest,
      directory: first.directory,
      catalog: await modelCatalog(resources),
      launch: fakeLaunch,
    })
    resources.defer(() => restarted.close())

    restarted.start()
    await restarted.ready()

    expect(() => restarted.record("owner", "clip", 0, pcm(3200))).not.toThrow()
    await expect(restarted.transcribe("owner", "clip")).resolves.toMatchObject({ language: "pl" })
  })

  it("only reads on a refresh, and chooses a model that is there on a load", async ({
    resources,
  }) => {
    const { voice, store } = await setup(resources, {
      catalog: await modelCatalog(resources),
    })
    await voice.install("small")
    await voice.settled()
    store.saveVoiceSettings({ model: "turbo" })

    await voice.refresh()
    expect(store.voiceSettings().model).toBe("turbo")
    await voice.load()
    expect(store.voiceSettings().model).toBe("small")
  })
})

describe("the switch of voice input", () => {
  it("is not chosen until an install, which turns it on, or a person", async ({ resources }) => {
    const { voice, store } = await setup(resources)
    expect(store.voiceEnabledChoice()).toBeUndefined()

    await voice.install("small")
    await voice.settled()
    expect(store.voiceEnabledChoice()).toBe(true)

    voice.set({ enabled: false })
    expect(store.voiceEnabledChoice()).toBe(false)
    expect(voice.state().enabled).toBe(false)
  })

  it("stays off by choice through another install, and is forgotten by an uninstall", async ({
    resources,
  }) => {
    const { voice, store } = await setup(resources, { catalog: await modelCatalog(resources) })
    await voice.install("small")
    await voice.settled()
    voice.set({ enabled: false })

    await voice.install("turbo")
    await voice.settled()
    expect(store.voiceEnabledChoice()).toBe(false)

    await voice.uninstall()
    expect(store.voiceEnabledChoice()).toBeUndefined()
    await voice.install("small")
    await voice.settled()
    expect(voice.state().enabled).toBe(true)
  })
})

describe("a chosen model that went missing", () => {
  it("gives way to one that is installed", async ({ resources }) => {
    const { voice, store, directory } = await setup(resources, {
      catalog: await modelCatalog(resources),
    })
    await voice.install("small")
    await voice.settled()
    await voice.install("turbo")
    await voice.settled()
    expect(voice.state()).toMatchObject({ model: "turbo", enabled: true })

    await rm(join(directory, "models", "ggml-turbo.bin"))
    await voice.load()

    expect(voice.state()).toMatchObject({ installed: ["small"], model: "small", enabled: true })
    expect(store.voiceSettings().model).toBe("small")
  })
})

describe("the install check", () => {
  it("does not disturb a dictation that runs with another model", async ({ resources }) => {
    const { voice } = await installed(resources, "turbo")
    voice.record("owner", "clip", 0, pcm(3200))

    await voice.install("small")
    const transcript = voice.transcribe("owner", "clip")
    await voice.settled()

    await expect(transcript).resolves.toMatchObject({ language: "pl" })
    expect(voice.state().failure).toBeNull()
  })
})

describe("closing voice input", () => {
  it("refuses what comes after, as the runner is closing", async ({ resources }) => {
    const { voice } = await installed(resources)

    await voice.close()

    await expect(voice.install("small")).rejects.toMatchObject({ code: "RUNTIME_CLOSING" })
    expect(() => voice.set({ language: "de" })).toThrowError(
      expect.objectContaining({ code: "RUNTIME_CLOSING" }),
    )
    expect(() => voice.record("owner", "clip", 0, pcm(2))).toThrowError(
      expect.objectContaining({ code: "RUNTIME_CLOSING" }),
    )
    await expect(voice.transcribe("owner", "clip")).rejects.toMatchObject({
      code: "RUNTIME_CLOSING",
    })
  })

  it("ends a watch when its owner is released", async ({ resources }) => {
    const { voice } = await setup(resources)
    const states: VoiceState[] = []
    const watching = (async () => {
      for await (const state of voice.watch("owner")) states.push(state)
    })()
    await new Promise((resolve) => setTimeout(resolve, 50))

    voice.release("owner")
    await watching

    expect(states).toHaveLength(1)
  })
})
