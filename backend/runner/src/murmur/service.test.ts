import { existsSync } from "node:fs"
import { chmod, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { MurmurState } from "@novadeck/protocol"
import { vi } from "vitest"

import { ActivityTracker } from "../engines/activity.js"
import { readManifest } from "../engines/manifest.js"
import type { Launch } from "../engines/server.js"
import { logs, useLogger } from "../log.js"
import { describe, expect, it } from "../test.js"
import {
  arc,
  fakeLaunch,
  folder,
  llamaArchive,
  modelFile,
  nvidia,
  processor,
  type FakeDevice,
} from "../testing/murmur.js"
import { redactionProbe } from "../testing/redaction-probe.js"
import type { Resources } from "../testing/resources.js"
import { WorkspaceStore } from "../workspaces/store.js"
import type { AgentDigest, Digest, NoteDigest } from "./describer.js"
import { Murmur, serverArguments } from "./service.js"

const digest: AgentDigest = {
  kind: "agent",
  harness: "Claude Code",
  project: "app",
  folder: null,
  branch: null,
  plan: null,
  folders: [],
  prompts: ["first thing", "fix the build, API_KEY=hunter2 is set"],
  reply: null,
  summary: null,
  previous: null,
  stage: "forming",
}

const setup = async (
  resources: Resources,
  options: {
    devices?: FakeDevice[]
    behaviour?: string
    engine?: false | string | undefined
    source?: string
    store?: WorkspaceStore
    directory?: string
    voice?: ConstructorParameters<typeof Murmur>[1]["voice"]
    freeMemory?: () => number
    requestMs?: number
    prepareMs?: number
    prepareScript?: URL
    startMs?: number
    checkMs?: number
    launch?: Launch
    idleMs?: number
    now?: () => number
  } = {},
) => {
  const store = options.store ?? new WorkspaceStore()
  if (!options.store) resources.defer(() => store.close())
  const directory = options.directory ?? (await folder(resources))
  const manifest =
    options.engine === false ? undefined : (options.engine ?? (await llamaArchive(resources)))
  const murmur = new Murmur(store, {
    engine: manifest,
    ...(options.source !== undefined && { source: options.source }),
    directory,
    model: await modelFile(resources, options.behaviour),
    launch: fakeLaunch(options.devices ?? [arc, nvidia, processor]),
    retryMs: 20,
    backoffMs: 60,
    ...(options.voice && { voice: options.voice }),
    ...(options.freeMemory && { freeMemory: options.freeMemory }),
    ...(options.requestMs !== undefined && { requestMs: options.requestMs }),
    ...(options.startMs !== undefined && { startMs: options.startMs }),
    ...(options.checkMs !== undefined && { checkMs: options.checkMs }),
    ...(options.prepareMs !== undefined && { prepareMs: options.prepareMs }),
    ...(options.prepareScript && { prepareScript: options.prepareScript }),
    ...(options.launch && { launch: options.launch }),
    ...(options.idleMs !== undefined && { idleMs: options.idleMs }),
    ...(options.now && { now: options.now }),
  })
  resources.defer(() => murmur.close())
  await murmur.refresh()
  return { murmur, store, directory, manifest }
}

const installed = async (resources: Resources, options: Parameters<typeof setup>[1] = {}) => {
  const context = await setup(resources, options)
  await context.murmur.install()
  await context.murmur.settled()
  return context
}

const watchUntil = async (murmur: Murmur, done: (state: MurmurState) => boolean) => {
  const states: MurmurState[] = []
  const controller = new AbortController()
  for await (const state of murmur.watch("owner", controller.signal)) {
    states.push(state)
    if (done(state)) break
  }
  controller.abort()
  return states
}

// The model file the fake llama-server runs from: named by the model's checksum, so found.
const modelOf = async (directory: string): Promise<string> => {
  const name = (await readdir(join(directory, "models"))).find((file) =>
    file.endsWith("model.gguf"),
  )
  if (name === undefined) throw new Error("No model installed.")
  return join(directory, "models", name)
}

// What the fake llama-server was sent, as the model file it ran from logged it.
const requests = async (
  directory: string,
): Promise<{ messages: { role: string; content: string }[] }[]> =>
  (await readFile(`${await modelOf(directory)}.requests`, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("murmur without an engine", () => {
  it("is unavailable and refuses to install", async ({ resources }) => {
    const { murmur } = await setup(resources, { engine: false })

    expect(murmur.state()).toMatchObject({ available: false, installed: false, enabled: false })
    expect(murmur.state().sizes.engine).toBe(0)
    await expect(murmur.install()).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(murmur.describe(digest, { terminal: "t" })).resolves.toBeUndefined()
  })
})

describe("installing murmur", () => {
  it("fails saying so where the build has nowhere to download the engine from", async ({
    resources,
  }) => {
    // A packaged build whose app-update.yml names no release passes an empty source.
    const { murmur, directory } = await setup(resources, { source: "" })
    await murmur.install().catch(() => {})
    await murmur.settled()
    expect(murmur.state()).toMatchObject({ installed: false, enabled: false })
    expect(murmur.state().failure).toBe("This build has nowhere to download the engine from.")
    // A download that can't happen says so with Try again; it is not a verdict on the computer.
    expect(murmur.state().unsupported).toBeNull()
    expect(murmur.state().wanted).toBe(true)
    expect(await readdir(directory)).not.toContain("engine")
  })

  it("fetches the engine and the model, checks them on the integrated GPU, and turns murmur on", async ({
    resources,
  }) => {
    const { murmur, store } = await setup(resources)
    const watching = watchUntil(
      murmur,
      (state) => state.installing === null && state.check !== null,
    )
    await sleep(50)

    await murmur.install()
    const states = await watching

    const steps = states.flatMap((state) => (state.installing ? [state.installing.step] : []))
    expect([...new Set(steps)]).toEqual(["engine", "model", "check"])
    expect(states[0]).toMatchObject({ available: true, installed: false, enabled: false })
    expect(states.at(-1)).toMatchObject({
      installed: true,
      enabled: true,
      installing: null,
      failure: null,
      check: { device: arc.name, integrated: true },
    })
    expect(store.murmurSettings()).toEqual({ enabled: true })
    expect(store.murmurCheck()).toMatchObject({ device: arc.name })
  })

  it("fails over to the next GPU when the integrated one cannot run the model", async ({
    resources,
  }) => {
    const { murmur } = await installed(resources, { behaviour: "fail:Vulkan0 device" })

    expect(murmur.state()).toMatchObject({
      enabled: true,
      failure: null,
      check: { device: nvidia.name, integrated: false },
    })
    await expect(murmur.describe(digest, { terminal: "t" })).resolves.toMatchObject({
      title: "Fake title on Vulkan1",
    })
  })

  it("lands in Not available when no device answers, before the model is downloaded, with the engine removed", async ({
    resources,
  }) => {
    const { murmur, store, directory } = await installed(resources, { devices: [processor] })

    expect(murmur.state()).toMatchObject({
      installed: false,
      check: null,
      failure: null,
      unsupported: {
        reason: expect.stringMatching(/^No graphics device answered\./),
        source: "check",
      },
      // Not a refusal: murmur is still wanted, only not here.
      wanted: true,
    })
    expect(await readdir(directory)).toEqual([])
    expect(store.murmurCheck()).toBeNull()
    expect(store.murmurUnsupported()?.reason).toBe(murmur.state().unsupported?.reason)
    expect(murmur.state().unsupported?.source).toBe("check")
    await expect(murmur.describe(digest, { terminal: "t" })).resolves.toBeUndefined()
  })

  it("lands in Not available when every device answers with nothing usable, removing the engine and the model", async ({
    resources,
  }) => {
    const { murmur, store, directory } = await installed(resources, { behaviour: "garbage" })

    expect(murmur.state()).toMatchObject({
      installed: false,
      check: null,
      failure: null,
      unsupported: {
        reason: expect.stringMatching(/^No graphics device could run the model\./),
        source: "check",
      },
    })
    expect(await readdir(directory)).toEqual([])
    expect(store.murmurCheck()).toBeNull()
    expect(murmur.state().installing).toBeNull()
  })

  it("stays retryable when a device does not answer in time, keeping the model", async ({
    resources,
  }) => {
    const { murmur, store, directory } = await installed(resources, {
      behaviour: "hang",
      checkMs: 300,
    })

    expect(murmur.state()).toMatchObject({ installed: true, check: null, unsupported: null })
    expect(murmur.state().failure).not.toBeNull()
    expect(store.murmurUnsupported()).toBeNull()
    expect(await readdir(join(directory, "models"))).not.toEqual([])
  })

  it("stays retryable on a busy machine whose engine is slow to start", async ({ resources }) => {
    const { murmur, store, directory, manifest } = await installed(resources, {
      behaviour: "late",
      startMs: 100,
    })

    expect(murmur.state()).toMatchObject({ installed: true, check: null, unsupported: null })
    expect(murmur.state().failure).not.toBeNull()
    expect(store.murmurUnsupported()).toBeNull()

    // The same files pass once the machine has the time.
    const calm = await setup(resources, { store, directory, engine: manifest, behaviour: "late" })
    await calm.murmur.install()
    await calm.murmur.settled()
    expect(calm.murmur.state()).toMatchObject({ failure: null, check: { integrated: true } })
  })

  it("stays retryable when no device has the memory for the model", async ({ resources }) => {
    const { murmur, store, directory } = await installed(resources, {
      behaviour: "fail:Vulkan0 fail:Vulkan1",
    })

    expect(murmur.state()).toMatchObject({ installed: true, check: null, unsupported: null })
    expect(murmur.state().failure).not.toBeNull()
    expect(store.murmurUnsupported()).toBeNull()
    expect(await readdir(join(directory, "models"))).not.toEqual([])
  })

  it("stays retryable when a device failed to load and another answered with nothing usable", async ({
    resources,
  }) => {
    const { murmur, store } = await installed(resources, { behaviour: "fail:Vulkan0 garbage" })

    expect(murmur.state()).toMatchObject({ installed: true, unsupported: null })
    expect(murmur.state().failure).not.toBeNull()
    expect(store.murmurUnsupported()).toBeNull()
  })

  it("stays retryable when the engine crashes during the check", async ({ resources }) => {
    const { murmur, store } = await installed(resources, { behaviour: "crash" })

    expect(murmur.state()).toMatchObject({ installed: true, unsupported: null })
    expect(store.murmurUnsupported()).toBeNull()
  })

  it("shows no Try again text when files stay beside a verdict, as when removing them failed", async ({
    resources,
  }) => {
    const first = await installed(resources)
    await first.murmur.close()
    first.store.saveMurmurCheck(null)
    first.store.saveMurmurUnsupported({
      reason: "No graphics device answered.",
      engine: (await readManifest(first.manifest))!.sha256,
    })

    const { murmur } = await setup(resources, {
      store: first.store,
      directory: first.directory,
      engine: first.manifest,
    })

    expect(murmur.state()).toMatchObject({
      installed: true,
      unsupported: expect.objectContaining({ source: "check" }),
      failure: null,
    })
  })

  it("is not undone by a look at the disk that races the removal after a verdict", async ({
    resources,
  }) => {
    const { murmur } = await setup(resources, { devices: [processor] })
    // A watch's refresh at every turn of the event loop while the install ends and removes.
    const looking = setInterval(() => void murmur.refresh().catch(() => {}), 1)
    try {
      await murmur.install()
      await murmur.settled()
    } finally {
      clearInterval(looking)
    }
    await murmur.refresh()

    expect(murmur.state()).toMatchObject({
      installed: false,
      unsupported: expect.objectContaining({ source: "check" }),
    })
  })

  it("keeps Not available across a restart, and checks anew when installed again", async ({
    resources,
  }) => {
    const { store, directory, manifest, murmur } = await installed(resources, {
      devices: [processor],
    })
    await murmur.close()

    const again = await setup(resources, { store, directory, engine: manifest })
    expect(again.murmur.state()).toMatchObject({
      unsupported: expect.objectContaining({ source: "check" }),
    })

    // A computer that now has a device passes the check, and the verdict is gone.
    const better = await setup(resources, {
      store,
      directory,
      engine: manifest,
      devices: [arc],
    })
    await better.murmur.install()
    await better.murmur.settled()
    expect(better.murmur.state()).toMatchObject({
      installed: true,
      unsupported: null,
      check: { device: arc.name },
    })
    expect(store.murmurUnsupported()).toBeNull()
  })

  it("keeps the verdict through a Check again that is cancelled or fails, until a check passes", async ({
    resources,
  }) => {
    const { store, directory, manifest, murmur } = await installed(resources, {
      devices: [processor],
    })
    await murmur.close()
    const verdict = store.murmurUnsupported()
    expect(verdict).not.toBeNull()

    // A Check again that cannot download: a failure to try again, the verdict standing.
    const offline = await setup(resources, { store, directory, engine: manifest, source: "" })
    await offline.murmur.install()
    await offline.murmur.settled()
    expect(offline.murmur.state().failure).not.toBeNull()
    expect(store.murmurUnsupported()).toEqual(verdict)
    expect(offline.murmur.state().unsupported?.reason).toBe(verdict!.reason)

    // One cancelled as it starts.
    const cancelled = await setup(resources, { store, directory, engine: manifest, devices: [arc] })
    await cancelled.murmur.install()
    await cancelled.murmur.cancel()
    expect(store.murmurUnsupported()).toEqual(verdict)

    // One that passes clears it.
    await cancelled.murmur.install()
    await cancelled.murmur.settled()
    expect(store.murmurUnsupported()).toBeNull()
    expect(cancelled.murmur.state()).toMatchObject({
      unsupported: null,
      check: { device: arc.name },
    })
  })

  it("forgets an install's verdict once the engine is another build", async ({ resources }) => {
    const { store, directory, murmur } = await installed(resources, { devices: [processor] })
    await murmur.close()

    const next = await setup(resources, {
      store,
      directory,
      engine: await llamaArchive(resources, "2"),
    })

    expect(next.murmur.state()).toMatchObject({ unsupported: null })
  })

  it("is Not available from the host's word alone, with nothing downloaded", async ({
    resources,
  }) => {
    const store = new WorkspaceStore()
    resources.defer(() => store.close())
    const directory = await folder(resources)
    const murmur = new Murmur(store, {
      engine: await llamaArchive(resources),
      directory,
      model: await modelFile(resources),
      launch: fakeLaunch([arc]),
      softwareGraphics: true,
    })
    resources.defer(() => murmur.close())
    await murmur.refresh()

    expect(murmur.state()).toMatchObject({
      available: true,
      installed: false,
      unsupported: { reason: expect.stringMatching(/software rendering/), source: "host" },
    })
    await expect(murmur.install()).rejects.toMatchObject({ code: "CONFLICT" })
    expect(await readdir(directory)).toEqual([])
    // Nothing is stored: a host that sees hardware next time offers it again.
    expect(store.murmurUnsupported()).toBeNull()
  })

  it("is not Not available while the host and the install say nothing against it", async ({
    resources,
  }) => {
    const { murmur } = await setup(resources)

    expect(murmur.state().unsupported).toBeNull()
  })

  it("passes a GPU whose title is none murmur would show, as the check asks only for a reply", async ({
    resources,
  }) => {
    const { murmur } = await installed(resources, { behaviour: "verbose" })

    expect(murmur.state()).toMatchObject({ enabled: true, failure: null })
    expect(murmur.state().check).not.toBeNull()
  })

  it("rejects a GPU whose title is symbols only, though the format holds", async ({
    resources,
  }) => {
    const { murmur } = await installed(resources, { behaviour: "junk" })

    expect(murmur.state().check).toBeNull()
    expect(murmur.state().unsupported?.reason).toMatch(/could run the model/)
  })

  it("rejects a GPU that answers with something else than a description", async ({ resources }) => {
    const { murmur } = await installed(resources, { behaviour: "garbage" })

    expect(murmur.state().check).toBeNull()
    expect(murmur.state().unsupported?.reason).toMatch(/could run the model/)
  })

  it("refuses a second install while one runs, and stops on cancel without a failure", async ({
    resources,
  }) => {
    const { murmur } = await setup(resources)

    await murmur.install()
    await expect(murmur.install()).rejects.toMatchObject({ code: "CONFLICT" })
    await murmur.cancel()

    expect(murmur.state().installing).toBeNull()
    expect(murmur.state().failure).toBeNull()
  })

  it("is tried again with the engine and model it has, and turns on once checked", async ({
    resources,
  }) => {
    const store = new WorkspaceStore()
    resources.defer(() => store.close())
    const directory = await folder(resources)
    const manifest = await llamaArchive(resources)
    // A check cut short (the runner went away during it): the downloads stand, no check.
    const first = await installed(resources, { store, directory, engine: manifest })
    await first.murmur.close()
    store.saveMurmurCheck(null)
    store.saveMurmurSettings({ enabled: null })
    const unchecked = await setup(resources, { store, directory, engine: manifest })
    // Unchecked, it is not turned on.
    expect(unchecked.murmur.state()).toMatchObject({
      installed: true,
      enabled: false,
      check: null,
    })

    const second = await installed(resources, { store, directory, engine: manifest })

    expect(second.murmur.state()).toMatchObject({
      enabled: true,
      failure: null,
      check: { integrated: true },
    })
  })
})

describe("installed murmur that never passed its check", () => {
  it("says a check is needed, to try again, after a cancelled check or a restart", async ({
    resources,
  }) => {
    const store = new WorkspaceStore()
    resources.defer(() => store.close())
    const directory = await folder(resources)
    const manifest = await llamaArchive(resources)
    // The downloads stand, and the check was cut short by the runner going away.
    const first = await installed(resources, { store, directory, engine: manifest })
    await first.murmur.close()
    store.saveMurmurCheck(null)

    const { murmur } = await setup(resources, { store, directory, engine: manifest })

    // Not a failure, yet the card must offer Try again: it says the check is owed.
    expect(murmur.state()).toMatchObject({
      installed: true,
      check: null,
      failure: null,
    })
    await murmur.install()
    await murmur.settled()
    expect(murmur.state()).toMatchObject({ failure: null, check: { integrated: true } })
  })

  it("is no failure when the person cancels the check, only a check owed", async ({
    resources,
  }) => {
    const { murmur } = await setup(resources, { behaviour: "slow" })
    await murmur.install()
    // The check is under way once the model is down.
    await expect
      .poll(() => murmur.state().installing?.step, { timeout: 10_000, interval: 5 })
      .toBe("check")

    await murmur.cancel()

    expect(murmur.state()).toMatchObject({
      installed: true,
      installing: null,
      check: null,
      failure: null,
    })
  })

  it("does not say so while an install runs, or before anything is installed", async ({
    resources,
  }) => {
    const { murmur } = await setup(resources)
    expect(murmur.state()).toMatchObject({ failure: null })

    await murmur.install()
    expect(murmur.state()).toMatchObject({ failure: null })
    await murmur.settled()
    expect(murmur.state()).toMatchObject({ failure: null })
  })
})

describe("murmur's settings", () => {
  it("is wanted until turned off, installed or not, and stays off until turned on", async ({
    resources,
  }) => {
    const { murmur } = await setup(resources)
    expect(murmur.state()).toMatchObject({ wanted: true, enabled: false })

    await murmur.set({ enabled: false })
    expect(murmur.state()).toMatchObject({ wanted: false, enabled: false })

    // Turned on before an install, it is wanted, and the install turns it on.
    await murmur.set({ enabled: true })
    expect(murmur.state()).toMatchObject({ wanted: true, enabled: false })
  })

  it("keeps an off chosen during an install", async ({ resources }) => {
    const { murmur } = await setup(resources)
    await murmur.install()
    await murmur.set({ enabled: false })
    await murmur.settled()

    expect(murmur.state()).toMatchObject({ installed: true, enabled: false })
    expect(murmur.state().check).not.toBeNull()
  })

  it("turns off and on again", async ({ resources }) => {
    const { murmur } = await installed(resources)

    await murmur.set({ enabled: false })
    expect(murmur.state().enabled).toBe(false)
    await expect(murmur.describe(digest, { terminal: "t" })).resolves.toBeUndefined()
    await murmur.set({ enabled: true })
    await expect(murmur.describe(digest, { terminal: "t" })).resolves.toBeDefined()
  })

  it("survives the runner, with what is installed", async ({ resources }) => {
    const store = new WorkspaceStore()
    resources.defer(() => store.close())
    const directory = await folder(resources)
    const manifest = await llamaArchive(resources)
    const first = await installed(resources, { store, directory, engine: manifest })
    await first.murmur.close()

    const { murmur } = await setup(resources, { store, directory, engine: manifest })

    expect(murmur.state()).toMatchObject({
      installed: true,
      enabled: true,
      check: { integrated: true },
    })
    await expect(murmur.describe(digest, { terminal: "t" })).resolves.toBeDefined()
  })

  it("tells those who watch usability when it changes", async ({ resources }) => {
    const { murmur } = await setup(resources)
    const heard: boolean[] = []
    murmur.watchUsable((usable) => heard.push(usable))

    await murmur.install()
    await murmur.settled()
    await murmur.set({ enabled: false })
    await murmur.set({ enabled: true })

    // It says how things are at once, then every change.
    expect(heard).toEqual([false, true, false, true])
  })
})

describe("what the running job is", () => {
  it("says an install is not the engine's own update, and an update of the engine is", async ({
    resources,
  }) => {
    const first = await setup(resources)
    const installs: string[] = []
    const watching = watchUntil(first.murmur, (state) => {
      if (state.installing) installs.push(state.installing.origin)
      return state.installing === null && installs.length > 0
    })
    await sleep(50)
    await first.murmur.install()
    await watching
    expect(installs.length).toBeGreaterThan(0)
    expect(installs.every((origin) => origin === "person")).toBe(true)
    await first.murmur.close()

    // The next build brings another engine: the app fetches it alone for a murmur that is on.
    const updates: string[] = []
    const again = await setup(resources, {
      store: first.store,
      directory: first.directory,
      engine: await llamaArchive(resources, "2"),
    })
    await watchUntil(again.murmur, (state) => {
      if (state.installing) updates.push(state.installing.origin)
      return state.installing === null && updates.length > 0
    })
    expect(updates.length).toBeGreaterThan(0)
    expect(updates.every((origin) => origin === "update")).toBe(true)
  })
})

describe("the one-time offer's count", () => {
  it("counts each session the app says it showed the offer in, and keeps it across a restart", async ({
    resources,
  }) => {
    const { murmur, store, directory, manifest } = await setup(resources)
    expect(murmur.state().offers).toBe(0)

    await murmur.noteOffered()
    await murmur.noteOffered()

    expect(murmur.state().offers).toBe(2)
    expect(murmur.state().wanted).toBe(true)
    await murmur.close()
    const again = await setup(resources, { store, directory, engine: manifest })
    expect(again.murmur.state().offers).toBe(2)
  })
})

describe("uninstalling murmur", () => {
  it("removes the engine and model and turns murmur off", async ({ resources }) => {
    const { murmur, store, directory } = await installed(resources)

    await murmur.uninstall()

    expect(murmur.state()).toMatchObject({
      installed: false,
      enabled: false,
      wanted: false,
      check: null,
    })
    expect(store.murmurCheck()).toBeNull()
    await expect(murmur.describe(digest, { terminal: "t" })).resolves.toBeUndefined()
    await expect(import("node:fs/promises").then((fs) => fs.readdir(directory))).resolves.toEqual(
      [],
    )
  })
})

describe("murmur after the app brings a new engine", () => {
  it("keeps the model and murmur on, and fetches the engine alone", async ({ resources }) => {
    const store = new WorkspaceStore()
    resources.defer(() => store.close())
    const directory = await folder(resources)
    const first = await installed(resources, { store, directory })
    await first.murmur.close()

    const next = await setup(resources, {
      store,
      directory,
      engine: await llamaArchive(resources, "2"),
    })
    const states = await watchUntil(
      next.murmur,
      (state) => state.installing === null && state.installed && state.failure === null,
    )

    expect(states.some((state) => state.installing?.step === "engine")).toBe(true)
    expect(next.murmur.state()).toMatchObject({ enabled: true, check: { integrated: true } })
    await expect(next.murmur.describe(digest, { terminal: "t" })).resolves.toBeDefined()
  })
})

describe("murmur after the app brings a new engine, while it is fetched", () => {
  it("runs the new engine afterwards, never the one it replaced", async ({ resources }) => {
    const store = new WorkspaceStore()
    resources.defer(() => store.close())
    const directory = await folder(resources)
    const programs: string[] = []
    const base = fakeLaunch([arc, nvidia])
    const launch: Launch = (program, args) => {
      if (!args.includes("--list-devices")) programs.push(program)
      return base(program, args)
    }
    const first = await installed(resources, { store, directory, launch })
    await first.murmur.describe(digest, { terminal: "t" })
    const old = programs.at(-1) ?? ""
    await first.murmur.close()

    const next = await setup(resources, {
      store,
      directory,
      launch,
      engine: await llamaArchive(resources, "2"),
    })
    const watching = watchUntil(next.murmur, (state) => state.installing !== null)
    await watching
    // A second look at the disk, as another watcher makes, while the engine is replaced.
    await next.murmur.refresh()
    await next.murmur.settled()
    programs.length = 0
    await next.murmur.describe(digest, { terminal: "t" })

    expect(programs).toHaveLength(1)
    expect(programs[0]).not.toBe(old)
    expect(programs[0]?.startsWith(directory)).toBe(true)
    expect(next.murmur.state()).toMatchObject({ enabled: true, failure: null })
  })
})

describe("describing", () => {
  it("answers with the description, having read the digest without its secrets, the current prompt last", async ({
    resources,
  }) => {
    const { murmur, directory } = await installed(resources, { behaviour: "log device" })

    const description = await murmur.describe(digest, { terminal: "t" })

    expect(description).toMatchObject({ title: "Fake title on Vulkan0" })
    const asked = (await requests(directory)).at(-1)
    expect(asked?.messages.map((message) => message.role)).toEqual(["system", "user"])
    const text = asked?.messages[1]?.content ?? ""
    expect(text).not.toContain("hunter2")
    expect(text).toContain("API_KEY=[redacted]")
    expect(text.indexOf("first thing")).toBeLessThan(text.indexOf("fix the build"))
    expect(text).toMatch(/latest prompt[^]*fix the build/)
  })

  it("describes a shell, without its previous title, which is renamed on every command", async ({
    resources,
  }) => {
    const { murmur, directory } = await installed(resources, { behaviour: "log" })
    const shell: Digest = {
      kind: "shell",
      project: null,
      folder: null,
      command: "tail -f app.log",
      screen: ["token=abc123", "line two"],
      previous: { title: "Tailing log" },
    }

    await murmur.describe(shell, { terminal: "t" })

    const text = (await requests(directory)).at(-1)?.messages[1]?.content ?? ""
    expect(text).toContain("tail -f app.log")
    expect(text).not.toContain("abc123")
    expect(text).not.toContain("Tailing log")
  })

  it("asks an agent for a verdict before the title, and a shell for the title alone", async ({
    resources,
  }) => {
    const { murmur, directory } = await installed(resources, { behaviour: "log" })

    await murmur.describe(digest, { terminal: "t" })
    await murmur.describe(
      { kind: "shell", project: null, folder: null, command: null, screen: ["$"], previous: null },
      { terminal: "t" },
    )

    const [agent, shell] = (await requests(directory)).slice(-2) as unknown as {
      response_format: { json_schema: { name: string; schema: { required: string[] } } }
    }[]
    // The schemas have names of their own, which the fake answers by.
    expect(agent?.response_format.json_schema.name).toBe("agent_title")
    expect(shell?.response_format.json_schema.name).toBe("terminal_title")
    expect(agent?.response_format.json_schema.schema.required).toEqual(["changed", "title"])
    expect(shell?.response_format.json_schema.schema.required).toEqual(["title"])
  })

  it("takes the project's name out of a title", async ({ resources }) => {
    const { murmur } = await installed(resources, { behaviour: "project" })

    expect(await murmur.describe({ ...digest, project: "shopdeck" }, { terminal: "t" })).toEqual({
      title: "Login redirect",
      changed: true,
    })
  })

  it("judges a settled name changed only when the new title shares no word with it", async ({
    resources,
  }) => {
    const { murmur } = await installed(resources)
    const settled = (title: string): AgentDigest => ({
      ...digest,
      previous: { title },
      stage: "settled",
    })

    expect(await murmur.describe(settled("Billing schema"), { terminal: "t" })).toMatchObject({
      changed: true,
    })
    expect(await murmur.describe(settled("Fake title"), { terminal: "t" })).toMatchObject({
      changed: false,
    })
    // A forming name is the model's call.
    expect(
      await murmur.describe({ ...settled("Fake title"), stage: "forming" }, { terminal: "t" }),
    ).toMatchObject({ changed: true })
  })

  it("hands over the model's title and verdict as they are, but for a first title and a shell", async ({
    resources,
  }) => {
    const { murmur } = await installed(resources, { behaviour: "same" })
    const settled: Digest = { ...digest, previous: { title: "Billing schema" }, stage: "settled" }

    expect(await murmur.describe(settled, { terminal: "t" })).toEqual({
      title: "Fake title 1",
      changed: false,
    })
    // With no previous title, a first title is always a change; so is any shell's.
    expect(await murmur.describe(digest, { terminal: "t" })).toMatchObject({ changed: true })
    expect(
      await murmur.describe(
        {
          kind: "shell",
          project: null,
          folder: null,
          command: null,
          screen: ["$"],
          previous: null,
        },
        { terminal: "t" },
      ),
    ).toMatchObject({ changed: true })
  })

  it("does one job at a time", async ({ resources }) => {
    const { murmur } = await installed(resources, { behaviour: "slow" })

    const [first, second] = await Promise.all([
      murmur.describe(digest, { terminal: "t" }),
      murmur.describe(digest, { terminal: "t" }),
    ])

    expect(first?.title).toBe("Fake title 1")
    expect(second?.title).toBe("Fake title 2")
  })

  it("drops a job whose signal aborted, before or while it waits", async ({ resources }) => {
    const { murmur } = await installed(resources, { behaviour: "slow" })
    const early = new AbortController()
    early.abort()
    expect(await murmur.describe(digest, { terminal: "t", signal: early.signal })).toBeUndefined()

    const running = murmur.describe(digest, { terminal: "t" })
    const waiting = new AbortController()
    const queued = murmur.describe(digest, { terminal: "t", signal: waiting.signal })
    waiting.abort()

    expect(await queued).toBeUndefined()
    expect(await running).toBeDefined()
  })

  it("aborts a request in flight", async ({ resources }) => {
    const { murmur } = await installed(resources, { behaviour: "slow" })
    const controller = new AbortController()

    const job = murmur.describe(digest, { terminal: "t", signal: controller.signal })
    await sleep(100)
    controller.abort()

    expect(await job).toBeUndefined()
    await expect(murmur.describe(digest, { terminal: "t" })).resolves.toBeDefined()
  })

  it("unloads the model when idle and loads it again for the next job", async ({ resources }) => {
    const { murmur } = await installed(resources, { idleMs: 100 })

    expect((await murmur.describe(digest, { terminal: "t" }))?.title).toBe("Fake title 1")
    await sleep(400)

    // A new server counts from one again.
    expect((await murmur.describe(digest, { terminal: "t" }))?.title).toBe("Fake title 1")
  })

  it("keeps the model loaded while jobs come", async ({ resources }) => {
    const { murmur } = await installed(resources, { idleMs: 1000 })

    await murmur.describe(digest, { terminal: "t" })

    expect((await murmur.describe(digest, { terminal: "t" }))?.title).toBe("Fake title 2")
  })
})

describe("an engine that stops answering", () => {
  it("fails the job after the request's time, backs off, and lets the next jobs through", async ({
    resources,
  }) => {
    let time = 1_000
    const context = await installed(resources, { requestMs: 300, now: () => time })
    await writeFile(await modelOf(context.directory), "hang")
    await context.murmur.set({ enabled: false })
    await context.murmur.set({ enabled: true })

    const hung = context.murmur.describe(digest, { terminal: "t" })
    // Another terminal's job, dropped by its own signal, leaves the line at once.
    const other = context.murmur.describe(digest, {
      terminal: "t",
      signal: AbortSignal.timeout(100),
    })

    expect(await other).toBeUndefined()
    expect(await hung).toBeUndefined()
    // Backing off now.
    expect(await context.murmur.describe(digest, { terminal: "t" })).toBeUndefined()
    await writeFile(await modelOf(context.directory), "plain")
    time += 10_000
    expect(await context.murmur.describe(digest, { terminal: "t" })).toBeDefined()
  })
})

describe("a reply that is no title", () => {
  it("gives that job no title, without backing off", async ({ resources }) => {
    const context = await installed(resources, { now: () => 1_000 })
    await writeFile(await modelOf(context.directory), "garbage")
    await context.murmur.set({ enabled: false })
    await context.murmur.set({ enabled: true })

    // The model ran and its reply was refused: null, not undefined.
    expect(await context.murmur.describe(digest, { terminal: "t" })).toBeNull()

    await writeFile(await modelOf(context.directory), "plain")
    await context.murmur.set({ enabled: false })
    await context.murmur.set({ enabled: true })
    // The clock didn't move, so a back-off would still refuse.
    expect(await context.murmur.describe(digest, { terminal: "t" })).toBeDefined()
  })
})

// The fake reads what its model file says at each request: mending it mends the running server.
const fix = async (context: { directory: string }) => {
  await writeFile(await modelOf(context.directory), "plain")
}

describe("titles that keep being refused", () => {
  const refuse = async (resources: Parameters<typeof setup>[0]) => {
    const context = await installed(resources, { now: () => 1_000 })
    await writeFile(await modelOf(context.directory), "garbage")
    await context.murmur.set({ enabled: false })
    await context.murmur.set({ enabled: true })
    return context
  }
  it("leaves that terminal alone for a while, and no other", async ({ resources }) => {
    const context = await refuse(resources)

    expect(await context.murmur.describe(digest, { terminal: "a" })).toBeNull()
    expect(await context.murmur.describe(digest, { terminal: "a" })).toBeNull()
    await fix(context)

    // Two refusals in a row: held off though the model is fine now. That is undefined: it didn't run.
    expect(await context.murmur.describe(digest, { terminal: "a" })).toBeUndefined()
    // Another terminal is asked as ever, even of the same shape.
    expect(await context.murmur.describe(digest, { terminal: "b" })).toBeDefined()
    expect(await context.murmur.describe(digest, { terminal: "b" })).not.toBeNull()
  })
})

describe("a model that copies an example", () => {
  // The install check refuses a copy too, so the model starts copying after it.
  const copying = async (resources: Parameters<typeof setup>[0]) => {
    const context = await installed(resources)
    await writeFile(await modelOf(context.directory), "copy")
    await context.murmur.set({ enabled: false })
    await context.murmur.set({ enabled: true })
    return context.murmur
  }

  it("is refused, as the digest says nothing of it", async ({ resources }) => {
    const murmur = await copying(resources)

    expect(await murmur.describe(digest, { terminal: "t" })).toBeNull()
  })

  it("is not, when the digest is about that work", async ({ resources }) => {
    const murmur = await copying(resources)

    expect(
      await murmur.describe(
        { ...digest, prompts: ["webhook key rotation, please"] },
        { terminal: "t" },
      ),
    ).toEqual({ title: "Webhook key rotation", changed: true })
  })
})

describe("an engine that hangs while it loads", () => {
  it("drops the job after the start's time, and backs off", async ({ resources }) => {
    // Installed with the usual time to start, so a busy machine can't fail the check.
    const first = await installed(resources)
    await first.murmur.close()
    const context = await setup(resources, {
      store: first.store,
      directory: first.directory,
      engine: first.manifest,
      startMs: 150,
      now: () => 1_000,
    })
    await writeFile(await modelOf(context.directory), "late")
    await context.murmur.set({ enabled: false })
    await context.murmur.set({ enabled: true })

    const started = Date.now()

    expect(await context.murmur.describe(digest, { terminal: "t" })).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(await context.murmur.describe(digest, { terminal: "t" })).toBeUndefined()
  })
})

describe("a digest that takes too long to redact", () => {
  it(
    "gives that job nothing, leaves the event loop running, and backs off",
    {
      timeout: 20_000,
    },
    async ({ resources }) => {
      const context = await installed(resources, {
        prepareMs: 300,
        prepareScript: new URL("../testing/slow-worker.mjs", import.meta.url),
        now: () => 1_000,
      })
      const probe = redactionProbe()
      const hanging = { ...digest, project: "hang", redactionProbe: probe.buffer }
      let finished = false
      // Only the deadline is controlled; the worker and its main-loop acknowledgement
      // stay real, without racing the host's timer cadence against 300 ms.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        const job = context.murmur.describe(hanging, { terminal: "a" }).then((result) => {
          finished = true
          return result
        })
        await probe.observe()
        expect(finished).toBe(false)
        await vi.advanceTimersByTimeAsync(299)
        expect(finished).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(finished).toBe(true)
        expect(await job).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
      // Only that terminal is held off; another still gets a title.
      expect(
        await context.murmur.describe({ ...digest, project: "app" }, { terminal: "b" }),
      ).toBeDefined()
      expect(
        await context.murmur.describe({ ...digest, project: "hang" }, { terminal: "a" }),
      ).toBeUndefined()
    },
  )
})

describe("a GPU that went missing", () => {
  it("backs off instead of listing the devices for every job", async ({ resources }) => {
    let time = 1_000
    let listings = 0
    // The GPU is there for the install, and gone afterwards.
    let devices: FakeDevice[] = [arc]
    const context = await installed(resources, {
      now: () => time,
      launch: (program, args) => {
        if (args.includes("--list-devices")) listings += 1
        return fakeLaunch(args.includes("--list-devices") ? devices : [arc])(program, args)
      },
    })
    devices = []
    await context.murmur.set({ enabled: false })
    await context.murmur.set({ enabled: true })
    listings = 0
    let cleared = 0
    context.murmur.watchCleared(() => (cleared += 1))

    expect(await context.murmur.describe(digest, { terminal: "t" })).toBeUndefined()
    expect(await context.murmur.describe(digest, { terminal: "t" })).toBeUndefined()
    expect(await context.murmur.describe(digest, { terminal: "t" })).toBeUndefined()

    expect(listings).toBe(1)
    // A clean listing without the checked GPU: the check is dropped, and says why.
    expect(context.store.murmurCheck()).toBeNull()
    expect(context.murmur.state().failure).toMatch(/isn't there now/)
    // Losing the GPU is not the person turning murmur off: no titles are cleared.
    expect(cleared).toBe(0)
  })
})

describe("a job dropped while memory is read", () => {
  it("runs nothing", async ({ resources }) => {
    const controller = new AbortController()
    const launched: string[] = []
    const base = fakeLaunch([arc, nvidia])
    const context = await installed(resources, {
      launch: (program, args) => {
        launched.push(args.join(" "))
        return base(program, args)
      },
      // The read is where the job is dropped, and it reports plenty of memory, as an
      // aborted read on macOS does.
      freeMemory: () => {
        controller.abort()
        return Number.POSITIVE_INFINITY
      },
    })
    launched.length = 0

    expect(
      await context.murmur.describe(digest, { terminal: "t", signal: controller.signal }),
    ).toBeUndefined()

    expect(launched).toEqual([])
  })
})

describe("giving way", () => {
  it("waits while voice input is busy and runs once it is not", async ({ resources }) => {
    let busy = true
    const tracker = new ActivityTracker(() => busy)
    const { murmur } = await installed(resources, { voice: tracker })
    let done = false

    const job = murmur.describe(digest, { terminal: "t" }).then((value) => {
      done = true
      return value
    })
    await sleep(150)
    expect(done).toBe(false)
    busy = false
    tracker.update()

    expect(await job).toBeDefined()
  })

  it("stops the request in flight when voice input begins, and runs it again after", async ({
    resources,
  }) => {
    let busy = false
    const tracker = new ActivityTracker(() => busy)
    const { murmur } = await installed(resources, { voice: tracker, behaviour: "slow device" })
    let done = false

    const job = murmur.describe(digest, { terminal: "t" }).then((value) => {
      done = true
      return value
    })
    await sleep(150)
    busy = true
    tracker.update()
    await sleep(700)
    expect(done).toBe(false)
    busy = false
    tracker.update()

    expect(await job).toMatchObject({ title: "Fake title on Vulkan0" })
  })

  it("waits while the computer is short of memory", async ({ resources }) => {
    let free = 512 * 1024 * 1024
    const { murmur } = await installed(resources, { freeMemory: () => free })
    let done = false

    const job = murmur.describe(digest, { terminal: "t" }).then((value) => {
      done = true
      return value
    })
    await sleep(150)
    expect(done).toBe(false)
    free = 16 * 1024 * 1024 * 1024

    expect(await job).toBeDefined()
  })

  it("can be dropped while it waits", async ({ resources }) => {
    const { murmur } = await installed(resources, { freeMemory: () => 0 })
    const controller = new AbortController()

    const job = murmur.describe(digest, { terminal: "t", signal: controller.signal })
    await sleep(60)
    controller.abort()

    expect(await job).toBeUndefined()
  })

  it("backs off after a failure, and tries again later", async ({ resources }) => {
    let time = 1_000
    const context = await installed(resources, { now: () => time })
    // The model now crashes on the first job.
    await writeFile(await modelOf(context.directory), "crash")
    await context.murmur.set({ enabled: false })
    await context.murmur.set({ enabled: true })

    expect(await context.murmur.describe(digest, { terminal: "t" })).toBeUndefined()
    // Refused at once, while backing off.
    time += 10
    expect(await context.murmur.describe(digest, { terminal: "t" })).toBeUndefined()

    await writeFile(await modelOf(context.directory), "plain")
    expect(await context.murmur.describe(digest, { terminal: "t" })).toBeUndefined()
    time += 10_000
    expect(await context.murmur.describe(digest, { terminal: "t" })).toBeDefined()
  })
})

describe("closing murmur", () => {
  it("does not let an install that began just before it run on", async ({ resources }) => {
    const launches: string[] = []
    const base = fakeLaunch([arc, nvidia])
    const { murmur } = await setup(resources, {
      launch: (program, args) => {
        launches.push(args.join(" "))
        return base(program, args)
      },
    })

    const installing = murmur.install()
    await murmur.close()
    await installing.catch(() => {})
    const before = launches.length
    await sleep(500)
    await murmur.settled()

    expect(launches.length).toBe(before)
  })

  it("does not let an uninstall that waited for an install go on after it", async ({
    resources,
  }) => {
    const { murmur, directory } = await setup(resources)
    await murmur.install()

    const removing = murmur.uninstall()
    await murmur.close()

    await removing.catch(() => {})
    expect(murmur.state().enabled).toBe(false)
    void directory
  })

  it("refuses what comes after, and describes nothing", async ({ resources }) => {
    const { murmur } = await installed(resources)

    await murmur.close()

    await expect(murmur.install()).rejects.toMatchObject({ code: "CLOSING" })
    await expect(murmur.describe(digest, { terminal: "t" })).resolves.toBeUndefined()
  })

  it("ends a watch when its owner is released", async ({ resources }) => {
    const { murmur } = await setup(resources)
    const states: MurmurState[] = []
    const watching = (async () => {
      for await (const state of murmur.watch("owner")) states.push(state)
    })()
    await sleep(50)

    murmur.release("owner")

    await watching
    expect(states.length).toBeGreaterThan(0)
  })
})

describe("the free-memory gate", () => {
  it("does not count murmur's own loaded model against it", async ({ resources }) => {
    let free = 16 * 1024 * 1024 * 1024
    const { murmur } = await installed(resources, { freeMemory: () => free })
    // Loaded now.
    expect(await murmur.describe(digest, { terminal: "t" })).toBeDefined()

    // Its own model is what used the memory up.
    free = 256 * 1024 * 1024

    expect(await murmur.describe(digest, { terminal: "t" })).toBeDefined()
  })
})

describe("a GPU that is gone", () => {
  it("drops the check and says so, when the engine lists others", async ({ resources }) => {
    let devices: FakeDevice[] = [arc]
    const context = await installed(resources, {
      launch: (program, args) =>
        fakeLaunch(args.includes("--list-devices") ? devices : [arc])(program, args),
    })
    devices = [nvidia]
    await context.murmur.set({ enabled: false })
    await context.murmur.set({ enabled: true })

    expect(await context.murmur.describe(digest, { terminal: "t" })).toBeUndefined()

    expect(context.store.murmurCheck()).toBeNull()
    expect(context.murmur.state()).toMatchObject({ installed: true, check: null })
    expect(context.murmur.state().failure).toMatch(/device murmur was checked on isn't there now/)
  })
})

// What the runner's log is given while `run` goes on: the level, event and data of each line.
type Logged = { level: string; evt: string; data?: unknown }
const logged = async (run: () => Promise<void>): Promise<Logged[]> => {
  const lines: Logged[] = []
  const before = logs.current()
  const note = (level: string) => (evt: string, _msg?: string, detail?: { data?: unknown }) => {
    lines.push({ level, evt, data: detail?.data })
  }
  useLogger({
    for: () => ({
      debug: note("debug"),
      info: note("info"),
      warn: note("warn"),
      error: note("error"),
      fatal: note("fatal"),
    }),
    flush: () => {},
    close: () => {},
  })
  try {
    await run()
  } finally {
    useLogger(before)
  }
  return lines
}

describe("an engine that keeps failing", () => {
  it("writes each failure to the log, with what the engine said", async ({ resources }) => {
    let time = 1_000
    const context = await installed(resources, { now: () => time })
    await writeFile(await modelOf(context.directory), "crash")
    time += 1_000_000

    const lines = await logged(async () => {
      await context.murmur.describe(digest, { terminal: "t" })
    })

    expect(lines).toEqual([
      { level: "warn", evt: "murmur.engine-failed", data: { reason: expect.any(String) } },
    ])
  })

  it("shows the third failure in a row, and clears it on the next success", async ({
    resources,
  }) => {
    let time = 1_000
    const context = await installed(resources, { now: () => time })
    await writeFile(await modelOf(context.directory), "crash")
    const job = async () => {
      time += 1_000_000
      return context.murmur.describe(digest, { terminal: "t" })
    }

    await job()
    await job()
    expect(context.murmur.state().failure).toBeNull()
    expect(context.murmur.state().stopped).toBeNull()
    await job()

    expect(context.murmur.state().failure).toMatch(/engine/i)
    // The same words, apart as what stopped it, for the footer.
    expect(context.murmur.state().stopped).toBe(context.murmur.state().failure)
    // The check stands: murmur is still on, and tries again.
    expect(context.murmur.state()).toMatchObject({ enabled: true, check: { integrated: true } })
    await writeFile(await modelOf(context.directory), "plain")
    expect(await job()).toBeDefined()
    expect(context.murmur.state().failure).toBeNull()
    expect(context.murmur.state().stopped).toBeNull()
  })

  it("leaves stopped null for a failed engine update", async ({ resources }) => {
    const first = await installed(resources)
    await first.murmur.close()
    // The next build's engine cannot be fetched: the old one keeps serving, and Addons says why.
    const next = await setup(resources, {
      store: first.store,
      directory: first.directory,
      engine: await llamaArchive(resources, "2"),
      source: "",
    })
    await watchUntil(next.murmur, (state) => state.failure !== null)
    expect(next.murmur.state().failure).not.toBeNull()
    expect(next.murmur.state()).toMatchObject({ installed: true, stopped: null })
  })
})

describe("an engine failure shown on the card", () => {
  it("goes when the person turns murmur off", async ({ resources }) => {
    let time = 1_000
    const context = await installed(resources, { now: () => time })
    await writeFile(await modelOf(context.directory), "crash")
    for (let i = 0; i < 3; i += 1) {
      time += 1_000_000
      // eslint-disable-next-line no-await-in-loop -- One after another.
      await context.murmur.describe(digest, { terminal: "t" })
    }
    expect(context.murmur.state().failure).toMatch(/engine/i)

    await context.murmur.set({ enabled: false })

    expect(context.murmur.state().failure).toBeNull()
  })
})

describe("what a failed install says", () => {
  // A launch whose --list-devices prints `message` and exits with `code`, as an engine that
  // cannot start does.
  const failingList = (message: string, code: number): Launch => {
    const base = fakeLaunch([arc])
    return (program, args) =>
      args.includes("--list-devices")
        ? {
            command: process.execPath,
            args: ["-e", `console.error(${JSON.stringify(message)}); process.exit(${code})`],
          }
        : base(program, args)
  }

  it("lands in Not available, with the Linux hint, when the engine cannot load a library", async ({
    resources,
  }) => {
    const { murmur, store } = await setup(resources, {
      launch: failingList(
        "error while loading shared libraries: libvulkan.so.1: cannot open shared object file.",
        127,
      ),
    })

    await murmur.install()
    await murmur.settled()

    // The same on every try: this computer's, not a failure to retry.
    expect(murmur.state()).toMatchObject({
      installed: false,
      failure: null,
      unsupported: expect.objectContaining({ source: "check" }),
    })
    expect(murmur.state().unsupported?.reason).toMatch(
      /could not list graphics devices: error while/,
    )
    expect(murmur.state().unsupported?.reason).not.toMatch(/\.\./)
    if (process.platform === "linux")
      expect(murmur.state().unsupported?.reason).toMatch(/Vulkan driver/)
    expect(store.murmurUnsupported()).not.toBeNull()
  })

  it("fails with the engine's own words, and the hint, when it cannot list the devices for another reason", async ({
    resources,
  }) => {
    const { murmur, store } = await setup(resources, {
      launch: failingList("something odd happened.", 1),
    })

    await murmur.install()
    await murmur.settled()

    // It did not get to say what it sees, and may next time: a failure to try again.
    expect(murmur.state().failure).toMatch(
      /could not list graphics devices: something odd happened\./,
    )
    expect(murmur.state().failure).not.toMatch(/\.\./)
    if (process.platform === "linux") expect(murmur.state().failure).toMatch(/Vulkan driver/)
    expect(murmur.state().unsupported).toBeNull()
    expect(store.murmurUnsupported()).toBeNull()
  })

  it("keeps an answer cut off by a crash an engine failure, never a verdict", async ({
    resources,
  }) => {
    const { murmur, store } = await installed(resources, { behaviour: "truncate" })

    expect(murmur.state()).toMatchObject({ installed: true, check: null, unsupported: null })
    expect(murmur.state().failure).not.toBeNull()
    expect(store.murmurUnsupported()).toBeNull()
  })

  it("fails when the worker that prepares digests cannot start", async ({ resources }) => {
    const { murmur } = await installed(resources, {
      prepareScript: new URL("../testing/no-such-worker.mjs", import.meta.url),
    })

    expect(murmur.state().check).toBeNull()
    expect(murmur.state().failure).toMatch(/worker could not start/)
  })

  it("says so on the card when the worker cannot start later", async ({ resources }) => {
    const context = await installed(resources)
    // Rebuilt around a script that is not there.
    const broken = await setup(resources, {
      store: context.store,
      directory: context.directory,
      engine: context.manifest as string,
      prepareScript: new URL("../testing/no-such-worker.mjs", import.meta.url),
    })

    expect(await broken.murmur.describe(digest, { terminal: "t" })).toBeUndefined()

    expect(broken.murmur.state().failure).toMatch(/worker could not start/)
  })
})

describe("backing off, and forgetting", () => {
  it("is forgotten when the person turns murmur on", async ({ resources }) => {
    const context = await installed(resources, { now: () => 1_000 })
    await writeFile(await modelOf(context.directory), "crash")
    expect(await context.murmur.describe(digest, { terminal: "t" })).toBeUndefined()
    // Backing off.
    expect(await context.murmur.describe(digest, { terminal: "t" })).toBeUndefined()
    await writeFile(await modelOf(context.directory), "plain")

    await context.murmur.set({ enabled: false })
    await context.murmur.set({ enabled: true })

    expect(await context.murmur.describe(digest, { terminal: "t" })).toBeDefined()
  })

  it("does not count a job whose digest was stopped by murmur turning off", async ({
    resources,
  }) => {
    const context = await installed(resources, {
      now: () => 1_000,
      prepareMs: 5000,
      prepareScript: new URL("../testing/slow-worker.mjs", import.meta.url),
    })
    const job = context.murmur.describe({ ...digest, project: "hang" }, { terminal: "a" })
    await sleep(200)
    await context.murmur.set({ enabled: false })
    expect(await job).toBeUndefined()

    // Nothing was counted against the terminal or murmur (before turning it on forgets).
    const counted = context.murmur as unknown as {
      refusals: Map<string, unknown>
      refusedUntil: number
      failures: number
    }
    expect(counted.refusals.size).toBe(0)
    expect(counted.refusedUntil).toBe(0)
    expect(counted.failures).toBe(0)
    await context.murmur.set({ enabled: true })
    expect(
      await context.murmur.describe({ ...digest, project: "app" }, { terminal: "a" }),
    ).toBeDefined()
  })
})

describe("the model file", () => {
  it("is named by its checksum, and others are removed after the install", async ({
    resources,
  }) => {
    const { directory } = await setup(resources)
    const { mkdir } = await import("node:fs/promises")
    await mkdir(join(directory, "models"), { recursive: true })
    await writeFile(join(directory, "models", "old-model.gguf"), "old")
    await writeFile(join(directory, "models", "stale.gguf.part"), "partial")
    const again = await installed(resources, { directory })

    const files = await readdir(join(directory, "models"))

    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^[0-9a-f]{12}-model\.gguf$/)
    expect(again.murmur.state().installed).toBe(true)
  })
})

describe("llama-server's arguments", () => {
  // Changing these means bumping `engineInterface` in engines/murmur/scripts/build.ts.
  it("are pinned", () => {
    expect(serverArguments("/m/model.gguf", "Vulkan0", 8080)).toEqual([
      "--host",
      "127.0.0.1",
      "--port",
      "8080",
      "-m",
      "/m/model.gguf",
      "--device",
      "Vulkan0",
      "-ngl",
      "999",
      "-c",
      "4096",
      "-np",
      "1",
      "--reasoning",
      "off",
      "--exit-with-stdin",
    ])
  })
})

describe("clearing titles", () => {
  it("tells when the person turns murmur off, once, and not on other ends", async ({
    resources,
  }) => {
    const { murmur } = await installed(resources)
    let cleared = 0
    const unwatch = murmur.watchCleared(() => (cleared += 1))

    await murmur.set({ enabled: false })
    await murmur.set({ enabled: false })
    expect(cleared).toBe(1)
    await murmur.set({ enabled: true })
    expect(cleared).toBe(1)
    unwatch()
    await murmur.set({ enabled: false })
    expect(cleared).toBe(1)
  })

  it("tells when murmur is uninstalled", async ({ resources }) => {
    const { murmur } = await installed(resources)
    let cleared = 0
    murmur.watchCleared(() => (cleared += 1))

    await murmur.uninstall()
    expect(cleared).toBe(1)
  })

  it("does not tell when the runner closes, with murmur on or mid-uninstall", async ({
    resources,
  }) => {
    const on = await installed(resources)
    let cleared = 0
    on.murmur.watchCleared(() => (cleared += 1))
    await on.murmur.close()
    expect(cleared).toBe(0)

    // The runner closes right after the removal turned murmur off, while it goes on.
    const removing = await installed(resources)
    removing.murmur.watchCleared(() => (cleared += 1))
    const save = removing.store.saveMurmurSettings.bind(removing.store)
    removing.store.saveMurmurSettings = (change) => {
      save(change)
      if (change.enabled === false) void removing.murmur.close()
    }
    await removing.murmur.uninstall().catch(() => {})
    expect(cleared).toBe(0)
  })

  it("drops a shown engine failure when an uninstall fails", async ({ resources }) => {
    if (process.platform === "win32" || process.getuid?.() === 0) return
    let time = 1_000
    const { murmur, directory } = await installed(resources, { now: () => time })
    await writeFile(await modelOf(directory), "crash")
    for (let i = 0; i < 3; i += 1) {
      time += 1_000_000
      // eslint-disable-next-line no-await-in-loop -- One after another.
      await murmur.describe(digest, { terminal: "t" })
    }
    expect(murmur.state().failure).toMatch(/engine/i)
    const models = join(directory, "models")
    await chmod(models, 0o555)
    try {
      await expect(murmur.uninstall()).rejects.toMatchObject({ code: "CONFLICT" })
    } finally {
      await chmod(models, 0o755)
    }

    expect(murmur.state().failure).toBeNull()
  })

  it("fires once for an uninstall whose removal fails", async ({ resources }) => {
    // A folder that cannot be written to keeps its files from being removed.
    if (process.platform === "win32" || process.getuid?.() === 0) return
    const { murmur, directory } = await installed(resources)
    let cleared = 0
    murmur.watchCleared(() => (cleared += 1))
    const models = join(directory, "models")
    await chmod(models, 0o555)
    try {
      await expect(murmur.uninstall()).rejects.toMatchObject({ code: "CONFLICT" })
    } finally {
      await chmod(models, 0o755)
    }

    // Murmur was turned off by it, so the titles go, once.
    expect(cleared).toBe(1)
  })

  it("is silent as the runner closes, and when a check fails", async ({ resources }) => {
    const { murmur } = await setup(resources, { devices: [processor] })
    let cleared = 0
    murmur.watchCleared(() => (cleared += 1))

    await murmur.install()
    await murmur.settled()
    await murmur.close()

    expect(cleared).toBe(0)
  })
})

const reply: NoteDigest = {
  kind: "reply",
  reply:
    "I rounded the checkout totals per line. Which mode should I keep? API_KEY=hunter2 is set.",
  failed: false,
}

describe("writing notes", () => {
  it("answers a reply with a gist", async ({ resources }) => {
    const { murmur, directory } = await installed(resources, { behaviour: "log" })

    expect(await murmur.note(reply, { terminal: "t" })).toEqual({
      kind: "gist",
      text: expect.stringMatching(/^Fake gist \d+$/),
    })

    const asked = await requests(directory)
    const request = asked.at(-1) as unknown as {
      response_format: { json_schema: { name: string } }
      max_tokens?: number
    }
    expect(request.response_format.json_schema.name).toBe("reply_gist")
    expect(request.max_tokens).toBe(128)
    // The worker redacted the reply before the model saw it.
    const text = asked.at(-1)?.messages[1]?.content ?? ""
    expect(text).not.toContain("hunter2")
    expect(text).toContain("API_KEY=[redacted]")
  })

  it("refuses a note that copies an example", async ({ resources }) => {
    const context = await installed(resources)
    await writeFile(await modelOf(context.directory), "copy")
    await context.murmur.set({ enabled: false })
    await context.murmur.set({ enabled: true })

    expect(await context.murmur.note(reply, { terminal: "t" })).toBeNull()
  })

  it("does not run when murmur is off", async ({ resources }) => {
    const { murmur } = await setup(resources, { engine: false })

    await expect(murmur.note(reply, { terminal: "t" })).resolves.toBeUndefined()
  })
})

// Starts jobs of each kind while one runs, and says in what order they finished.
const order = async (murmur: Murmur, jobs: readonly (readonly [string, NoteDigest | Digest])[]) => {
  const finished: string[] = []
  const results = jobs.map(([name, input]) => {
    const options = { terminal: "t" }
    const result =
      input.kind === "reply" ? murmur.note(input, options) : murmur.describe(input, options)
    return result.then((value) => {
      finished.push(name)
      return value
    })
  })
  await Promise.all(results)
  return finished
}

describe("the line of jobs", () => {
  it("serves a gist before a title, and first come first served within", async ({ resources }) => {
    const { murmur } = await installed(resources, { behaviour: "slow" })

    const finished = await order(murmur, [
      ["running", digest],
      ["title 1", digest],
      ["gist 1", reply],
      ["title 2", digest],
      ["gist 2", reply],
    ])

    // The one running is never pre-empted.
    expect(finished).toEqual(["running", "gist 1", "gist 2", "title 1", "title 2"])
  })

  it("lets a waiting job leave when its signal aborts, without holding the others", async ({
    resources,
  }) => {
    const { murmur } = await installed(resources, { behaviour: "slow" })
    const leaving = new AbortController()
    const finished: string[] = []
    const running = murmur.describe(digest, { terminal: "t" }).then(() => finished.push("running"))
    const gist = murmur.note(reply, { terminal: "t", signal: leaving.signal }).then((value) => {
      finished.push("gist")
      return value
    })
    const title = murmur.describe(digest, { terminal: "t" }).then(() => finished.push("title"))
    leaving.abort()

    expect(await gist).toBeUndefined()
    await Promise.all([running, title])
    expect(finished).toEqual(["gist", "running", "title"])
    // The line is idle again.
    expect(await murmur.note(reply, { terminal: "t" })).toMatchObject({ kind: "gist" })
  })
})

describe("notes that keep being refused", () => {
  it("are counted for each kind of text apart", async ({ resources }) => {
    const context = await installed(resources, { now: () => 1_000 })
    await writeFile(await modelOf(context.directory), "garbage")
    await context.murmur.set({ enabled: false })
    await context.murmur.set({ enabled: true })

    expect(await context.murmur.note(reply, { terminal: "a" })).toBeNull()
    expect(await context.murmur.note(reply, { terminal: "a" })).toBeNull()
    await fix(context)

    // Two gists refused in a row: that terminal's gists are held off.
    expect(await context.murmur.note(reply, { terminal: "a" })).toBeUndefined()
    // Its titles are not, nor are another terminal's gists.
    expect(await context.murmur.describe(digest, { terminal: "a" })).toMatchObject({
      title: expect.any(String),
    })
    expect(await context.murmur.note(reply, { terminal: "b" })).toMatchObject({ kind: "gist" })
  })
})

describe("notes giving way", () => {
  it("wait while voice input is busy and run once it is not", async ({ resources }) => {
    let busy = true
    const tracker = new ActivityTracker(() => busy)
    const { murmur } = await installed(resources, { voice: tracker })
    let done = false

    const job = murmur.note(reply, { terminal: "t" }).then((value) => {
      done = true
      return value
    })
    await sleep(150)
    expect(done).toBe(false)
    busy = false
    tracker.update()

    expect(await job).toMatchObject({ kind: "gist" })
  })

  it("back off after a failure, for titles too", async ({ resources }) => {
    const time = 1_000
    const context = await installed(resources, { now: () => time })
    await writeFile(await modelOf(context.directory), "crash")
    await context.murmur.set({ enabled: false })
    await context.murmur.set({ enabled: true })

    expect(await context.murmur.note(reply, { terminal: "t" })).toBeUndefined()
    await fix(context)

    expect(await context.murmur.note(reply, { terminal: "u" })).toBeUndefined()
    expect(await context.murmur.describe(digest, { terminal: "v" })).toBeUndefined()
  })

  it("count no failure when murmur is turned off under them", async ({ resources }) => {
    const context = await installed(resources, { now: () => 1_000 })
    // The engine never answers, and says when the note's request has reached it: the note is
    // under way when murmur is turned off, however slow the machine.
    const model = await modelOf(context.directory)
    await writeFile(model, "hang seen")
    const job = context.murmur.note(reply, { terminal: "a" })
    await vi.waitFor(() => expect(existsSync(`${model}.seen`)).toBe(true), { timeout: 10_000 })
    await context.murmur.set({ enabled: false })
    expect(await job).toBeUndefined()

    const counted = context.murmur as unknown as {
      refusals: Map<string, unknown>
      refusedUntil: number
      failures: number
    }
    expect(counted.refusals.size).toBe(0)
    expect(counted.refusedUntil).toBe(0)
    expect(counted.failures).toBe(0)
  })
})

describe("a request too big for the context", () => {
  it("gets no text for any kind of job, without a failure or a restart", async ({ resources }) => {
    const context = await installed(resources, { now: () => 1_000 })
    await writeFile(await modelOf(context.directory), "overflow")
    await context.murmur.set({ enabled: false })
    await context.murmur.set({ enabled: true })

    expect(await context.murmur.note(reply, { terminal: "b" })).toBeNull()
    expect(await context.murmur.describe(digest, { terminal: "c" })).toBeNull()

    const counted = context.murmur as unknown as {
      refusedUntil: number
      failures: number
      engineStrikes: number
    }
    expect(counted.refusedUntil).toBe(0)
    expect(counted.failures).toBe(0)
    expect(counted.engineStrikes).toBe(0)
    expect(context.murmur.state().failure).toBeNull()
    // The engine was not stopped for it: a smaller request is answered at once.
    await fix(context)
    expect(await context.murmur.note(reply, { terminal: "d" })).toMatchObject({ kind: "gist" })
  })
})
