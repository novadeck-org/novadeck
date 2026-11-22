import type { Log } from "@novadeck/log"
import { maxDevices } from "@novadeck/protocol"
import type { Session } from "@novadeck/wire/server"

import { describe, expect, it } from "../test.js"
import { WorkspaceStore } from "../workspaces/store.js"
import { mintCredential, proves, readCredential, secretHash } from "./credential.js"
import { Devices } from "./devices.js"

// A log that keeps every line it is given, whole, to check no secret is in one.
const keptLog = () => {
  const lines: string[] = []
  const write =
    (level: string): Log[keyof Log] =>
    (...line) =>
      void lines.push(`${level} ${JSON.stringify(line)}`)
  const log: Log = {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    fatal: write("fatal"),
  }
  return { lines, log }
}

const ownerSession = { device: undefined } as Session
const sessionOf = (id: string) => ({ device: { id, name: "Device" } }) as Session

const setUp = () => {
  const store = new WorkspaceStore()
  let at = 1_000
  const { lines, log } = keptLog()
  const revoked: string[] = []
  const live = new Set<string>()
  const devices = new Devices(store.devices, { now: () => at, log })
  devices.serve({ revoke: (id) => void revoked.push(id), connected: (id) => live.has(id) })
  return {
    store,
    devices,
    lines,
    revoked,
    live,
    later: (ms: number) => {
      at += ms
    },
  }
}

describe("a device's credential", () => {
  it("is ndd_, a 22-character id and a 43-character secret, fresh each time", () => {
    const first = mintCredential()
    const second = mintCredential()
    expect(first.token).toMatch(/^ndd_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/)
    expect(first.id).not.toBe(second.id)
    expect(first.secret).not.toBe(second.secret)
    // An id or a secret may hold the separator itself: the parts are read by length.
    expect(readCredential(first.token)).toEqual({ id: first.id, secret: first.secret })
  })

  it("reads no other token as one, such as the owner's", () => {
    for (const token of [
      undefined,
      "a".repeat(64),
      `ndd_${"a".repeat(22)}_${"b".repeat(42)}`,
      `ndd_${"a".repeat(22)}_${"b".repeat(43)}x`,
      `ndd_${"a".repeat(22)}_${"b".repeat(42)}=`,
    ])
      expect(readCredential(token)).toBeUndefined()
  })

  it("is proved only by its own secret, of its own id, against a hash of 32 bytes", () => {
    const credential = mintCredential()
    const kept = secretHash(credential)
    expect(kept.byteLength).toBe(32)
    expect(proves(credential, kept)).toBe(true)
    expect(proves({ ...credential, secret: mintCredential().secret }, kept)).toBe(false)
    expect(proves({ ...credential, id: mintCredential().id }, kept)).toBe(false)
    expect(proves(credential, undefined)).toBe(false)
  })
})

describe("the runner's devices", () => {
  it("gives a device a credential once, keeps only its hash, and knows it by it", () => {
    const { store, devices } = setUp()
    const { device, credential } = devices.mint("Phone", ownerSession)
    expect(device).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      name: "Phone",
      createdAt: 1_000,
      lastSeenAt: null,
      connected: false,
    })
    const kept = store.devices.find(device.id)
    expect(Buffer.from(kept!.secretHash).toString("hex")).not.toContain(
      Buffer.from(readCredential(credential)!.secret).toString("hex"),
    )
    expect(devices.verify(credential)).toEqual({ device: { id: device.id, name: "Phone" } })
  })

  it("lets only the owner add a device, up to the limit", () => {
    const { devices } = setUp()
    const { device } = devices.mint("Laptop", ownerSession)
    expect(() => devices.mint("Tablet", sessionOf(device.id))).toThrow(
      expect.objectContaining({ code: "FORBIDDEN" }),
    )
    for (let count = 1; count < maxDevices; count += 1)
      devices.mint(`Device ${count}`, ownerSession)
    expect(() => devices.mint("One more", ownerSession)).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    )
  })

  it("lists the devices not revoked, oldest first, when each was last seen, and whether it is connected", () => {
    const { devices, live, later } = setUp()
    const laptop = devices.mint("Laptop", ownerSession)
    later(5)
    const phone = devices.mint("Phone", ownerSession)
    later(5)
    devices.verify(phone.credential)
    live.add(phone.device.id)
    expect(devices.list()).toEqual([
      { ...laptop.device, connected: false },
      { ...phone.device, lastSeenAt: 1_010, connected: true },
    ])
    later(5)
    devices.ended(sessionOf(phone.device.id))
    expect(devices.list()[1]?.lastSeenAt).toBe(1_015)
    devices.revoke(laptop.device.id, ownerSession)
    expect(devices.list().map(({ name }) => name)).toEqual(["Phone"])
  })

  it("revokes any device for the owner, and only itself for a device, ending its sessions", () => {
    const { devices, revoked } = setUp()
    const laptop = devices.mint("Laptop", ownerSession)
    const phone = devices.mint("Phone", ownerSession)
    expect(() => devices.revoke(laptop.device.id, sessionOf(phone.device.id))).toThrow(
      expect.objectContaining({ code: "FORBIDDEN" }),
    )
    devices.revoke(phone.device.id, sessionOf(phone.device.id))
    devices.revoke(laptop.device.id, ownerSession)
    expect(revoked).toEqual([phone.device.id, laptop.device.id])
    // Revoked already, or never one: no device to revoke.
    expect(() => devices.revoke(laptop.device.id, ownerSession)).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    expect(() => devices.revoke(mintCredential().id, ownerSession)).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
  })

  it("tells a revoked device so, but only one that still proves its credential", () => {
    const { devices } = setUp()
    const { device, credential } = devices.mint("Phone", ownerSession)
    devices.revoke(device.id, ownerSession)
    expect(devices.verify(credential)).toEqual({ refused: "revoked" })
    const guessed = `ndd_${device.id}_${mintCredential().secret}`
    expect(devices.verify(guessed)).toBe(false)
    expect(devices.verify(mintCredential().token)).toBe(false)
    // Not a device's credential at all, as the owner's token: for the owner check to judge.
    expect(devices.verify("a".repeat(64))).toBeUndefined()
  })

  it("tells a device whose credential expired so", () => {
    const { store, devices, later } = setUp()
    // No credential expires yet; pairing may give ones that do, with the column kept for it.
    const credential = mintCredential()
    store.devices.add({
      id: credential.id,
      name: "Guest",
      secretHash: secretHash(credential),
      createdAt: 1_000,
      expiresAt: 1_010,
    })
    expect(devices.verify(credential.token)).toEqual({
      device: { id: credential.id, name: "Guest" },
    })
    later(10)
    expect(devices.verify(credential.token)).toEqual({ refused: "expired" })
  })

  it("lets a device in even when the store can't note when it was seen", () => {
    const { store } = setUp()
    const failing = Object.assign(Object.create(store.devices) as typeof store.devices, {
      seen: () => {
        throw new Error("database or disk is full")
      },
    })
    const devices = new Devices(failing, { now: () => 1_000, log: keptLog().log })
    const { device, credential } = devices.mint("Phone", ownerSession)
    expect(devices.verify(credential)).toEqual({ device: { id: device.id, name: "Phone" } })
  })

  it("logs devices by their id and name, never a credential or its secret", () => {
    const { devices, lines } = setUp()
    const { device, credential } = devices.mint("Phone", ownerSession)
    devices.verify(credential)
    devices.verify(`ndd_${device.id}_${mintCredential().secret}`)
    devices.revoke(device.id, ownerSession)
    devices.verify(credential)
    const { secret } = readCredential(credential)!
    expect(lines.some((line) => line.includes(device.id))).toBe(true)
    expect(lines.filter((line) => line.includes(secret) || line.includes(credential))).toEqual([])
    expect(lines.map((line) => /"(device\.[a-z]+)"/.exec(line)?.[1])).toEqual([
      "device.minted",
      "device.refused",
      "device.revoked",
      "device.refused",
    ])
  })
})
