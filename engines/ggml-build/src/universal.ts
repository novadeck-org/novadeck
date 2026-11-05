import { chmodSync, lstatSync, readlinkSync, symlinkSync } from "node:fs"
import { mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"

import type { Slice } from "./cmake.ts"
import { output, type Run } from "./machine.ts"

// macOS's universal engine: each architecture is built and staged on its own (cmake.ts says
// why), and the staged slices are merged here into one folder, each binary one universal
// Mach-O that holds every slice, each link once.

/** A file a slice staged: a link keeps its target. */
export type Staged = { readonly name: string; readonly link?: string }

/** A file of the universal folder: a link the slices share, or a binary merged from theirs. */
export type Merged = { readonly name: string; readonly link: string } | { readonly name: string }

const listing = (files: readonly Staged[]): string =>
  files
    .map(({ name, link }) => (link === undefined ? name : `${name} -> ${link}`))
    .toSorted()
    .join(", ")

/**
 * What the universal folder holds, from what each slice staged. The slices must stage the
 * same files and links: one that lacks a library the other has would load it on one
 * architecture and fail on the other.
 */
export const mergePlan = (slices: readonly (readonly Staged[])[]): Merged[] => {
  const [first, ...rest] = slices
  if (!first) throw new Error("No slice was staged to merge.")
  for (const other of rest) {
    if (listing(other) !== listing(first)) {
      throw new Error(
        `The slices staged different files: ${listing(first)}; and ${listing(other)}.`,
      )
    }
  }
  return first
    .map(({ name, link }) => (link === undefined ? { name } : { name, link }))
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** The slices `lipo -archs` names that are not the ones wanted, or that are missing. */
export const archsProblem = (archs: string, wanted: readonly Slice[]): string | undefined => {
  const found = archs.trim().split(/\s+/).filter(Boolean).toSorted()
  const expected = wanted.toSorted()
  return found.join(" ") === expected.join(" ")
    ? undefined
    : `holds ${found.join(" ") || "no slice"}, not ${expected.join(" ")}`
}

const read = async (folder: string): Promise<Staged[]> =>
  (await readdir(folder)).map((name) => {
    const path = join(folder, name)
    return lstatSync(path).isSymbolicLink() ? { name, link: readlinkSync(path) } : { name }
  })

/**
 * Merges the slices staged in `folders` into `staging`, emptied first, and checks that every
 * binary holds every slice.
 */
export const merge = async (
  folders: readonly { readonly slice: Slice; readonly folder: string }[],
  staging: string,
  run: Run,
): Promise<void> => {
  const plan = mergePlan(await Promise.all(folders.map(({ folder }) => read(folder))))
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  const slices = folders.map(({ slice }) => slice)
  for (const file of plan) {
    const into = join(staging, file.name)
    if ("link" in file) {
      symlinkSync(file.link, into)
      continue
    }
    const parts = folders.map(({ folder }) => join(folder, file.name))
    run("lipo", ["-create", "-output", into, ...parts])
    // The first slice's mode, so the archive marks what runs whatever mode lipo writes.
    chmodSync(into, lstatSync(parts[0]!).mode & 0o777)
    const problem = archsProblem(output("lipo", ["-archs", into]), slices)
    if (problem) throw new Error(`The universal ${file.name} ${problem}.`)
  }
}
