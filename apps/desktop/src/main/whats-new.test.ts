/* eslint-disable no-await-in-loop -- Each case runs on its own, one after another. */
import { notesBlock, type ReleaseNotes } from "@novadeck/protocol/release-notes"
import type { IpcMainEvent } from "electron"
import { vi } from "vitest"

import { dismissWhatsNewChannel, openWhatsNewPageChannel, whatsNewChannel } from "../bridge.js"
import { context, describe, expect, it } from "../test"
import { isNewerVersion } from "./applications-folder"
import {
  keepWhatsNew,
  prereleaseRecheckMs,
  readRetryMs,
  registerWhatsNewIpc,
  whatsNewAtLaunch,
  type ReleaseFetch,
} from "./whats-new"

const launch = (
  previous: string | undefined,
  current: string,
  extra: {
    pending?: string
    from?: string
    settled?: string
    ranBefore?: boolean
    offerable?: boolean
  } = {},
) =>
  whatsNewAtLaunch(
    {
      previous,
      current,
      pending: extra.pending,
      from: extra.from,
      settled: extra.settled,
      ranBefore: extra.ranBefore ?? false,
      offerable: extra.offerable ?? true,
    },
    isNewerVersion,
  )

describe("what a launch records about what is new", () => {
  it("marks the version after an update", () => {
    expect(launch("0.4.2", "0.5.0")).toEqual({
      lastRunVersion: "0.5.0",
      pending: "0.5.0",
      from: "0.4.2",
    })
    expect(launch("0.5.0-beta.1", "0.5.0")).toMatchObject({ pending: "0.5.0" })
    expect(launch("0.4.2", "0.5.0-beta.2")).toEqual({
      lastRunVersion: "0.5.0-beta.2",
      pending: "0.5.0-beta.2",
      from: "0.4.2",
    })
  })

  it("starts the notes after the version updated from, or the newest settled past it", () => {
    expect(launch("0.4.2", "0.5.0", { settled: "0.4.5" })?.from).toBe("0.4.5")
    expect(launch("0.4.2", "0.5.0", { settled: "0.4.0" })?.from).toBe("0.4.2")
    // The start is kept with the mark, across launches of the same version.
    expect(launch("0.5.0", "0.5.0", { pending: "0.5.0", from: "0.4.2" })?.from).toBe("0.4.2")
    // Updated from a version that is not known, only the version's own notes are told.
    expect(launch(undefined, "0.5.0", { ranBefore: true })?.from).toBeUndefined()
    expect(launch("0.5.0", "0.5.0", { from: "0.4.2" })?.from).toBeUndefined()
  })

  it("marks nothing on a fresh install", () => {
    expect(launch(undefined, "0.5.0")).toEqual({
      lastRunVersion: "0.5.0",
      pending: undefined,
      from: undefined,
    })
  })

  it("marks nothing for the same version or a downgrade", () => {
    expect(launch("0.5.0", "0.5.0")).toMatchObject({ lastRunVersion: "0.5.0", pending: undefined })
    expect(launch("0.5.0", "0.4.2")).toMatchObject({ lastRunVersion: "0.4.2", pending: undefined })
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
    expect(launch(undefined, "0.5.0", { ranBefore: true })).toMatchObject({
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
    status === 404 ? { message: "Not Found" } : { tag_name: "v0.5.0", body, prerelease },
})

const kept = (
  answer: (url: string) => ReturnType<ReleaseFetch>,
  options: {
    pending?: string | undefined
    from?: string
    launched?: () => Promise<void>
    checkedAt?: number
    delay?: (ms: number) => Promise<void>
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
    from: () => options.from,
    clear: () => void (state.pending = undefined),
    checkedAt: () => state.checkedAt,
    recordCheck: (time) => void (state.checkedAt = time),
    now: options.now ?? (() => 1_000_000_000),
    ...(options.delay ? { delay: options.delay } : { delay: async () => {} }),
    repository: async () => repository,
    fetch: (url, init) => {
      urls.push(url)
      inits.push(init)
      return answer(url)
    },
    newer: isNewerVersion,
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

  it("answers a prerelease's own highlights, with no wait for its promotion", async () => {
    const own = notesBlock({ ...notes([highlight]), kind: "release" })
    const { whatsNew, state } = kept(async () => release(own, 200, true))
    expect(await whatsNew()).toEqual({
      version: "0.5.0",
      highlights: [{ title: "Faster Grid", line: "Grid opens in half the time." }],
    })
    expect(state.pending).toBe("0.5.0")
    expect(state.checkedAt).toBeUndefined()
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

  context("when the first read fails for a reason that may pass", () => {
    it("tries once more after two minutes, in the same launch, and answers what it finds", async () => {
      vi.useFakeTimers()
      try {
        const answers = [release("", 429), release(notesBlock(notes([highlight])))]
        const whatsNew = keepWhatsNew({
          version: "0.5.0",
          launched: async () => {},
          pending: () => "0.5.0",
          clear: () => {},
          checkedAt: () => undefined,
          recordCheck: () => {},
          now: () => 0,
          from: () => undefined,
          repository: async () => repository,
          fetch: async () => answers.shift()!,
          newer: isNewerVersion,
          log: () => {},
        }).whatsNew
        let answer: unknown = "unanswered"
        void whatsNew().then((found) => (answer = found))
        await vi.advanceTimersByTimeAsync(readRetryMs - 1)
        expect(answer).toBe("unanswered")
        await vi.advanceTimersByTimeAsync(1)
        expect(answer).toEqual({
          version: "0.5.0",
          highlights: [{ title: "Faster Grid", line: "Grid opens in half the time." }],
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it("tries only once more, and keeps the mark when that fails too", async () => {
      const run = kept(async () => release("", 503))
      expect(await run.whatsNew()).toBeUndefined()
      expect(run.urls).toHaveLength(2)
      expect(run.state.pending).toBe("0.5.0")
    })

    it("does not try again when the person dismissed it meanwhile", async () => {
      let wake!: () => void
      const run = kept(async () => release("", 503), {
        delay: () => new Promise<void>((resolve) => (wake = resolve)),
      })
      const asked = run.whatsNew()
      await vi.waitFor(() => expect(wake).toBeDefined())
      run.dismiss()
      wake()
      expect(await asked).toBeUndefined()
      expect(run.urls).toHaveLength(1)
    })

    it("does not try again after a read that settles, or a prerelease's wait", async () => {
      const gone = kept(async () => release("", 404))
      await gone.whatsNew()
      const waiting = kept(async () => release(notesBlock(notes([])), 200, true))
      await waiting.whatsNew()
      expect([gone.urls.length, waiting.urls.length]).toEqual([1, 1])
    })
  })

  context("when the block names another version", () => {
    const other = { ...notes([highlight]), version: "0.4.2" }

    it("takes it for no block and settles, as the tag matched", async () => {
      const run = kept(async () => release(notesBlock(other)))
      expect(await run.whatsNew()).toBeUndefined()
      expect(run.state.pending).toBeUndefined()
      expect(run.urls).toHaveLength(1)
    })

    it("waits for a prerelease's promotion, which may write the right one", async () => {
      const run = kept(async () => release(notesBlock(other), 200, true))
      expect(await run.whatsNew()).toBeUndefined()
      expect(run.state.pending).toBe("0.5.0")
    })
  })

  context("when the release has nothing to show", () => {
    it("clears the mark for a release without highlights, without a block, or that is gone", async () => {
      const answers = [
        async () => release(notesBlock(notes([]))),
        async () => release("Just words."),
        async () => release("", 404),
        async () => ({ ...release(""), json: async () => ({ tag_name: "v0.5.0", body: null }) }),
      ]
      const runs = answers.map((answer) => kept(answer))
      expect(await Promise.all(runs.map(({ whatsNew }) => whatsNew()))).toEqual(
        answers.map(() => undefined),
      )
      expect(runs.map(({ state }) => state.pending)).toEqual(answers.map(() => undefined))
    })

    it("keeps the mark for an answer that is not this release", async () => {
      const answers = [
        null,
        {},
        { error: "oops" },
        { tag_name: "v0.4.2", body: "" },
        { tag_name: "v0.5.0" },
        { tag_name: "v0.5.0", body: 3 },
      ]
      const runs = answers.map((answer) =>
        kept(async () => ({ ...release(""), json: async () => answer })),
      )
      await Promise.all(runs.map(({ whatsNew }) => whatsNew()))
      expect(runs.map(({ state }) => state.pending)).toEqual(answers.map(() => "0.5.0"))
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

    it("reads again when the recorded time is ahead of now, as after the clock moved back", async () => {
      const ahead = kept(async () => release(notesBlock(notes([])), 200, true), {
        checkedAt: 1_000_000_000 + 60_000,
      })
      await ahead.whatsNew()
      expect(ahead.urls).toHaveLength(1)
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
      expect(logged).toEqual([
        "The release notes were not read.",
        "The release notes were not read.",
      ])
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

describe("what is new since the version updated from", () => {
  // A release of `version`, with a notes block of its own, as the list answers it.
  const listed = (
    version: string,
    titles: readonly string[],
    {
      kind = "release",
      prerelease = true,
    }: { kind?: ReleaseNotes["kind"]; prerelease?: boolean } = {},
  ) => ({
    tag_name: `v${version}`,
    prerelease,
    body: notesBlock({
      version,
      kind,
      highlights: titles.map((title) => ({ title, line: `${title} line.`, prs: [1] })),
      changes: [],
      fixes: 0,
    }),
  })
  const json = (answer: unknown, status = 200) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: jsonType,
    json: async () => answer,
  })
  // Answers the version's own release from `own`, and the list from `pages`, one per page.
  const answering =
    (own: unknown, pages: readonly unknown[]) =>
    async (url: string): ReturnType<ReleaseFetch> => {
      if (url.includes("/releases/tags/")) return json(own)
      const page = Number(new URL(url).searchParams.get("page"))
      return json(pages[page - 1] ?? [])
    }
  const titles = (found: Awaited<ReturnType<ReturnType<typeof kept>["whatsNew"]>>) =>
    found?.highlights.map(({ title }) => title)

  it("tells the builds skipped on the way, newest first, after the version's own", async () => {
    const own = listed("0.5.0", ["Own"])
    const list = [own, listed("0.4.4", ["Fourth"]), listed("0.4.3", []), listed("0.4.2", ["Gone"])]
    const { whatsNew, urls } = kept(answering(own, [list]), { from: "0.4.2" })
    const found = await whatsNew()
    expect(found?.version).toBe("0.5.0")
    expect(titles(found)).toEqual(["Own", "Fourth"])
    expect(urls[1]).toBe(
      "https://api.github.com/repos/novadeck-org/novadeck/releases?per_page=100&page=1",
    )
  })

  it("reads no list without a version to start from", async () => {
    const own = listed("0.5.0", ["Own"])
    const { whatsNew, urls } = kept(answering(own, []))
    expect(titles(await whatsNew())).toEqual(["Own"])
    expect(urls).toHaveLength(1)
  })

  it("leaves out a prerelease's notes that a newer promotion among them tells", async () => {
    const own = listed("0.5.0", ["Own"])
    const list = [
      own,
      listed("0.4.5", ["Promoted"], { kind: "promote", prerelease: false }),
      listed("0.4.4", ["Told by the promotion"]),
      listed("0.4.3", ["Stable before"], { kind: "promote", prerelease: false }),
    ]
    const { whatsNew } = kept(answering(own, [list]), { from: "0.4.0" })
    expect(titles(await whatsNew())).toEqual(["Own", "Promoted", "Stable before"])
  })

  it("leaves out every older prerelease's notes when the version is the promotion", async () => {
    const own = listed("0.5.0", ["Promoted"], { kind: "promote", prerelease: false })
    const list = [
      own,
      listed("0.4.4", ["Told"]),
      listed("0.4.3", ["Stable before"], { kind: "promote" }),
    ]
    const { whatsNew } = kept(answering(own, [list]), { from: "0.4.0" })
    expect(titles(await whatsNew())).toEqual(["Promoted", "Stable before"])
  })

  it("tells the skipped builds when the version's own notes have no highlights", async () => {
    const own = listed("0.5.0", [])
    const { whatsNew, state } = kept(answering(own, [[own, listed("0.4.4", ["Fourth"])]]), {
      from: "0.4.2",
    })
    expect(titles(await whatsNew())).toEqual(["Fourth"])
    expect(state.checkedAt).toBeUndefined()
  })

  it("waits for a prerelease whose notes are not written yet, without the list", async () => {
    const own = { tag_name: "v0.5.0", prerelease: true, body: "Changelog only." }
    const { whatsNew, state, urls } = kept(answering(own, [[listed("0.4.4", ["Fourth"])]]), {
      from: "0.4.2",
    })
    expect(await whatsNew()).toBeUndefined()
    expect(state).toMatchObject({ pending: "0.5.0", checkedAt: 1_000_000_000 })
    expect(urls).toHaveLength(1)
  })

  it("settles a stable release when neither it nor the builds skipped have highlights", async () => {
    const own = listed("0.5.0", [], { prerelease: false })
    const { whatsNew, state } = kept(answering(own, [[own, listed("0.4.4", [])]]), {
      from: "0.4.2",
    })
    expect(await whatsNew()).toBeUndefined()
    expect(state.pending).toBeUndefined()
  })

  it("tells a highlight two releases share once, and four at most", async () => {
    const own = listed("0.5.0", ["Same", "One"])
    const list = [own, listed("0.4.4", ["Same", "Two", "Three"]), listed("0.4.3", ["Four"])]
    const { whatsNew } = kept(answering(own, [list]), { from: "0.4.2" })
    expect(titles(await whatsNew())).toEqual(["Same", "One", "Two", "Three"])
  })

  it("reads the next page only while the list has not reached the start", async () => {
    const own = listed("0.5.0", ["Own"])
    const full = Array.from({ length: 100 }, (_, index) => listed(`0.4.${200 - index}`, []))
    full[50] = listed("0.4.150", ["Deep"])
    const reached = [listed("0.4.100", ["Last"]), listed("0.4.99", ["Before start"])]
    const { whatsNew, urls } = kept(answering(own, [full, reached, [listed("0.4.1", [])]]), {
      from: "0.4.99",
    })
    expect(titles(await whatsNew())).toEqual(["Own", "Deep", "Last"])
    expect(urls.filter((url) => url.includes("page="))).toHaveLength(2)
  })

  it("tries again when the list can't be read now, or is not a list", async () => {
    const own = listed("0.5.0", ["Own"])
    for (const list of [json([], 503), json({ message: "a proxy" })]) {
      let first = true
      const { whatsNew, urls } = kept(
        async (url) => {
          if (url.includes("/tags/")) return json(own)
          if (first) {
            first = false
            return list
          }
          return json([own, listed("0.4.4", ["Fourth"])])
        },
        { from: "0.4.2" },
      )
      expect(titles(await whatsNew())).toEqual(["Own", "Fourth"])
      expect(urls).toHaveLength(4)
    }
  })

  it("skips an entry of the list that is not a release", async () => {
    const own = listed("0.5.0", ["Own"])
    const list = [own, { tag_name: 3 }, null, listed("0.4.4", ["Fourth"])]
    const { whatsNew } = kept(answering(own, [list]), { from: "0.4.2" })
    expect(titles(await whatsNew())).toEqual(["Own", "Fourth"])
  })
})

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
