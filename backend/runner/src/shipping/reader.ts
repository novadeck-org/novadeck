/* eslint-disable no-await-in-loop -- A command's segments are read in order: each may move the folder the next runs in. */
/**
 * What a shell command ships, for the shipping gate (see architecture/grants.md): its git and
 * gh commands read on top of the shell reader (`words.ts`), each as an action with a target
 * Novadeck resolves from git, never from the command's text alone.
 *
 * Shipping is defined by target: `gh pr create`, `gh pr merge`, and a push or a ref move
 * (merge, pull, rebase, cherry-pick, reset, `branch -f`, `update-ref`, `checkout -B`) whose
 * target is not the agent's own branch. A command that looks like shipping but can't be read
 * (an expansion, a wrapper, a tag push, a mutating `gh api`) comes back with a `refusal`: the
 * gate never allows it. A command with no shipping in it is `none`, and the gate says nothing.
 */
import { isAbsolute, resolve } from "node:path"

import { parseShell, type Simple } from "./words.js"

/** What kind of shipping an action is. */
export type ActionKind = "push" | "push-force" | "land" | "pr-create" | "pr-merge"

/** One thing a command ships: what, where (a key that includes the repository) and how. */
export type Action = {
  readonly kind: ActionKind
  /** The permit's target, as `permitKey` builds it: the repository is part of it. */
  readonly key: string
  /** A force push (or reset-like landing): its permit is single use. */
  readonly singleUse: boolean
}

/** What a command is, as far as shipping goes. */
export type Reading =
  | { readonly kind: "none" }
  | {
      readonly kind: "ships"
      /** The actions it ships, in order, own branches left out. */
      readonly actions: readonly Action[]
      /** Why the gate can't allow it however it is permitted; undefined when it can be. */
      readonly refusal?: string
    }

/** What the reader asks of git and of the runner's records. All lookups, none changes anything. */
export type Lookups = {
  /** The branch checked out at `cwd`; undefined when detached or not a checkout. */
  readonly branch: (cwd: string) => Promise<string | undefined>
  /** `branch`'s upstream as remote and branch names, from git config. */
  readonly upstream: (
    cwd: string,
    branch: string,
  ) => Promise<{ readonly remote: string; readonly branch: string } | undefined>
  /** The repository `cwd` is in, as `owner/repo` of its origin, else its git folder. */
  readonly repo: (cwd: string) => Promise<string | undefined>
  /** Whether `branch` is the agent's own: checked out in a worktree its terminal owns, not a home. */
  readonly own: (cwd: string, branch: string) => Promise<boolean>
}

/** The permit key of an action: its kind and target, the repository included. */
export const permitKey = {
  push: (repo: string, remote: string, branch: string, force: boolean): string =>
    `${force ? "push-force" : "push"}:${repo}:${remote}/${branch}`,
  land: (repo: string, branch: string): string => `land:${repo}:${branch}`,
  prCreate: (repo: string, base: string): string => `pr-create:${repo}:${base}`,
  prMerge: (repo: string, number: number): string => `pr-merge:${repo}#${number}`,
  prMergeBranch: (repo: string, branch: string): string => `pr-merge:${repo}@${branch}`,
}

const wrappers = new Set([
  "env",
  "command",
  "eval",
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "xargs",
  "sudo",
  "doas",
  "nohup",
  "time",
  "timeout",
  "exec",
  "watch",
  "nice",
  "setsid",
  "script",
  "busybox",
  "pwsh",
  "powershell",
  "cmd",
])

// Anything that moves a ref or the remote, as a verb of git or gh, wherever it is written.
const shippingText =
  /\b(?:git|gh)\b[^|;&\n]*?\b(?:push|merge|rebase|pull|cherry-pick|reset|checkout|switch|branch|update-ref|pr|api|release|workflow)\b/

const base = (program: string): string => program.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "")

// Merge strategies git ships; any other name runs a program named `git-merge-<name>`.
const strategies = new Set(["ort", "recursive", "resolve", "octopus", "ours", "subtree"])

// The most of a command the reader takes whole.
const maxCommand = 262_144

const ref = (name: string): string => name.replace(/^refs\/heads\//, "")

type Cursor = { cwd: string; readable: boolean }

/** Reads `command`, run in `cwd`, for what it ships. */
export const readCommand = async (
  command: string,
  cwd: string,
  lookups: Lookups,
): Promise<Reading> => {
  if (command.length > maxCommand)
    return shippingText.test(command)
      ? { kind: "ships", actions: [], refusal: "it is too long for Novadeck to read" }
      : { kind: "none" }
  return await readLine(command, cwd, lookups, 0)
}

const readLine = async (
  line: string,
  start: string,
  lookups: Lookups,
  depth: number,
): Promise<Reading> => {
  const parsed = parseShell(line)
  const actions: Action[] = []
  let refusal: string | undefined
  let ships = false
  let others = false
  const refuse = (why: string) => {
    ships = true
    refusal ??= why
  }
  const cursor: Cursor = { cwd: start, readable: true }
  for (const inner of parsed.inner) {
    if (depth >= 4) {
      if (shippingText.test(inner)) refuse("it nests commands too deeply to read")
      continue
    }
    const read = await readLine(inner, start, lookups, depth + 1)
    if (read.kind === "ships")
      refuse("it ships inside a substitution or a subshell, which can't be read")
  }
  let first = true
  for (const simple of parsed.commands) {
    const program = simple.words[0] === undefined ? "" : base(simple.words[0])
    const here = await readSimple(simple, program, cursor, lookups)
    if (here.kind === "cd") {
      first = false
      continue
    }
    if (here.kind === "none") {
      others = true
      first = false
      continue
    }
    ships = true
    if (here.refusal !== undefined) refuse(here.refusal)
    else actions.push(...here.actions)
    if (!first && simple.joint !== "&&" && simple.joint !== ";")
      refuse("it is piped or run in the background")
    first = false
  }
  if (!ships) return { kind: "none" }
  if (/(?:^|[^&])&\s*$/.test(line)) refusal ??= "it is run in the background"
  if (others && refusal === undefined && actions.length > 0)
    refusal = "it mixes a shipping command with other commands: run it on its own"
  else if (
    refusal === undefined &&
    parsed.commands.length > 1 &&
    parsed.commands.some((each, at) => at > 0 && each.joint !== "&&" && each.joint !== ";")
  )
    refusal = "it is piped or run in the background: run it on its own"
  return { kind: "ships", actions, ...(refusal !== undefined && { refusal }) }
}

type Simply =
  | { kind: "cd" }
  | { kind: "none" }
  | { kind: "ships"; actions: Action[]; refusal?: string }

const readSimple = async (
  simple: Simple,
  program: string,
  cursor: Cursor,
  lookups: Lookups,
): Promise<Simply> => {
  const { words } = simple
  if (words.length === 0) return { kind: "none" }
  if (program === "cd" || program === "pushd") {
    const dir = words[1]
    if (words.length === 2 && dir !== undefined && !simple.dynamic && dir !== "-")
      cursor.cwd = isAbsolute(dir) ? dir : resolve(cursor.cwd, dir)
    else cursor.readable = false
    return { kind: "cd" }
  }
  if (wrappers.has(program)) {
    return shippingText.test(words.slice(1).join(" ")) || shippingText.test(simple.text)
      ? {
          kind: "ships",
          actions: [],
          refusal: `it runs git or gh through \`${program}\`, which can't be read`,
        }
      : { kind: "none" }
  }
  if (program !== "git" && program !== "gh") return { kind: "none" }
  if (program === "git") return await readGit(simple, cursor, lookups)
  return await readGh(simple, cursor, lookups)
}

const unreadable = (why: string): Simply => ({ kind: "ships", actions: [], refusal: why })

// Environment variables that name a program or a place git runs, which a shipping command may
// not carry; GH_REPO alone is honoured.
const withAssigns = (simple: Simple): string | undefined => {
  const odd = simple.assigns.filter((each) => !each.startsWith("GH_REPO="))
  return odd.length > 0 ? "it sets environment variables for the command" : undefined
}

const readGit = async (simple: Simple, cursor: Cursor, lookups: Lookups): Promise<Simply> => {
  const { words } = simple
  let cwd = cursor.cwd
  let readable = cursor.readable
  let at = 1
  let configured = false
  // Git's own options, before the subcommand.
  for (; at < words.length; at += 1) {
    const word = words[at]!
    if (word === "-C") {
      const dir = words[at + 1]
      if (dir === undefined) break
      cwd = isAbsolute(dir) ? dir : resolve(cwd, dir)
      at += 1
    } else if (word === "-c" || word.startsWith("-c") || word.startsWith("--config-env")) {
      configured = true
      if (word === "-c" || word === "--config-env") at += 1
    } else if (
      word === "--exec-path" ||
      word.startsWith("--exec-path=") ||
      word.startsWith("--git-dir") ||
      word.startsWith("--work-tree") ||
      word === "--namespace"
    ) {
      configured = true
      if (!word.includes("=") && word !== "--exec-path") at += 1
    } else if (word.startsWith("-")) {
      continue
    } else break
  }
  const sub = words[at]
  const rest = words.slice(at + 1)
  if (sub === undefined) return { kind: "none" }
  const verbs = [
    "push",
    "merge",
    "pull",
    "rebase",
    "cherry-pick",
    "reset",
    "checkout",
    "switch",
    "branch",
    "update-ref",
  ]
  if (!verbs.includes(sub)) return { kind: "none" }
  const flag = (...names: string[]) => rest.some((word) => names.includes(word))
  // A subcommand that doesn't move anything.
  if (
    sub === "branch" &&
    !flag(
      "-f",
      "--force",
      "-M",
      "--move",
      "-C",
      "--copy",
      "-D",
      "-d",
      "--delete",
      "--set-upstream-to",
      "-u",
    )
  )
    return { kind: "none" }
  if (sub === "branch" && flag("-D", "-d", "--delete", "--set-upstream-to", "-u"))
    return { kind: "none" }
  if ((sub === "checkout" || sub === "switch") && !flag("-B", "-C", "--force-create"))
    return { kind: "none" }
  if (
    ["merge", "rebase", "cherry-pick", "pull"].includes(sub) &&
    flag("--abort", "--quit", "--continue", "--skip")
  )
    return { kind: "none" }
  if (sub === "merge" && flag("--no-commit")) return { kind: "none" }
  if (sub === "reset" && !flag("--hard", "--soft", "--keep", "--merge")) return { kind: "none" }
  // The shipping is read; from here, anything that can't be allowed says why.
  const odd = withAssigns(simple)
  if (odd !== undefined) return unreadable(odd)
  if (simple.dynamic) return unreadable("it holds an expansion, whose value Novadeck can't read")
  if (configured) return unreadable("it sets git options (-c, --git-dir) that can run a program")
  if (!readable) return unreadable("it follows a `cd` Novadeck can't read")
  if (
    rest.some(
      (word) =>
        word.startsWith("--exec") ||
        word.startsWith("--receive-pack") ||
        word.startsWith("--upload-pack"),
    )
  )
    return unreadable("it names a program to run (--exec, --receive-pack)")
  const repo = await lookups.repo(cwd)
  if (repo === undefined) return unreadable("Novadeck can't tell which repository it is in")
  if (sub === "push") return await readPush(rest, cwd, repo, lookups)
  if (sub === "update-ref") {
    const name = rest.find((word) => !word.startsWith("-"))
    if (name === undefined || !name.startsWith("refs/heads/"))
      return unreadable("it moves a ref that isn't a branch")
    return await moved(cwd, repo, ref(name), lookups)
  }
  if (sub === "branch" || sub === "checkout" || sub === "switch") {
    // `branch -f <name> [start]`, `checkout -B <name> [start]`.
    const positional = rest.filter((word) => !word.startsWith("-"))
    const index =
      sub === "branch"
        ? 0
        : rest.findIndex((word) => word === "-B" || word === "-C" || word === "--force-create") + 1
    const name = sub === "branch" ? positional[index] : rest[index]
    if (name === undefined) return unreadable("Novadeck can't tell which branch it moves")
    return await moved(cwd, repo, name, lookups)
  }
  if (sub === "merge" || sub === "pull") {
    for (let i = 0; i < rest.length; i += 1) {
      const word = rest[i]!
      const value =
        word === "-s" || word === "--strategy"
          ? rest[i + 1]
          : word.startsWith("--strategy=")
            ? word.slice(11)
            : word.startsWith("-s") && word.length > 2 && !word.startsWith("--")
              ? word.slice(2)
              : undefined
      if (value !== undefined && !strategies.has(value))
        return unreadable("it names a custom merge strategy, which runs a program")
    }
  }
  const branch = await lookups.branch(cwd)
  if (branch === undefined) return { kind: "none" }
  return await moved(cwd, repo, branch, lookups)
}

/** A ref move of `branch`: nothing when it is the agent's own, else a landing on it. */
const moved = async (
  cwd: string,
  repo: string,
  branch: string,
  lookups: Lookups,
): Promise<Simply> =>
  (await lookups.own(cwd, branch))
    ? { kind: "none" }
    : {
        kind: "ships",
        actions: [{ kind: "land", key: permitKey.land(repo, branch), singleUse: false }],
      }

const readPush = async (
  rest: readonly string[],
  cwd: string,
  repo: string,
  lookups: Lookups,
): Promise<Simply> => {
  let force = false
  const positional: string[] = []
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!
    if (word === "--") {
      positional.push(...rest.slice(i + 1))
      break
    }
    if (
      ["--mirror", "--all", "--tags", "--follow-tags", "--delete", "-d", "--prune"].includes(word)
    )
      return unreadable(`\`${word}\` pushes more than Novadeck can read`)
    if (
      word === "-f" ||
      word === "--force" ||
      word.startsWith("--force-with-lease") ||
      word === "--force-if-includes"
    )
      force = true
    else if (word === "-o" || word === "--push-option" || word === "--repo") i += 1
    else if (
      word.startsWith("-") &&
      !word.startsWith("--") &&
      word.length > 2 &&
      /f/.test(word.slice(1))
    )
      force = true
    else if (!word.startsWith("-")) positional.push(word)
  }
  const current = await lookups.branch(cwd)
  let remote = positional[0]
  const specs = positional.slice(1)
  if (remote === undefined) {
    const up = current === undefined ? undefined : await lookups.upstream(cwd, current)
    remote = up?.remote ?? "origin"
    if (specs.length === 0) {
      if (current === undefined) return unreadable("Novadeck can't tell which branch it pushes")
      specs.push(up === undefined ? current : `${current}:${up.branch}`)
    }
  } else if (specs.length === 0) {
    if (current === undefined) return unreadable("Novadeck can't tell which branch it pushes")
    const up = await lookups.upstream(cwd, current)
    specs.push(up !== undefined && up.remote === remote ? `${current}:${up.branch}` : current)
  }
  const actions: Action[] = []
  for (const spec of specs) {
    const plus = spec.startsWith("+")
    const [src = "", dst = src, ...extra] = (plus ? spec.slice(1) : spec).split(":")
    if (extra.length > 0 || /[*?[]/.test(spec))
      return unreadable("a refspec holds a pattern Novadeck can't read")
    if (src === "") return unreadable("it deletes a remote branch")
    if (spec.includes("refs/tags/") || (dst.startsWith("refs/") && !dst.startsWith("refs/heads/")))
      return unreadable("it pushes a ref that isn't a branch")
    const from = src === "HEAD" ? current : ref(src)
    const to = dst === "HEAD" ? current : ref(dst)
    if (from === undefined || to === undefined)
      return unreadable("Novadeck can't tell which branch it pushes")
    // Own: pushed to the remote branch of the same name.
    if (from === to && (await lookups.own(cwd, to))) continue
    const forced = force || plus
    actions.push({
      kind: forced ? "push-force" : "push",
      key: permitKey.push(repo, remote, to, forced),
      singleUse: forced,
    })
  }
  return actions.length === 0 ? { kind: "none" } : { kind: "ships", actions }
}

const readGh = async (simple: Simple, cursor: Cursor, lookups: Lookups): Promise<Simply> => {
  const words = simple.words.slice(1)
  let repoFlag: string | undefined = simple.assigns
    .find((each) => each.startsWith("GH_REPO="))
    ?.slice(8)
  const positional: string[] = []
  let admin = false
  let target: string | undefined
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!
    if (word === "-R" || word === "--repo") {
      repoFlag = words[i + 1]
      i += 1
    } else if (word.startsWith("--repo=")) repoFlag = word.slice(7)
    else if (word === "-B" || word === "--base") {
      target = words[i + 1]
      i += 1
    } else if (word.startsWith("--base=")) target = word.slice(7)
    else if (word === "--admin") admin = true
    else if (word.startsWith("-")) {
      // Flags with values that would otherwise read as positional.
      if (
        [
          "-t",
          "--title",
          "-b",
          "--body",
          "-F",
          "--body-file",
          "-H",
          "--head",
          "-a",
          "--assignee",
          "-l",
          "--label",
          "-r",
          "--reviewer",
          "-m",
          "--milestone",
          "--match-head-commit",
          "--subject",
          "-A",
          "--author-email",
          "-p",
          "--project",
        ].includes(word)
      )
        i += 1
    } else positional.push(word)
  }
  const [area, verb, subject] = positional
  if (area === "api") {
    const method = words.findIndex((word) => word === "-X" || word === "--method")
    const given = method >= 0 ? words[method + 1]?.toUpperCase() : undefined
    const writes =
      (given !== undefined && given !== "GET") ||
      words.some((word) => /^(-f|-F|--field|--raw-field|--input)/.test(word))
    return writes
      ? unreadable("a mutating `gh api` call ships something Novadeck can't read")
      : { kind: "none" }
  }
  if (area !== "pr" || (verb !== "create" && verb !== "merge" && verb !== "edit"))
    return { kind: "none" }
  if (verb === "edit" && target === undefined) return { kind: "none" }
  const odd = withAssigns(simple)
  if (odd !== undefined) return unreadable(odd)
  if (simple.dynamic) return unreadable("it holds an expansion, whose value Novadeck can't read")
  if (!cursor.readable) return unreadable("it follows a `cd` Novadeck can't read")
  const repo = repoFlag ?? (await lookups.repo(cursor.cwd))
  if (repo === undefined) return unreadable("Novadeck can't tell which repository it is in")
  if (verb === "merge") {
    if (admin)
      return unreadable(
        "`--admin` bypasses the PR's checks: only a grant that names it covers it, and no grant exists yet",
      )
    const number =
      subject === undefined
        ? undefined
        : (/^#?(\d+)$/.exec(subject)?.[1] ?? /\/pull\/(\d+)\/?$/.exec(subject)?.[1])
    if (number !== undefined)
      return {
        kind: "ships",
        actions: [
          { kind: "pr-merge", key: permitKey.prMerge(repo, Number(number)), singleUse: false },
        ],
      }
    const branch = subject ?? (await lookups.branch(cursor.cwd))
    if (branch === undefined) return unreadable("Novadeck can't tell which PR it merges")
    return {
      kind: "ships",
      actions: [{ kind: "pr-merge", key: permitKey.prMergeBranch(repo, branch), singleUse: false }],
    }
  }
  // `pr create` and `pr edit --base X` both open a PR into X.
  return {
    kind: "ships",
    actions: [
      { kind: "pr-create", key: permitKey.prCreate(repo, target ?? "@default"), singleUse: false },
    ],
  }
}
