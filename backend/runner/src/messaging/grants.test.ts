import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Grant } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { storeWith } from "../testing/workspace.js"
import type { WorkspaceStore } from "../workspaces/store.js"
import { maxGrantMs, type MakeGrant } from "./grants.js"
import { wrap, wrapGrants } from "./messages.js"
import { Messaging } from "./messaging.js"

const projectId = randomUUID()
const sessionId = randomUUID()
const here = { projectId, sessionId }
const hour = 3_600_000

// A lead (sable), its teammate fox, a peer owl nobody leads, and elk in another session.
const setup = (store?: WorkspaceStore, clock = { at: 1_000_000 }) => {
  const messaging = new Messaging({
    now: () => clock.at,
    restoreMs: 0,
    sweepMs: 0,
    waitsMs: 0,
    grantsMs: 0,
    ...(store && { records: store, grants: store }),
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
      hours: 8,
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
    // The shell exits first: the live entry goes, the grants stay.
    messaging.unregister("L")
    expect(messaging.grants.list()).toHaveLength(2)
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
  it("is cut to a day, and over when its time is up", () => {
    const { messaging, make, clock } = setup()
    const grant = make({ hours: 100 })
    expect(grant.endsAt - grant.madeAt).toBe(maxGrantMs)
    clock.at += maxGrantMs - 1
    expect(messaging.grants.covering("F")).toHaveLength(1)
    clock.at += 1
    expect(messaging.grants.covering("F")).toEqual([])
    expect(messaging.grants.list()).toEqual([])
  })

  it("tells the covered terminals when it ends by time, once, and by revoke", () => {
    const { messaging, make, told, clock } = setup()
    const first = make({ hours: 1 })
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
    const live = wrap(
      [message!],
      () => false,
      "Ab3dEf9Z",
      "PersonMk",
      {},
      {
        grants: (id) => messaging.grants.get(id),
      },
    )
    expect(live).toContain(`<grant id="${grant.id}" person="PersonMk"`)
    messaging.grants.revoke(grant.id)
    const ended = wrap(
      [message!],
      () => false,
      "Ab3dEf9Z",
      "PersonMk",
      {},
      {
        grants: (id) => messaging.grants.get(id),
      },
    )
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
      const kept = first.make({ hours: 8 })
      const revoked = first.make()
      const lapsed = first.make({ hours: 1 })
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
