import type { AgentFeedbackDraft } from "@novadeck/core/feedback"
import type { FeedbackDraft } from "@novadeck/protocol"
import type { DesktopApp } from "@novadeck/protocol/bridge"
import { WireError } from "@novadeck/wire"
import { vi } from "vitest"

import { desktopFeedback } from "./desktop-host"
import { id, scripted } from "./scripted"
import { describe, expect, it } from "./test"

const host = (overrides: Record<string, unknown> = {}) =>
  ({
    feedback: true,
    feedbackAbout: () => Promise.resolve({ version: "0.0.219", os: "linux", arch: "x64" }),
    sendFeedback: () => Promise.resolve(),
    ...overrides,
  }) as unknown as DesktopApp

const entry = (change: Partial<FeedbackDraft> = {}): FeedbackDraft => ({
  id: id(50),
  terminalId: id(1),
  projectId: "p",
  workspaceSessionId: id(8),
  agent: "claude",
  handle: "moth",
  at: 5,
  kind: "bug",
  text: "It froze.",
  asked: true,
  ...change,
})

const shown = [{ id: id(1), lastProcess: "claude" }]
const withHost = (calls?: { settle?: (id: string) => Promise<void> }) =>
  scripted({
    shown,
    feedback: desktopFeedback(host()),
    ...(calls ? { feedbackCalls: calls } : {}),
  })

describe("the feedback of the runner backend", () => {
  describe("asking an agent", () => {
    it("is offered where the host can send feedback, and relays the hint to the agent's terminal", async () => {
      const app = withHost()
      const { feedback } = app.backend
      expect(feedback?.ask).toBeTypeOf("function")
      await feedback!.ask!(app.key(id(1)), "the freeze")
      expect(app.of("ask feedback")).toEqual([[id(1), "the freeze"]])
      app.stop()
    })

    it("is not offered, nor are drafts, where the host can't send feedback", () => {
      for (const feedback of [
        desktopFeedback(undefined),
        desktopFeedback(host({ feedback: false })),
        desktopFeedback(host({ sendFeedback: undefined })),
      ]) {
        const app = scripted({ shown, feedback })
        expect(app.backend.feedback).toBeUndefined()
        app.stop()
      }
    })

    it("keeps the host's own note sending", async () => {
      const send = vi.fn<() => Promise<void>>(() => Promise.resolve())
      const app = scripted({ shown, feedback: desktopFeedback(host({ sendFeedback: send })) })
      await app.backend.feedback!.send({ kind: "bug", text: "hi" })
      expect(send).toHaveBeenCalledWith({ kind: "bug", text: "hi" })
      app.stop()
    })
  })

  describe("the agents' drafts", () => {
    const follow = (app: ReturnType<typeof withHost>) => {
      const heard: (readonly AgentFeedbackDraft[])[] = []
      const stop = app.backend.feedback!.drafts!.watch((drafts) => heard.push(drafts))
      return { heard, stop }
    }

    it("tells a listener the runner's drafts as the card needs them, oldest first", async () => {
      const app = withHost()
      const { heard, stop } = follow(app)
      expect(app.watches).toHaveLength(1)
      app.watches[0]!.push([
        entry(),
        entry({ id: id(51), terminalId: id(2), handle: "fox", at: 9 }),
      ])
      await vi.waitFor(() => expect(heard).toHaveLength(1))
      expect(heard[0]).toEqual([
        {
          id: id(50),
          terminal: { projectId: "p", workspaceSessionId: id(8), terminalId: id(1) },
          handle: "moth",
          agent: "claude",
          kind: "bug",
          text: "It froze.",
          asked: true,
          at: 5,
        },
        expect.objectContaining({ id: id(51), handle: "fox", at: 9 }),
      ])
      stop()
      app.stop()
    })

    it("shares one stream between listeners, giving a late one what is held", async () => {
      const app = withHost()
      const first = follow(app)
      app.watches[0]!.push([entry()])
      await vi.waitFor(() => expect(first.heard).toHaveLength(1))
      const second = follow(app)
      expect(app.watches).toHaveLength(1)
      expect(second.heard).toEqual(first.heard)
      app.watches[0]!.push([])
      await vi.waitFor(() => expect(first.heard).toHaveLength(2))
      expect(second.heard).toHaveLength(2)
      first.stop()
      second.stop()
      app.stop()
    })

    it("opens the stream with the first listener and closes it with the last", async () => {
      const app = withHost()
      expect(app.watches).toHaveLength(0)
      const first = follow(app)
      const second = follow(app)
      first.stop()
      app.watches[0]!.push([entry()])
      await vi.waitFor(() => expect(second.heard).toHaveLength(1))
      expect(first.heard).toEqual([])
      second.stop()
      // A later listener starts a fresh stream and hears only what it then lists.
      const third = follow(app)
      expect(app.watches).toHaveLength(2)
      expect(third.heard).toEqual([])
      third.stop()
      app.stop()
    })

    it("settles a draft on the runner, sent or discarded", async () => {
      const app = withHost()
      const { drafts } = app.backend.feedback!
      await drafts!.settle(id(50), "sent")
      await drafts!.settle(id(51), "discarded")
      expect(app.of("settle feedback")).toEqual([
        [id(50), "sent"],
        [id(51), "discarded"],
      ])
      app.stop()
    })

    it("takes a draft the runner no longer holds as settled", async () => {
      const app = withHost({ settle: () => Promise.reject(new WireError("NOT_FOUND")) })
      await expect(app.backend.feedback!.drafts!.settle(id(50), "sent")).resolves.toBeUndefined()
      app.stop()
    })

    it("rejects when the runner couldn't be told, so the draft stays waiting", async () => {
      const app = withHost({ settle: () => Promise.reject(new WireError("INTERNAL", "down")) })
      await expect(app.backend.feedback!.drafts!.settle(id(50), "sent")).rejects.toThrow("down")
      app.stop()
    })
  })
})
