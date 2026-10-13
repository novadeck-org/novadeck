// What the E2E workflow runs, decided from what a pull request changed. Pure: `main.ts`
// gathers the facts (the event, turbo's affected packages, git's changed files).

// The table's source, which imports nothing, so the plan needs no package built first.
import { harnesses } from "../../../application/protocol/src/harnesses.ts"

/** The facts a decision rests on; `undefined` where they couldn't be had. */
export type Facts = {
  /** The workflow's event (`pull_request`, `schedule`, `workflow_dispatch`). */
  readonly event: string
  /** Names of the workspace packages turbo calls affected, dependents included. */
  readonly affected: readonly string[] | undefined
  /** Paths git calls changed, relative to the repository's root, with `/` as separator. */
  readonly files: readonly string[] | undefined
}

// The packages a change in which runs no harness of its own: the suite runs on none of the
// UI and the host, and the runner is reported affected by any package it depends on, an
// adapter's too, which would run everything for a change to one harness; its own changes
// are told by its files instead (`sharedFolders`). Any other package but an adapter, one
// the runner builds on (harness-core, the protocol, the relay, the engines) or one added
// later, can break any harness, so it runs everything.
const unshared = new Set(["@novadeck/runner", "@novadeck/ui", "@novadeck/host"])

// The runner, where the suite and the pins live, and what lies outside every package yet
// inside what the suite runs on or how CI runs it.
const sharedFiles = new Set([
  ".github/workflows/e2e.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
])
const sharedFolders = [".github/actions/e2e-harness-cache/", "application/runner/", "scripts/e2e/"]

/** The adapter package of a harness. */
export const adapterOf = (id: string): string => `@novadeck/harness-${id}`

/**
 * The harnesses whose rows run. All of them when nothing says otherwise (a nightly or
 * manual run, or facts missing, which can't be told from everything changing); none when
 * the change is nothing the suite runs on.
 */
export const select = (facts: Facts, ids: readonly string[]): readonly string[] => {
  if (facts.event !== "pull_request") return ids
  const { affected, files } = facts
  if (!affected || !files) return ids
  const adapters = new Set(ids.map(adapterOf))
  if (affected.some((name) => !adapters.has(name) && !unshared.has(name))) return ids
  if (files.some((file) => sharedFiles.has(file) || sharedFolders.some((f) => file.startsWith(f))))
    return ids
  return ids.filter((id) => affected.includes(adapterOf(id)))
}

/** One row of the `e2e` job's matrix. */
export type Setup = {
  readonly agents: string
  readonly name: string
  readonly files?: string
}

/** One row of the `quirks` job's matrix. */
export type Quirk = {
  readonly agents: string
  readonly name: string
  readonly files: string
  readonly autorun?: true
}

// A harness's display name, as the protocol's table has it; its id where the table has no
// row for it yet.
const nameOf = (id: string): string => harnesses.find((each) => each.id === id)?.name ?? id

/**
 * The rows of the `e2e` job: each selected harness alone, then Mixed, which runs every
 * harness at once for the scenarios across harnesses (`*.mixed.e2e.ts`) the others skip.
 */
export const setups = (selected: readonly string[], ids: readonly string[]): readonly Setup[] =>
  selected.length === 0
    ? []
    : [
        ...selected.map((id) => ({ agents: id, name: nameOf(id) })),
        { agents: ids.join(","), name: "Mixed", files: "mixed.e2e.ts" },
      ]

const core = "messaging.e2e.ts requests.e2e.ts lifecycle.e2e.ts"

/**
 * The rows of the `quirks` job, one per selected harness. Each runs the core scenarios;
 * Claude Code's job also runs the registry's PATH, which needs no harness and so runs in
 * one job. Antigravity's runs the cmd AutoRun last, as it turns Antigravity's messaging
 * off by design.
 */
export const quirks = (selected: readonly string[]): readonly Quirk[] =>
  selected.map((id) => ({
    agents: id,
    name: nameOf(id),
    files: id === "claude" ? `${core} windows-quirks.e2e.ts` : core,
    ...(id === "agy" ? { autorun: true as const } : {}),
  }))

/** What the workflow's jobs read. */
export type Plan = {
  readonly run: boolean
  readonly e2e: readonly Setup[]
  readonly quirks: readonly Quirk[]
}

export const plan = (facts: Facts, ids: readonly string[]): Plan => {
  const selected = select(facts, ids)
  // With nothing to run the jobs are skipped, but their matrices still name every row: a
  // skipped job's matrix is never run, and an empty one is an error where Actions reads it.
  const rows = selected.length > 0 ? selected : ids
  return {
    run: selected.length > 0,
    e2e: setups(rows, ids),
    quirks: quirks(rows),
  }
}

/** The package names of `turbo ls --output json`, or `undefined` if it isn't that. */
export const parseAffected = (output: string): readonly string[] | undefined => {
  try {
    const items = (JSON.parse(output) as { packages?: { items?: unknown } }).packages?.items
    if (!Array.isArray(items)) return undefined
    const found = items.map((item: { name?: unknown }) => item?.name)
    return found.every((name) => typeof name === "string") ? (found as string[]) : undefined
  } catch {
    return undefined
  }
}
