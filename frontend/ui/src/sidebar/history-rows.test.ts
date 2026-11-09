import type { ClosedTerminal } from "@novadeck/core/history"
import type { AgentConnection } from "@novadeck/core/port"

import { context, describe, expect, it } from "../test"
import {
  closedShort,
  folderOf,
  litPieces,
  rowFolder,
  rowMatches,
  rowTooltip,
  summaryExcerpt,
  rowView,
} from "./history-rows"

const now = new Date(2026, 10, 6, 18, 0).getTime()

const row = (parts: Partial<ClosedTerminal> = {}): ClosedTerminal => ({
  id: "closed-1",
  projectId: "storefront",
  title: "Coupon codes",
  summary: "Coupon codes in the cart and at checkout",
  handle: "wren",
  agent: "claude",
  program: "claude",
  cwd: "/work/storefront",
  closedAt: new Date(2026, 10, 6, 15, 40).getTime(),
  closedBy: null,
  availability: { state: "ready" },
  ...parts,
})

const plain = row({
  title: "pnpm dev",
  handle: null,
  summary: null,
  agent: null,
  program: "pnpm",
  cwd: "/work/storefront/web/",
})

const connection = (parts: Partial<AgentConnection> = {}): AgentConnection => ({
  agent: "claude",
  available: true,
  connected: false,
  busy: false,
  ...parts,
})

describe("History's rows", () => {
  context("when a terminal closed", () => {
    it("shows the time of day for today and the date for an earlier day", () => {
      const today = closedShort(row().closedAt, now)
      expect(today).toContain("40")
      const earlier = closedShort(new Date(2026, 10, 5, 16, 8).getTime(), now)
      // A date, not the time it closed at.
      expect(earlier).not.toContain("08")
    })

    it("adds the year to a date in another year", () => {
      expect(closedShort(new Date(2025, 11, 30, 9, 0).getTime(), now)).toMatch(/2025/)
    })
  })

  context("where a plain terminal ran", () => {
    it("names its last folder, whatever the separator or a trailing one", () => {
      expect(folderOf("/work/storefront/web/")).toBe("web")
      expect(folderOf("C:\\work\\api")).toBe("api")
      expect(folderOf("/")).toBe("/")
    })

    it("adds it to a plain terminal's row only", () => {
      expect(rowFolder(plain)).toBe("web")
      expect(rowFolder(row())).toBeUndefined()
    })
  })

  context("when it can be restored", () => {
    it("takes a click, and says nothing more than the time", () => {
      expect(rowView(row(), now, undefined)).toMatchObject({
        state: "ready",
        inert: false,
        end: { kind: "time", text: closedShort(row().closedAt, now) },
        reason: undefined,
        connect: undefined,
      })
    })
  })

  context("when it can't", () => {
    it("is inert while restoring, with a spinner where the date was", () => {
      expect(rowView(row({ availability: { state: "restoring" } }), now, undefined)).toMatchObject({
        inert: true,
        end: { kind: "restoring" },
      })
    })

    it("says which of the conversation and the folder is gone", () => {
      const gone = (reason: "conversation" | "folder") =>
        rowView(row({ availability: { state: "gone", reason } }), now, undefined)
      expect(gone("conversation")).toMatchObject({
        inert: true,
        end: { text: "Unavailable" },
        reason: "Claude Code no longer has this conversation",
      })
      expect(gone("folder").reason).toBe("The folder it ran in is gone")
    })

    it("goes to the terminal that holds an open conversation, by its handle", () => {
      expect(
        rowView(
          row({ availability: { state: "open", handle: "kite", terminalId: "t-kite" } }),
          now,
          undefined,
        ),
      ).toMatchObject({
        inert: false,
        end: { kind: "handle", text: "@kite" },
        reason: "Open as @kite",
      })
    })
  })

  context("when its agent isn't connected", () => {
    const disconnected = row({ availability: { state: "disconnected", agent: "claude" } })

    it("offers to connect it, as far as the agents are known", () => {
      expect(rowView(disconnected, now, undefined)).toMatchObject({
        inert: true,
        end: { text: "Not connected" },
        reason: "Connect Claude Code to restore this",
        connect: "claude",
      })
      expect(rowView(disconnected, now, [connection()]).connect).toBe("claude")
    })

    it("says so, and offers nothing, when the agent isn't installed", () => {
      expect(rowView(disconnected, now, [connection({ available: false })])).toMatchObject({
        reason: "Claude Code isn't installed on this computer",
        connect: undefined,
      })
    })

    it("says so, and offers nothing, while the agent changes its connection", () => {
      expect(rowView(disconnected, now, [connection({ busy: true })])).toMatchObject({
        reason: "Claude Code is changing its connection",
        connect: undefined,
      })
    })

    it("tells why the last attempt failed, and still offers it", () => {
      expect(rowView(disconnected, now, [connection({ error: "No such plugin" })])).toMatchObject({
        reason: "Connecting Claude Code didn't work: No such plugin",
        connect: "claude",
      })
    })

    it("takes a click once the agent is connected, as the runner checks again on restoring", () => {
      expect(rowView(disconnected, now, [connection({ connected: true })])).toMatchObject({
        state: "ready",
        inert: false,
      })
      // Not while the connection is still being made.
      expect(rowView(disconnected, now, [connection({ connected: true, busy: true })]).state).toBe(
        "disconnected",
      )
    })
  })

  context("when searched", () => {
    it("finds a row by handle, title, folder or summary", () => {
      expect(rowMatches(row(), "@WREN")).toBe(true)
      expect(rowMatches(row(), "coupon")).toBe(true)
      expect(rowMatches(plain, "web")).toBe(true)
      expect(rowMatches(row(), "checkout")).toBe(true)
      expect(rowMatches(row(), "refund")).toBe(false)
    })

    it("finds an agent's row by the folder it ran in too, though it doesn't show it", () => {
      expect(rowMatches(row({ summary: null }), "storefront")).toBe(true)
    })

    it("lights the match in the summary, whatever its case", () => {
      expect(litPieces("Stripe Webhook retries", "webhook")).toEqual([
        { text: "Stripe ", lit: false, at: 0 },
        { text: "Webhook", lit: true, at: 7 },
        { text: " retries", lit: false, at: 14 },
      ])
      expect(litPieces("Stripe", "webhook")).toEqual([{ text: "Stripe", lit: false, at: 0 }])
    })

    it("lights the right text where lowercasing changes a text's length", () => {
      // "İ" lowercases to two units, so offsets in the lowered text drift from the text's.
      expect(litPieces("İİ retries", "retries")).toEqual([
        { text: "İİ ", lit: false, at: 0 },
        { text: "retries", lit: true, at: 3 },
      ])
    })

    it("cuts a summary to start before a match that its two lines wouldn't show", () => {
      const long =
        "Stripe signatures are checked on every delivery and the webhook retries are idempotent"
      const excerpt = summaryExcerpt(long, "idempotent")
      expect(excerpt.startsWith("…")).toBe(true)
      expect(excerpt.endsWith("idempotent")).toBe(true)
      expect(excerpt.length).toBeLessThan(55)
      expect(summaryExcerpt("Short summary here", "short")).toBe("Short summary here")
      // Its two lines show a match a little way in, so the summary stays whole.
      const whole = "Order receipts sent after the payment webhook"
      expect(summaryExcerpt(whole, "webhook")).toBe(whole)
    })
  })

  context("under the pointer", () => {
    it("tells who closed it, when, why it can't come back, and its summary", () => {
      const closed = row({
        closedBy: "fox",
        availability: { state: "gone", reason: "conversation" },
      })
      const lines = rowTooltip(closed, rowView(closed, now, undefined), now).split("\n")
      expect(lines[0]).toBe("Claude Code no longer has this conversation")
      expect(lines[1]).toBe("Coupon codes, closed by @fox")
      expect(lines[2]).toMatch(/^Closed .*40/)
      expect(lines[3]).toBe("Coupon codes in the cart and at checkout")
    })
  })
})
