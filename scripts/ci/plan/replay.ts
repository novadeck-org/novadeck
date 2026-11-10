import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"

import * as e2e from "../../e2e/plan/plan.ts"
import * as packaging from "../../package/plan/plan.ts"
import {
  declaredPlatform,
  declaredReads,
  platformOf,
  type Declared,
  workspacePackages,
  workspaceTrees,
} from "../../workspace/platform.ts"
import { readScope, scopeFile } from "../../workspace/scopes.ts"
import { affected, dependencies, graphOf, type Manifest } from "./graph.ts"
import { type Facts, packageOf, plan, type Plan, type Workspace } from "./plan.ts"

// `node scripts/ci/plan/replay.ts [count] [ref]`: replays the last merges on `ref` (`origin/main`
// by default, first parent, 300 of them) through the old planners (scripts/e2e/plan,
// scripts/package/plan, and the E2E plan's rule for systems, which Windows' and macOS' unit
// tests would take from it) and through this one, and prints, as JSON, each merge where they
// disagree and the counts. Each merge's facts come from its own tree: its packages, their
// dependencies, its harnesses; a package's platform from its own declaration, or, before it had
// one, from today's for the same folder (`system` for a folder that is no package today). The
// old planners run as they are today, with today's lists.

const root = join(import.meta.dirname, "..", "..", "..")
const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })

/** The text of each of `paths` at `commit`, `undefined` where it is missing. */
const show = (commit: string, paths: readonly string[]): readonly (string | undefined)[] => {
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: paths.map((path) => `${commit}:${path}\n`).join(""),
    maxBuffer: 1 << 28,
  })
  const output = result.stdout
  const texts: (string | undefined)[] = []
  let at = 0
  for (const _ of paths) {
    const end = output.indexOf(10, at)
    const header = output.subarray(at, end).toString("utf8")
    at = end + 1
    if (header.endsWith(" missing")) {
      texts.push(undefined)
      continue
    }
    const size = Number(header.split(" ")[2])
    texts.push(output.subarray(at, at + size).toString("utf8"))
    at += size + 1
  }
  return texts
}

const today = new Map(
  workspacePackages(root).map(({ folder, manifest }) => [
    folder,
    { platform: platformOf(manifest), reads: declaredReads(manifest) ?? [] },
  ]),
)
// The scopes as they are today: no merge before them had one.
const scopes = git("-c", "core.quotePath=false", "ls-files", "-z", "-co", "--exclude-standard")
  .split("\0")
  .filter((file) => file.split("/").at(-1) === scopeFile)
  .flatMap((file) => readScope(dirname(file), readFileSync(join(root, file), "utf8")) ?? [])

type Merge = {
  readonly commit: string
  readonly subject: string
  readonly author: string
  readonly date: string
}

/** A merge's facts, as a pull request's run would have had them, and its harnesses. */
const factsOf = (merge: Merge): { facts: Facts; ids: readonly string[] } => {
  const { commit } = merge
  const files = git(
    "-c",
    "core.quotePath=false",
    "diff",
    "-z",
    "--name-only",
    "--no-renames",
    `${commit}^`,
    commit,
  )
    .split("\0")
    .filter(Boolean)
  const [workspace, pins] = show(commit, [
    "pnpm-workspace.yaml",
    "backend/runner/src/e2e/harnesses.json",
  ])
  const trees = new Set(workspaceTrees(workspace ?? ""))
  const folders = git("ls-tree", "-r", "--name-only", commit)
    .split("\n")
    .map((path) => /^([^/]+\/[^/]+)\/package\.json$/.exec(path)?.[1])
    .filter((folder): folder is string => !!folder && trees.has(folder.split("/")[0]!))
  const manifests = show(
    commit,
    folders.map((folder) => `${folder}/package.json`),
  ).map((text) => JSON.parse(text ?? "{}") as Manifest & Declared)
  const packages: Workspace[] = folders.map((folder, index) => {
    const manifest = manifests[index]!
    return {
      name: manifest.name,
      folder,
      platform: declaredPlatform(manifest) ?? today.get(folder)?.platform ?? "system",
      reads: manifest.novadeck?.reads
        ? (declaredReads(manifest) ?? [""])
        : (today.get(folder)?.reads ?? []),
    }
  })
  const graph = graphOf(manifests)
  const changed = files.flatMap((file) => packageOf(file, packages)?.name ?? [])
  return {
    facts: {
      event: "pull_request",
      packages,
      scopes,
      files,
      affected: affected(graph, changed),
      suite: dependencies(graph, "@novadeck/runner"),
      packaged: dependencies(graph, "@novadeck/desktop"),
    },
    ids: Object.keys(JSON.parse(pins ?? "{}") as object),
  }
}

/** What the old planners decide for the same facts. */
const old = (facts: Facts, ids: readonly string[]) => {
  const packages = facts.packages ?? []
  const folderOf = new Map(packages.map(({ name, folder }) => [name, folder]))
  const e2eFacts = {
    event: facts.event,
    affected: facts.affected,
    runner: facts.suite,
    files: facts.files,
  }
  const decided = e2e.plan(e2eFacts, ids)
  return {
    e2e: decided,
    // The rule step 1d gives Windows' and macOS' unit tests: the E2E plan's, by changed files.
    systemTests: e2e.selectSystems(e2eFacts).length > 1,
    package: packaging.plan({
      event: facts.event,
      packaged: facts.packaged?.map((name) => folderOf.get(name) ?? name),
      files: facts.files,
    }),
  }
}

const agentsOf = (each: { readonly run: boolean; readonly e2e: readonly e2e.Setup[] }) =>
  each.run ? each.e2e.map(({ agents }) => agents).join(" ") : "none"
const systemsOf = (each: { readonly run: boolean; readonly os: readonly string[] }) =>
  each.run ? each.os.join(" ") : "none"
const runsSystems = (decided: Plan) =>
  decided.tests.windows === "all" || decided.tests.windows.length > 0

// The narrowings, added one at a time,
// for what each saves.
const variants = {
  strict: (facts: Facts, ids: readonly string[]) =>
    plan({ ...facts, scopes: [] }, ids, { prose: false }),
  prose: (facts: Facts, ids: readonly string[]) => plan({ ...facts, scopes: [] }, ids),
  scopes: (facts: Facts, ids: readonly string[]) => plan(facts, ids),
}

export const replay = (count: number, ref: string) => {
  const merges: Merge[] = git(
    "log",
    ref,
    "--first-parent",
    `-${count}`,
    "--format=%H%x09%s%x09%an%x09%ad",
    "--date=short",
  )
    .trim()
    .split("\n")
    .map((line) => {
      const [commit = "", subject = "", author = "", date = ""] = line.split("\t")
      return { commit, subject, author, date }
    })
  const rows = merges.map((merge) => {
    const { facts, ids } = factsOf(merge)
    const decided = plan(facts, ids)
    const was = old(facts, ids)
    const changed = [
      ...new Set(
        (facts.files ?? []).flatMap((file) => packageOf(file, facts.packages ?? [])?.folder ?? []),
      ),
    ]
    const outside = (facts.files ?? []).filter((file) => !packageOf(file, facts.packages ?? []))
    const differences = {
      agents: [agentsOf(was.e2e), agentsOf(decided.e2e)] as const,
      systems: [systemsOf(was.e2e), systemsOf(decided.e2e)] as const,
      systemTests: [was.systemTests, runsSystems(decided)] as const,
      package: [was.package, decided.package] as const,
    }
    return {
      pr: /\(#(\d+)\)$/.exec(merge.subject)?.[1],
      commit: merge.commit.slice(0, 9),
      date: merge.date,
      subject: merge.subject,
      bot: /dependabot/.test(merge.author),
      everything: decided.everything,
      changed,
      outside,
      linux: decided.tests.linux === "all" ? "all" : decided.tests.linux.length,
      windows: decided.tests.windows === "all" ? "all" : decided.tests.windows,
      systemTests: differences.systemTests,
      variants: Object.fromEntries(
        Object.entries(variants).map(([name, each]) => [name, runsSystems(each(facts, ids))]),
      ),
      disagree: Object.fromEntries(
        Object.entries(differences).filter(([, [before, after]]) => before !== after),
      ),
    }
  })
  const share = (matching: number) =>
    `${matching} of ${rows.length} (${Math.round((100 * matching) / rows.length)}%)`
  return {
    range: `${merges.at(-1)?.date} to ${merges[0]?.date}`,
    merges: rows.length,
    skipsSystemTests: {
      old: share(rows.filter(({ systemTests: [before] }) => !before).length),
      ...Object.fromEntries(
        Object.keys(variants).map((name) => [
          name,
          share(rows.filter(({ variants: ran }) => !ran[name]).length),
        ]),
      ),
    },
    everything: share(rows.filter(({ everything }) => everything !== undefined).length),
    disagreements: rows.filter(({ disagree }) => Object.keys(disagree).length > 0),
    rows,
  }
}

if (import.meta.main) {
  const [count = "300", ref = "origin/main"] = process.argv.slice(2)
  console.log(JSON.stringify(replay(Number(count), ref), null, 2))
}
