import type { SQLTagStore } from "node:sqlite"

/** A device as the store keeps it: the hash of its secret, never the secret. */
export type DeviceRecord = {
  readonly id: string
  readonly name: string
  readonly secretHash: Uint8Array
  readonly createdAt: number
  readonly lastSeenAt: number | null
  readonly expiresAt: number | null
  readonly revokedAt: number | null
}

/** A device as listed: all but its hash. */
export type ListedDevice = Omit<DeviceRecord, "secretHash" | "expiresAt" | "revokedAt">

/** The devices table (`devices` in the workspace schema), over the store's queries. */
export class DeviceRecords {
  constructor(private readonly queries: SQLTagStore) {}

  /** Keeps a new device; one with no `expiresAt`, as every device yet, never expires. */
  add(
    device: Pick<DeviceRecord, "id" | "name" | "secretHash" | "createdAt"> &
      Partial<Pick<DeviceRecord, "expiresAt">>,
  ): void {
    void this.queries.run`
      INSERT INTO devices (id, name, secret_hash, created_at, expires_at)
      VALUES (${device.id}, ${device.name}, ${device.secretHash}, ${device.createdAt},
        ${device.expiresAt ?? null})`
  }

  /** The device with `id`, revoked or not. */
  find(id: string): DeviceRecord | undefined {
    return this.queries.get`
      SELECT id, name, secret_hash AS secretHash, created_at AS createdAt,
        last_seen_at AS lastSeenAt, expires_at AS expiresAt, revoked_at AS revokedAt
      FROM devices WHERE id = ${id}` as DeviceRecord | undefined
  }

  /** The devices not revoked, oldest first. */
  active(): ListedDevice[] {
    return this.queries.all`
      SELECT id, name, created_at AS createdAt, last_seen_at AS lastSeenAt
      FROM devices WHERE revoked_at IS NULL ORDER BY created_at, rowid` as ListedDevice[]
  }

  /** How many devices are not revoked. */
  count(): number {
    const row = this.queries.get`SELECT count(*) AS count FROM devices WHERE revoked_at IS NULL`
    return Number((row as { count: number }).count)
  }

  seen(id: string, at: number): void {
    void this.queries.run`UPDATE devices SET last_seen_at = ${at} WHERE id = ${id}`
  }

  /** Revokes the device, keeping its row; resolves whether it was one not revoked yet. */
  revoke(id: string, at: number): boolean {
    const { changes } = this.queries.run`
      UPDATE devices SET revoked_at = ${at} WHERE id = ${id} AND revoked_at IS NULL`
    return Number(changes) > 0
  }
}
