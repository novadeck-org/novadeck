import type { SourceChange, SourceFile, SourceProject } from "@novadeck/core/source"
import type { Work } from "@novadeck/core/works"

// The Source panel's overlay where the backend tells no changes of its own (a runner): every
// tracked worktree's work against main laid over the project's files, as each worktree is
// one agent's. A file shows the change its work made, when it last changed, and the handle of
// the terminal that owns the worktree; a worktree with no live owner shows its changes with
// nobody's name on them. Each live agent's cursor is on the file its running turn wrote last,
// where that file is in one of its worktrees: what an agent writes elsewhere isn't shown.

// A terminal that owns worktrees: its handle, and the absolute path its running turn wrote
// last, if it is writing one.
export type Owner = { readonly handle: string; readonly wrote: string | undefined }

// Where a work's repository and the project's folder meet: the project's folder from the
// repository's top (`repo`), and the repository's top from the project's folder (`project`).
export type WorkFolder = NonNullable<Work["folder"]>

// A path of a work's repository as a path from the project's folder, or undefined where it is
// outside the project's folder.
export const projectPath = ({ repo, project }: WorkFolder, path: string): string | undefined => {
  if (repo !== "" && !path.startsWith(`${repo}/`)) return undefined
  const inside = repo === "" ? path : path.slice(repo.length + 1)
  return project === "" ? inside : `${project}/${inside}`
}

// A path with `/` between names and no `/` at its end.
const slashed = (path: string): string => path.replaceAll("\\", "/").replace(/\/+$/, "")

// An absolute path as a path inside `root`, with `/` between names, or undefined where it
// is not inside it. Windows paths compare without regard to case, as the file system does.
const inside = (root: string, path: string): string | undefined => {
  const windows = /^[a-z]:\//i.test(slashed(root))
  const fold = (each: string): string => (windows ? each.toLowerCase() : each)
  const top = slashed(root)
  const file = slashed(path)
  if (!fold(file).startsWith(`${fold(top)}/`)) return undefined
  return file.slice(top.length + 1)
}

type Placed = { readonly kind: SourceChange; readonly at: number }

// The overlay of a project's works, or undefined where nothing is changed or written in it.
// Where two works change one file, it shows the change made last, and every owner's time.
export const sourceOfWorks = (
  works: readonly Work[],
  projectId: string,
  owners: ReadonlyMap<string, Owner>,
): SourceProject | undefined => {
  const placed = new Map<string, Placed>()
  const touched = new Map<string, Record<string, number>>()
  const writing: Record<string, string> = {}
  const place = (path: string, kind: SourceChange, at: number, handle: string | undefined) => {
    const was = placed.get(path)
    if (!was || at > was.at) placed.set(path, { kind, at })
    const times = touched.get(path) ?? {}
    if (handle !== undefined) times[handle] = Math.max(times[handle] ?? 0, at)
    touched.set(path, times)
  }
  for (const work of works) {
    if (work.projectId !== projectId || work.folder === undefined) continue
    const { folder } = work
    const owner = work.terminalId === null ? undefined : owners.get(work.terminalId)
    for (const file of work.files) {
      const path = projectPath(folder, file.path)
      // A rename shows as its old path gone and its new one made, either of which may be
      // outside the project's folder.
      if (file.status === "renamed") {
        const from = file.from === undefined ? undefined : projectPath(folder, file.from)
        if (from !== undefined) place(from, "deleted", file.changedAt, owner?.handle)
        if (path !== undefined) place(path, "added", file.changedAt, owner?.handle)
      } else if (path !== undefined) place(path, file.status, file.changedAt, owner?.handle)
    }
    const wrote = owner?.wrote === undefined ? undefined : inside(work.root, owner.wrote)
    const path = wrote === undefined ? undefined : projectPath(folder, wrote)
    if (owner && path !== undefined) writing[owner.handle] = path
  }
  if (placed.size === 0 && Object.keys(writing).length === 0) return undefined
  const changes: Record<string, SourceFile> = {}
  for (const [path, { kind }] of placed) changes[path] = { kind, touched: touched.get(path)! }
  return { changes, writing }
}
