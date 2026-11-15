import { realpath } from "node:fs/promises"
import path from "node:path"

import { homeOf } from "../worktrees/repo.js"

// Where a repository's main checkout is in a project's folder, so a work's files (named from
// the checkout) can be laid over the project's own tree.

/** Where a project's folder and its repository's top share a place: see `workFolder`. */
export type Folder = { readonly repo: string; readonly project: string }

/**
 * How `project` and `top` (both real paths) lie: the same folder (both empty), `top` inside
 * `project` (`project` names it), or `project` inside `top` (`repo` names the project's folder
 * from the top). Undefined where neither holds (siblings, or other drives).
 */
export const folderBetween = (
  project: string,
  top: string,
  flavor: Pick<typeof path, "relative" | "isAbsolute" | "sep"> = path,
): Folder | undefined => {
  const down = flavor.relative(project, top)
  if (down === "") return { repo: "", project: "" }
  if (flavor.isAbsolute(down)) return undefined
  const steps = down.split(flavor.sep)
  if (!steps.includes("..")) return { repo: "", project: steps.join("/") }
  // Only ever up means `project` is inside `top`; going up and then down is a sibling's.
  if (!steps.every((step) => step === "..")) return undefined
  return { repo: flavor.relative(top, project).split(flavor.sep).join("/"), project: "" }
}

/**
 * The folder of a work's main checkout in its project, given the repository's common git dir
 * (as `commonDir` gives it): see `folderBetween`. Undefined too where the checkout can't be
 * told (a bare repository, a submodule's git dir) or the project's folder is unknown.
 */
export const folderOf = async (
  project: string | undefined,
  common: string | undefined,
): Promise<Folder | undefined> => {
  if (project === undefined || common === undefined || path.basename(common) !== ".git")
    return undefined
  const real = await realpath(project).catch(() => project)
  const top = await realpath(homeOf(common)).catch(() => homeOf(common))
  return folderBetween(real, top)
}

/**
 * A path from the project's folder as a path from the repository's top (a work's files are named
 * so), or undefined where it is outside the repository: the inverse of how the Source panel
 * lays a work's file over the project's tree.
 */
export const repoPath = (folder: Folder, file: string): string | undefined => {
  if (folder.project !== "" && !file.startsWith(`${folder.project}/`)) return undefined
  const inside = folder.project === "" ? file : file.slice(folder.project.length + 1)
  return folder.repo === "" ? inside : `${folder.repo}/${inside}`
}

/** A path from the repository's top as a path from the project's folder, or undefined where it is outside it. */
export const projectPathOf = (folder: Folder, file: string): string | undefined => {
  if (folder.repo !== "" && !file.startsWith(`${folder.repo}/`)) return undefined
  const inside = folder.repo === "" ? file : file.slice(folder.repo.length + 1)
  return folder.project === "" ? inside : `${folder.project}/${inside}`
}
