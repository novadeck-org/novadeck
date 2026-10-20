import { notesBlock, type ReleaseNotes } from "@novadeck/protocol/release-notes"
import type { IpcMainEvent } from "electron"

import { dismissWhatsNewChannel, openWhatsNewPageChannel, whatsNewChannel } from "../bridge.js"
import { context, describe, expect, it } from "../test"
import { isNewerVersion } from "./applications-folder"
import {
  keepWhatsNew,
  prereleaseRecheckMs,
  registerWhatsNewIpc,
  whatsNewAtLaunch,
  type ReleaseFetch,
} from "./whats-new"

const launch = (
  previous: string | undefined,
  current: string,
  extra: { pending?: string; settled?: string; ranBefore?: boolean; offerable?: boolean } = {},
) =>
  whatsNewAtLaunch(
    {
      previous,
      current,
      pending: extra.pending,
      settled: extra.settled,
      ranBefore: extra.ranBefore ?? false,
      offerable: extra.offerable ?? true,
    },
    isNewerVersion,
  )

describe("what a launch records about what is new", () => {
  it("marks the version after an update", () => {
    expect(launch("0.4.2", "0.5.0")).toEqual({ lastRunVersion: "0.5.0", pending: "0.5.0" })
    expect(launch("0.5.0-beta.1", "0.5.0")).toEqual({ lastRunVersion: "0.5.0", pending: "0.5.0" })
    expect(launch("0.4.2", "0.5.0-beta.2")).toEqual({
      lastRunVersion: "0.5.0-beta.2",
      pending: "0.5.0-beta.2",
    })
  })

  it("marks nothing on a fresh install", () => {
    expect(launch(undefined, "0.5.0")).toEqual({ lastRunVersion: "0.5.0", pending: undefined })
  })

  it("marks nothing for the same version or a downgrade", () => {
    expect(launch("0.5.0", "0.5.0")).toEqual({ lastRunVersion: "0.5.0", pending: undefined })
    expect(launch("0.5.0", "0.4.2")).toEqual({ lastRunVersion: "0.4.2", pending: undefined })
  })

  it("keeps the mark of this version until it is settled, across launches", () => {
    expect(launch("0.5.0", "0.5.0", { pending: "0.5.0" })?.pending).toBe("0.5.0")
  })

  it("gives up the mark of another version", () => {
    expect(launch("0.5.0", "0.6.0", { pending: "0.5.0" })?.pending).toBe("0.6.0")
    expect(launch("0.5.0", "0.5.0", { pending: "0.4.2" })?.pending).toBeUndefined()
  })

  it("never offers a version at or below one settled", () => {
    expect(launch("0.5.0", "0.6.0", { settled: "0.6.0" })?.pending).toBeUndefined()
    expect(
      launch("0.4.2", "0.5.0", { settled: "0.6.0", pending: "0.5.0" })?.pending,
    ).toBeUndefined()
    expect(launch("0.6.0", "0.7.0", { settled: "0.6.0" })?.pending).toBe("0.7.0")
  })

  it("counts an install from before the last-run version was kept as updated, if it ran before", () => {
    expect(launch(undefined, "0.5.0", { ranBefore: true })).toEqual({
      lastRunVersion: "0.5.0",
      pending: "0.5.0",
    })
    expect(launch(undefined, "0.5.0", { ranBefore: false })?.pending).toBeUndefined()
    // Once a last-run version is kept, the data folder says nothing more.
    expect(launch("0.5.0", "0.5.0", { ranBefore: true })?.pending).toBeUndefined()
  })

  it("changes nothing for a build that is no release's or has no repository", () => {
    expect(launch("0.4.2", "0.0.0", { pending: "0.4.2" })).toBeUndefined()
    expect(launch("0.4.2", "dev")).toBeUndefined()
    expect(launch("0.4.2", "0.5.0", { offerable: false })).toBeUndefined()
  })
})

const repository = { owner: "novadeck-org", repo: "novadeck" }

const notes = (highlights: ReleaseNotes["highlights"]): ReleaseNotes => ({
  version: "0.5.0",
  kind: "promote",
  highlights,
  changes: [],
  fixes: 0,
})
const highlight = { title: "Faster Grid", line: "Grid opens in half the time.", prs: [12] }

const jsonType = { get: () => "application/json; charset=utf-8" }

const release = (body: string, status = 200, prerelease = false) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: jsonType,
  json: async (): Promise<unknown> =>
    status === 404 ? { message: "Not Found" } : { body, prerelease },
})

const kept = (
  answer: () => ReturnType<ReleaseFetch>,
  options: {
    pending?: string | undefined
    launched?: () => Promise<void>
    checkedAt?: number
    now?: () => number
  } = {},
) => {
  const state: { pending: string | undefined; checkedAt: number | undefined } = {
    checkedAt: options.checkedAt,
    pending: "pending" in options ? options.pending : "0.5.0",
  }
  const urls: string[] = []
  const inits: Parameters<ReleaseFetch>[1][] = []
  const logged: string[] = []
  const whatsNew = keepWhatsNew({
    version: "0.5.0",
    launched: options.launched ?? (async () => {}),
    pending: () => state.pending,
    clear: () => void (state.pending = undefined),
    checkedAt: () => state.checkedAt,
    recordCheck: (time) => void (state.checkedAt = time),
    now: options.now ?? (() => 1_000_000_000),
    repository: async () => repository,
    fetch: (url, init) => {
      urls.push(url)
      inits.push(init)
      return answer()
    },
    log: (message) => void logged.push(message),
  })
  return { ...whatsNew, state, urls, inits, logged }
}

describe("what is new in the version", () => {
  it("reads the release of the version and answers its highlights without the pull requests", async () => {
    const body = `Notes\n\n${notesBlock(notes([highlight]))}`
    const { whatsNew, urls, inits, state } = kept(async () => release(body))
    expect(await whatsNew()).toEqual({
      version: "0.5.0",
      highlights: [{ title: "Faster Grid", line: "Grid opens in half the time." }],
    })
    expect(urls).toEqual([
      "https://api.github.com/repos/novadeck-org/novadeck/releases/tags/v0.5.0",
    ])
    expect(inits[0]?.headers).toMatchObject({ Accept: "application/vnd.github+json" })
    expect(inits[0]?.headers["User-Agent"]).toBeTruthy()
    expect(inits[0]?.signal.aborted).toBe(false)
    // Showing it leaves it pending, until the person dismisses it.
    expect(state.pending).toBe("0.5.0")
  })

  it("reads the release once, however often it is asked", async () => {
    const body = notesBlock(notes([highlight]))
    const { whatsNew, urls } = kept(async () => release(body))
    const answers = await Promise.all([whatsNew(), whatsNew()])
    await whatsNew()
    expect(answers[0]).toBe(answers[1])
    expect(urls).toHaveLength(1)
  })

  it("is nothing when the version is not pending", async () => {
    const { whatsNew, urls } = kept(async () => release(notesBlock(notes([highlight]))), {
      pending: undefined,
    })
    expect(await whatsNew()).toBeUndefined()
    expect(urls).toEqual([])
  })

  it("is nothing once dismissed, and stays so", async () => {
    const { whatsNew, dismiss, state } = kept(async () => release(notesBlock(notes([highlight]))))
    expect(await whatsNew()).toBeDefined()
    dismiss()
    expect(state.pending).toBeUndefined()
    expect(await whatsNew()).toBeUndefined()
  })

  it("waits for the launch to mark the version before it looks", async () => {
    let settle!: () => void
    const launched = new Promise<void>((resolve) => (settle = resolve))
    const { whatsNew, state, urls } = kept(async () => release(notesBlock(notes([highlight]))), {
      pending: undefined,
      launched: () => launched,
    })
    const asked = whatsNew()
    await Promise.resolve()
    expect(urls).toEqual([])
    state.pending = "0.5.0"
    settle()
    expect(await asked).toBeDefined()
  })

  context("when the release has nothing to show", () => {
    it("clears the mark for a release without highlights, without a block, or that is gone", async () => {
      const answers = [
        async () => release(notesBlock(notes([]))),
        async () => release("Just words."),
        async () => release("", 404),
        async () => ({ status: 200, ok: true, headers: jsonType, json: async () => null }),
      ]
      const runs = answers.map((answer) => kept(answer))
      expect(await Promise.all(runs.map(({ whatsNew }) => whatsNew()))).toEqual(
        answers.map(() => undefined),
      )
      expect(runs.map(({ state }) => state.pending)).toEqual(answers.map(() => undefined))
    })
  })

  context("when the release can't be read now", () => {
    it("keeps the mark for a prerelease with no highlights, which its promotion fills in", async () => {
      const { whatsNew, state } = kept(async () => release(notesBlock(notes([])), 200, true))
      expect(await whatsNew()).toBeUndefined()
      expect(state.pending).toBe("0.5.0")
      expect(state.checkedAt).toBe(1_000_000_000)
    })

    it("reads such a prerelease again only after a day", async () => {
      const answer = async () => release(notesBlock(notes([])), 200, true)
      const soon = kept(answer, { checkedAt: 1_000_000_000 - prereleaseRecheckMs + 1 })
      expect(await soon.whatsNew()).toBeUndefined()
      expect(soon.urls).toEqual([])
      const later = kept(answer, { checkedAt: 1_000_000_000 - prereleaseRecheckMs })
      await later.whatsNew()
      expect(later.urls).toHaveLength(1)
    })

    it("does not throttle a failed read", async () => {
      const failed = kept(async () => release("", 503))
      await failed.whatsNew()
      expect(failed.state.checkedAt).toBeUndefined()
    })

    it("takes a 404 that is not GitHub's JSON for a passing failure", async () => {
      const answers = [
        {
          status: 404,
          ok: false,
          headers: { get: () => "text/html" },
          json: async () => ({ message: "x" }),
        },
        {
          status: 404,
          ok: false,
          headers: { get: () => null },
          json: async () => ({ message: "x" }),
        },
        { status: 404, ok: false, headers: jsonType, json: async () => ({}) },
        { status: 404, ok: false, headers: jsonType, json: async () => ({ message: 3 }) },
        {
          status: 404,
          ok: false,
          headers: jsonType,
          json: async (): Promise<unknown> => {
            throw new SyntaxError("<html>")
          },
        },
      ]
      const runs = answers.map((answer) => kept(async () => answer))
      await Promise.all(runs.map(({ whatsNew }) => whatsNew()))
      expect(runs.map(({ state }) => state.pending)).toEqual(answers.map(() => "0.5.0"))
    })

    it("keeps the mark for a later launch", async () => {
      const answers = [
        async () => release("", 403),
        async () => release("", 429),
        async () => release("", 503),
        async () => {
          throw new TypeError("fetch failed")
        },
        async () => {
          throw new DOMException("The operation timed out.", "TimeoutError")
        },
        async () => ({
          status: 200,
          ok: true,
          headers: jsonType,
          json: async (): Promise<unknown> => {
            throw new SyntaxError("Unexpected end of JSON input")
          },
        }),
      ]
      const runs = answers.map((answer) => kept(answer))
      expect(await Promise.all(runs.map(({ whatsNew }) => whatsNew()))).toEqual(
        answers.map(() => undefined),
      )
      expect(runs.map(({ state }) => state.pending)).toEqual(answers.map(() => "0.5.0"))
    })

    it("logs a thrown failure and not a refusal's status", async () => {
      const { whatsNew, logged } = kept(async () => {
        throw new TypeError("fetch failed")
      })
      await whatsNew()
      expect(logged).toEqual(["The release notes were not read."])
    })
  })
})

type Listener = (event: IpcMainEvent, ...values: unknown[]) => unknown

const registered = (own: boolean) => {
  const listeners = new Map<string, Listener>()
  const calls: string[] = []
  registerWhatsNewIpc(
    {
      on: (name, listener) => void listeners.set(name, listener as Listener),
      handle: (name, listener) => void listeners.set(name, listener as Listener),
    },
    {
      window: () => (own ? "window" : undefined),
      whatsNew: async () => {
        calls.push("whats new")
        return { version: "0.5.0", highlights: [{ title: "T", line: "L" }] }
      },
      dismiss: () => void calls.push("dismiss"),
      openPage: () => void calls.push("open page"),
    },
  )
  const send = (name: string): unknown => listeners.get(name)?.({} as IpcMainEvent)
  return { send, calls }
}

describe("taking the page's requests about what is new", () => {
  it("answers, dismisses and opens the page for the app's own window", async () => {
    const { send, calls } = registered(true)
    expect(await send(whatsNewChannel)).toEqual({
      version: "0.5.0",
      highlights: [{ title: "T", line: "L" }],
    })
    send(dismissWhatsNewChannel)
    send(openWhatsNewPageChannel)
    expect(calls).toEqual(["whats new", "dismiss", "open page"])
  })

  it("ignores any other sender and tells it there is nothing", async () => {
    const { send, calls } = registered(false)
    expect(await send(whatsNewChannel)).toBeUndefined()
    send(dismissWhatsNewChannel)
    send(openWhatsNewPageChannel)
    expect(calls).toEqual([])
  })
})
