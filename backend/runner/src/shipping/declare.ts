/**
 * `request_permit`, as the runner answers it (see architecture/grants.md): the agent declares a
 * shipping action, Novadeck resolves the real target from git and gh, and then, in order, the
 * user's own words (a quote checked word for word against what they typed in this terminal),
 * a permit already live, or a card for the user. The answer says what Novadeck went by.
 */
import { execFile } from "node:child_process"

import type { Cards } from "./cards.js"
import { describeKey } from "./gate.js"
import type { Permits, Quotes } from "./permits.js"
import { permitKey, type Lookups } from "./reader.js"

export type Declared = {
  readonly action: string
  readonly target?: string
  readonly said?: string
  readonly folder?: string
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
  /** Tells the agent in the terminal something, as a Novadeck notice. */
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

const escalation =
  " If the sandbox blocks the command, run it again asking for escalation; Novadeck approves it."

export const declare = async (
  deps: DeclareDeps,
  terminalId: string,
  cwd: string,
  input: Declared,
): Promise<DeclareAnswer> => {
  const folder = input.folder?.trim() || cwd
  const lookups = deps.lookups(terminalId)
  const repo = await lookups.repo(folder)
  if (repo === undefined)
    return { ok: false, reason: `Novadeck can't tell which repository ${folder} is in.` }
  const target = input.target?.trim() ?? ""
  let keys: string[]
  let title: string
  const detail: string[] = [`Repository: ${repo}`]
  let singleUse = false
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
      title = pull ? `Merge PR #${number} into ${pull.base}?` : `Merge PR #${number}?`
      if (pull) detail.push(`PR #${number}: ${pull.head} into ${pull.base} (read from GitHub)`)
      else detail.push(`GitHub didn't say which branch PR #${number} targets.`)
      break
    }
    case "open_pr": {
      const base = target === "" ? "@default" : target
      keys = [permitKey.prCreate(repo, base)]
      title = base === "@default" ? "Open a PR into the default branch?" : `Open a PR into ${base}?`
      break
    }
    case "push":
    case "force_push": {
      const branch = target || (await lookups.branch(folder))
      if (!branch)
        return { ok: false, reason: `${input.action} needs target: the branch pushed to.` }
      singleUse = input.action === "force_push"
      keys = [permitKey.push(repo, "origin", branch, singleUse)]
      title = `${singleUse ? "Force-push" : "Push"} to origin/${branch}?`
      break
    }
    case "land": {
      const branch = target || (await lookups.branch(folder))
      if (!branch) return { ok: false, reason: "land needs target: the branch landed on." }
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
  if (said && deps.quotes.said(terminalId, said)) {
    for (const key of keys)
      deps.permits.give(terminalId, key, singleUse, { type: "quote", quote: said })
    return {
      ok: true,
      state: "permitted",
      text: `The user's words "${said}" are in what they typed in this terminal, so Novadeck permits it (${sentence}) for ten minutes. Run the command on its own.${how}`,
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
