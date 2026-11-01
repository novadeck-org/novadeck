import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Grant } from "@novadeck/protocol"
import { vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { storeWith } from "../testing/workspace.js"
import type { WorkspaceStore } from "../workspaces/store.js"
import {
  activitySaveMs,
  idleGrantMs,
  memoryGrants,
  type GrantRecords,
  type MakeGrant,
} from "./grants.js"
import { isQuiet, wrap, wrapGrants } from "./messages.js"
import { Messaging } from "./messaging.js"

const projectId = randomUUID()
const sessionId = randomUUID()
const here = { projectId, sessionId }
const hour = 3_600_000

// A lead (sable), its teammate fox, a peer owl nobody leads, and elk in another session.
const setup = (
  store?: WorkspaceStore,
  clock: { at: number; mono?: number } = { at: 1_000_000 },
  grants?: GrantRecords,
) => {
  const messaging = new Messaging({
    now: () => clock.at,
    restoreMs: 0,
    sweepMs: 0,
    waitsMs: 0,
    grantsMs: 0,
    // A clock of its own to step the wall clock against; else it follows the wall clock.
    mono: () => clock.mono ?? clock.at,
    ...(store && { records: store, grants: store }),
    ...(grants && { grants }),
  })
  const arrive = (id: string, handle: string, ledBy: string | null, scope = here) => {
    messaging.register(id, scope, handle, ledBy)
    messaging.rooted(id, [
      {
        type: "new",
        root: { agent: "claude", sessionId: `s-${id}`, instance: null, source: "binding" },
        guess: false,
        ready: true,
      },
    ])
  }
  arrive("L", "sable", null)
  arrive("F", "fox", "sable")
  arrive("O", "owl", null)
  arrive("E", "elk", "sable", { projectId, sessionId: randomUUID() })
  const make = (fields: Partial<MakeGrant> = {}): Grant =>
    messaging.grants.make({
      ...here,
      workspaceSessionId: sessionId,
      holder: { kind: "team", lead: "sable", withLead: false },
      presets: ["push"],
      commands: [],
      repos: [{ url: "github.com/acme/shop", defaultBranch: "main", defaultFrom: "github" }],
      entryId: randomUUID(),
      proposedBy: "sable",
      lifetime: "until-done",
      ...fields,
    })
  const told = (terminalId: string) =>
    [...messaging["store"].messages()].filter(
      (each) => each.to.terminalId === terminalId && each.grantId !== undefined,
    )
  return { messaging, arrive, make, told, clock }
}

describe("who a grant covers", () => {
  it("is the lead's direct teammates in its project and session, not the lead, a peer or another session", () => {
    const { messaging, make } = setup()
    make()
    expect(messaging.grants.covering("F")).toHaveLength(1)
    for (const id of ["L", "O", "E", "nobody"]) expect(messaging.grants.covering(id)).toEqual([])
  })

  it("includes the lead only when ticked, and teammates opened later at once", () => {
    const { messaging, make, arrive } = setup()
    make({ holder: { kind: "team", lead: "sable", withLead: true } })
    expect(messaging.grants.covering("L")).toHaveLength(1)
    arrive("N", "newt", "sable")
    expect(messaging.grants.covering("N")).toHaveLength(1)
  })

  it("drops a teammate the lead lets go of, and the grant when its lead closes", () => {
    const { messaging, make, told } = setup()
    make()
    messaging.endLead("F")
    expect(messaging.grants.covering("F")).toEqual([])
    const second = setup()
    second.make()
    expect(second.told("F")).toHaveLength(1)
    second.messaging.unregister("L", true)
    expect(second.messaging.grants.list()).toEqual([])
    expect(second.told("F")).toHaveLength(2)
    expect(told("F")).toHaveLength(1)
  })

  it("ends a lead's grants when it is closed after its shell exited, by its kept identity", () => {
    const { messaging, make } = setup()
    make()
    make({
      holder: { kind: "terminal", handle: "sable" },
      presets: [],
      repos: [],
      commands: [{ argv: ["make", "ship"], rest: false }],
    })
    // The shell exits first: the live entry goes, and with it the grant its agent held alone;
    // the team grant it leads stays for the team.
    messaging.unregister("L")
    expect(messaging.grants.list()).toHaveLength(1)
    messaging.unregister("L", true, { sessionId, handle: "sable" })
    expect(messaging.grants.list()).toEqual([])
  })

  it("tells a terminal the lead adopts of the grants that now cover it, at once", () => {
    const { messaging, make, told } = setup()
    make()
    expect(told("O")).toHaveLength(0)
    messaging.setLead("O", "sable")
    expect(messaging.grants.covering("O")).toHaveLength(1)
    expect(told("O")).toHaveLength(1)
    expect(told("O")[0]).toMatchObject({ from: { kind: "novadeck" } })
  })

  it("keeps a terminal grant to that handle", () => {
    const { messaging, make } = setup()
    make({
      holder: { kind: "terminal", handle: "owl" },
      presets: [],
      commands: [{ argv: ["make", "ship"], rest: false }],
      repos: [],
    })
    expect(messaging.grants.covering("O")).toHaveLength(1)
    expect(messaging.grants.covering("F")).toEqual([])
  })
})

describe("how long a grant lasts", () => {
  it("has no clock until done, and an hour has one", () => {
    const { make } = setup()
    const open = make()
    expect(open).toMatchObject({
      lifetime: "until-done",
      endsAt: null,
      lastActivityAt: open.madeAt,
    })
    expect(open.ended).toEqual([])
    const hourly = make({ lifetime: "hour" })
    expect(hourly.endsAt).toBe(hourly.madeAt + hour)
  })

  it("ends an hour grant at its hour, and an until-done grant not at all by the clock", () => {
    const { messaging, make, clock } = setup()
    make({ lifetime: "hour" })
    const open = make()
    clock.at += hour - 1
    // Heard from, so the idle cap is far off either way.
    messaging.grants.activity("F")
    expect(messaging.grants.covering("F")).toHaveLength(2)
    clock.at += 1
    expect(messaging.grants.covering("F").map(({ id }) => id)).toEqual([open.id])
  })

  it("ends after a day without activity, and any activity of a covered terminal renews it", () => {
    const { messaging, make, clock, told } = setup()
    const grant = make()
    clock.at += idleGrantMs - 1
    messaging.grants.activity("F")
    clock.at += idleGrantMs - 1
    messaging.grants.sweep()
    expect(messaging.grants.covering("F")).toHaveLength(1)
    // A terminal it doesn't cover renews nothing.
    messaging.grants.activity("O")
    messaging.grants.activity("L")
    clock.at += 1
    expect(messaging.grants.covering("F")).toEqual([])
    messaging.grants.sweep()
    expect(messaging.grants.list()).toEqual([])
    expect(told("F")).toHaveLength(2)
    expect(() => messaging.grants.revoke(grant.id)).toThrow(/ended/)
  })

  it("tells the covered terminals when it ends by time, once, and by revoke", () => {
    const { messaging, make, told, clock } = setup()
    const first = make({ lifetime: "hour" })
    expect(told("F")).toHaveLength(1)
    clock.at += hour
    messaging.grants.sweep()
    messaging.grants.sweep()
    expect(told("F")).toHaveLength(2)
    const second = make()
    messaging.grants.revoke(second.id)
    expect(messaging.grants.covering("F")).toEqual([])
    expect(told("F")).toHaveLength(4)
    expect(() => messaging.grants.revoke(second.id)).toThrow(/ended/)
    expect(() => messaging.grants.revoke(first.id)).toThrow(/ended/)
  })
})

describe("when a terminal's coverage ends", () => {
  const ended = (messaging: Messaging, grantId: string, terminalId: string) =>
    messaging.grants.endedWhy(grantId, terminalId)

  it("ends with one teammate's done, for it and for good, and not the others'", () => {
    const { messaging, make, arrive, told } = setup()
    arrive("G", "gull", "sable")
    const grant = make()
    messaging.grants.coverageEnds("F", "done")
    expect(messaging.grants.covering("F")).toEqual([])
    expect(messaging.grants.covering("G")).toHaveLength(1)
    expect(ended(messaging, grant.id, "F")).toBe("done")
    expect(messaging.grants.list()).toHaveLength(1)
    expect(told("F")).toHaveLength(2)
    expect(told("G")).toHaveLength(1)
    // Led again by the same lead, it stays out: it asks the lead for a new grant.
    messaging.setLead("F", "sable")
    expect(messaging.grants.covering("F")).toEqual([])
    expect(messaging.grants.get(grant.id, "F")).toBeUndefined()
    expect(messaging.grants.get(grant.id, "G")).toBeDefined()
  })

  it("still covers a teammate opened later", () => {
    const { messaging, make, arrive } = setup()
    make()
    messaging.grants.coverageEnds("F", "done")
    arrive("N", "newt", "sable")
    expect(messaging.grants.covering("N")).toHaveLength(1)
  })

  it("ends when the lead releases the teammate, and when its agent exits", () => {
    const { messaging, make, arrive } = setup()
    arrive("G", "gull", "sable")
    const grant = make()
    // As the terminal manager does: the grants first, then the lead.
    messaging.grants.coverageEnds("F", "released")
    messaging.endLead("F")
    messaging.grants.coverageEnds("G", "exited")
    messaging.endLead("G")
    expect(messaging.grants.covering("F")).toEqual([])
    expect(messaging.grants.covering("G")).toEqual([])
    expect(ended(messaging, grant.id, "F")).toBe("released")
    expect(ended(messaging, grant.id, "G")).toBe("exited")
    expect(messaging.grants.list()[0]!.ended.map(({ handle }) => handle)).toEqual(["fox", "gull"])
  })

  it("ends only the lead's own coverage on the lead's own done, leaving its teammates covered", () => {
    const { messaging, make } = setup()
    make({ holder: { kind: "team", lead: "sable", withLead: true } })
    expect(messaging.grants.covering("L")).toHaveLength(1)
    messaging.grants.coverageEnds("L", "done")
    expect(messaging.grants.covering("L")).toEqual([])
    expect(messaging.grants.covering("F")).toHaveLength(1)
    messaging.grants.coverageEnds("L", "exited")
    expect(messaging.grants.list()[0]!.ended).toHaveLength(1)
  })

  it("ends a grant held by one terminal with its holder's done or exit, not with a release", () => {
    for (const why of ["done", "exited"] as const) {
      const { messaging, make, told } = setup()
      const grant = make({
        holder: { kind: "terminal", handle: "sable" },
        presets: [],
        repos: [],
        commands: [{ argv: ["make", "ship"], rest: false }],
      })
      messaging.grants.coverageEnds("O", "done")
      messaging.grants.coverageEnds("L", "released")
      expect(messaging.grants.list()).toHaveLength(1)
      messaging.grants.coverageEnds("L", why)
      expect(messaging.grants.list()).toEqual([])
      expect(messaging.grants.covering("L")).toEqual([])
      expect(ended(messaging, grant.id, "L")).toBe(why)
      expect(told("L")).toHaveLength(2)
    }
  })

  it("ends the whole grant when the record of ended terminals is full", () => {
    const { messaging, make, arrive } = setup()
    make()
    for (let each = 0; each < 257; each += 1) {
      arrive(`T${each}`, `t${each}`, "sable")
      messaging.grants.coverageEnds(`T${each}`, "done")
    }
    expect(messaging.grants.list()).toEqual([])
  })

  it("tells a done quietly, so the doorbell doesn't wake the agent that finished, and the rest as before", () => {
    const { messaging, make, arrive, told } = setup()
    arrive("G", "gull", "sable")
    arrive("H", "hare", "sable")
    make()
    messaging.grants.coverageEnds("F", "done")
    messaging.grants.coverageEnds("G", "released")
    messaging.grants.coverageEnds("H", "exited")
    // The grant made, then its end: only the done's end is quiet.
    expect(told("F").map(isQuiet)).toEqual([false, true])
    expect(told("G").map(isQuiet)).toEqual([false, false])
    expect(told("H").map(isQuiet)).toEqual([false, false])
    // A terminal-held grant ends with its holder's done just as quietly.
    const alone = setup()
    alone.make({
      holder: { kind: "terminal", handle: "sable" },
      presets: [],
      repos: [],
      commands: [{ argv: ["make", "ship"], rest: false }],
    })
    alone.messaging.grants.coverageEnds("L", "done")
    expect(alone.told("L").map(isQuiet)).toEqual([false, true])
    // Only Novadeck's own notice is quiet, whatever an agent's message says.
    const [notice] = told("F")
    expect(
      isQuiet({ ...notice!, from: { kind: "agent", handle: "fox", terminalId: "F" } as never }),
    ).toBe(false)
  })

  it("is told to the terminal in the words of why, at its next delivery", () => {
    const { messaging, make } = setup()
    const grant = make()
    const send = (terminalId: string) => {
      const message = [...messaging["store"].messages()].filter(
        (each) => each.to.terminalId === terminalId && each.grantId === grant.id,
      )
      return wrap(message, () => false, "m", {
        grants: (id) => messaging.grants.get(id, terminalId),
        endedWhy: (id) => messaging.grants.endedWhy(id, terminalId),
      })
    }
    expect(send("F")).toContain("<grant ")
    messaging.grants.coverageEnds("F", "done")
    const text = send("F")
    expect(text).toContain(
      `<grant-ended id="${grant.id}" why="done">Your grant ended when you reported done; ask again if you continue.</grant-ended>`,
    )
    expect(text).not.toContain("<grant ")
  })
})

describe("what the covered are told", () => {
  it("is Novadeck's message carrying the grant, rendered live and then as ended", () => {
    const { messaging, make, told } = setup()
    const grant = make()
    const [message] = told("F")
    expect(message).toMatchObject({
      from: { kind: "novadeck" },
      grantId: grant.id,
      state: "queued",
    })
    const live = wrap([message!], () => false, "Ab3dEf9Z", {
      personMark: "PersonMk",
      grants: (id) => messaging.grants.get(id),
    })
    expect(live).toContain(`<grant id="${grant.id}" person="PersonMk"`)
    messaging.grants.revoke(grant.id)
    const ended = wrap([message!], () => false, "Ab3dEf9Z", {
      personMark: "PersonMk",
      grants: (id) => messaging.grants.get(id),
    })
    expect(ended).toContain(`<grant-ended id="${grant.id}">`)
    expect(told("L")).toEqual([])
  })

  it("is delivered with the prompt, under a person mark", () => {
    const { messaging, make } = setup()
    const grant = make()
    const text = wrapGrants(messaging.grants.covering("F"), "claude", "linux")
    expect(text).toContain(`<grant id="${grant.id}" person="`)
    expect(wrapGrants(messaging.grants.covering("O"), "claude", "linux")).toBe("")
  })
})

describe("who a grant covers now, as the grants list sends it", () => {
  const covering = (messaging: Messaging) =>
    messaging.grants.list().map((grant) => grant.id) &&
    [...messaging["grants"]["listing"]()].map(({ covering: who }) =>
      who.map(({ handle }) => handle),
    )

  it("is the lead's current teammates whose agent runs, the lead when ticked, less who ended", () => {
    const { messaging, make, arrive } = setup()
    // A teammate with no agent yet is not covering anything.
    messaging.register("U", here, "ukko", "sable")
    make({ holder: { kind: "team", lead: "sable", withLead: true } })
    expect(covering(messaging)).toEqual([["sable", "fox"]])
    arrive("N", "newt", "sable")
    expect(covering(messaging)).toEqual([["sable", "fox", "newt"]])
    messaging.grants.coverageEnds("F", "done")
    expect(covering(messaging)).toEqual([["sable", "newt"]])
    messaging.grants.coverageEnds("L", "done")
    expect(covering(messaging)).toEqual([["newt"]])
    // A terminal grant covers its holder while it runs.
    const alone = setup()
    alone.make({
      holder: { kind: "terminal", handle: "owl" },
      presets: [],
      repos: [],
      commands: [{ argv: ["make"], rest: false }],
    })
    expect(covering(alone.messaging)).toEqual([["owl"]])
  })

  it("is sent again when coverage changes, and not on mere activity", async () => {
    const { messaging, make, arrive } = setup()
    messaging.register("U", here, "ukko", "sable")
    make()
    const seen: string[][] = []
    const abort = new AbortController()
    const reading = (async () => {
      for await (const listing of messaging.grants.watch(abort.signal))
        seen.push(listing[0]!.covering.map(({ handle }) => handle))
    })()
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
    await settle()
    expect(seen).toEqual([["fox"]])
    // Activity: nothing new.
    messaging.grants.activity("F")
    await settle()
    expect(seen).toHaveLength(1)
    // A teammate led and started its agent, one released, one done, one that exits.
    arrive("N", "newt", "sable")
    await settle()
    expect(seen.at(-1)).toEqual(["fox", "newt"])
    messaging.setLead("O", "sable")
    arrive("O", "owl", "sable")
    await settle()
    expect(seen.at(-1)).toEqual(
      ["fox", "owl", "newt"].toSorted((a, b) => seen.at(-1)!.indexOf(a) - seen.at(-1)!.indexOf(b)),
    )
    messaging.grants.coverageEnds("F", "done")
    await settle()
    expect(seen.at(-1)).not.toContain("fox")
    messaging.unregister("N")
    await settle()
    expect(seen.at(-1)).not.toContain("newt")
    abort.abort()
    await reading
  })
})

describe("when the person's Antigravity settings can't be read", () => {
  it("says so in the note of a grant an Antigravity gets, until they can be", () => {
    const { messaging, make } = setup()
    const grant = make()
    const note = () =>
      wrapGrants(messaging.grants.covering("F"), "agy", "linux", "P", messaging.grants.cmdPrints())
    expect(messaging.grants.cmdPrints()).toBe(false)
    expect(note()).not.toContain("could not read")
    messaging.grants.agySettings(false)
    expect(messaging.grants.cmdPrints()).toBe("unreadable")
    expect(note()).toContain(`<grant id="${grant.id}"`)
    expect(note()).toContain("Novadeck could not read the user's Antigravity settings")
    // Not the other harnesses'.
    expect(
      wrapGrants(messaging.grants.covering("F"), "claude", "linux", "P", "unreadable"),
    ).not.toContain("could not read")
    messaging.grants.agySettings(true)
    expect(note()).not.toContain("could not read")
  })
})

describe("what a harness is given at launch", () => {
  it("is git for push, gh for pr, and the first word of each command", () => {
    const { messaging, make } = setup()
    make({ presets: ["push", "pr"], commands: [{ argv: ["uberepo", "ship"], rest: true }] })
    expect(messaging.grants.launchPrograms("F").toSorted()).toEqual(["gh", "git", "uberepo"])
    expect(messaging.grants.launchPrograms("O")).toEqual([])
  })

  it("notes the last use for a covered terminal only", () => {
    const { messaging, make } = setup()
    const grant = make()
    messaging.grants.recordUse(grant.id, "O", "git push x")
    expect(messaging.grants.get(grant.id)?.lastUse).toBeNull()
    messaging.grants.recordUse(grant.id, "F", "git push origin a:b")
    expect(messaging.grants.get(grant.id)?.lastUse).toMatchObject({
      handle: "fox",
      command: "git push origin a:b",
    })
  })
})

describe("grants across a restart", () => {
  it("are kept, and an ended one is dropped at load", () => {
    const directory = mkdtempSync(join(tmpdir(), "novadeck-grants-"))
    const store = storeWith(join(directory, "workspace.sqlite"), here)
    try {
      const clock = { at: 1_000_000 }
      const first = setup(store, clock)
      const kept = first.make()
      const revoked = first.make()
      const lapsed = first.make({ lifetime: "hour" })
      first.messaging.grants.revoke(revoked.id)
      first.messaging.close()
      clock.at += 2 * hour
      const second = setup(store, clock)
      expect(second.messaging.grants.list().map(({ id }) => id)).toEqual([kept.id])
      expect(second.messaging.grants.covering("F")).toHaveLength(1)
      expect(store.grants().map(({ id }) => id)).toEqual([kept.id])
      expect(store.grants().some(({ id }) => id === lapsed.id)).toBe(false)
      second.messaging.close()
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("keep who stopped being covered, and last activity written at most every five minutes", () => {
    const directory = mkdtempSync(join(tmpdir(), "novadeck-grants-"))
    const store = storeWith(join(directory, "workspace.sqlite"), here)
    try {
      const clock = { at: 1_000_000 }
      const first = setup(store, clock)
      const grant = first.make()
      first.messaging.grants.coverageEnds("F", "done")
      clock.at += activitySaveMs - 1
      first.arrive("G", "gull", "sable")
      first.messaging.grants.activity("G")
      // Exact in memory, not yet written.
      expect(first.messaging.grants.list()[0]!.lastActivityAt).toBe(clock.at)
      expect(store.grants()[0]!.lastActivityAt).toBe(grant.madeAt)
      clock.at += 1
      first.messaging.grants.activity("G")
      expect(store.grants()[0]!.lastActivityAt).toBe(clock.at)
      first.messaging.close()
      const second = setup(store, clock)
      second.arrive("G", "gull", "sable")
      expect(second.messaging.grants.covering("F")).toEqual([])
      expect(second.messaging.grants.covering("G")).toHaveLength(1)
      expect(second.messaging.grants.list()[0]).toMatchObject({
        lastActivityAt: clock.at,
        ended: [{ terminalId: "F", handle: "fox", why: "done" }],
      })
      // A grant idle for a day while the runner was away is dropped at load.
      second.messaging.close()
      clock.at += idleGrantMs
      const third = setup(store, clock)
      expect(third.messaging.grants.list()).toEqual([])
      expect(store.grants()).toEqual([])
      third.messaging.close()
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("go with their session", () => {
    const directory = mkdtempSync(join(tmpdir(), "novadeck-grants-"))
    const store = storeWith(join(directory, "workspace.sqlite"), here)
    try {
      const { make, messaging } = setup(store)
      make()
      expect(store.grants()).toHaveLength(1)
      store["database"].prepare("DELETE FROM sessions WHERE id = ?").run(sessionId)
      expect(store.grants()).toEqual([])
      messaging.close()
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("a grant's coverage ends with the agent that had it", () => {
  const owlOnly = {
    holder: { kind: "terminal", handle: "owl" },
    presets: [],
    repos: [],
    commands: [{ argv: ["make", "deploy"], rest: false }],
  } satisfies Partial<MakeGrant>

  it("when its shell exits, so a restart's next agent there is not covered", () => {
    const { messaging, make } = setup()
    const grant = make(owlOnly)
    expect(messaging.grants.covering("O")).toHaveLength(1)
    // Terminals.exited: the shell goes with the agent in it.
    messaging.unregister("O")
    // Terminals.restart as a plain shell: it ends the lead it had, then registers again.
    messaging.grants.coverageEnds("O", "exited")
    messaging.register("O", here, "owl", null)
    messaging.rooted("O", [
      {
        type: "new",
        root: { agent: "codex", sessionId: "s-O2", instance: null, source: "binding" },
        guess: false,
        ready: true,
      },
    ])
    expect(messaging.grants.covering("O")).toEqual([])
    expect(messaging.grants.list()).toEqual([])
    expect(messaging.grants.get(grant.id)).toBeUndefined()
  })

  it("for a teammate of a team grant too, which is told it ended", () => {
    const { messaging, make, told } = setup()
    const grant = make()
    messaging.unregister("F")
    messaging.register("F", here, "fox", "sable")
    expect(messaging.grants.covering("F")).toEqual([])
    expect(messaging.grants.endedWhy(grant.id, "F")).toBe("exited")
    // The others it covers are not affected.
    expect(messaging.grants.list()).toHaveLength(1)
    expect(told("L")).toEqual([])
  })

  it("but not as the runner stops, which is not an agent ending", () => {
    const { messaging, make } = setup()
    make(owlOnly)
    messaging.grants.close()
    messaging.unregister("O")
    expect(messaging.grants.list()[0]).toMatchObject({ ended: [], revokedAt: null })
  })

  it("and a lead's release of a teammate that leads its own team ends only the lead's grants", () => {
    const { messaging, make, arrive } = setup()
    // fox is led by sable and leads owl, which it includes in the grant it asked for itself.
    messaging.endLead("O")
    arrive("Y", "yarrow", "fox")
    const own = make({ holder: { kind: "team", lead: "fox", withLead: true } })
    const sables = make()
    expect(
      messaging.grants
        .covering("F")
        .map((each) => each.id)
        .toSorted(),
    ).toEqual([sables.id, own.id].toSorted())
    // Bindings.endLead(fox, true, "released"), as sable releases fox.
    messaging.grants.coverageEnds("F", "released")
    messaging.endLead("F")
    expect(messaging.grants.covering("F").map((each) => each.id)).toEqual([own.id])
    expect(messaging.grants.endedWhy(own.id, "F")).toBeUndefined()
    expect(messaging.grants.endedWhy(sables.id, "F")).toBe("released")
    expect(messaging.grants.covering("Y").map((each) => each.id)).toEqual([own.id])
    // Its own done does end it.
    messaging.grants.coverageEnds("F", "done")
    expect(messaging.grants.covering("F")).toEqual([])
  })
})

describe("a teammate that becomes covered after the grant was made", () => {
  it("is told of it once its agent runs, whether opened, adopted or newly led", () => {
    const { messaging, make, arrive, told } = setup()
    make()
    // Opened later: registered first, its agent comes after.
    messaging.register("N", here, "newt", "sable")
    expect(told("N")).toEqual([])
    arrive("N", "newt", "sable")
    expect(told("N")).toHaveLength(1)
    // Adopted: a peer the lead takes on.
    messaging.setLead("O", "sable")
    expect(told("O")).toHaveLength(1)
    // Heard of once, however often the sessions change.
    arrive("P", "pike", null)
    expect(told("N")).toHaveLength(1)
    expect(told("O")).toHaveLength(1)
    expect(told("P")).toEqual([])
  })

  it("is told of a restored grant too, and not of one that ended", () => {
    const records = memoryGrants()
    const first = setup(undefined, undefined, records)
    const grant = first.make()
    first.messaging.close()
    const second = setup(undefined, undefined, records)
    expect(second.messaging.grants.covering("F").map((each) => each.id)).toEqual([grant.id])
    second.arrive("N", "newt", "sable")
    expect(second.told("N")).toHaveLength(1)
    const third = setup()
    const ended = third.make()
    third.messaging.grants.revoke(ended.id)
    third.arrive("N", "newt", "sable")
    expect(third.told("N")).toEqual([])
  })

  it("is told once its agent starts, though it was covered as a plain shell when the grant was made", () => {
    const { messaging, make, told } = setup()
    // Led, but no agent runs or is expected there yet: nobody to tell.
    messaging.register("U", here, "ukko", "sable")
    make()
    expect(told("U")).toEqual([])
    messaging.rooted("U", [
      {
        type: "new",
        root: { agent: "claude", sessionId: "s-U", instance: null, source: "binding" },
        guess: false,
        ready: true,
      },
    ])
    expect(told("U")).toHaveLength(1)
  })
})

describe("a grant's records fail closed", () => {
  // Records that refuse every write while `down`.
  const flaky = () => {
    const inner = memoryGrants()
    const state = { down: false, writes: 0 }
    const records: GrantRecords = {
      grants: () => inner.grants(),
      saveGrant(grant) {
        if (state.down) throw new Error("disk full")
        state.writes += 1
        inner.saveGrant(grant)
      },
      removeGrants: (ids) => inner.removeGrants(ids),
    }
    return { records, state, inner }
  }

  it("leaves no grant, in memory or on disk, when the answer it was made for fails", () => {
    const { records, inner } = flaky()
    const { messaging, told } = setup(undefined, undefined, records)
    expect(() =>
      messaging.grants.make(
        {
          ...here,
          workspaceSessionId: sessionId,
          holder: { kind: "team", lead: "sable", withLead: false },
          presets: [],
          commands: [{ argv: ["make"], rest: false }],
          repos: [],
          entryId: randomUUID(),
          proposedBy: "sable",
          lifetime: "until-done",
        },
        () => {
          throw new Error("answer not saved")
        },
      ),
    ).toThrow(/answer not saved/)
    expect(inner.grants()).toEqual([])
    expect(messaging.grants.list()).toEqual([])
    expect(told("F")).toEqual([])
    // A grant whose answer stands is written after it.
    const order: string[] = []
    const kept = records.saveGrant
    records.saveGrant = (grant) => {
      order.push("saved")
      kept(grant)
    }
    messaging.grants.make(
      {
        ...here,
        workspaceSessionId: sessionId,
        holder: { kind: "team", lead: "sable", withLead: false },
        presets: [],
        commands: [{ argv: ["make"], rest: false }],
        repos: [],
        entryId: randomUUID(),
        proposedBy: "sable",
        lifetime: "until-done",
      },
      () => order.push("answered"),
    )
    expect(order).toEqual(["answered", "saved"])
  })

  it("never throws once the answer stands: a notice that can't be queued leaves a live grant, told later", () => {
    const { messaging, told, arrive } = setup()
    const notice = vi.spyOn(messaging["relays"], "grantNotice").mockImplementation(() => {
      throw new Error("store full")
    })
    let committed = false
    const grant = messaging.grants.make(
      {
        ...here,
        workspaceSessionId: sessionId,
        holder: { kind: "team", lead: "sable", withLead: false },
        presets: ["push"],
        commands: [],
        repos: [{ url: "github.com/acme/shop", defaultBranch: "main", defaultFrom: "github" }],
        entryId: randomUUID(),
        proposedBy: "sable",
        lifetime: "until-done",
      },
      () => void (committed = true),
    )
    expect(committed).toBe(true)
    expect(messaging.grants.covering("F").map((each) => each.id)).toEqual([grant.id])
    expect(told("F")).toEqual([])
    // The next change of who is covered tells it.
    notice.mockRestore()
    arrive("N", "newt", "sable")
    expect(told("F")).toHaveLength(1)
    expect(told("N")).toHaveLength(1)
  })

  it("refuses the person's end when it can't be written, and the grant goes on as it was", () => {
    const { records, state, inner } = flaky()
    const { messaging, make } = setup(undefined, undefined, records)
    const grant = make()
    state.down = true
    expect(() => messaging.grants.revoke(grant.id)).toThrow(/could not save/)
    expect(messaging.grants.covering("F")).toHaveLength(1)
    expect(inner.grants()[0]).toMatchObject({ revokedAt: null })
    state.down = false
    messaging.grants.revoke(grant.id)
    expect(messaging.grants.covering("F")).toEqual([])
    expect(inner.grants()[0]?.revokedAt).not.toBeNull()
  })

  it("ends in memory what it can't write at once, and writes it at the next sweep or close", () => {
    const { records, state, inner } = flaky()
    const { messaging, make } = setup(undefined, undefined, records)
    const grant = make()
    const alone = make({ lifetime: "hour" })
    state.down = true
    messaging.grants.coverageEnds("F", "done")
    expect(messaging.grants.covering("F")).toEqual([])
    expect(inner.grants().find((each) => each.id === grant.id)?.ended).toEqual([])
    messaging.grants.sweep()
    expect(inner.grants().find((each) => each.id === grant.id)?.ended).toEqual([])
    state.down = false
    messaging.grants.sweep()
    expect(inner.grants().find((each) => each.id === grant.id)?.ended).toHaveLength(1)
    expect(inner.grants().find((each) => each.id === alone.id)?.ended).toHaveLength(1)
    // Written at close when no sweep came.
    const later = make()
    state.down = true
    messaging.grants.coverageEnds("F", "done")
    expect(inner.grants().find((each) => each.id === later.id)?.ended).toEqual([])
    state.down = false
    messaging.grants.close()
    expect(inner.grants().find((each) => each.id === later.id)?.ended).toHaveLength(1)
  })

  it("tries a write twice before giving up", () => {
    const { records, state } = flaky()
    let failures = 1
    const saveGrant = records.saveGrant
    records.saveGrant = (grant) => {
      if (failures-- > 0) throw new Error("busy")
      saveGrant(grant)
    }
    const { messaging, make } = setup(undefined, undefined, records)
    const grant = make()
    expect(state.writes).toBe(1)
    failures = 1
    messaging.grants.revoke(grant.id)
    expect(messaging.grants.list()).toEqual([])
    expect(state.writes).toBe(2)
  })
})

describe("the clock a grant is judged by", () => {
  it("is held to monotonic time too: a step back of the wall clock does not stretch an hour grant", () => {
    const clock = { at: 1_000_000, mono: 0 }
    const { messaging, make } = setup(undefined, clock)
    make({ lifetime: "hour" })
    clock.at += hour / 2
    clock.mono += hour / 2
    expect(messaging.grants.covering("F")).toHaveLength(1)
    // The wall clock is set back an hour; thirty minutes later the grant's hour is up.
    clock.at -= hour
    expect(messaging.grants.covering("F")).toHaveLength(1)
    clock.at += hour / 2 + 1
    clock.mono += hour / 2 + 1
    expect(messaging.grants.covering("F")).toEqual([])
  })

  it("keeps the wall clock's times as they are, so a jump forward and back, then a restart, does not outlive the hour", () => {
    const clock = { at: 1_000_000, mono: 0 }
    const records = memoryGrants()
    const first = setup(undefined, clock, records)
    const grant = first.make({ lifetime: "hour" })
    expect(grant.endsAt).toBe(1_000_000 + hour)
    const real = { at: clock.at }
    // Twenty minutes pass; the wall clock jumps two hours forward and then back an hour and a half.
    for (const step of [20 * 60_000, 2 * hour, -1.5 * hour]) {
      clock.at += step
      first.messaging.grants.activity("F")
      first.messaging.grants.sweep()
    }
    clock.mono += 20 * 60_000
    // Nothing saved is skewed.
    expect(records.grants()[0]).toMatchObject({ madeAt: grant.madeAt, endsAt: grant.endsAt })
    first.messaging.close()
    // The runner restarts at the real time, an hour and a minute after the grant was made.
    clock.at = real.at + hour + 60_000
    const second = setup(undefined, clock, records)
    expect(second.messaging.grants.list()).toEqual([])
  })
})

describe("a quiet notice that a grant ended", () => {
  it("is no time held, as it rings nobody and waits for the next prompt", () => {
    const { messaging, make, told, clock } = setup()
    make()
    // The grant's own notice is delivered; the done's quiet one is all that waits.
    for (const notice of told("F")) messaging["store"].gone(notice, "terminal-closed")
    messaging.grants.coverageEnds("F", "done")
    const live = messaging["sessions"].get("F")!
    live.idleSince = clock.at
    clock.at += hour
    expect(told("F").some(isQuiet)).toBe(true)
    expect(messaging["holds"].oldestHeld(live)).toBeNull()
  })
})
