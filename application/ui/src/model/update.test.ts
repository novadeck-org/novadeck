import { context, describe, expect, it } from "../test"
import { noticeRaised, portableNagged, offerStale, staleAfterMs, type UpdateOffer } from "./update"

const now = Date.parse("2026-10-12T12:00:00Z")
const dated = (ms: number, kind: UpdateOffer["kind"] = "available"): UpdateOffer => ({
  kind,
  version: "0.0.80",
  notes: [],
  outdatedSince: new Date(now - ms).toISOString(),
})
const day = 24 * 60 * 60 * 1000

describe("a stale release", () => {
  it("is one this copy has known of for 14 days or more", () => {
    expect(staleAfterMs).toBe(14 * day)
    expect(offerStale(dated(14 * day), now)).toBe(true)
    expect(offerStale(dated(14 * day - 1), now)).toBe(false)
    expect(offerStale(dated(60 * day), now)).toBe(true)
  })

  it("is not one with no readable date, or one in the future", () => {
    expect(offerStale({ kind: "available", version: "0.0.80", notes: [] }, now)).toBe(false)
    expect(offerStale({ ...dated(0), outdatedSince: "last week" }, now)).toBe(false)
    expect(offerStale(dated(-30 * day), now)).toBe(false)
  })

  it("is nagged about on a portable copy only for a release to fetch", () => {
    expect(portableNagged(dated(20 * day), now)).toBe(true)
    expect(portableNagged(dated(20 * day, "ready"), now)).toBe(false)
    expect(portableNagged(dated(2 * day), now)).toBe(false)
  })
})

describe("a notice's raising", () => {
  const raised = (
    offer: UpdateOffer,
    options: { seen?: string | null; portable?: boolean; shownThisRun?: boolean },
  ): boolean =>
    noticeRaised(offer, {
      seen: null,
      portable: false,
      shownThisRun: false,
      now,
      ...options,
    })

  context("for an offer not shown before", () => {
    it("is raised", () => {
      expect(raised(dated(2 * day), { portable: true })).toBe(true)
      expect(raised(dated(2 * day), { seen: "available:0.0.79" })).toBe(true)
    })
  })

  context("for an offer shown before", () => {
    const seen = "available:0.0.80"

    it("is not raised again when the copy is recent", () => {
      expect(raised(dated(2 * day), { seen, portable: true })).toBe(false)
      expect(raised(dated(20 * day), { seen })).toBe(false)
    })

    it("is raised again at a launch of a portable copy once stale", () => {
      expect(raised(dated(20 * day), { seen, portable: true })).toBe(true)
    })

    it("is not raised again within a run that has shown its notice", () => {
      expect(raised(dated(20 * day), { seen, portable: true, shownThisRun: true })).toBe(false)
    })

    it("is not raised for a stale offer with no date", () => {
      const undated: UpdateOffer = {
        kind: "available",
        version: "0.0.80",
        notes: [],
      }
      expect(raised(undated, { seen, portable: true })).toBe(false)
    })
  })
})
