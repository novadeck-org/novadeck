import { execFileSync } from "node:child_process"
import { matchesGlob } from "node:path"

import { covered, notes, roots, type Root } from "../content/areas.ts"
import type { AgentSurface, Api, Area, BrokenAnchor, Data } from "../src/atlas.ts"
import type { Anchors } from "./anchors.ts"

export type Owned = { api: Api; data: Data; agents: AgentSurface }

const sourceFile = /\.(?:ts|tsx|js|mjs|cjs|rs|css)$/
const testFile = /\.(?:test|spec)\.tsx?$|\.e2e\.ts$/
const generated = /(?:^|\/)(?:node_modules|dist|target)\//

// The area whose globs match a repository-relative file; the first one wins.
export const areaOf = (areas: Area[], file: string): string | null =>
  areas.find((area) => area.globs.some((glob) => matchesGlob(file, glob)))?.id ?? null

// The folders directly under `dir` that hold any of the files.
const foldersUnder = (files: string[], dir: string): string[] =>
  [
    ...new Set(
      files.flatMap((file) => {
        if (!file.startsWith(`${dir}/`)) return []
        const rest = file.slice(dir.length + 1).split("/")
        return rest.length > 1 ? [rest[0]!] : []
      }),
    ),
  ].toSorted()

// A package's tokens, most specific first so the first matching glob is the owner:
// `ui/backend/runner` before `ui/backend` before `ui`.
const tokensOf = (root: Root, files: string[]): { id: string; glob: string }[] => {
  if (root.src === undefined) return [{ id: root.token, glob: `${root.dir}/**` }]
  const src = `${root.dir}/${root.src}`
  const tokens = foldersUnder(files, src).flatMap((folder) => {
    const own = { id: `${root.token}/${folder}`, glob: `${src}/${folder}/**` }
    if (!root.split?.includes(folder)) return [own]
    const nested = foldersUnder(files, `${src}/${folder}`).map((child) => ({
      id: `${root.token}/${folder}/${child}`,
      glob: `${src}/${folder}/${child}/**`,
    }))
    return [...nested, own]
  })
  return [...tokens, { id: root.token, glob: `${root.dir}/**` }]
}

// The areas, derived from the folders of the packages in `content/areas.ts`, measured
// and given what they own; and what keeps the tokens honest: source no package covers,
// and notes for tokens that no longer exist.
export const extractAreas = (
  repo: string,
  anchors: Anchors,
  owned: Owned,
): { areas: Area[]; problems: BrokenAnchor[] } => {
  const files = execFileSync("git", ["ls-files"], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  })
    .split("\n")
    .filter((file) => sourceFile.test(file) && !generated.test(file))

  const areas: Area[] = roots.flatMap((root) =>
    tokensOf(root, files).map(({ id, glob }) => {
      const note = notes[id]
      return {
        id,
        node: root.nodes?.[id] ?? root.node,
        purpose: note?.purpose ?? "",
        globs: [glob],
        files: 0,
        lines: 0,
        tests: 0,
        entries: (note?.entries ?? []).map((entry) => anchors.resolve(entry, `area ${id} entry`)),
        docs: note?.docs ?? [],
        procedures: [],
        tables: [],
        tools: [],
      }
    }),
  )

  const problems: BrokenAnchor[] = []
  const byId = new Map(areas.map((area) => [area.id, area]))
  for (const file of files) {
    const area = byId.get(areaOf(areas, file) ?? "")
    if (area === undefined) {
      if (covered.some((dir) => file.startsWith(dir)))
        problems.push({ where: "no area", file, text: "" })
      continue
    }
    area.files += 1
    if (testFile.test(file)) area.tests += 1
    const source = anchors.read(file)
    if (source !== null) area.lines += source.split("\n").length - (source.endsWith("\n") ? 1 : 0)
  }
  // An area stays when it holds files or something under it does.
  const live = (id: string): boolean =>
    areas.some((area) => area.files > 0 && (area.id === id || area.id.startsWith(`${id}/`)))
  for (const id of Object.keys(notes))
    if (!live(id)) problems.push({ where: "note for a missing area", file: id, text: "" })
  for (const root of roots)
    if (!files.some((file) => file.startsWith(`${root.dir}/`)))
      problems.push({
        where: "package root without files",
        file: root.dir,
        text: `no tracked source under ${root.dir} for \`${root.token}\``,
        reason: "no tracked source files",
      })

  const own = (file: string | undefined, id: string, into: "procedures" | "tables" | "tools") => {
    if (file === undefined) return
    const area = byId.get(areaOf(areas, file) ?? "")
    if (area !== undefined && !area[into].includes(id)) area[into].push(id)
  }
  for (const procedure of owned.api.procedures)
    own(procedure.handler?.file, procedure.id, "procedures")
  for (const table of owned.data.tables) own(table.anchor.file, table.name, "tables")
  // A tool belongs to the area that defines it; its handler lives elsewhere.
  for (const tool of owned.agents.tools) own(tool.anchor.file, tool.name, "tools")
  return { areas: areas.filter((area) => area.files > 0), problems }
}
