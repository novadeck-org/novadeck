/** One call a client owns while it runs, which the client's release marks released. */
export type Pending = { released: boolean }

/**
 * The calls each client has running (a create, an attach, a restore), so that a client that
 * lets go of its terminals meanwhile marks each released, and the call gives back what it
 * made instead of keeping it for nobody.
 */
export class PendingOwners {
  private readonly owners = new Map<string, Set<Pending>>()

  /** A call `ownerId` starts, released once it lets go. */
  add(ownerId: string): Pending {
    const pending = { released: false }
    const entries = this.owners.get(ownerId) ?? new Set<Pending>()
    entries.add(pending)
    this.owners.set(ownerId, entries)
    return pending
  }

  /** The call ended, released or not. */
  complete(ownerId: string, pending: Pending): void {
    const entries = this.owners.get(ownerId)
    entries?.delete(pending)
    if (entries?.size === 0) this.owners.delete(ownerId)
  }

  /** `ownerId` let go: each of its running calls is released. */
  release(ownerId: string): void {
    for (const pending of this.owners.get(ownerId) ?? []) pending.released = true
  }

  clear(): void {
    this.owners.clear()
  }
}
