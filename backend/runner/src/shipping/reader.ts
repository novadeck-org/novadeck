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
export type ActionKind =
  | "push"
  | "push-force"
  | "land"
  | "pr-create"
  | "pr-merge"
  | "pr-auto"
  | "pr-admin"

/** One thing a command ships: what, where (a key that includes the repository) and how. */
export type Action = {
  readonly kind: ActionKind
  /** The permit's target, as `permitKey` builds it: the repository is part of it. */
  readonly key: string
  /** A force push, a merge past the checks (or a reset-like landing): its permit is single use. */
  readonly singleUse: boolean
  /**
   * Permit keys that end when the command runs: `gh pr edit --base X` changes where a PR
   * merges, so the merge permits given for it as it was are void.
   */
  readonly voids?: readonly string[]
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
      /** What the person or agent can do about the refusal, where it isn't "run it on its own". */
      readonly remedy?: string
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
  /**
   * The repository `gh` acts on in `cwd` with no flag naming one, as `gh` resolves it without the
   * network: the remote `gh repo set-default` chose (`remote.<name>.gh-resolved`), else the only
   * remote. Undefined where it can't be told.
   */
  readonly ghRepo: (cwd: string) => Promise<string | undefined>
  /** The repository the remote `remote` (a name, or a URL) pushes to; undefined where it can't be told. */
  readonly remoteRepo: (cwd: string, remote: string) => Promise<string | undefined>
  /** Whether `name` is a tag here and no branch: what `git push <remote> <name>` then pushes. */
  readonly tag: (cwd: string, name: string) => Promise<boolean>
  /** Whether `branch` is the agent's own: checked out in a worktree its terminal owns, not a home. */
  readonly own: (cwd: string, branch: string) => Promise<boolean>
}

// Repositories are case-insensitive on GitHub: a remote's `Owner/Repo` and `-R owner/repo` are one.
const lc = (repo: string): string => repo.toLowerCase()

/** The permit key of an action: its kind and target, the repository included. */
export const permitKey = {
  push: (repo: string, remote: string, branch: string, force: boolean): string =>
    `${force ? "push-force" : "push"}:${lc(repo)}:${remote}/${branch}`,
  land: (repo: string, branch: string): string => `land:${lc(repo)}:${branch}`,
  prCreate: (repo: string, base: string): string => `pr-create:${lc(repo)}:${base}`,
  prMerge: (repo: string, number: number): string => `pr-merge:${lc(repo)}#${number}`,
  prMergeBranch: (repo: string, branch: string): string => `pr-merge:${lc(repo)}@${branch}`,
  // `--auto`: merges by itself once the checks pass. Its own target; a plain merge's permit never covers it.
  prAuto: (repo: string, number: number): string => `pr-auto:${lc(repo)}#${number}`,
  prAutoBranch: (repo: string, branch: string): string => `pr-auto:${lc(repo)}@${branch}`,
  // `--admin`: merges past the PR's required checks. Its own target, single use.
  prAdmin: (repo: string, number: number): string => `pr-admin:${lc(repo)}#${number}`,
  prAdminBranch: (repo: string, branch: string): string => `pr-admin:${lc(repo)}@${branch}`,
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
export const shippingVerbs = [
  "push",
  "merge",
  "rebase",
  "pull",
  "cherry-pick",
  "reset",
  "checkout",
  "switch",
  "branch",
  "update-ref",
  "pr",
  "api",
  "release",
  "workflow",
]
const shippingText = new RegExp(`\\b(?:git|gh)\\b[^|;&\\n]*?\\b(?:${shippingVerbs.join("|")})\\b`)

const base = (program: string): string => program.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "")

// Merge strategies git ships; any other name runs a program named `git-merge-<name>`.
const strategies = new Set(["ort", "recursive", "resolve", "octopus", "ours", "subtree"])

// The most of a command the reader takes whole.
const maxCommand = 262_144

const ref = (name: string): string => name.replace(/^refs\/heads\//, "")

// The redirects an allowed command may carry: output thrown away or joined, and input.
const harmless = (redirect: string): boolean =>
  redirect === "2>&1" ||
  redirect === ">/dev/null" ||
  redirect === "2>/dev/null" ||
  redirect.startsWith("<")

type Cursor = {
  cwd: string
  readable: boolean
  /** A `checkout` or `switch` ran earlier in the command: the branch checked out is no longer the one Novadeck can look up. */
  switched: boolean
}

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
  let remedy: string | undefined
  let ships = false
  let others = false
  const refuse = (why: string, how?: string) => {
    ships = true
    if (refusal === undefined) {
      refusal = why
      remedy = how
    }
  }
  const cursor: Cursor = { cwd: start, readable: true, switched: false }
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
  let redirected = false
  for (const simple of parsed.commands) {
    const program = simple.words[0] === undefined ? "" : base(simple.words[0])
    if (!simple.redirects.every(harmless)) redirected = true
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
    if (here.refusal !== undefined) refuse(here.refusal, here.remedy)
    else actions.push(...here.actions)
    if (!first && simple.joint !== "&&" && simple.joint !== ";")
      refuse("it is piped or run in the background")
    first = false
  }
  if (!ships) return { kind: "none" }
  if (redirected) refusal ??= "it redirects into a file, which a permit doesn't cover"
  if (/(?:^|[^&])&\s*$/.test(line)) refusal ??= "it is run in the background"
  if (others && refusal === undefined && actions.length > 0)
    refusal = "it mixes a shipping command with other commands: run it on its own"
  else if (
    refusal === undefined &&
    parsed.commands.length > 1 &&
    parsed.commands.some((each, at) => at > 0 && each.joint !== "&&" && each.joint !== ";")
  )
    refusal = "it is piped or run in the background: run it on its own"
  return {
    kind: "ships",
    actions,
    ...(refusal !== undefined && { refusal }),
    ...(refusal !== undefined && remedy !== undefined && { remedy }),
  }
}

type Simply =
  | { kind: "cd" }
  | { kind: "none" }
  | { kind: "ships"; actions: Action[]; refusal?: string; remedy?: string }

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
  // After a switch of branch in the same command, the checked-out branch is no longer the one
  // looked up: a segment that goes by it can't be read exactly.
  let current = false
  const after: Lookups = cursor.switched
    ? {
        ...lookups,
        branch: (folder) => {
          current = true
          return lookups.branch(folder)
        },
      }
    : lookups
  const read =
    program === "git" ? await readGit(simple, cursor, after) : await readGh(simple, cursor, after)
  return current
    ? unreadable(
        "it switches branch first, so Novadeck can't tell where this lands: run the switch and this command as separate commands",
      )
    : read
}

const unreadable = (why: string, remedy?: string): Simply => ({
  kind: "ships",
  actions: [],
  refusal: why,
  ...(remedy !== undefined && { remedy }),
})

// Environment variables that name a program or a place git runs, which a shipping command may
// not carry; GH_REPO alone is honoured.
const withAssigns = (simple: Simple): string | undefined => {
  const odd = simple.assigns.filter((each) => !each.startsWith("GH_REPO="))
  return odd.length > 0 ? "it sets environment variables for the command" : undefined
}

// Options that take a value in their own word, for the verbs whose positional words matter.
const pullValued = new Set([
  "-s",
  "--strategy",
  "-X",
  "--strategy-option",
  "--depth",
  "--deepen",
  "--shallow-since",
  "--shallow-exclude",
  "-j",
  "--jobs",
  "-o",
  "--server-option",
  "--negotiation-tip",
  "--refmap",
])
const valued: { readonly [verb: string]: ReadonlySet<string> } = {
  rebase: new Set(["--onto", "-s", "--strategy", "-X", "--strategy-option", "--whitespace", "-C"]),
  pull: pullValued,
  fetch: pullValued,
}

// What `git branch` takes when it moves or copies a branch; any other option is unknown.
const branchOptions = new Set([
  "--force",
  "--move",
  "--copy",
  "--quiet",
  "--no-track",
  "--track",
  "--create-reflog",
  "--no-create-reflog",
])

/** The words of `rest` that are positional: no options, nor the values of `names`. */
const positionals = (rest: readonly string[], names: ReadonlySet<string> = new Set()): string[] => {
  const out: string[] = []
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!
    if (word === "--") {
      out.push(...rest.slice(i + 1))
      break
    }
    if (names.has(word)) i += 1
    else if (!word.startsWith("-")) out.push(word)
  }
  return out
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
    "fetch",
    "rebase",
    "cherry-pick",
    "reset",
    "checkout",
    "switch",
    "branch",
    "update-ref",
  ]
  if (!verbs.includes(sub)) return { kind: "none" }
  // Whatever it does after, the branch checked out may now be another.
  if (sub === "checkout" || sub === "switch") cursor.switched = true
  // Options as written before any `--`: whole (`--force`, `--force=x`) or as one of a cluster of
  // short ones (`-fB`).
  const options = rest.includes("--") ? rest.slice(0, rest.indexOf("--")) : rest
  const long = (...names: string[]) =>
    options.some((word) => names.some((name) => word === name || word.startsWith(`${name}=`)))
  const short = (letters: string) =>
    options.some(
      (word) => /^-[^-]/.test(word) && [...letters].some((c) => word.slice(1).includes(c)),
    )
  const flag = (...names: string[]) => rest.some((word) => names.includes(word))
  const branching = short("fmMcC") || long("--force", "--move", "--copy")
  // A subcommand that doesn't move anything.
  if (sub === "branch" && (short("dD") || long("--delete", "--set-upstream-to") || short("u")))
    return { kind: "none" }
  if (sub === "branch" && !branching) return { kind: "none" }
  if (sub === "checkout" && !short("B")) return { kind: "none" }
  if (sub === "switch" && !(short("C") || long("--force-create"))) return { kind: "none" }
  if (
    ["merge", "rebase", "cherry-pick", "pull"].includes(sub) &&
    flag("--abort", "--quit", "--continue", "--skip")
  )
    return { kind: "none" }
  // A reset that names nothing to move to, or only paths, leaves the branch where it is.
  if (
    sub === "reset" &&
    !long("--hard", "--soft", "--keep", "--merge", "--mixed") &&
    (rest.includes("--") || positionals(rest).length === 0)
  )
    return { kind: "none" }
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
    ) ||
    (sub === "rebase" && short("x"))
  )
    return unreadable("it names a program to run (--exec, --receive-pack)")
  const repo = await lookups.repo(cwd)
  if (repo === undefined) return unreadable("Novadeck can't tell which repository it is in")
  if (sub === "push") return await readPush(rest, cwd, repo, lookups)
  // What it does that the gate doesn't model (an option, a pattern, a ref that isn't a branch):
  // left alone, unless it comes with a guarded target.
  let skipped: Skipped | undefined
  if (sub === "update-ref") {
    // Its message (`-m <why>`) is no ref; any other option changes what it does.
    const refs: string[] = []
    for (let i = 0; i < rest.length; i += 1) {
      const word = rest[i]!
      if (word === "-m") i += 1
      else if (word === "--no-deref" || word === "--create-reflog") continue
      else if (word.startsWith("-")) skipped ??= unknownOption(word, "update-ref")
      else refs.push(word)
    }
    const name = refs[0]
    // A ref that isn't a branch is left alone too.
    if (name === undefined || !name.startsWith("refs/heads/")) return { kind: "none" }
    return alone(await moved(cwd, repo, [ref(name)], lookups), skipped)
  }
  if (sub === "branch") {
    // `branch -f <name> [start]`, `-m [old] <new>` and `-c [old] <new>`: the names it writes.
    const unknown = options.find((word) =>
      word.startsWith("--")
        ? !branchOptions.has(word.split("=")[0]!)
        : word.startsWith("-") &&
          !word
            .slice(1)
            .split("")
            .every((c) => "fmMcCqt".includes(c)),
    )
    if (unknown !== undefined) skipped = unknownOption(unknown, "branch")
    const names = positionals(rest)
    const current = await lookups.branch(cwd)
    const moves = short("mM") || long("--move")
    const copies = short("cC") || long("--copy")
    if (names.length === 0 || names.length > 2)
      return unreadable("Novadeck can't tell which branch it moves")
    const old = names.length === 2 ? names[0]! : current
    const fresh = names.length === 2 ? names[1]! : names[0]!
    if (moves || copies) {
      if (old === undefined) return unreadable("Novadeck can't tell which branch it moves")
      // A move also takes `old` away; a copy only writes `fresh`.
      return alone(await moved(cwd, repo, moves ? [old, fresh] : [fresh], lookups), skipped)
    }
    return alone(await moved(cwd, repo, [names[0]!], lookups), skipped)
  }
  if (sub === "checkout" || sub === "switch") {
    // `checkout -B <name> [start]` or `-fB <name>`, `switch -C <name> [start]`.
    const letter = sub === "checkout" ? "B" : "C"
    const index = rest.findIndex((word) => /^-[^-]/.test(word) && word.slice(1).includes(letter))
    const cluster = index < 0 ? undefined : rest[index]
    const name =
      cluster === undefined
        ? rest[rest.findIndex((word) => word === "--force-create") + 1]
        : cluster.slice(cluster.indexOf(letter) + 1) || rest[index + 1]
    if (name === undefined || name.startsWith("-"))
      return unreadable("Novadeck can't tell which branch it moves")
    return await moved(cwd, repo, [name], lookups)
  }
  const targets: string[] = []
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
  if (sub === "pull" || sub === "fetch") {
    // `<remote> a:b` writes the local branch b, whichever branch is checked out.
    for (const spec of positionals(rest, valued[sub]).slice(1)) {
      if (!spec.includes(":")) continue
      const [, destination = "", ...extra] = (spec.startsWith("+") ? spec.slice(1) : spec).split(
        ":",
      )
      if (extra.length > 0 || /[*?[]/.test(spec)) {
        skipped ??= separately("a refspec pattern", sub)
        continue
      }
      if (destination === "" || destination.startsWith("refs/remotes/")) continue
      if (destination.startsWith("refs/") && !destination.startsWith("refs/heads/")) {
        skipped ??= separately("a ref that isn't a branch", sub)
        continue
      }
      targets.push(ref(destination))
    }
    if (sub === "fetch")
      return alone(
        targets.length === 0 ? { kind: "none" } : await moved(cwd, repo, targets, lookups),
        skipped,
      )
  }
  if (sub === "rebase") {
    // `rebase <upstream> <branch>` switches to <branch> first and moves it.
    const named = positionals(rest, valued.rebase)
    if (named.length > 2) return unreadable("Novadeck can't tell which branch it rebases")
    if (named[1] !== undefined) targets.push(ref(named[1]))
  }
  if (targets.length === 0 || sub !== "rebase") {
    const branch = await lookups.branch(cwd)
    if (branch === undefined && targets.length === 0) return { kind: "none" }
    if (branch !== undefined) targets.push(branch)
  }
  return alone(await moved(cwd, repo, targets, lookups), skipped)
}

/** What the gate leaves alone in a command, and what to do where it comes with a guarded target. */
type Skipped = { readonly why: string; readonly remedy: string }

const unknownOption = (word: string, verb: string): Skipped => ({
  why: `it has an option Novadeck doesn't know (${word}), together with a branch that needs a permit`,
  remedy: `Run \`git ${verb}\` without it, in a command of its own.`,
})

const separately = (what: string, verb: string): Skipped => ({
  why: `it also does ${what}, which Novadeck leaves alone, together with a branch that needs a permit`,
  remedy: `${verb[0]!.toUpperCase()}${verb.slice(1)} the branch and ${what} separately.`,
})

/**
 * `read`, the guarded part of a command, as it stands: where the command also does something
 * the gate doesn't model, it is denied, as a permit's allow must never carry the rest; nothing
 * guarded, and it is left alone.
 */
const alone = (read: Simply, skipped: Skipped | undefined): Simply =>
  skipped === undefined || read.kind !== "ships" ? read : unreadable(skipped.why, skipped.remedy)

/** A ref move of `branches`: nothing for the agent's own, else a landing on each of the others. */
const moved = async (
  cwd: string,
  repo: string,
  branches: readonly string[],
  lookups: Lookups,
): Promise<Simply> => {
  const actions: Action[] = []
  for (const branch of new Set(branches))
    if (!(await lookups.own(cwd, branch)))
      actions.push({ kind: "land", key: permitKey.land(repo, branch), singleUse: false })
  return actions.length === 0 ? { kind: "none" } : { kind: "ships", actions }
}

// The options of `git push` the reader knows. A word that starts with `-` and is none of these
// (or a cluster of the short ones below) is one it doesn't model.
const pushLong = new Set([
  "--force",
  "--force-if-includes",
  "--no-force-if-includes",
  "--no-force-with-lease",
  "--dry-run",
  "--porcelain",
  "--progress",
  "--quiet",
  "--verbose",
  "--set-upstream",
  "--thin",
  "--no-thin",
  "--verify",
  "--no-verify",
  "--atomic",
  "--no-atomic",
  "--signed",
  "--no-signed",
  "--no-recurse-submodules",
  "--ipv4",
  "--ipv6",
  "--no-prune",
  "--no-follow-tags",
  "--help",
])
// Short ones: force, dry-run, quiet, verbose, upstream, ipv4, ipv6, help.
const pushShort = new Set(["f", "n", "q", "v", "u", "4", "6", "h"])

const readPush = async (
  rest: readonly string[],
  cwd: string,
  repo: string,
  lookups: Lookups,
): Promise<Simply> => {
  let force = false
  let named: string | undefined
  // What the gate doesn't model: a tag, every branch, a delete, a pattern, an option it lacks.
  let skipped: Skipped | undefined
  // A delete, `--all` or `--mirror`: the words after the remote aren't refspecs to push.
  let others = false
  let tags = false
  const positional: string[] = []
  const skip = (what: string) => {
    skipped ??= separately(what, "push")
  }
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!
    if (word === "--") {
      positional.push(...rest.slice(i + 1))
      break
    }
    if (word === "--tags") {
      tags = true
      skip("the tags")
    } else if (word === "--follow-tags") skip("the tags it follows")
    else if (word === "--prune") skip("a prune of the remote's branches")
    else if (word === "--all" || word === "--branches" || word === "--mirror") {
      others = true
      skip(`every branch (${word})`)
    } else if (word === "--delete") {
      others = true
      skip("a remote delete")
    } else if (
      word === "-f" ||
      word === "--force" ||
      word.startsWith("--force-with-lease") ||
      word === "--force-if-includes"
    )
      force = true
    else if (word === "--repo" || word.startsWith("--repo=")) {
      // The remote it names stands for the one a first word would, which is then a refspec.
      named = word === "--repo" ? rest[i + 1] : word.slice(7)
      if (word === "--repo") i += 1
    } else if (word === "--push-option") i += 1
    else if (word.startsWith("--push-option=") || word.startsWith("--signed=")) continue
    else if (word.startsWith("--recurse-submodules")) continue
    else if (word.startsWith("--")) {
      if (!pushLong.has(word)) {
        skipped ??= {
          why: `it has an option Novadeck doesn't know (${word}), together with a branch that needs a permit`,
          remedy: "Push the branch without it, in a command of its own.",
        }
      }
    } else if (word.startsWith("-") && word.length > 1) {
      // A cluster of short options: `-fu`, `-d`, `-ofoo`.
      for (let at = 1; at < word.length; at += 1) {
        const letter = word[at]!
        if (letter === "o") {
          if (at === word.length - 1) i += 1
          break
        }
        if (letter === "f") force = true
        else if (letter === "d") {
          others = true
          skip("a remote delete")
        } else if (!pushShort.has(letter)) {
          skipped ??= {
            why: `it has an option Novadeck doesn't know (${word}), together with a branch that needs a permit`,
            remedy: "Push the branch without it, in a command of its own.",
          }
          break
        }
      }
    } else positional.push(word)
  }
  // A delete, `--all` or `--mirror` has no branch to read; `--tags` alone pushes only tags.
  if (others) return { kind: "none" }
  const current = await lookups.branch(cwd)
  let remote = named ?? positional[0]
  const specs = named === undefined ? positional.slice(1) : positional
  if (tags && specs.length === 0) return { kind: "none" }
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
  // Where it goes: the repository of the remote it pushes to, which gh's own choice isn't.
  const target = (await lookups.remoteRepo(cwd, remote)) ?? repo
  const actions: Action[] = []
  for (const spec of specs) {
    const plus = spec.startsWith("+")
    const [src = "", dst = src, ...extra] = (plus ? spec.slice(1) : spec).split(":")
    if (extra.length > 0 || /[*?[]/.test(spec)) {
      skip("a refspec pattern")
      continue
    }
    if (src === "") {
      skip("a remote delete")
      continue
    }
    if (
      spec.includes("refs/tags/") ||
      (dst.startsWith("refs/") && !dst.startsWith("refs/heads/"))
    ) {
      skip("a ref that isn't a branch")
      continue
    }
    const from = src === "HEAD" ? current : ref(src)
    const to = dst === "HEAD" ? current : ref(dst)
    if (from === undefined || to === undefined)
      return unreadable("Novadeck can't tell which branch it pushes")
    // Own: pushed to the remote branch of the same name.
    if (from === to && (await lookups.own(cwd, to))) continue
    // A bare name that is a tag (and no branch) pushes the tag.
    if (from === to && !spec.includes(":") && (await lookups.tag(cwd, to))) {
      skip("a tag")
      continue
    }
    const forced = force || plus
    actions.push({
      kind: forced ? "push-force" : "push",
      key: permitKey.push(target, remote, to, forced),
      singleUse: forced,
    })
  }
  return alone(actions.length === 0 ? { kind: "none" } : { kind: "ships", actions }, skipped)
}

// The flags of each `gh pr` verb the reader acts on, as [short, long, takes a value]: a flag that
// isn't here is unknown, and a command with one is never allowed. The tables are per verb because
// a letter means different things in each (`-r` is `--rebase` in `merge`, `--reviewer` in `create`).
type Flag = readonly [short: string | undefined, long: string, value: boolean]
const helpFlag: Flag = ["h", "--help", false]
const repoFlag: Flag = ["R", "--repo", true]
const bodyFlags: readonly Flag[] = [
  ["b", "--body", true],
  ["F", "--body-file", true],
]
const prFlags: { readonly [verb: string]: readonly Flag[] } = {
  create: [
    helpFlag,
    repoFlag,
    ...bodyFlags,
    ["d", "--draft", false],
    ["f", "--fill", false],
    [undefined, "--fill-first", false],
    [undefined, "--fill-verbose", false],
    [undefined, "--no-maintainer-edit", false],
    ["w", "--web", false],
    [undefined, "--dry-run", false],
    ["e", "--editor", false],
    ["a", "--assignee", true],
    ["B", "--base", true],
    ["H", "--head", true],
    ["l", "--label", true],
    ["m", "--milestone", true],
    ["p", "--project", true],
    ["r", "--reviewer", true],
    ["T", "--template", true],
    ["t", "--title", true],
    [undefined, "--recover", true],
  ],
  merge: [
    helpFlag,
    repoFlag,
    ...bodyFlags,
    [undefined, "--admin", false],
    [undefined, "--auto", false],
    [undefined, "--disable-auto", false],
    ["d", "--delete-branch", false],
    ["m", "--merge", false],
    ["r", "--rebase", false],
    ["s", "--squash", false],
    ["t", "--subject", true],
    ["A", "--author-email", true],
    [undefined, "--match-head-commit", true],
  ],
  edit: [
    helpFlag,
    repoFlag,
    ...bodyFlags,
    ["B", "--base", true],
    ["m", "--milestone", true],
    ["t", "--title", true],
    [undefined, "--remove-milestone", false],
    [undefined, "--add-assignee", true],
    [undefined, "--add-label", true],
    [undefined, "--add-project", true],
    [undefined, "--add-reviewer", true],
    [undefined, "--remove-assignee", true],
    [undefined, "--remove-label", true],
    [undefined, "--remove-project", true],
    [undefined, "--remove-reviewer", true],
  ],
}

type Flags = {
  readonly positional: readonly string[]
  /** Each flag seen, by its long name: its value, or "" for one that takes none. */
  readonly seen: ReadonlyMap<string, string>
  /** The first flag the verb doesn't have, as written. */
  readonly unknown?: string
}

/** `words` as the flags `table` lists read them: spaced, attached (`-Bmain`, `--base=x`) or clustered (`-dm`). */
const parseFlags = (words: readonly string[], table: readonly Flag[]): Flags => {
  const positional: string[] = []
  const seen = new Map<string, string>()
  let unknown: string | undefined
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!
    if (word === "--") {
      positional.push(...words.slice(i + 1))
      break
    }
    if (word.startsWith("--")) {
      const [name = "", ...value] = word.split("=")
      const flag = table.find((each) => each[1] === name)
      if (flag === undefined) unknown ??= word
      else if (!flag[2]) seen.set(name, "")
      else seen.set(name, value.length > 0 ? value.join("=") : (words[++i] ?? ""))
    } else if (word.startsWith("-") && word.length > 1) {
      for (let at = 1; at < word.length; at += 1) {
        const flag = table.find((each) => each[0] === word[at])
        if (flag === undefined) {
          unknown ??= word
          break
        }
        if (!flag[2]) seen.set(flag[1], "")
        else {
          seen.set(flag[1], word.slice(at + 1).replace(/^=/, "") || (words[++i] ?? ""))
          break
        }
      }
    } else positional.push(word)
  }
  return { positional, seen, ...(unknown !== undefined && { unknown }) }
}

/** `owner/repo` of what `gh` takes for a repository: `[HOST/]OWNER/REPO`. */
export const repoNamed = (text: string | undefined): string | undefined => {
  const parts = text?.split("/")
  return parts !== undefined && parts.length >= 2 && parts.length <= 3 && parts.every(Boolean)
    ? parts.slice(-2).join("/")
    : undefined
}

const readGh = async (simple: Simple, cursor: Cursor, lookups: Lookups): Promise<Simply> => {
  const words = simple.words.slice(1)
  const area = words[0]
  // A writing `gh api` call and a release (with its tag) aren't modelled: left alone.
  if (area !== "pr") return { kind: "none" }
  // `gh pr -R owner/repo merge 12`: the repository flag may come before the verb.
  let before: string | undefined
  let at = 1
  for (; at < words.length && words[at]!.startsWith("-"); at += 1) {
    const word = words[at]!
    if (word === "-R" || word === "--repo") {
      before = words[at + 1]
      at += 1
    } else if (word.startsWith("--repo=")) before = word.slice(7)
    else if (/^-R./.test(word)) before = word.slice(2).replace(/^=/, "")
    else
      return words.some((each) => ["create", "merge", "edit"].includes(each))
        ? unreadable(`it puts ${word} before the verb of \`gh pr\`, which Novadeck can't read`)
        : { kind: "none" }
  }
  const verb = words[at]
  if (verb === undefined || !["create", "merge", "edit"].includes(verb)) return { kind: "none" }
  const parsed = parseFlags(words.slice(at + 1), prFlags[verb]!)
  const target = parsed.seen.get("--base")
  if (verb === "edit" && target === undefined) return { kind: "none" }
  // `--disable-auto` only turns auto-merge off: it ships nothing (gh refuses it with the others).
  if (verb === "merge" && parsed.seen.has("--disable-auto") && parsed.unknown === undefined)
    return { kind: "none" }
  const odd = withAssigns(simple)
  if (odd !== undefined) return unreadable(odd)
  if (simple.dynamic) return unreadable("it holds an expansion, whose value Novadeck can't read")
  if (!cursor.readable) return unreadable("it follows a `cd` Novadeck can't read")
  if (parsed.unknown !== undefined)
    return unreadable(`\`gh pr ${verb}\` has an option Novadeck doesn't know (${parsed.unknown})`)
  if (verb === "merge" && parsed.seen.has("--admin") && parsed.seen.has("--auto"))
    return unreadable("gh refuses `--admin` together with `--auto`")
  const named =
    parsed.seen.get("--repo") ??
    before ??
    simple.assigns.find((each) => each.startsWith("GH_REPO="))?.slice(8)
  const [subject, ...more] = parsed.positional
  // The repository `gh` acts on: the command's own word for it, else a PR's URL, else the
  // clone's default (`gh repo set-default`), else its only remote.
  const urlOf =
    verb === "create" || subject === undefined
      ? null
      : /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(subject)
  let repo =
    named !== undefined ? repoNamed(named) : (urlOf?.[1] ?? (await lookups.ghRepo(cursor.cwd)))
  if (repo === undefined)
    return named === undefined
      ? unreadable(
          "it can't tell which repository gh acts on here without the network: the clone has no default and not exactly one remote",
          "Name the repository with -R owner/repo.",
        )
      : unreadable("it names a repository Novadeck can't read")
  if (verb === "create") {
    if (subject !== undefined || more.length > 0)
      return unreadable("`gh pr create` takes no argument Novadeck knows")
    return {
      kind: "ships",
      actions: [
        {
          kind: "pr-create",
          key: permitKey.prCreate(repo, target ?? "@default"),
          singleUse: false,
        },
      ],
    }
  }
  if (more.length > 0) return unreadable(`\`gh pr ${verb}\` names more than one PR`)
  // A PR's URL names its repository, which must be the one the command resolves.
  const url = urlOf
  if (url !== null) {
    if (url[1]!.toLowerCase() !== repo.toLowerCase())
      return unreadable(
        `the PR's URL names ${url[1]}, not the repository the command is in (${repo})`,
      )
    repo = url[1]!
  }
  const number = subject === undefined ? undefined : (/^#?(\d+)$/.exec(subject)?.[1] ?? url?.[2])
  const branch = number === undefined ? (subject ?? (await lookups.branch(cursor.cwd))) : undefined
  if (number === undefined && branch === undefined)
    return unreadable(`Novadeck can't tell which PR \`gh pr ${verb}\` names`)
  const merge =
    number === undefined
      ? permitKey.prMergeBranch(repo, branch!)
      : permitKey.prMerge(repo, Number(number))
  if (verb === "merge") {
    const admin = parsed.seen.has("--admin")
    const key =
      number === undefined
        ? (admin ? permitKey.prAdminBranch : permitKey.prAutoBranch)(repo, branch!)
        : (admin ? permitKey.prAdmin : permitKey.prAuto)(repo, Number(number))
    if (admin || parsed.seen.has("--auto"))
      return {
        kind: "ships",
        actions: [{ kind: admin ? "pr-admin" : "pr-auto", key, singleUse: admin }],
      }
    return { kind: "ships", actions: [{ kind: "pr-merge", key: merge, singleUse: false }] }
  }
  // `pr edit --base X` opens the PR into X, as far as shipping goes, and the merge permits given
  // for it before are void: they were for where it merged then.
  return {
    kind: "ships",
    actions: [
      {
        kind: "pr-create",
        key: permitKey.prCreate(repo, target ?? "@default"),
        singleUse: false,
        voids: [merge],
      },
    ],
  }
}
