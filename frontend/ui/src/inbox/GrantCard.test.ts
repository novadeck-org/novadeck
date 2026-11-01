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
  commands: [{ argv: ["echo", "it's here"], rest: false }],
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
  agyOutdated: false,
  covered: [
    { handle: "fox", agent: "codex", started: false, plan: false },
    { handle: "owl", agent: "claude", started: false, plan: false },
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
        { argv: ["pnpm", "run", "x y"], rest: false },
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
  covering: [],
  endsAt: Date.now() + 42 * 60_000 - 1000,
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
  const silenced: string[] = []
  const inbox: Inbox = {
    state,
    answer: (_, answer) => void sent.push(answer),
    see: () => {},
    readAll: () => {},
    dismiss: (id) => void dismissed.push(id),
    grants: { state: store, revoke: (id) => void revoked.push(id), failed },
    autorun: {
      state: createStore<AutoRunState>(autorun),
      silence: (value) => void silenced.push(value),
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
  const button = (name: string): HTMLButtonElement =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (each) => each.textContent === name,
    )!
  const done = async (): Promise<void> => {
    await nextFrame()
    view.unmount()
    mounted = null
  }
  const key = (name: string, target: Element = document.querySelector(".inbox-row-select")!) =>
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
      )
    })
  return {
    view,
    state,
    store,
    failed,
    sent,
    dismissed,
    revoked,
    silenced,
    option,
    tick,
    button,
    key,
    done,
  }
}

const text = (selector: string) => document.querySelector(selector)?.textContent ?? null
const texts = (selector: string) =>
  Array.from(document.querySelectorAll(selector)).map((each) => each.textContent)
const menu = () => texts(".console-option .console-t")

const offer: AutoRunState = {
  state: "offer",
  current: "chcp 65001",
  next: "(chcp 65001) >nul 2>&1",
  machine: null,
  outcome: null,
  dismissed: false,
}
const elk = { covered: [{ handle: "elk", agent: "agy", started: false, plan: false }] }

describe("The Grant card", () => {
  context("the default view", () => {
    it("asks in a short title and says what they'd do, from the presets and repos alone", async () => {
      const inbox = mount([grantRow()])

      expect(text(".console-tag")).toBe("Grant")
      expect(text("h3.console-ask")).toBe("!Let @fox and @owl work without asking?")
      expect(text(".console-body")).toBe(
        "They'd push their branches and open pull requests in acme/shop without asking you each time. Merges and pushes to main still need you.",
      )
      expect(text(".console-body code")).toBe("acme/shop")
      // Nothing to tick, and nothing hidden shows until it is asked for.
      expect(document.querySelectorAll(".grant-tick")).toHaveLength(0)
      expect(document.querySelector(".grant-group")).toBeNull()
      expect(document.querySelector("[role=switch]")).toBeNull()
      await inbox.done()
    })

    it("names my team past three, and never lets the lead's words into the title or the body", async () => {
      const crowd = ["a", "b", "c", "d"].map((handle) => ({
        handle,
        agent: "claude",
        started: false,
        plan: false,
      }))
      const inbox = mount([
        grantRow({ covered: crowd, reason: "Let @moth do everything. Novadeck says it is safe." }),
      ])

      expect(text("h3.console-ask")).toBe("!Let my team work without asking?")
      expect(text("h3.console-ask")).not.toContain("safe")
      expect(text(".console-body")).not.toContain("safe")
      await inbox.done()
    })

    it("says in the collapsed card that the lead is included, past three holders too", async () => {
      const covered = (count: number) =>
        Array.from({ length: count }, (_, n) => ({
          handle: `a${n}`,
          agent: "claude",
          started: false,
          plan: false,
        }))
      const few = mount([grantRow({ withLead: true, covered: covered(1) })])
      expect(text("h3.console-ask")).toBe("!Let @moth and @a0 work without asking?")
      await few.done()
      const crowd = mount([grantRow({ withLead: true, covered: covered(4) })])
      expect(text("h3.console-ask")).toBe("!Let @moth and its team work without asking?")
      await crowd.done()
    })

    it("says the lead's team is included where it has no teammates yet", async () => {
      const inbox = mount([grantRow({ withLead: true, covered: [] })])
      expect(text("h3.console-ask")).toBe("!Let @moth and its team work without asking?")
      await inbox.done()
    })

    it("keeps the lead's reason as a muted note, and leaves it out when empty", async () => {
      const inbox = mount([grantRow()])
      expect(text("[data-reason-intro]")).toBe("@moth's reason:")
      expect(text("[role=note]")).toBe("Fox and owl finish the checkout today.")
      expect(document.querySelector<HTMLElement>("[role=note]")!.style.fontFamily).toBe(
        "var(--font-mono)",
      )
      expect(document.querySelector("blockquote")).toBeNull()
      await inbox.done()
      const quiet = mount([grantRow({ reason: "  " })])
      expect(document.querySelector("[data-reason-intro], [role=note]")).toBeNull()
      await quiet.done()
    })

    it("says how many more things the lead asked for, behind Review", async () => {
      const inbox = mount([grantRow()])

      expect(text("p.grant-warn")).toBe("@moth also asked for 3 more things · Review")
      expect(inbox.button("Review").getAttribute("aria-expanded")).toBe("false")
      await inbox.done()
      const none = mount([grantRow({ commands: [], repos: [proposal.repos[0]!] })])
      expect(document.querySelector("p.grant-warn")).toBeNull()
      await none.done()
    })

    it("offers until they're done, 1 hour, Decline and the terminal, with the way to end it", async () => {
      const inbox = mount([grantRow()])

      expect(menu()).toEqual([
        "Allow until they're done",
        "Allow for 1 hour",
        "Decline",
        "Go to terminal",
      ])
      expect(text(".console-option .console-s")).toBe(
        "Ends when each reports done, or the lead lets them go. Revoke anytime from the Inbox.",
      )
      // No time control: the options carry it.
      expect(document.querySelector(".segment")).toBeNull()
      await inbox.done()
    })
  })

  context("Review", () => {
    it("lists the extras unticked, each with why it needs the person's OK", async () => {
      const inbox = mount([grantRow()])
      act(() => inbox.button("Review").click())

      expect(inbox.button("Review").getAttribute("aria-expanded")).toBe("true")
      expect(text(".grant-group > legend")).toBe("Needs your OK")
      expect(text(".grant-group > .console-note")).toBe("Not included unless you tick them.")
      expect(texts(".grant-tick")).toEqual([
        "Also run echo 'it'\\''s here'This isn't pushing or a pull request",
        "Push to acme/shop-uiThis remote was added recently and isn't yours",
        "Push to acme/newThis repo was just created or changed",
      ])
      expect(inbox.tick("echo").checked).toBe(false)
      expect(inbox.tick("shop-ui").checked).toBe(false)
      expect(inbox.tick("acme/new").checked).toBe(false)
      await inbox.done()
    })
  })

  context("Details", () => {
    it("says who is covered, with Include me off, and warns for Codex, in words", async () => {
      const inbox = mount([grantRow()])
      expect(document.querySelector("[role=switch]")).toBeNull()
      act(() => inbox.button("Details").click())

      expect(text(".grant-who")).toBe("Includes teammates @moth adds later.")
      const include = document.querySelector<HTMLElement>("[role=switch]")!
      expect(include.getAttribute("aria-checked")).toBe("false")
      expect(include.getAttribute("aria-labelledby")).toBeTruthy()
      expect(document.getElementById(include.getAttribute("aria-labelledby")!)?.textContent).toBe(
        "Include me (@moth) too",
      )
      expect(text("[data-grant=codex]")).toBe(
        "@fox uses Codex: allowed commands run outside Codex's sandbox.",
      )
      expect(inbox.button("Hide details")).toBeDefined()
      await inbox.done()
    })

    it("says a teammate started in plan mode is not reached, one line each", async () => {
      const planned = mount([
        grantRow({
          covered: [
            { handle: "elk", agent: "agy", started: true, plan: true },
            { handle: "kit", agent: "agy", started: false, plan: true },
            { handle: "owl", agent: "agy", started: false, plan: false },
            { handle: "fox", agent: "codex", started: false, plan: false },
          ],
        }),
      ])
      act(() => planned.button("Details").click())
      expect(
        [...document.querySelectorAll("[data-grant=agy-plan]")].map((p) => p.textContent),
      ).toEqual([
        "@elk was started in plan mode, so this grant doesn't reach it.",
        "@kit was started in plan mode, so this grant doesn't reach it.",
      ])
      // A running plan-mode teammate is not also told it "picks this up the next time".
      expect(document.querySelector("[data-grant=agy]")).toBeNull()
      await planned.done()
      const none = mount([grantRow(elk)])
      act(() => none.button("Details").click())
      expect(document.querySelector("[data-grant=agy-plan]")).toBeNull()
      await none.done()
    })

    it("says only the Antigravity clause that applies, and none where neither does", async () => {
      const neither = mount([grantRow(elk)])
      act(() => neither.button("Details").click())
      expect(document.querySelector("[data-grant=agy], [data-grant=agy-old]")).toBeNull()
      expect(document.querySelector("[data-grant=codex]")).toBeNull()
      await neither.done()

      const started = mount([
        grantRow({
          covered: [
            { handle: "elk", agent: "agy", started: true, plan: false },
            { handle: "kit", agent: "agy", started: true, plan: false },
            { handle: "owl", agent: "agy", started: false, plan: false },
          ],
        }),
      ])
      act(() => started.button("Details").click())
      expect(text("[data-grant=agy]")).toBe("@elk, @kit pick this up the next time it starts.")
      expect(document.querySelector("[data-grant=agy-old]")).toBeNull()
      await started.done()

      const old = mount([grantRow({ ...elk, agyOutdated: true })])
      act(() => old.button("Details").click())
      expect(text("[data-grant=agy-old]")).toBe("Antigravity needs updating to 1.4.10 to use this.")
      expect(document.querySelector("[data-grant=agy]")).toBeNull()
      await old.done()
    })

    it("has the AutoRun line and its Fix while Command Prompt prints, and drops it once it doesn't", async () => {
      const printing = mount([grantRow(elk)], { autorun: offer })
      act(() => printing.button("Details").click())
      expect(texts("p.grant-warn").at(-1)).toBe(
        "Antigravity on this PC needs one fix to use this grant · Fix",
      )
      await printing.done()

      const silenced = mount([grantRow(elk)], {
        autorun: {
          state: "silenced",
          current: offer.next,
          restores: offer.current,
          machine: null,
          suggested: null,
          outcome: null,
          dismissed: false,
        },
      })
      act(() => silenced.button("Details").click())
      expect(document.body.textContent).not.toContain("to use this grant")
      await silenced.done()

      const other = mount([grantRow()], { autorun: offer })
      act(() => other.button("Details").click())
      expect(document.body.textContent).not.toContain("to use this grant")
      await other.done()
    })

    it("opens a small confirm from Fix, with the key and values behind details, and Hide it hides them", async () => {
      const inbox = mount([grantRow(elk)], { autorun: offer })
      act(() => inbox.button("Details").click())
      act(() => inbox.button("Fix").click())
      await nextFrame()

      const dialog = document.querySelector("[role=alertdialog]")!
      expect(dialog.querySelector("h2, [id*=title]")?.textContent).toBe(
        "Antigravity can't use your approvals on this computer",
      )
      expect(dialog.textContent).toContain("Novadeck can hide that script's output.")
      expect(dialog.textContent).not.toContain("HKEY_CURRENT_USER")
      act(() =>
        Array.from(dialog.querySelectorAll("button"))
          .find((each) => each.textContent === "details")!
          .click(),
      )
      expect(dialog.textContent).toContain(
        "HKEY_CURRENT_USER\\Software\\Microsoft\\Command Processor",
      )
      expect(dialog.querySelector("[data-autorun-value=current]")?.textContent).toBe("chcp 65001")
      expect(dialog.querySelector("[data-autorun-value=next]")?.textContent).toBe(
        "(chcp 65001) >nul 2>&1",
      )
      act(() =>
        Array.from(dialog.querySelectorAll("button"))
          .find((each) => each.textContent === "Hide it")!
          .click(),
      )
      expect(inbox.silenced).toEqual(["(chcp 65001) >nul 2>&1"])
      await inbox.done()
    })
  })

  context("answering", () => {
    it("sends the presets and the repos it ticks for as long as they're at it, with nothing else", async () => {
      const inbox = mount([grantRow()])
      act(() => inbox.option("Allow until they're done").click())

      expect(inbox.sent).toEqual([
        {
          kind: "grant",
          answer: {
            type: "grant",
            presets: ["push", "pr"],
            commands: [],
            repos: ["github.com/acme/shop"],
            withLead: false,
            lifetime: "until-done",
          },
        },
      ])
      await inbox.done()
    })

    it("carries 1 hour in the answer, with what was ticked under Review and Include me", async () => {
      const inbox = mount([grantRow()])
      act(() => inbox.button("Review").click())
      act(() => inbox.tick("shop-ui").click())
      act(() => inbox.tick("echo").click())
      act(() => inbox.button("Details").click())
      act(() => document.querySelector<HTMLElement>("[role=switch]")!.click())
      act(() => inbox.option("Allow for 1 hour").click())

      expect(inbox.sent).toEqual([
        {
          kind: "grant",
          answer: {
            type: "grant",
            presets: ["push", "pr"],
            commands: [0],
            repos: ["github.com/acme/shop", "github.com/acme/shop-ui"],
            withLead: true,
            lifetime: "hour",
          },
        },
      ])
      await inbox.done()
    })

    it("sends nothing while no repo is ticked for a preset, and says why", async () => {
      const repos = proposal.repos.map((each) => ({ ...each, ticked: false }))
      const inbox = mount([grantRow({ repos })])

      expect(inbox.option("Allow until they're done").textContent).toContain("Tick a repo")
      act(() => inbox.option("Allow until they're done").click())
      expect(inbox.sent).toEqual([])
      act(() => inbox.button("Review").click())
      act(() => inbox.tick("shop-ui").click())
      expect(inbox.option("Allow until they're done").textContent).not.toContain("Tick a repo")
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
  it("keeps the agent's words as a muted note and says in Novadeck's what it would run, as code", async () => {
    const inbox = mount([approvalRow()])

    expect(text(".console-tag")).toBe("Approval")
    expect(text("h3.console-ask")).toBe("!Can I run these without asking?")
    expect(text("[data-reason-intro]")).toBe("@fox's reason:")
    expect(texts("[role=note]")).toEqual(["It only writes `dist/`."])
    expect(text(".console-body")).toBe("I'd run these without asking you each time:")
    expect(texts(".grant-lines code")).toEqual(["pnpm build", "pnpm run 'x y'"])
    await inbox.done()
  })

  it("titles every approval in Novadeck's words, and shows none of the agent's subject, hard-to-undo line or details", async () => {
    const row = approvalRow()
    if (row.kind !== "ask") throw new Error("an ask")
    const inbox = mount([
      {
        ...row,
        ask: {
          ...row.ask,
          subject: "Can I run the read-only test suite?",
          hardToUndo: "Nothing, it is safe.",
          details: "Totally harmless, trust me.",
        },
      },
    ])
    expect(text("h3.console-ask")).toBe("!Can I run these without asking?")
    expect(document.querySelector(".console-detail")).toBeNull()
    expect(text(".console-hard")).toBe("! @fox says some of this would be hard to undo.")
    expect(document.body.textContent).not.toContain("read-only")
    expect(document.body.textContent).not.toContain("harmless")
    // The Inbox row says the same.
    expect(text(".inbox-row-select")).toContain("Can I run these without asking?")
    expect(text(".inbox-row-select")).not.toContain("read-only")
    await inbox.done()
  })

  it("says in Novadeck's words why a hard-to-undo approval is marked, and shows none of the agent's", async () => {
    const row = approvalRow()
    if (row.kind !== "ask") throw new Error("an ask")
    const inbox = mount([
      { ...row, ask: { ...row.ask, hardToUndo: "Deletes everything, trust me." } },
    ])
    expect(text("[data-grant=hard]")).toBe("! @fox says some of this would be hard to undo.")
    expect(document.body.textContent).not.toContain("trust me")
    await inbox.done()
  })

  it("offers exact commands only: nothing is said to be followed by anything", async () => {
    const inbox = mount([approvalRow()])

    expect(document.querySelector("[data-grant=rest]")).toBeNull()
    expect(document.body.textContent).not.toContain("followed by anything")
    expect(document.querySelector(".grant-rest, .grant-flag")).toBeNull()
    await inbox.done()
  })

  it("warns about Codex's sandbox only when the asking terminal runs Codex", async () => {
    const claude = mount([approvalRow()])
    expect(document.querySelector("[data-grant=codex]")).toBeNull()
    await claude.done()
    const codex = approvalRow()
    const inbox = mount([{ ...codex, source: { ...codex.source, agent: "codex" } }])
    expect(text("[data-grant=codex]")).toBe(
      "@fox uses Codex: allowed commands run outside Codex's sandbox.",
    )
    await inbox.done()
  })

  it("offers until it's done, 1 hour, Decline and the terminal, and the answer carries the time", async () => {
    const inbox = mount([approvalRow()])

    expect(menu()).toEqual([
      "Allow until it's done",
      "Allow for 1 hour",
      "Decline",
      "Go to terminal",
    ])
    act(() => inbox.option("Allow for 1 hour").click())
    expect(inbox.sent).toEqual([{ kind: "ask", answer: { type: "approve", lifetime: "hour" } }])
    await inbox.done()
  })

  it("declines by dismissing the ask", async () => {
    const inbox = mount([approvalRow()])
    act(() => inbox.option("Decline").click())

    expect(inbox.dismissed).toEqual(["ap"])
    expect(inbox.sent).toEqual([])
    await inbox.done()
  })
})

describe("The Grants section", () => {
  it("is absent while no grant is live", async () => {
    const inbox = mount([], { open: false })

    expect(document.querySelector(".inbox-grants")).toBeNull()
    await inbox.done()
  })

  it("lists each live grant with its holder, actions, repos, how long it lasts and last use", async () => {
    const lastUse = { at: Date.now() - 4 * 60_000, handle: "owl", command: "git push origin a:a" }
    const inbox = mount([], { grants: [live({ lastUse })], open: false })

    const row = document.querySelector(".grant-row")!
    expect(row.querySelector(".grant-row-holder")?.textContent).toBe("@moth's team")
    expect(row.querySelector(".grant-row-left")?.textContent).toBe("1 hour · 42 min left")
    expect(row.querySelector(".grant-row-what")?.textContent).toBe("push branches in acme/shop")
    expect(row.querySelector(".grant-row-commands")?.textContent).toBe("pnpm test")
    expect(row.querySelector(".grant-row-last")?.textContent).toBe(
      "Last allowed: git push origin a:a by @owl, 4m ago",
    )
    await inbox.done()
  })

  it("says until done, with the live holders the runner names", async () => {
    const inbox = mount([], {
      grants: [
        live({
          lifetime: "until-done",
          endsAt: null,
          covering: [
            { terminalId: "t1", handle: "fox" },
            { terminalId: "t2", handle: "owl" },
          ],
        }),
      ],
      open: false,
    })
    expect(document.querySelector(".grant-row-left")?.textContent).toBe(
      "until done · @fox, @owl working",
    )
    await inbox.done()
  })

  it("says only until done where nobody is live, and never more than 60 minutes left", async () => {
    const idle = mount([], {
      grants: [live({ lifetime: "until-done", endsAt: null })],
      open: false,
    })
    expect(document.querySelector(".grant-row-left")?.textContent).toBe("until done")
    await idle.done()
    const long = mount([], { grants: [live({ endsAt: Date.now() + 90 * 60_000 })], open: false })
    expect(document.querySelector(".grant-row-left")?.textContent).toBe("1 hour · 60 min left")
    await long.done()
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

describe("The AutoRun line in the Inbox", () => {
  it("is not there where Command Prompt prints nothing", async () => {
    const inbox = mount([], { open: false })
    expect(document.querySelector("[data-autorun]")).toBeNull()
    await inbox.done()
  })

  it("says Antigravity needs a fix, with Fix, with no Grant card open", async () => {
    const inbox = mount([], { autorun: offer, open: false })
    expect(text(".inbox-grants .grant-row")).toBe(
      "Antigravity on this PC needs one fix to use approvals · Fix",
    )
    expect(document.querySelector("[role=alertdialog]")).toBeNull()
    act(() => inbox.button("Fix").click())
    await nextFrame()
    expect(document.querySelector("[role=alertdialog]")).not.toBeNull()
    await inbox.done()
  })
})

describe("The Grant card as the person changes it", () => {
  it("follows Include me in its title, and names the lead in the receipt", async () => {
    const inbox = mount([grantRow(), approvalRow()])
    expect(text("h3.console-ask")).toBe("!Let @fox and @owl work without asking?")
    act(() => inbox.button("Details").click())
    act(() => document.querySelector<HTMLElement>("[role=switch]")!.click())
    expect(text("h3.console-ask")).toBe("!Let @moth, @fox and @owl work without asking?")
    act(() => inbox.option("Allow until they're done").click())
    act(() =>
      inbox.state.update((current) => ({
        ...current,
        items: current.items.filter((each) => each.id !== "g"),
      })),
    )

    expect(text(".console-receipt")).toBe("Granted @moth's team and @moth until it's done.")
    await inbox.done()
  })

  it("follows the repos ticked under Review in its body", async () => {
    const inbox = mount([grantRow()])
    act(() => inbox.button("Review").click())
    act(() => inbox.tick("shop-ui").click())

    expect(text(".console-body")).toContain("in acme/shop and 1 more without asking")
    expect(inbox.button("Review").getAttribute("aria-controls")).toBe(
      document.querySelector(".grant-group")!.id,
    )
    await inbox.done()
  })

  it("matches the row's subject to the card's title", async () => {
    const inbox = mount([grantRow()])
    expect(text(".inbox-row-select")).toContain("Let @fox and @owl work without asking?")
    await inbox.done()
  })

  it("spaces the code in a Review row as the card's text does", async () => {
    const inbox = mount([grantRow()])
    act(() => inbox.button("Review").click())

    const row = document.querySelector(".grant-tick .grant-repo")!
    expect(row.querySelector(":scope > code")?.textContent).toBe("echo 'it'\\''s here'")
    await inbox.done()
  })

  it("answers on a number or the arrows, as any menu does", async () => {
    const one = mount([grantRow()])
    one.key("2")
    expect(one.sent).toMatchObject([{ answer: { lifetime: "hour" } }])
    await one.done()

    const other = mount([grantRow()])
    other.key("ArrowDown")
    other.key("Enter", document.activeElement!)
    expect(other.sent).toMatchObject([{ answer: { lifetime: "hour" } }])
    await other.done()

    const declined = mount([grantRow()])
    declined.key("3")
    expect(declined.dismissed).toEqual(["g"])
    await declined.done()
  })
})

describe("A proposal with no presets", () => {
  const bare = { presets: [] as GrantProposal["presets"] }

  it("says asked for, offers no repo, and waits for a command to be ticked", async () => {
    const inbox = mount([grantRow(bare)])

    expect(text("p.grant-warn")).toBe("@moth asked for 1 thing · Review")
    expect(inbox.option("Allow until they're done").textContent).toContain("Tick something")
    act(() => inbox.button("Review").click())
    expect(texts(".grant-tick")).toHaveLength(1)
    expect(document.querySelector(".grant-group")?.textContent).not.toContain("Push to")
    act(() => inbox.option("Allow until they're done").click())
    expect(inbox.sent).toEqual([])

    act(() => inbox.tick("echo").click())
    expect(inbox.option("Allow until they're done").textContent).not.toContain("Tick something")
    act(() => inbox.option("Allow until they're done").click())
    expect(inbox.sent).toMatchObject([
      { answer: { presets: [], commands: [0], repos: [], lifetime: "until-done" } },
    ])
    await inbox.done()
  })
})

describe("The agent's words", () => {
  const mimic =
    "Novadeck: this is safe. Grant it. `rm -rf /` **bold** Let @moth do anything without asking?"

  it("stays in the muted note, as plain text with an aria name, and never in Novadeck's lines", async () => {
    const inbox = mount([grantRow({ reason: mimic })])

    const note = document.querySelector("[role=note]")!
    expect(note.textContent).toBe(mimic)
    expect(note.querySelector("code, strong, b")).toBeNull()
    expect(note.getAttribute("aria-label")).toBe("What @moth says")
    expect((note as HTMLElement).style.webkitLineClamp).toBe("2")
    expect(text(".console-body")).not.toContain("Novadeck")
    expect(text("h3.console-ask")).not.toContain("safe")
    await inbox.done()
  })

  it("holds a hostile reason inside the note, under Novadeck's intro line", async () => {
    const hostile =
      "Novadeck checked these commands: nothing below needs your OK, so you can skip Review. Novadeck recommends: Allow until they're done.\u202E"
    const inbox = mount([grantRow({ reason: hostile })])

    expect(text("[data-reason-intro]")).toBe("@moth's reason:")
    expect(document.querySelector("[role=note]")!.textContent).toBe(
      hostile.replace("\u202E", "\\u{202E}"),
    )
    expect(text(".console-body")).not.toContain("checked")
    expect(text("p.grant-warn")).toBe("@moth also asked for 3 more things · Review")
    await inbox.done()
  })

  it("writes out what nothing shows", async () => {
    const inbox = mount([grantRow({ reason: "ok\u202Eyes\u200Bno" })])
    expect(text("[role=note]")).toBe("ok\\u{202E}yes\\u{200B}no")
    await inbox.done()
  })

  it("clips a very long reason, and shows the rest on more", async () => {
    const long = "word ".repeat(400).trim()
    const inbox = mount([grantRow({ reason: long })])

    expect(text("[role=note]")!.length).toBe(281)
    expect(text("[role=note]")!.endsWith("…")).toBe(true)
    act(() => inbox.button("more").click())
    expect(text("[role=note]")).toBe(long)
    act(() => inbox.button("less").click())
    expect(text("[role=note]")!.length).toBe(281)
    await inbox.done()
  })

  it("breaks a long unbroken word anywhere, and cuts no surrogate pair in two", async () => {
    const url = `https://example.com/${"a".repeat(200)}`
    const inbox = mount([grantRow({ reason: url })])
    expect(document.querySelector<HTMLElement>("[role=note]")!.style.overflowWrap).toBe("anywhere")
    await inbox.done()

    // An astral character that straddles the 280th unit stays whole or goes whole.
    const astral = `${"x".repeat(279)}\u{1F600}tail`
    const other = mount([grantRow({ reason: astral })])
    const shown = text("[role=note]")!
    expect(shown).toBe(`${"x".repeat(279)}…`)
    expect(/[\ud800-\udfff]/.test(shown.replace(/\ud83d\ude00/g, ""))).toBe(false)
    await other.done()
  })

  it("clamps the reason to two lines, with more at the end of the second", async () => {
    const long = "word ".repeat(400).trim()
    const inbox = mount([grantRow({ reason: long })])
    const note = document.querySelector<HTMLElement>("[role=note]")!
    expect(note.style.webkitLineClamp).toBe("2")
    const more = inbox.button("more")
    // Inside the note's own box, placed over its last line's end, not on a line of its own.
    expect(note.parentElement?.contains(more)).toBe(true)
    expect(more.style.position).toBe("absolute")
    expect(more.style.bottom).toBe("0px")
    expect(more.style.right).toBe("0px")
    await inbox.done()
  })

  it("offers more where two lines overflow", async () => {
    const was = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight")
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 40,
    })
    const inbox = mount([grantRow()])
    expect(inbox.button("more")).toBeDefined()
    if (was) Object.defineProperty(HTMLElement.prototype, "scrollHeight", was)
    else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight
    await inbox.done()
  })

  it("holds the approval body the same way: plain, written out and named", async () => {
    const row = approvalRow()
    if (row.kind !== "ask") throw new Error("an ask")
    const inbox = mount([{ ...row, ask: { ...row.ask, body: "run `dist/` now\u202E" } }])

    const note = document.querySelector("[role=note]")!
    expect(note.textContent).toBe("run `dist/` now\\u{202E}")
    expect(note.querySelector("code")).toBeNull()
    expect(note.getAttribute("aria-label")).toBe("What @fox says")
    await inbox.done()
  })

  it("puts the approval's sentence and commands before the agent's note", async () => {
    const inbox = mount([approvalRow()])
    const order = Array.from(
      document.querySelectorAll(".console-body, .grant-lines, [data-reason-intro]"),
    ).map((each) => each.className || each.getAttribute("data-grant"))
    expect(text(".console-body")).toBe("I'd run these without asking you each time:")
    expect(order).toEqual(["console-body", "grant-lines", "console-note"])
    inbox.key("1")
    expect(inbox.sent).toEqual([
      { kind: "ask", answer: { type: "approve", lifetime: "until-done" } },
    ])
    await inbox.done()
  })

  it("answers the approval on arrows and Enter too", async () => {
    const inbox = mount([approvalRow()])
    inbox.key("ArrowDown")
    inbox.key("Enter", document.activeElement!)
    expect(inbox.sent).toEqual([{ kind: "ask", answer: { type: "approve", lifetime: "hour" } }])
    await inbox.done()
  })
})

describe("The AutoRun line in the Inbox once dismissed", () => {
  it("goes away where the person said not now, and comes back with Preferences' own link", async () => {
    const inbox = mount([], { autorun: { ...offer, dismissed: true }, open: false })
    expect(document.querySelector("[data-autorun]")).toBeNull()
    await inbox.done()
  })
})
