import { type AutoRunState, noAutoRun } from "@novadeck/core/autorun"
import type { Grant, GrantProposal } from "@novadeck/core/grants"
import {
  emptyInbox,
  type Inbox,
  type InboxAnswer,
  type InboxRow,
  type InboxState,
} from "@novadeck/core/inbox"
import { createStore } from "@novadeck/core/store"
import { nextFrame, render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach } from "vitest"

import { context, describe, expect, it } from "../test"
import { InboxList } from "./InboxList"
import { InboxProvider } from "./InboxProvider"
import { InboxSheet } from "./InboxSheet"

// jsdom has no ResizeObserver, which the sheet's placement watches its anchor with.
Object.assign(globalThis, {
  ResizeObserver: class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
})

const source = (handle: string): InboxRow["source"] => ({
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: `t-${handle}`,
  handle,
  agent: "claude",
  title: `Task of ${handle}`,
  projectName: "Project",
})

const proposal: GrantProposal = {
  presets: ["push", "pr"],
  commands: [
    { argv: ["pnpm", "test"], rest: false },
    { argv: ["echo", "it's here"], rest: true },
  ],
  repos: [
    {
      repo: { url: "github.com/acme/shop", defaultBranch: "main", defaultFrom: "github" },
      ticked: true,
      flag: null,
    },
    {
      repo: { url: "github.com/acme/shop-ui", defaultBranch: "trunk", defaultFrom: "remote-head" },
      ticked: false,
      flag: "added-remote",
    },
    {
      repo: { url: "github.com/acme/new", defaultBranch: "main", defaultFrom: "guess" },
      ticked: false,
      flag: "recent",
    },
  ],
  withLead: false,
  lifetime: "until-done",
  reason: "Fox and owl finish the checkout today.",
  covered: [
    { handle: "fox", agent: "codex" },
    { handle: "owl", agent: "claude" },
  ],
}

const grantRow = (more: Partial<GrantProposal> = {}): InboxRow => ({
  id: "g",
  source: source("moth"),
  at: 1,
  stopped: true,
  seen: false,
  kind: "grant",
  proposal: { ...proposal, ...more },
})

const approvalRow = (): InboxRow => ({
  id: "ap",
  source: source("fox"),
  at: 1,
  stopped: false,
  seen: false,
  kind: "ask",
  ask: {
    subject: "May I run the build?",
    body: "It only writes `dist/`.",
    details: null,
    hardToUndo: null,
    shape: {
      type: "approval",
      commands: [
        { argv: ["pnpm", "build"], rest: false },
        { argv: ["pnpm", "run", "x y"], rest: true },
      ],
    },
  },
})

const live = (more: Partial<Grant> = {}): Grant => ({
  id: "live",
  projectId: "p",
  workspaceSessionId: "s",
  holder: { kind: "team", lead: "moth", withLead: false },
  presets: ["push"],
  commands: [{ argv: ["pnpm", "test"], rest: false }],
  repos: [{ url: "github.com/acme/shop", defaultBranch: "main", defaultFrom: "github" }],
  entryId: "g",
  proposedBy: "moth",
  madeAt: 0,
  lifetime: "hour",
  endsAt: Date.now() + 90 * 60_000 - 1000,
  revokedAt: null,
  lastUse: null,
  ...more,
})

let mounted: { readonly unmount: () => void } | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

const mount = (
  rows: readonly InboxRow[],
  { grants = [] as readonly Grant[], open = true, autorun = noAutoRun as AutoRunState } = {},
) => {
  const state = createStore<InboxState>({ ...emptyInbox, items: rows })
  const store = createStore<readonly Grant[]>(grants)
  const failed = createStore<Readonly<Record<string, string>>>({})
  const sent: InboxAnswer[] = []
  const dismissed: string[] = []
  const revoked: string[] = []
  const inbox: Inbox = {
    state,
    answer: (_, answer) => void sent.push(answer),
    see: () => {},
    readAll: () => {},
    dismiss: (id) => void dismissed.push(id),
    grants: { state: store, revoke: (id) => void revoked.push(id), failed },
    autorun: {
      state: createStore<AutoRunState>(autorun),
      silence: () => {},
      undo: () => {},
      dismiss: () => {},
    },
  }
  const view = render(
    createElement(
      InboxProvider,
      { inbox, reveal: () => {} },
      createElement("div", { id: "inbox-panel" }, createElement(InboxList)),
      createElement(InboxSheet, { active: true }),
    ),
  )
  mounted = view
  if (open) act(() => view.container.querySelector<HTMLElement>(".inbox-row-select")!.click())
  const option = (label: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(".console-option")).find((each) =>
      each.textContent?.includes(label),
    )!
  const tick = (label: string): HTMLInputElement =>
    Array.from(document.querySelectorAll<HTMLLabelElement>(".grant-tick"))
      .find((each) => each.textContent?.includes(label))!
      .querySelector("input")!
  const done = async (): Promise<void> => {
    await nextFrame()
    view.unmount()
    mounted = null
  }
  return { view, store, failed, sent, dismissed, revoked, option, tick, done }
}

const text = (selector: string) => document.querySelector(selector)?.textContent ?? null

describe("The Grant card", () => {
  context("what it shows", () => {
    it("words each preset itself, with the one repo that is ticked", async () => {
      const inbox = mount([grantRow()])

      expect(text(".console-tag")).toBe("Grant")
      const sentences = Array.from(
        document.querySelectorAll(".grant-group:first-child .grant-tick"),
      ).map((each) => each.textContent)
      expect(sentences).toEqual([
        "Push a named branch to acme/shop (no force, never to main/master or its default branch)",
        "Open, edit, mark ready and comment on pull requests in acme/shop (no merge commands, close or reopen; no labels)",
      ])
      await inbox.done()
    })

    it("lists the repos ticked as proposed, flagged, with the default branch and where it came from", async () => {
      const inbox = mount([grantRow()])

      expect(inbox.tick("github.com/acme/shop").checked).toBe(true)
      expect(inbox.tick("shop-ui").checked).toBe(false)
      expect(text("[data-flag=added-remote]")).toBe("added remote")
      expect(text("[data-flag=recent]")).toBe("new or changed in the last 24 h")
      const shopUi = inbox.tick("shop-ui").closest("label")!.textContent
      expect(shopUi).toContain("default branch trunk, from the remote's HEAD")
      expect(inbox.tick("acme/new").closest("label")!.textContent).toContain("guessed")
      await inbox.done()
    })

    it("shows each command shell-quoted, the open-ended one marked", async () => {
      const inbox = mount([grantRow()])

      const commands = Array.from(document.querySelectorAll(".grant-command")).map(
        (each) => each.textContent,
      )
      expect(commands[0]).toBe("$ pnpm test")
      expect(commands[1]).toBe("$ echo 'it'\\''s here' … followed by anything")
      expect(document.querySelectorAll(".grant-rest")).toHaveLength(1)
      await inbox.done()
    })

    it("says who is covered, now and later, with the lead itself unticked, and warns for Codex", async () => {
      const inbox = mount([grantRow()])

      expect(text(".grant-who")).toBe("@moth's teammates, now and later (now: @fox, @owl)")
      expect(inbox.tick("and @moth itself").checked).toBe(false)
      expect(text("[data-grant=codex]")).toBe(
        "@fox runs Codex, which runs allowed commands outside Codex's sandbox.",
      )
      await inbox.done()
    })

    it("warns for Antigravity that a teammate started earlier still asks, and old versions never take it", async () => {
      const inbox = mount([grantRow({ covered: [{ handle: "elk", agent: "agy" }] })])

      expect(text("[data-grant=agy]")).toBe(
        "@elk runs Antigravity, which only partly takes it: a teammate started before the grant still asks per command; Antigravity before 1.4.10 never takes it.",
      )
      expect(document.querySelector("[data-grant=codex]")).toBeNull()
      await inbox.done()
    })

    it("names the fix for Antigravity while cmd's AutoRun prints, and drops the line once it doesn't", async () => {
      const offer: AutoRunState = {
        state: "offer",
        current: "chcp 65001",
        next: "(chcp 65001) >nul 2>&1",
        machine: null,
        outcome: null,
      }
      const printing = mount([grantRow({ covered: [{ handle: "elk", agent: "agy" }] })], {
        autorun: offer,
      })
      expect(text("[data-grant=agy]")).toBe(
        "@elk runs Antigravity, which only partly takes it: a teammate started before the grant still asks per command; Antigravity before 1.4.10 never takes it. cmd's AutoRun prints here, so Antigravity asks for each command: Silence it in the Inbox (one click, undoable).",
      )
      await printing.done()
      const silenced = mount([grantRow({ covered: [{ handle: "elk", agent: "agy" }] })], {
        autorun: {
          state: "silenced",
          current: offer.next,
          restores: offer.current,
          machine: null,
          suggested: null,
          outcome: null,
        },
      })
      expect(text("[data-grant=agy]")).not.toContain("AutoRun")
      await silenced.done()
    })

    it("quotes the lead's reason and offers until done and 1 hour with until done chosen", async () => {
      const inbox = mount([grantRow()])

      expect(text("blockquote.console-quote")).toBe("Fox and owl finish the checkout today.")
      const choices = Array.from(document.querySelectorAll<HTMLInputElement>(".segment input"))
      expect(choices.map((each) => each.getAttribute("aria-label"))).toEqual([
        "Until it's done",
        "1 hour",
      ])
      expect(choices.find((each) => each.checked)?.getAttribute("aria-label")).toBe(
        "Until it's done",
      )
      await inbox.done()
    })
  })

  context("answering", () => {
    it("sends Grant with what stayed ticked and the time", async () => {
      const inbox = mount([grantRow()])
      act(() => inbox.tick("shop-ui").click())
      act(() => inbox.tick("echo").click())
      act(() => inbox.tick("and @moth itself").click())
      act(() => inbox.tick("pull requests").click())
      act(() => inbox.option("Grant").click())

      expect(inbox.sent).toEqual([
        {
          kind: "grant",
          answer: {
            type: "grant",
            presets: ["push"],
            commands: [0],
            repos: ["github.com/acme/shop", "github.com/acme/shop-ui"],
            withLead: true,
            lifetime: "until-done",
          },
        },
      ])
      await inbox.done()
    })

    it("sends what was proposed when nothing is touched", async () => {
      const inbox = mount([grantRow()])
      act(() => inbox.option("Grant").click())

      expect(inbox.sent).toEqual([
        {
          kind: "grant",
          answer: {
            type: "grant",
            presets: ["push", "pr"],
            commands: [0, 1],
            repos: ["github.com/acme/shop"],
            withLead: false,
            lifetime: "until-done",
          },
        },
      ])
      await inbox.done()
    })

    it("sends nothing while no repo is ticked for a preset, and says why", async () => {
      const inbox = mount([grantRow()])
      act(() => inbox.tick("github.com/acme/shop").click())

      expect(inbox.option("Grant").textContent).toContain("Tick a repo")
      act(() => inbox.option("Grant").click())
      expect(inbox.sent).toEqual([])
      await inbox.done()
    })

    it("declines by dismissing the card", async () => {
      const inbox = mount([grantRow()])
      act(() => inbox.option("Decline").click())

      expect(inbox.dismissed).toEqual(["g"])
      expect(inbox.sent).toEqual([])
      await inbox.done()
    })
  })
})

describe("The approval card", () => {
  it("says what it lets the terminal run, for how long, with the commands as code", async () => {
    const inbox = mount([approvalRow()])

    expect(text(".console-tag")).toBe("Approval")
    expect(text(".grant-sentence")).toBe(
      "Lets @fox run, without asking again, until it reports done or for 1 hour:",
    )
    expect(
      Array.from(document.querySelectorAll(".grant-command")).map((each) => each.textContent),
    ).toEqual(["$ pnpm build", "$ pnpm run 'x y' … followed by anything"])
    await inbox.done()
  })

  it("warns about Codex's sandbox only when the asking terminal runs Codex", async () => {
    const claude = mount([approvalRow()])
    expect(document.querySelector("[data-grant=codex]")).toBeNull()
    await claude.done()
    const codex = approvalRow()
    const inbox = mount([{ ...codex, source: { ...codex.source, agent: "codex" } }])
    expect(text("[data-grant=codex]")).toBe(
      "@fox runs Codex, which runs allowed commands outside Codex's sandbox.",
    )
    await inbox.done()
  })

  it("approves, or takes the person's words", async () => {
    const inbox = mount([approvalRow()])

    expect(
      Array.from(document.querySelectorAll(".console-option .console-t")).map(
        (each) => each.textContent,
      ),
    ).toEqual(["Approve", "Approve for 1 hour", "Reply in your own words", "Go to terminal"])
    act(() => inbox.option("Approve for 1 hour").click())
    expect(inbox.sent).toEqual([{ kind: "ask", answer: { type: "approve", lifetime: "hour" } }])
    await inbox.done()
  })
})

describe("The Grants section", () => {
  it("is absent while no grant is live", async () => {
    const inbox = mount([], { open: false })

    expect(document.querySelector(".inbox-grants")).toBeNull()
    await inbox.done()
  })

  it("lists each live grant with its holder, actions, repos, time left and last use", async () => {
    const lastUse = { at: Date.now() - 4 * 60_000, handle: "owl", command: "git push origin a:a" }
    const inbox = mount([], { grants: [live({ lastUse })], open: false })

    const row = document.querySelector(".grant-row")!
    expect(row.querySelector(".grant-row-holder")?.textContent).toBe("@moth's team")
    expect(row.querySelector(".grant-row-left")?.textContent).toBe("1h 30m left")
    expect(row.querySelector(".grant-row-what")?.textContent).toBe("push branches in acme/shop")
    expect(row.querySelector(".grant-row-commands")?.textContent).toBe("pnpm test")
    expect(row.querySelector(".grant-row-last")?.textContent).toBe(
      "Last allowed: git push origin a:a by @owl, 4m ago",
    )
    await inbox.done()
  })

  it("says until done for a grant with no clock", async () => {
    const inbox = mount([], {
      grants: [live({ lifetime: "until-done", endsAt: null })],
      open: false,
    })
    expect(document.querySelector(".grant-row-left")?.textContent).toBe("until done")
    await inbox.done()
  })

  it("shows why a revoke failed beside its grant", async () => {
    const inbox = mount([], { grants: [live()], open: false })
    expect(document.querySelector(".grant-row-error")).toBeNull()
    act(() => inbox.failed.update(() => ({ live: "The runner is away." })))
    expect(text(".grant-row-error")).toBe("Could not revoke: The runner is away.")
    await inbox.done()
  })

  it("revokes a grant, and drops it when the list does", async () => {
    const inbox = mount([], {
      grants: [live(), live({ id: "other", holder: { kind: "terminal", handle: "fox" } })],
      open: false,
    })
    act(() => document.querySelector<HTMLElement>("[data-grant-id=live] button")!.click())

    expect(inbox.revoked).toEqual(["live"])
    act(() => inbox.store.update((current) => current.filter((each) => each.id !== "live")))
    expect(document.querySelectorAll(".grant-row")).toHaveLength(1)
    expect(document.querySelector(".grant-row-holder")?.textContent).toBe("@fox")
    act(() => inbox.store.update(() => []))
    expect(document.querySelector(".inbox-grants")).toBeNull()
    await inbox.done()
  })
})
