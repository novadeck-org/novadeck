import type { Log } from "@novadeck/log"
import { maxDevices, type Device, type MintedDevice } from "@novadeck/protocol"
import type { Session, Sessions, Verdict } from "@novadeck/wire/server"

import { DomainError } from "../errors.js"
import { logs } from "../log.js"
import { mintCredential, proves, readCredential, secretHash } from "./credential.js"
import type { DeviceRecords } from "./records.js"

/**
 * The runner's devices: each has a credential of its own beside the owner's token, which
 * proves it at the handshake and is revoked on its own. The sessions are given once they
 * exist, as they serve the router these devices are part of.
 */
export class Devices {
  private sessions: Pick<Sessions, "revoke" | "connected"> | undefined
  private readonly log: Log
  private readonly now: () => number

  constructor(
    private readonly records: DeviceRecords,
    options: { readonly now?: () => number; readonly log?: Log } = {},
  ) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? logs.for("devices")
  }

  /** The sessions whose devices these are: revoking one ends them, and listing asks them. */
  serve(sessions: Pick<Sessions, "revoke" | "connected">): void {
    this.sessions = sessions
  }

  /**
   * What a handshake's token proves of a device: the device, a refusal with why (`revoked`,
   * `expired`) to one that proves its credential still, `false` to one that doesn't, or
   * `undefined` for a token that isn't a device's credential at all.
   */
  verify(token: string | undefined): Verdict | undefined {
    const credential = readCredential(token)
    if (credential === undefined) return undefined
    const record = this.records.find(credential.id)
    if (!proves(credential, record?.secretHash) || record === undefined) {
      // Only an id the runner has is worth a line: a guessed one is noise.
      if (record !== undefined)
        this.log.warn("device.refused", "A device's credential didn't prove itself.", {
          data: { device: record.id },
        })
      return false
    }
    const now = this.now()
    const reason =
      record.revokedAt !== null
        ? "revoked"
        : record.expiresAt !== null && record.expiresAt <= now
          ? "expired"
          : undefined
    if (reason !== undefined) {
      this.log.info("device.refused", "A device's credential is no longer good.", {
        data: { device: record.id, reason },
      })
      return { refused: reason }
    }
    this.records.seen(record.id, now)
    return { device: { id: record.id, name: record.name } }
  }

  /** Notes when a device's session ended, as when it was last seen. */
  ended(session: Session): void {
    if (session.device !== undefined) this.records.seen(session.device.id, this.now())
  }

  /** Gives a new device its credential, which is answered once and kept only as a hash. */
  mint(name: string, by: Session): MintedDevice {
    owner(by, "Only the owner's connection can add a device.")
    if (this.records.count() >= maxDevices)
      throw new DomainError("CONFLICT", `The runner has ${maxDevices} devices; revoke one first.`)
    const credential = mintCredential()
    const createdAt = this.now()
    this.records.add({ id: credential.id, name, secretHash: secretHash(credential), createdAt })
    this.log.info("device.minted", "A device was given a credential.", {
      data: { device: credential.id, name },
    })
    return {
      device: { id: credential.id, name, createdAt, lastSeenAt: null, connected: false },
      credential: credential.token,
    }
  }

  /** The devices not revoked, oldest first, and whether each is connected now. */
  list(): Device[] {
    return this.records
      .active()
      .map((device) => ({ ...device, connected: this.sessions?.connected(device.id) ?? false }))
  }

  /**
   * Revokes a device's credential and ends its sessions. The owner may revoke any device, a
   * device only itself.
   */
  revoke(id: string, by: Session): void {
    if (by.device !== undefined && by.device.id !== id)
      throw new DomainError("FORBIDDEN", "A device can revoke only itself.")
    if (!this.records.revoke(id, this.now()))
      throw new DomainError("NOT_FOUND", "The runner has no such device.")
    this.log.info("device.revoked", "A device's credential was revoked.", {
      data: { device: id, by: by.device?.id ?? null },
    })
    this.sessions?.revoke(id)
  }
}

const owner = (session: Session, message: string): void => {
  if (session.device !== undefined) throw new DomainError("FORBIDDEN", message)
}
