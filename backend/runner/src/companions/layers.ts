import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import {
  companionLimits,
  maxChangeLayers,
  maxChangedFiles,
  maxChangeSideBytes,
  maxChangesBytes,
  maxLayerFiles,
  uncommittedLayer,
  type ChangedFile,
  type ChangeFileDiff,
  type ChangeLayer,
  type ChangeRange,
  type ItemContent,
} from "@novadeck/protocol"

import { ellipsized } from "../text.js"
import {
  mainBranch,
  mergeBase,
  privateObjects,
  snapshotTree,
  type Taken,
} from "../works/repository.js"
import {
  diffFlags,
  gitScope,
  displayed,
  emptyTrees,
  failure,
  git,
  metaBytes,
  parseDiff,
  parseListing,
  patchBytes,
  reasonOf,
  repositoryOf,
  samePlace,
  type ChangeFailure,
  type Entry,
  type Run,
} from "./changes.js"
import { hashOf } from "./content.js"
import { secrets } from "./secrets.js"

// A change as layers: a checkout measured against its repository's main branch. The layers
// are its commits since the merge base with main, newest first, then, on top, the work not
// committed yet, which is the working tree (untracked files included, under the size limits
// of a snapshot) taken as a tree through a private index and a private object folder, so
// neither the person's index nor their object store is written. A file's diff is read when it
// is asked for, for the layers that were selected, which are always one range.

const small = { cap: 64 * 1024 }
// How many layers' files are listed at once.
const poolSize = 4
// How long closing waits for the reads under way, whose git runs it has ended.
const closeWaitMs = 2000
// How many snapshots a checkout's private objects take before they are emptied.
const pruneAfter = 120

/** A commit of the checkout since main, and the commit it is diffed against. */
type Commit = {
  readonly id: string
  readonly parent: string | undefined
  /** Its parents, the first the one it is checked out on: more than one makes it a merge. */
  readonly parents: readonly string[]
  readonly time: number
  readonly subject: string
}

/** A file as a layer's listing has it: git's entry, and the lines that only changed whitespace. */
type Listed = Entry & { readonly reindented: number }

/** The files two commits or trees differ by, once read: a commit's never change. */
const kept = new Map<string, readonly Listed[]>()
const keptMost = 400

const keep = (key: string, files: readonly Listed[]): void => {
  kept.delete(key)
  kept.set(key, files)
  for (const old of kept.keys()) {
    if (kept.size <= keptMost) break
    kept.delete(old)
  }
}

const printed = (run: Run): string => (run.ok ? run.out.trim() : "")

/** The empty tree of the repository's object format. */
const emptyTreeOf = async (root: string): Promise<string> => {
  const format = await git(root, ["rev-parse", "--show-object-format"], small)
  return format.ok && format.out.trim() === "sha256" ? emptyTrees.sha256 : emptyTrees.sha1
}

/** Maps with at most `size` runs at once, in order. */
const pooled = async <T, R>(
  items: readonly T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> => {
  const out: R[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    for (; next < items.length;) {
      const at = next
      next += 1
      // eslint-disable-next-line no-await-in-loop -- A worker takes one after another.
      out[at] = await run(items[at]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
  return out
}

/**
 * The files two commits or trees differ by, renames found, with the lines each added and
 * removed ignoring whitespace; the lines that only changed whitespace are `reindented`. `env`
 * says where a snapshot's objects are.
 */
const listDiff = async (
  root: string,
  from: string,
  to: string,
  env?: NodeJS.ProcessEnv,
  /** Whether the listing is kept: not where one end is a snapshot, a new tree every time. */
  store = env === undefined,
): Promise<readonly Listed[] | ChangeFailure> => {
  const key = `${root}\0${from}\0${to}`
  const known = kept.get(key)
  if (known) return known
  const limit = { cap: metaBytes, ...(env && { env }) }
  const [plain, quiet] = await Promise.all([
    git(root, [...diffFlags, "--raw", "--numstat", "-z", from, to, "--"], limit),
    git(root, [...diffFlags, "-w", "--raw", "--numstat", "-z", from, to, "--"], limit),
  ])
  if (!plain.ok) return failure("failed", reasonOf(plain, "read the changes"))
  if (!quiet.ok) return failure("failed", reasonOf(quiet, "read the changes"))
  const ignoring = new Map(parseListing(quiet.out).map((entry) => [entry.path, entry]))
  const files = parseListing(plain.out).map((entry): Listed => {
    const quieter = ignoring.get(entry.path)
    if (!quieter || entry.binary) return { ...entry, reindented: 0 }
    return {
      ...entry,
      added: quieter.added,
      removed: quieter.removed,
      reindented: Math.max(
        0,
        Math.min(entry.added - quieter.added, entry.removed - quieter.removed),
      ),
    }
  })
  if (store) keep(key, files)
  return files
}

/**
 * The commits from `since` (exclusive) to `head`, newest first, following first parents, at
 * most one more than a change carries (so that more can be told).
 */
const commitsSince = async (
  root: string,
  since: string,
  head: string,
): Promise<readonly Commit[] | ChangeFailure> => {
  const run = await git(
    root,
    [
      "log",
      "-z",
      "--first-parent",
      // A log setting that shows signatures would put gpg's words in what is read.
      "--no-show-signature",
      `--max-count=${maxChangeLayers + 1}`,
      "--format=%H%x1f%P%x1f%ct%x1f%s",
      `${since}..${head}`,
      "--",
    ],
    { cap: 4 * 1024 * 1024 },
  )
  if (!run.ok) return failure("failed", reasonOf(run, "read the commits"))
  return run.out
    .split("\0")
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [id = "", parents = "", time = "0", ...subject] = record.trim().split("\x1f")
      const list = parents.split(" ").filter(Boolean)
      return {
        id,
        parent: list[0],
        parents: list,
        time: Number(time) * 1000,
        // The subject is a paragraph of any length.
        subject: ellipsized(subject.join(" "), companionLimits.name),
      }
    })
}

/** Where a checkout stands: its HEAD, the name it is measured against and the commits between. */
type Standing = {
  readonly head: string | undefined
  readonly base: string
  /** Where it left main, which what is measured starts from; undefined where it has no main or common history. */
  readonly since: string | undefined
  /** Layers were left out: history cut short (a shallow clone) or past the bound. */
  readonly cut: boolean
  readonly commits: readonly Commit[]
}

const standing = async (root: string): Promise<Standing | ChangeFailure> => {
  const head = printed(await git(root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], small))
  if (!head)
    return {
      head: undefined,
      base: "HEAD (no commits yet)",
      since: undefined,
      cut: false,
      commits: [],
    }
  const main = await mainBranch(root)
  if (!main) return { head, base: "HEAD", since: undefined, cut: false, commits: [] }
  const since = await mergeBase(root, main.commit, head)
  // A main with no history in common (a shallow clone, say): there is nothing to measure from.
  if (!since)
    return {
      head,
      // The protocol carries a name this long; the name is cut to leave room for the note.
      base: `${ellipsized(main.name, 200)} (no common history)`,
      since: undefined,
      cut: false,
      commits: [],
    }
  const found = await commitsSince(root, since, head)
  if ("ok" in found) return found
  // A shallow repository's oldest commit has no parent to be diffed against: it is not a layer.
  const shallow =
    printed(await git(root, ["rev-parse", "--is-shallow-repository"], small)) === "true"
  const commits = shallow ? found.filter((commit) => commit.parent !== undefined) : found
  return { head, base: main.name, since, cut: commits.length < found.length, commits }
}

type Held = (path: string, oldPath: string | null) => boolean

/** The person's environment says where tools keep their logins; see `secrets`. */
const holder = (root: string, env: NodeJS.ProcessEnv | undefined): Held => {
  const held = secrets(env)
  return (path, oldPath) =>
    held(join(root, path)) || (oldPath !== null && held(join(root, oldPath)))
}

const fileOf = (entry: Listed, held: Held): ChangedFile => ({
  path: displayed(entry.path),
  oldPath: entry.oldPath === null ? null : displayed(entry.oldPath),
  status: entry.status,
  added: entry.added,
  removed: entry.removed,
  reindented: entry.reindented,
  binary: entry.binary,
  secret: held(entry.path, entry.oldPath),
})

const layerOf = (
  listed: readonly Listed[],
  held: Held,
  layer: Pick<ChangeLayer, "id" | "kind" | "subject" | "time" | "firstParent">,
  room: { left: number },
  skipped = false,
): ChangeLayer => {
  const take = Math.min(maxChangedFiles, listed.length, room.left)
  room.left -= take
  return {
    ...layer,
    added: listed.reduce((sum, entry) => sum + entry.added, 0),
    removed: listed.reduce((sum, entry) => sum + entry.removed, 0),
    files: listed.slice(0, take).map((entry) => fileOf(entry, held)),
    truncated: take < listed.length || skipped,
  }
}

/** A change as read, and what its item says of it. */
export type ReadLayers = {
  readonly content: ItemContent
  /** One line: the files the change differs from main by, and their lines. */
  readonly detail: string
  /** The checkout's folder named for an item. */
  readonly name: string
}

type Read = { readonly ok: true; readonly change: ReadLayers } | ChangeFailure
type ReadFile = { readonly ok: true; readonly diff: ChangeFileDiff } | ChangeFailure
type ReadRange = { readonly ok: true; readonly range: ChangeRange } | ChangeFailure
type RunOfFile = Omit<NonNullable<ChangeFileDiff["run"]>, "layers">

/** What a selection of layers spans: the commits or trees it runs between. */
type Span = {
  readonly from: string
  readonly to: string
  readonly layers: readonly string[]
  /** Where the objects of the snapshot and of merges made in memory are. */
  readonly env: NodeJS.ProcessEnv | undefined
  /** Whether the listing may be kept (no end of it is a snapshot). */
  readonly store: boolean
  /** Untracked files that may hold secrets, which a span to the snapshot lists by name. */
  readonly named: readonly Listed[]
}

/**
 * Reads checkouts' changes and files' diffs, one read at a time per checkout: each has a
 * private index and a folder for the objects a snapshot makes, in a folder made when first
 * needed, and two reads would write one file.
 */
export class LayerReader {
  private folder: Promise<string> | undefined
  private closed = false
  private mergeTree: Promise<boolean> | undefined
  private readonly stop = new AbortController()
  private readonly queues = new Map<string, Promise<void>>()
  /** Each checkout's last snapshot, which a file asked for next reads while HEAD stands. */
  private readonly taken = new Map<string, Taken>()
  /** Each checkout's environment for private objects. */
  private readonly envs = new Map<string, NodeJS.ProcessEnv>()
  /** How many snapshots each checkout's object folder has taken since it was emptied. */
  private readonly written = new Map<string, number>()

  constructor(
    private readonly environment: () => NodeJS.ProcessEnv | undefined,
    /** How many snapshots a checkout's objects take before they are emptied. */
    private readonly emptyAfter = pruneAfter,
    private readonly options: { readonly mergeTree?: boolean } = {},
  ) {}

  /** A checkout's layers as they are now. */
  read(root: string): Promise<Read> {
    return this.exclusive(root, () => this.layers(root))
  }

  /**
   * One file's diff for the layers selected, as one range from the oldest layer's parent to
   * the newest (layers between are taken in). Layers no longer there are left out; a file the
   * selection did not change has no run.
   */
  file(root: string, path: string, selected: readonly string[]): Promise<ReadFile> {
    return this.exclusive(root, () => this.diff(root, path, selected))
  }

  /** The files the layers selected changed as one range, with their lines as the range has them. */
  range(root: string, selected: readonly string[]): Promise<ReadRange> {
    return this.exclusive(root, () => this.listRange(root, selected))
  }

  /** Forgets the private indexes and objects once the reads in flight are done; nothing is read after. */
  async close(): Promise<void> {
    this.closed = true
    // The git runs under way are ended, and the reads waited for a moment (they fail as they
    // find this closed), so the folder goes with nothing writing to it.
    this.stop.abort()
    await Promise.race([Promise.all(this.queues.values()), sleep(closeWaitMs)])
    const folder = this.folder
    this.folder = undefined
    if (folder) await rm(await folder, { recursive: true, force: true }).catch(() => {})
  }

  private exclusive<T>(root: string, run: () => Promise<T>): Promise<T | ChangeFailure> {
    if (this.closed) return Promise.resolve(failure("failed", "Novadeck is closing."))
    const before = this.queues.get(root) ?? Promise.resolve()
    const next: Promise<T | ChangeFailure> = before.then(async (): Promise<T | ChangeFailure> => {
      if (this.closed) return failure("failed", "Novadeck is closing.")
      return gitScope.run(this.stop.signal, async () => {
        await this.tidy(root)
        return run()
      })
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

  /** The files made for a checkout, undefined once closed (nothing is made then). */
  private async place(root: string): Promise<{ index: string; objects: string } | undefined> {
    if (this.closed) return undefined
    this.folder ??= mkdtemp(join(tmpdir(), "novadeck-changes-"))
    const name = createHash("sha1").update(root).digest("hex").slice(0, 16)
    const folder = await this.folder
    // Closed while the folder was made: close removes it, and nothing is written to it.
    if (this.closed) return undefined
    return { index: join(folder, name), objects: join(folder, `${name}-objects`) }
  }

  /**
   * Empties a checkout's object folder once it has taken many snapshots (each leaves its
   * blobs and trees), as no read of it is in flight; what is read after makes what it needs.
   */
  private async tidy(root: string): Promise<void> {
    if ((this.written.get(root) ?? 0) < this.emptyAfter) return
    const placed = await this.place(root)
    if (!placed) return
    await rm(placed.objects, { recursive: true, force: true }).catch(() => {})
    this.written.set(root, 0)
    this.taken.delete(root)
    this.envs.delete(root)
  }

  /** The environment that makes objects in a checkout's private folder; undefined once closed. */
  private async objectsOf(root: string): Promise<NodeJS.ProcessEnv | undefined> {
    const known = this.envs.get(root)
    if (known) return known
    const placed = await this.place(root)
    const env = placed && (await privateObjects(root, placed.objects))
    if (env) this.envs.set(root, env)
    return env
  }

  /** The work not committed yet as a tree, taken now. */
  private async snapshot(root: string): Promise<Taken | undefined> {
    const placed = await this.place(root)
    if (!placed) return undefined
    this.written.set(root, (this.written.get(root) ?? 0) + 1)
    const taken = await snapshotTree(root, placed.index, placed.objects, this.environment())
    if (taken) this.taken.set(root, taken)
    return taken
  }

  /** Why the work not committed yet could not be taken. */
  private unsnapped(): ChangeFailure {
    return failure(
      "failed",
      this.closed ? "Novadeck is closing." : "Git couldn't read the work not committed yet.",
    )
  }

  /**
   * What a commit is diffed from: its parent; for a merge, the parent with main's work that
   * the merge holds merged in (see `startOf`), so a merge shows what it did itself: a branch
   * of the checkout's own it merged as its work, main's own changes as none.
   */
  private async fromOf(
    root: string,
    commit: Commit,
    since: string | undefined,
    empty: string,
    env: NodeJS.ProcessEnv,
    merges: boolean,
  ): Promise<string | ChangeFailure> {
    if (commit.parents.length < 2 || since === undefined || !merges) return commit.parent ?? empty
    const main = await mergeBase(root, since, commit.id)
    return startOf(root, commit.parent, main, empty, env)
  }

  /** Whether this git can merge in memory (2.38 and later); settled once. */
  private merges(): Promise<boolean> {
    return (this.mergeTree ??= (async () => this.options.mergeTree ?? (await canMergeTree()))())
  }

  private async layers(root: string): Promise<Read> {
    const where = await standing(root)
    if ("ok" in where) return where
    const { head, base, since, commits } = where
    const name = `Changes · ${basename(root)}`
    const held = holder(root, this.environment())
    const room = { left: maxLayerFiles }
    const taken = await this.snapshot(root)
    if (!taken) return this.unsnapped()
    const own = await this.objectsOf(root)
    if (!own) return this.unsnapped()
    const empty = await emptyTreeOf(root)
    const merges = await this.merges()
    const dirty = await listDiff(root, head ?? empty, taken.tree, taken.env)
    if ("ok" in dirty) return dirty
    const layers: ChangeLayer[] = [
      layerOf(
        [...dirty, ...named(taken)].toSorted(byPath),
        held,
        { id: uncommittedLayer, kind: "uncommitted", subject: "", time: null },
        room,
        taken.skipped,
      ),
    ]
    const shown = commits.slice(0, maxChangeLayers - 1)
    const lists = await pooled(shown, poolSize, async (commit) => {
      const from = await this.fromOf(root, commit, since, empty, own, merges)
      // A merge's own work is read with the objects the merge in memory made.
      return typeof from === "string" ? listDiff(root, from, commit.id, own, true) : from
    })
    let unread = false
    for (const [at, commit] of shown.entries()) {
      const listed = lists[at]!
      const layer = {
        id: commit.id,
        kind: "commit" as const,
        subject: commit.subject,
        time: commit.time,
        // Without a merge in memory it is shown against its first parent, and says so.
        ...(commit.parents.length > 1 && !merges && { firstParent: true }),
      }
      // A layer git could not list does not fail the change: it is shown with what is known.
      if ("ok" in listed) {
        unread = true
        layers.push({ ...layerOf([], held, layer, room), truncated: true })
      } else layers.push(layerOf(listed, held, layer, room))
    }
    const truncated =
      where.cut ||
      unread ||
      commits.length > shown.length ||
      layers.some((layer) => layer.truncated)
    const netList = await listDiff(root, since ?? head ?? empty, taken.tree, taken.env)
    const net = "ok" in netList ? netList : [...netList, ...named(taken)].toSorted(byPath)
    return {
      ok: true,
      change: this.made(
        base,
        layers,
        truncated,
        name,
        `${head ?? ""} ${taken.tree}`,
        net,
        held,
        root,
      ),
    }
  }

  private made(
    base: string,
    layers: ChangeLayer[],
    truncated: boolean,
    name: string,
    version: string,
    net: readonly Listed[] | ChangeFailure,
    held: Held,
    root: string,
  ): ReadLayers {
    // The change as a whole: what it differs from main by, not what its layers add up to. The
    // stamp follows the snapshot too, so a line edited with its counts unchanged is news.
    const files = "ok" in net ? undefined : net
    // Where git could not list it, the layers' own files stand in, a path once.
    const listed = files
      ? files.slice(0, maxChangedFiles).map((entry) => fileOf(entry, held))
      : [
          ...new Map(
            layers
              .toReversed()
              .flatMap((layer) => layer.files)
              .map((file) => [file.path, file]),
          ).values(),
        ].slice(0, maxChangedFiles)
    const cut = files ? files.length > maxChangedFiles : false
    const content = {
      kind: "changes" as const,
      root,
      base,
      layers,
      files: listed,
      truncated: truncated || cut,
    }
    const count = files
      ? files.length
      : new Set(layers.flatMap((layer) => layer.files.map((file) => file.path))).size
    const added = files
      ? files.reduce((sum, file) => sum + file.added, 0)
      : layers.reduce((sum, layer) => sum + layer.added, 0)
    const removed = files
      ? files.reduce((sum, file) => sum + file.removed, 0)
      : layers.reduce((sum, layer) => sum + layer.removed, 0)
    return {
      content: { state: "ready", stamp: hashOf(`${version}\n${JSON.stringify(content)}`), content },
      detail: `${count} ${count === 1 ? "file" : "files"} · +${added} −${removed}`,
      name,
    }
  }

  /** The commits or trees a selection spans, or none where it selects nothing there is. */
  private async span(
    root: string,
    selected: readonly string[],
  ): Promise<Span | undefined | ChangeFailure> {
    const where = await standing(root)
    if ("ok" in where) return where
    const { head, since, commits } = where
    const wanted = new Set(selected)
    const shown = commits.slice(0, maxChangeLayers - 1)
    // Every layer there is, newest first, as the list shows them.
    const all = [uncommittedLayer, ...shown.map((commit) => commit.id)]
    const at = all.flatMap((id, place) => (wanted.has(id) ? [place] : []))
    if (at.length === 0) return undefined
    const newest = at[0]!
    const oldest = at.at(-1)!
    const layers = all.slice(newest, oldest + 1)
    const empty = await emptyTreeOf(root)
    const own = await this.objectsOf(root)
    if (!own) return this.unsnapped()
    let taken = this.taken.get(root)
    let to: string
    if (newest === 0) {
      // The tree the list was last read at serves while HEAD stands, so stepping through the
      // files does not take the snapshot again for each.
      if (!taken || taken.head !== (head ?? "")) taken = await this.snapshot(root)
      if (!taken) return this.unsnapped()
      to = taken.tree
    } else to = shown[newest - 1]!.id
    let from: string
    if (oldest === 0) from = head ?? empty
    else {
      const first = shown[oldest - 1]!
      // A range that reaches back to where the checkout left main starts from there, which
      // for the whole of it is what `git diff main...HEAD` shows; for one that ends at an
      // older commit, where that commit left main.
      const reaches = oldest === all.length - 1 && commits.length <= shown.length
      const left =
        since !== undefined && reaches
          ? newest === 0
            ? since
            : await mergeBase(root, since, to)
          : undefined
      if (left !== undefined) from = left
      else {
        // Else from the parent of its oldest layer. Where the range holds a merge, and main's
        // work as `to` has it is not in that parent yet, it starts from the parent with it
        // merged in (in memory), so main's own changes are no part of the range's work.
        const inside = shown.slice(newest === 0 ? 0 : newest - 1, oldest)
        const merging = since !== undefined && inside.some((commit) => commit.parents.length > 1)
        if (!merging || !(await this.merges())) from = first.parent ?? empty
        else {
          const main = newest === 0 ? since : await mergeBase(root, since, to)
          const start = await startOf(root, first.parent, main, empty, own)
          if (typeof start !== "string") return start
          from = start
        }
      }
    }
    return {
      from,
      to,
      layers,
      env: own,
      // Where the snapshot is an end, its listing is not kept (a new tree each time).
      store: newest !== 0,
      named: newest === 0 && taken ? named(taken) : [],
    }
  }

  private async listRange(root: string, selected: readonly string[]): Promise<ReadRange> {
    const span = await this.span(root, selected)
    if (span === undefined) return { ok: true, range: { files: [], truncated: false } }
    if ("ok" in span) return span
    const found = await listDiff(root, span.from, span.to, span.env, span.store)
    if ("ok" in found) return found
    const listed = [...found, ...span.named].toSorted(byPath)
    const held = holder(root, this.environment())
    return {
      ok: true,
      range: {
        files: listed.slice(0, maxChangedFiles).map((entry) => fileOf(entry, held)),
        truncated: listed.length > maxChangedFiles,
      },
    }
  }

  private async diff(root: string, path: string, selected: readonly string[]): Promise<ReadFile> {
    const span = await this.span(root, selected)
    if (span === undefined) return { ok: true, diff: { run: null } }
    if ("ok" in span) return span
    const run = await this.run(root, path, span, holder(root, this.environment()))
    if ("ok" in run) return run
    return { ok: true, diff: { run: run.file ? { ...run.file, layers: [...span.layers] } : null } }
  }

  /** One file between two commits or trees, if they differ by it. */
  private async run(
    root: string,
    path: string,
    { from, to, env, store, named }: Span,
    held: Held,
  ): Promise<ChangeFailure | { readonly file: RunOfFile | undefined }> {
    const found = await listDiff(root, from, to, env, store)
    if ("ok" in found) return found
    const listed = [...found, ...named]
    // By its name now, or by the one it had where the range began.
    const entry =
      listed.find((each) => displayed(each.path) === path) ??
      listed.find((each) => each.oldPath !== null && displayed(each.oldPath) === path)
    if (!entry) return { file: undefined }
    const file = fileOf(entry, held)
    const none = { file, big: false, badName: false, hunks: [], before: null, after: null }
    if (file.secret || entry.binary) return { file: none }
    // A name git can't be given back (it is no valid UTF-8) is named, not read.
    if (entry.path.includes("\uFFFD") || entry.oldPath?.includes("\uFFFD"))
      return { file: { ...none, badName: true } }
    const names = entry.oldPath === null ? [entry.path] : [entry.oldPath, entry.path]
    const patch = await git(root, [...diffFlags, "-U3", from, to, "--", ...names], {
      cap: patchBytes,
      truncate: true,
      ...(env && { env }),
    })
    if (!patch.ok) return failure("failed", reasonOf(patch, "read the file's changes"))
    const parsed = parseDiff(patch.out, { budget: { left: maxChangesBytes } })
    const big = patch.cut || parsed.some((each) => each.listed)
    const hunks = big ? [] : parsed.flatMap((each) => each.hunks)
    const [before, after] = await Promise.all([
      entry.status === "added" || big
        ? null
        : this.side(root, from, entry.oldPath ?? entry.path, env),
      entry.status === "deleted" || big ? null : this.side(root, to, entry.path, env),
    ])
    return { file: { file, big, badName: false, hunks, before, after } }
  }

  /** A file's text at a commit or tree; null where it is not there, is past the bound or is binary. */
  private async side(
    root: string,
    rev: string,
    path: string,
    env: NodeJS.ProcessEnv | undefined,
  ): Promise<string | null> {
    const run = await git(root, ["cat-file", "blob", `${rev}:${path}`], {
      cap: maxChangeSideBytes,
      ...(env && { env }),
    })
    if (!run.ok) return null
    return run.out.includes("\0") ? null : run.out
  }
}

const byPath = (a: Listed, b: Listed): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/** The untracked files that may hold secrets, as added files that are only named. */
const named = (taken: Taken): readonly Listed[] =>
  taken.secret.map((path): Listed => ({
    path,
    oldPath: null,
    status: "added",
    added: 0,
    removed: 0,
    binary: false,
    reindented: 0,
  }))

/** Whether a commit is `ancestor` of another (or the same). */
const isAncestor = async (
  root: string,
  ancestor: string,
  of: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> =>
  (await git(root, ["merge-base", "--is-ancestor", ancestor, of], { cap: small.cap, env })).ok

/**
 * Where a range or a merge starts from, given the `parent` it follows and `main`, the latest
 * commit of main that its end holds: the parent itself where that already holds main's work,
 * else the parent with main merged in, in memory (`merge-tree`, its objects in `env`'s
 * folder; a conflict's tree has its markers in it, so what the range resolves is its work).
 * Only main counts as brought in: a branch of the checkout's own is work.
 */
const startOf = async (
  root: string,
  parent: string | undefined,
  main: string | undefined,
  empty: string,
  env: NodeJS.ProcessEnv,
): Promise<string | ChangeFailure> => {
  if (parent === undefined) return empty
  if (main === undefined || (await isAncestor(root, main, parent, env))) return parent
  // The names only: with many conflicts git prints a line per stage.
  const run = await git(
    root,
    [
      "merge-tree",
      "--write-tree",
      "--no-messages",
      "--name-only",
      "--allow-unrelated-histories",
      parent,
      main,
    ],
    { cap: metaBytes, env },
  )
  // A conflict exits 1 with the tree printed first.
  const out = run.ok ? run.out : run.kind === "exit" && run.status === 1 ? (run.out ?? "") : ""
  const tree = out.split("\n")[0]!.trim()
  if (/^[0-9a-f]{40,64}$/.test(tree)) return tree
  return failure(
    "failed",
    run.ok ? "Git couldn't merge in memory." : reasonOf(run, "merge the parents of a merge"),
  )
}

let mergeTreeKnown: Promise<boolean> | undefined
/** Whether git can merge without a checkout (`merge-tree --write-tree`, from 2.38). */
const canMergeTree = (): Promise<boolean> =>
  (mergeTreeKnown ??= (async () => {
    const run = await git(process.cwd(), ["--version"], small)
    const version = /(\d+)\.(\d+)/.exec(run.ok ? run.out : "")
    // Not told: it is tried, and a merge that fails fails its layer only.
    if (!version) return true
    const [major, minor] = [Number(version[1]), Number(version[2])]
    return major > 2 || (major === 2 && minor >= 38)
  })())

/** The repository a changes item points at, if it still is one. */
export const findRepository = async (
  folder: string,
): Promise<
  { readonly ok: true; readonly root: string } | { readonly ok: false; readonly missing: boolean }
> => {
  const found = await repositoryOf(folder)
  if (!found.ok) return { ok: false, missing: found.kind === "missing" }
  // A repository that lost its own .git is now a folder of another: that is not its change.
  if (!samePlace(found.root, folder)) return { ok: false, missing: true }
  return { ok: true, root: found.root }
}
