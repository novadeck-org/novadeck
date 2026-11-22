/**
 * `request_permit`, as the runner answers it (see architecture/grants.md): the agent declares a
 * shipping action, Novadeck resolves the real target from git and gh, and then, in order, the
 * user's own words (a quote checked word for word against what they typed in this terminal),
 * a permit already live, or a card for the user. The answer says what Novadeck went by.
 */
import { execFile } from "node:child_process"
import { resolve as resolvePath } from "node:path"

import type { Cards } from "./cards.js"
import { describeKey } from "./gate.js"
import type { Permits, Quotes } from "./permits.js"
import { permitKey, type Lookups } from "./reader.js"

export type Declared = {
  readonly action: string
  readonly target?: string
  readonly said?: string
  readonly folder?: string
  /** The remote a push goes to, when the agent names one; else the branch's upstream remote, else origin. */
  readonly remote?: string
}

/** What `gh pr view` said of a PR, when it could. */
export type PullRequest = { readonly base: string; readonly head: string } | undefined

export type DeclareDeps = {
  readonly lookups: (terminalId: string) => Lookups
  readonly permits: Permits
  readonly quotes: Quotes
  readonly cards: Cards
  /** A PR's base and head, from `gh` in `folder`; undefined where gh can't say. */
  readonly pull: (folder: string, repo: string, number: number) => Promise<PullRequest>
  /** Whether `name` is a branch or remote name git accepts (`git check-ref-format`). */
  readonly valid: (folder: string, name: string) => Promise<boolean>
  /** The repository's default branch, from `origin/HEAD` or else `gh repo view`; undefined where neither says. */
  readonly defaultBranch: (folder: string, repo: string) => Promise<string | undefined>
  /** The agent running in the terminal, if one is bound. */
  readonly agentOf: (terminalId: string) => "claude" | "codex" | "agy" | undefined
}

export type DeclareAnswer =
  | { readonly ok: true; readonly state: "permitted" | "asked"; readonly text: string }
  | { readonly ok: false; readonly reason: string }

export const actions = ["merge_pr", "open_pr", "push", "force_push", "land"] as const

/** The pull request `gh` knows, read with no change; the hook never asks the network, this call may. */
export const ghPull = (folder: string, repo: string, number: number): Promise<PullRequest> =>
  new Promise((resolve) => {
    execFile(
      "gh",
      ["pr", "view", String(number), "-R", repo, "--json", "baseRefName,headRefName"],
      {
        cwd: folder,
        timeout: 6_000,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      },
      (error, out) => {
        if (error) return resolve(undefined)
        try {
          const read = JSON.parse(out) as { baseRefName?: unknown; headRefName?: unknown }
          resolve(
            typeof read.baseRefName === "string" && typeof read.headRefName === "string"
              ? { base: read.baseRefName, head: read.headRefName }
              : undefined,
          )
        } catch {
          resolve(undefined)
        }
      },
    )
  })

/** The repository's default branch as `gh` knows it, read with no change. */
export const ghDefault = (folder: string, repo: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile(
      "gh",
      ["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      {
        cwd: folder,
        timeout: 6_000,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      },
      (error, out) => resolve(error ? undefined : out.trim() || undefined),
    )
  })

// The most of a quote a permit and its record keep.
const quoteCut = 300

const escalation =
  " If the sandbox blocks the command, run it again asking for escalation; Novadeck approves it."

export const declare = async (
  deps: DeclareDeps,
  terminalId: string,
  cwd: string,
  input: Declared,
): Promise<DeclareAnswer> => {
  // As the tool says, relative to the terminal's current directory: never the runner's own.
  const named = input.folder?.trim()
  const folder = named ? resolvePath(cwd, named) : cwd
  const lookups = deps.lookups(terminalId)
  const repo = await lookups.repo(folder)
  if (repo === undefined)
    return { ok: false, reason: `Novadeck can't tell which repository ${folder} is in.` }
  const target = input.target?.trim() ?? ""
  let keys: string[]
  let title: string
  const detail: string[] = [`Repository: ${repo}`]
  let singleUse = false
  // A name from the agent counts only once git accepts it as one.
  const checked = async (name: string, what: string): Promise<string | undefined> =>
    (await deps.valid(folder, name))
      ? undefined
      : `${JSON.stringify(name)} isn't a ${what} name git accepts.`
  switch (input.action) {
    case "merge_pr": {
      const number = Number(/^#?(\d+)$/.exec(target)?.[1] ?? /\/pull\/(\d+)\/?$/.exec(target)?.[1])
      if (!Number.isSafeInteger(number) || number <= 0)
        return { ok: false, reason: "merge_pr needs target: the PR's number." }
      const pull = await deps.pull(folder, repo, number)
      keys = [permitKey.prMerge(repo, number)]
      const branch = await lookups.branch(folder)
      if (pull !== undefined && branch !== undefined && branch === pull.head)
        keys.push(permitKey.prMergeBranch(repo, branch))
      // GitHub's own words for the base count as much as an agent's: only a name git accepts is shown.
      const base =
        pull !== undefined && (await deps.valid(folder, pull.base)) ? pull.base : undefined
      title = base ? `Merge PR #${number} into ${base}?` : `Merge PR #${number}?`
      if (pull && base) detail.push(`PR #${number} merges into ${base} (read from GitHub)`)
      else detail.push(`GitHub didn't say which branch PR #${number} targets.`)
      break
    }
    case "open_pr": {
      const bad = target === "" ? undefined : await checked(target, "branch")
      if (bad) return { ok: false, reason: bad }
      const fallback = await deps.defaultBranch(folder, repo)
      if (target === "" && fallback === undefined)
        return {
          ok: false,
          reason: `Novadeck can't tell ${repo}'s default branch: name the base in target.`,
        }
      const base = target === "" ? fallback! : target
      // A command with no --base goes to the default branch, which the hook never looks up.
      keys = [permitKey.prCreate(repo, base)]
      if (base === fallback) keys.push(permitKey.prCreate(repo, "@default"))
      title = `Open a PR into ${base}?`
      if (target === "") detail.push(`${base} is the repository's default branch.`)
      break
    }
    case "push":
    case "force_push": {
      const current = await lookups.branch(folder)
      const branch = target || current
      if (!branch)
        return { ok: false, reason: `${input.action} needs target: the branch pushed to.` }
      const up = current === undefined ? undefined : await lookups.upstream(folder, current)
      const remote = input.remote?.trim() || up?.remote || "origin"
      const bad = (await checked(branch, "branch")) ?? (await checked(remote, "remote"))
      if (bad) return { ok: false, reason: bad }
      singleUse = input.action === "force_push"
      keys = [permitKey.push(repo, remote, branch, singleUse)]
      title = `${singleUse ? "Force-push" : "Push"} to ${remote}/${branch}?`
      detail.push(`Remote: ${remote}`)
      break
    }
    case "land": {
      const branch = target || (await lookups.branch(folder))
      if (!branch) return { ok: false, reason: "land needs target: the branch landed on." }
      const bad = await checked(branch, "branch")
      if (bad) return { ok: false, reason: bad }
      keys = [permitKey.land(repo, branch)]
      title = `Land work on ${branch}?`
      break
    }
    default:
      return { ok: false, reason: `Novadeck knows these actions: ${actions.join(", ")}.` }
  }
  const sentence = keys.map(describeKey)[0]!
  const agent = deps.agentOf(terminalId)
  const how = agent === "codex" ? escalation : ""
  // Already covered: nothing to ask.
  if (keys.every((key) => deps.permits.covering(terminalId, key) !== undefined))
    return {
      ok: true,
      state: "permitted",
      text: `A permit already covers it (${sentence}). Run the command on its own.${how}`,
    }
  // The user's own words typed in this terminal.
  const said = input.said?.trim()
  // What of the user's own typing the quote is, as they wrote it: what the permit goes by.
  const matched = said ? deps.quotes.said(terminalId, said)?.slice(0, quoteCut) : undefined
  if (matched !== undefined) {
    for (const key of keys)
      deps.permits.give(terminalId, key, singleUse, { type: "quote", quote: matched })
    return {
      ok: true,
      state: "permitted",
      text: `The user's words "${matched}" are in what they typed in this terminal, so Novadeck permits it (${sentence}) for ten minutes. Run the command on its own.${how}`,
    }
  }
  const asked = deps.cards.ask(terminalId, keys, singleUse, title, detail.join("\n"))
  const unmatched = said ? ` "${said}" is not in what the user typed in this terminal.` : ""
  return {
    ok: true,
    state: "asked",
    text: `Novadeck asked the user: ${asked.card.title}${unmatched} Their answer reaches you as a Novadeck notice, with the permit live on Allow. ${
      asked.fresh ? "" : "The card was already open. "
    }Nothing else to do now.`,
  }
}
