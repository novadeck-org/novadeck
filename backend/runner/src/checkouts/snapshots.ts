import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import {
  commonDir,
  privateObjects,
  repack,
  snapshotTree,
  type Held,
  type Taken,
} from "./repository.js"

// One service that takes checkouts' working trees as trees, for the Changes panel (works) and
// the changes item (layers) alike, so a checkout both read is taken once, not once for each:
// a snapshot younger than `freshMs` serves whoever asks next. Each checkout has a private index
// file; each repository one private object folder (its worktrees' snapshots are merged with
// each other), which what snapshots and merges in memory make goes to, never the person's own
// store. A folder that took many snapshots is rebuilt with only the trees kept for its
// checkouts (see `keep`), once nothing is using it.

/** A checkout's working tree as a tree, when it was taken, and the rebuild of its folder it is of. */
export type Snapshot = Taken & {
  readonly at: number
  /** Counts its object folder's rebuilds: a later one may have dropped what was made before. */
  readonly generation: number
}

/** What a use of a checkout can do with it. */
export type Checkout = {
  readonly root: string
  /**
   * Its working tree as a tree: the last one taken where it is younger than `freshMs` (and
   * `fresh` is not asked), else one taken now. Undefined where it can't be taken.
   */
  readonly take: (fresh?: boolean) => Promise<Snapshot | undefined>
  /** The last snapshot taken, while its objects are kept. */
  readonly latest: () => Snapshot | undefined
  /** The environment whose git runs write to the repository's object folder and read from it. */
  readonly objects: () => Promise<NodeJS.ProcessEnv | undefined>
}

export type SnapshotsOptions = {
  /** Which untracked files may hold secrets, asked at each snapshot: those are only named. */
  readonly held: () => Held
  /**
   * Where each repository's object folder is kept across runs, as the trees the person last
   * read works as are in them; without, in a folder of the run's own.
   */
  readonly home?: string
  /** How many snapshots a repository's object folder takes before it is rebuilt. */
  readonly repackAfter?: number
  /** How long a snapshot serves before another is taken, in milliseconds. */
  readonly freshMs?: number
  readonly now?: () => number
}

/** A repository's object folder, and who is using it. */
type Folder = {
  readonly path: string
  readonly roots: Set<string>
  written: number
  users: number
  generation: number
  rebuilding: Promise<void> | undefined
}

const repackAfter = 300
const freshMs = 1500
// How long closing waits for the uses under way.
const closeWaitMs = 2000

/** Thrown by a use asked for once the service is closed. */
export class SnapshotsClosed extends Error {
  constructor() {
    super("Novadeck is closing.")
  }
}

const hashed = (text: string): string => createHash("sha1").update(text).digest("hex").slice(0, 16)

export class Snapshots {
  private temporary: Promise<string> | undefined
  private closed = false
  /** Each checkout's uses, one after another: they share its private index. */
  private readonly queues = new Map<string, Promise<void>>()
  private readonly folders = new Map<string, Folder>()
  /** Each checkout's object folder, found once. */
  private readonly placed = new Map<string, Promise<Folder>>()
  private readonly taken = new Map<string, Snapshot>()
  private readonly envs = new Map<string, NodeJS.ProcessEnv>()
  private readonly keeps = new Set<(root: string) => readonly string[]>()
  private readonly now: () => number

  constructor(private readonly options: SnapshotsOptions) {
    this.now = options.now ?? Date.now
  }

  /**
   * Runs `run` with the checkout, after its uses before (they share its index), while its
   * repository's folder is not being rebuilt. Rejects with `SnapshotsClosed` once closed.
   */
  use<T>(root: string, run: (checkout: Checkout) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new SnapshotsClosed())
    const before = this.queues.get(root) ?? Promise.resolve()
    const next = before.then(async () => {
      if (this.closed) throw new SnapshotsClosed()
      const folder = await this.folderOf(root)
      // A folder due to be rebuilt is rebuilt first, once nothing is using it.
      // eslint-disable-next-line no-await-in-loop -- Waits for each rebuild before looking again.
      while (folder.rebuilding || this.tidy(root, folder)) await folder.rebuilding
      folder.users += 1
      try {
        return await run(this.checkout(root, folder))
      } finally {
        folder.users -= 1
      }
    })
    const tail = next.then(
      () => {},
      () => {},
    )
    this.queues.set(root, tail)
    void tail.then(() => {
      if (this.queues.get(root) === tail) this.queues.delete(root)
    })
    return next
  }

  /** Names the trees a folder's rebuild keeps for a checkout (the tree a work was last read as). */
  keep(trees: (root: string) => readonly string[]): void {
    this.keeps.add(trees)
  }

  /** Lets go of a checkout no one is in: its index file and its last snapshot. */
  forget(root: string): void {
    if (this.closed) return
    void this.use(root, async () => {
      this.taken.delete(root)
      const index = await this.indexOf(root)
      await rm(index, { force: true })
      await rm(`${index}.lock`, { force: true })
    }).catch(() => {})
  }

  /** Ends the service once the uses under way are done (or a moment has passed); the run's folder goes. */
  async close(): Promise<void> {
    this.closed = true
    await Promise.race([Promise.all(this.queues.values()), sleep(closeWaitMs)])
    await Promise.all([...this.folders.values()].map((folder) => folder.rebuilding))
    const folder = await this.temporary?.catch(() => undefined)
    this.temporary = undefined
    if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {})
  }

  private checkout(root: string, folder: Folder): Checkout {
    return {
      root,
      take: (fresh = false) => this.take(root, folder, fresh),
      latest: () => this.taken.get(root),
      objects: () => this.objectsOf(root, folder),
    }
  }

  private async take(root: string, folder: Folder, fresh: boolean): Promise<Snapshot | undefined> {
    const last = this.taken.get(root)
    if (!fresh && last && this.now() - last.at < (this.options.freshMs ?? freshMs)) return last
    if (this.closed) return undefined
    const at = this.now()
    folder.written += 1
    const taken = await snapshotTree(
      root,
      await this.indexOf(root),
      folder.path,
      this.options.held(),
    )
    if (!taken) return undefined
    const snapshot = { ...taken, at, generation: folder.generation }
    this.taken.set(root, snapshot)
    return snapshot
  }

  private async objectsOf(root: string, folder: Folder): Promise<NodeJS.ProcessEnv | undefined> {
    const known = this.envs.get(root)
    if (known) return known
    const env = await privateObjects(root, folder.path)
    if (env) this.envs.set(root, env)
    return env
  }

  /** The run's own folder: the index files, and the object folders where nothing keeps them. */
  private run(): Promise<string> {
    this.temporary ??= mkdtemp(join(tmpdir(), "novadeck-snapshots-"))
    return this.temporary
  }

  private async indexOf(root: string): Promise<string> {
    return join(await this.run(), hashed(root))
  }

  /** The object folder of the checkout's repository, one for all of its worktrees. */
  private folderOf(root: string): Promise<Folder> {
    let found = this.placed.get(root)
    if (!found) {
      found = (async () => {
        const common = (await commonDir(root)) ?? root
        const name = hashed(common)
        const path =
          this.options.home === undefined
            ? join(await this.run(), `objects-${name}`)
            : join(this.options.home, name)
        const folder = this.folders.get(path) ?? {
          path,
          roots: new Set<string>(),
          written: 0,
          users: 0,
          generation: 0,
          rebuilding: undefined,
        }
        folder.roots.add(root)
        this.folders.set(path, folder)
        return folder
      })()
      this.placed.set(root, found)
      // Not found (git slow): asked again next time.
      found.catch(() => this.placed.delete(root))
    }
    return found
  }

  /**
   * Starts rebuilding a folder that took many snapshots where no use of it is running, keeping
   * the trees its checkouts keep; the uses asked for meanwhile wait for it. Whether it started.
   */
  private tidy(root: string, folder: Folder): boolean {
    if (folder.users > 0 || folder.rebuilding || this.closed) return false
    if (folder.written < (this.options.repackAfter ?? repackAfter)) return false
    const roots = [...folder.roots]
    const trees = [
      ...new Set(roots.flatMap((each) => [...this.keeps].flatMap((keep) => keep(each)))),
    ]
    folder.rebuilding = (async () => {
      try {
        // Where it can't be rebuilt it stays as it is, and is tried again as many snapshots later.
        if (await repack(root, folder.path, trees)) {
          folder.generation += 1
          for (const each of roots) this.taken.delete(each)
        }
      } catch {
        // As above.
      } finally {
        folder.written = 0
        folder.rebuilding = undefined
      }
    })()
    return true
  }
}
