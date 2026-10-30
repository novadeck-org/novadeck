import { createPageSights, type PageSeen } from "@novadeck/core/items/page-sights"
import {
  maxLookPicture,
  maxPageTroubles,
  type PageLook,
  type PageLookAnswer,
} from "@novadeck/protocol"
import type { DesktopPageLook } from "@novadeck/protocol/bridge"
import { noTheme } from "@novadeck/terminal-views/theme"
import { afterAll, vi } from "vitest"

import { runnerBackend, type RunnerApi } from "../backend"
import { context, describe, expect, it } from "../test"
import { startTestRunner } from "../testing/runner"
import { answerLook, lookDeadlineMs, lookWidths, noPictures, type Looks } from "./looks"

const jpeg = "data:image/jpeg;base64,AAAA"
const look: PageLook = {
  lookId: "look-1",
  itemId: "item-1",
  shown: 3,
  url: "http://localhost:5173/",
}
const seen = (picture = jpeg): PageSeen => ({
  picture,
  url: "http://localhost:5173/work",
  title: "Work",
  size: { width: 1280, height: 640.4 },
})
const freshLook = (
  fields: Partial<Extract<DesktopPageLook, { picture: string }>> = {},
): DesktopPageLook => ({
  picture: jpeg,
  url: "http://localhost:5173/",
  title: "Home",
  size: { width: 1280, height: 800 },
  troubles: [],
  ...fields,
})

describe("an agent's look at a page", () => {
  context("where a pane shows the page live", () => {
    it("is the pane's picture, as the person sees it, taken at the widest a look gets", async () => {
      const sights = createPageSights()
      const widths: number[] = []
      sights.register("item-1", async (width) => (widths.push(width), seen()))
      const fresh = vi.fn<NonNullable<Looks["fresh"]>>()
      expect(await answerLook(look, { sights, fresh })).toEqual({
        lookId: "look-1",
        picture: jpeg,
        url: "http://localhost:5173/work",
        title: "Work",
        taken: "pane",
        size: { width: 1280, height: 640 },
        troubles: [],
      })
      expect(widths).toEqual([lookWidths[0]])
      expect(fresh).not.toHaveBeenCalled()
    })

    it("is taken again narrower when the picture comes out too large", async () => {
      const sights = createPageSights()
      const widths: number[] = []
      sights.register("item-1", async (width) => {
        widths.push(width)
        return seen(
          widths.length < 3 ? `data:image/jpeg;base64,${"A".repeat(maxLookPicture)}` : jpeg,
        )
      })
      expect(await answerLook(look, { sights })).toMatchObject({ taken: "pane", picture: jpeg })
      expect(widths).toEqual([...lookWidths])
    })

    it("is asked of each viewer with the show the agent made, so one at an earlier show can decline", async () => {
      const sights = createPageSights()
      const asked: number[] = []
      sights.register("item-1", async (_width, shown) => (asked.push(shown), undefined))
      const fresh = vi.fn<NonNullable<Looks["fresh"]>>(async () => freshLook())
      expect(await answerLook(look, { sights, fresh })).toMatchObject({ taken: "fresh" })
      expect(asked).toEqual([3])
    })

    it("asks the latest viewer first, and the next when one has none to give", async () => {
      const sights = createPageSights()
      sights.register("item-1", async () => seen())
      sights.register("item-1", async () => undefined)
      expect(await answerLook(look, { sights })).toMatchObject({ taken: "pane" })
    })
  })

  context("where no pane shows it live", () => {
    it("is the page loaded afresh at the size the person chose for it, with what went wrong", async () => {
      const sights = createPageSights()
      sights.setLayout("item-1", "phone")
      const fresh = vi.fn<NonNullable<Looks["fresh"]>>(async () =>
        freshLook({
          size: { width: 390, height: 844 },
          troubles: [{ kind: "load", text: "ERR_CONNECTION_REFUSED" }],
        }),
      )
      expect(await answerLook(look, { sights, fresh })).toEqual({
        lookId: "look-1",
        picture: jpeg,
        url: "http://localhost:5173/",
        title: "Home",
        taken: "fresh",
        size: { width: 390, height: 844 },
        troubles: [{ kind: "load", text: "ERR_CONNECTION_REFUSED" }],
      })
      expect(fresh).toHaveBeenCalledWith({
        url: look.url,
        layout: "phone",
        before: expect.any(Number),
      })
    })

    it("is given until the runner stops waiting, to be begun by", async () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      try {
        vi.setSystemTime(1_000_000)
        const fresh = vi.fn<NonNullable<Looks["fresh"]>>(async () => freshLook())
        await answerLook(look, { sights: createPageSights(), fresh })
        expect(fresh.mock.calls[0]![0].before).toBe(1_000_000 + lookDeadlineMs)
        expect(lookDeadlineMs).toBeLessThan(20_000)
      } finally {
        vi.useRealTimers()
      }
    })

    it("is loaded afresh as a desktop's, unless the person switched it", async () => {
      const fresh = vi.fn<NonNullable<Looks["fresh"]>>(async () => freshLook())
      await answerLook(look, { sights: createPageSights(), fresh })
      expect(fresh).toHaveBeenCalledWith({
        url: look.url,
        layout: "desktop",
        before: expect.any(Number),
      })
    })

    it("is loaded afresh when its pane's viewer has no picture, as at rest", async () => {
      const sights = createPageSights()
      sights.register("item-1", async () => undefined)
      expect(await answerLook(look, { sights, fresh: async () => freshLook() })).toMatchObject({
        taken: "fresh",
      })
    })

    it("tells no more troubles than the runner takes, in the shapes it takes them", async () => {
      const troubles = Array.from({ length: maxPageTroubles + 5 }, () => ({
        kind: "request" as const,
        url: `http://localhost:5173/${"x".repeat(3000)}`,
        status: 500,
        what: "fetch",
      }))
      const answer = await answerLook(look, {
        sights: createPageSights(),
        fresh: async () => freshLook({ troubles }),
      })
      expect(answer).toMatchObject({ troubles: expect.any(Array) })
      const told = (answer as Extract<PageLookAnswer, { picture: string }>).troubles
      expect(told).toHaveLength(maxPageTroubles)
      expect(told[0]).toMatchObject({ url: expect.stringMatching(/^.{2048}$/) })
    })

    it("is the app's reason, when it has no picture", async () => {
      expect(
        await answerLook(look, {
          sights: createPageSights(),
          fresh: async () => ({ reason: "Another picture of a page is being taken." }),
        }),
      ).toEqual({ lookId: "look-1", reason: "Another picture of a page is being taken." })
    })

    it("is a reason when the app fails or answers a picture too large", async () => {
      const sights = createPageSights()
      expect(
        await answerLook(look, {
          sights,
          fresh: () => Promise.reject(new Error("gone")),
        }),
      ).toEqual({ lookId: "look-1", reason: "The page could not be pictured." })
      expect(
        await answerLook(look, {
          sights,
          fresh: async () =>
            freshLook({ picture: `data:image/jpeg;base64,${"A".repeat(maxLookPicture)}` }),
        }),
      ).toMatchObject({ reason: expect.stringContaining("too large") })
    })
  })

  it("is a clear reason where the app can't take pictures of pages", async () => {
    expect(await answerLook(look, { sights: createPageSights() })).toEqual({
      lookId: "look-1",
      reason: noPictures,
    })
  })
})

// The backend follows the runner's looks and answers each.
vi.setConfig({ testTimeout: 20_000 })
const runner = await startTestRunner()
afterAll(() => runner.close())

describe("looks through the runner backend", () => {
  it("answers each look the runner sends, with a reason where the app can't take one", async () => {
    const queued: PageLook[] = []
    let wake: (() => void) | undefined
    const iterator: AsyncIterableIterator<PageLook, undefined> = {
      [Symbol.asyncIterator]: () => iterator,
      next: async () => {
        // eslint-disable-next-line no-await-in-loop -- Waits for the next pushed look.
        while (!queued.length) await new Promise<void>((resolve) => (wake = resolve))
        return { value: queued.shift()!, done: false }
      },
      return: async () => ({ value: undefined, done: true }),
    }
    const answers: PageLookAnswer[] = []
    const api: RunnerApi = {
      ...runner.client,
      companions: {
        ...runner.client.companions,
        looks: () => iterator,
        answerLook: async (answer) => {
          answers.push(answer)
        },
      },
    }
    const { backend } = runnerBackend(api, runner.listing, { theme: noTheme, saveDelay: 10 })
    const stop = backend.start!({ dispatch: () => {}, open: () => {} })
    queued.push(look)
    wake?.()
    await vi.waitFor(() => expect(answers).toHaveLength(1))
    stop()
    expect(answers).toEqual([{ lookId: "look-1", reason: noPictures }])
  })
})
