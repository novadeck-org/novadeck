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
  let ships = false
  let others = false
  const refuse = (why: string) => {
    ships = true
    refusal ??= why
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
    if (here.refusal !== undefined) refuse(here.refusal)
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

const unreadable = (why: string): Simply => ({ kind: "ships", actions: [], refusal: why })

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
  if (sub === "update-ref") {
    // Its message (`-m <why>`) is no ref; any other option changes what it does.
    const refs: string[] = []
    for (let i = 0; i < rest.length; i += 1) {
      const word = rest[i]!
      if (word === "-m") i += 1
      else if (word === "--no-deref" || word === "--create-reflog") continue
      else if (word.startsWith("-"))
        return unreadable(`\`git update-ref ${word}\` moves refs in ways Novadeck can't read`)
      else refs.push(word)
    }
    const name = refs[0]
    if (name === undefined || !name.startsWith("refs/heads/"))
      return unreadable("it moves a ref that isn't a branch")
    return await moved(cwd, repo, [ref(name)], lookups)
  }
  if (sub === "branch") {
    // `branch -f <name> [start]`, `-m [old] <new>` and `-c [old] <new>`: the names it writes.
    if (
      options.some((word) =>
        word.startsWith("--")
          ? !branchOptions.has(word.split("=")[0]!)
          : word.startsWith("-") &&
            !word
              .slice(1)
              .split("")
              .every((c) => "fmMcCqt".includes(c)),
      )
    )
      return unreadable("it gives `git branch` an option Novadeck doesn't know")
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
      return await moved(cwd, repo, moves ? [old, fresh] : [fresh], lookups)
    }
    return await moved(cwd, repo, [names[0]!], lookups)
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
      if (extra.length > 0 || /[*?[]/.test(spec))
        return unreadable("a refspec holds a pattern Novadeck can't read")
      if (destination === "" || destination.startsWith("refs/remotes/")) continue
      if (destination.startsWith("refs/") && !destination.startsWith("refs/heads/"))
        return unreadable("it writes a ref that isn't a branch")
      targets.push(ref(destination))
    }
    if (sub === "fetch")
      return targets.length === 0 ? { kind: "none" } : await moved(cwd, repo, targets, lookups)
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
  return await moved(cwd, repo, targets, lookups)
}

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

const readPush = async (
  rest: readonly string[],
  cwd: string,
  repo: string,
  lookups: Lookups,
): Promise<Simply> => {
  let force = false
  let named: string | undefined
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
    else if (word === "--repo" || word.startsWith("--repo=")) {
      // The remote it names stands for the one a first word would, which is then a refspec.
      named = word === "--repo" ? rest[i + 1] : word.slice(7)
      if (word === "--repo") i += 1
    } else if (word === "-o" || word === "--push-option") i += 1
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
  let remote = named ?? positional[0]
  const specs = named === undefined ? positional.slice(1) : positional
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
const repoNamed = (text: string | undefined): string | undefined => {
  const parts = text?.split("/")
  return parts !== undefined && parts.length >= 2 && parts.length <= 3 && parts.every(Boolean)
    ? parts.slice(-2).join("/")
    : undefined
}

// A flag of `gh api` that makes it a write: a method, or a field or input.
const apiWrites = (words: readonly string[]): boolean => {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!
    if (word === "--") break
    let method: string | undefined
    if (word === "--method") method = words[i + 1]
    else if (word.startsWith("--method=")) method = word.slice(9)
    else if (/^-[A-Za-z]*X/.test(word)) method = word.slice(word.indexOf("X") + 1) || words[i + 1]
    else if (/^(-f|-F|--field|--raw-field|--input)/.test(word)) return true
    if (method !== undefined && method.replace(/^=/, "").toUpperCase() !== "GET") return true
  }
  return false
}

const readGh = async (simple: Simple, cursor: Cursor, lookups: Lookups): Promise<Simply> => {
  const words = simple.words.slice(1)
  const area = words[0]
  if (area === "api")
    return apiWrites(words.slice(1))
      ? unreadable("a mutating `gh api` call ships something Novadeck can't read")
      : { kind: "none" }
  if (area === "release" && words[1] === "create")
    return unreadable("it creates a release, and with it a tag, which Novadeck can't read")
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
  if (verb === "edit" && target === undefined && parsed.unknown === undefined)
    return { kind: "none" }
  const odd = withAssigns(simple)
  if (odd !== undefined) return unreadable(odd)
  if (simple.dynamic) return unreadable("it holds an expansion, whose value Novadeck can't read")
  if (!cursor.readable) return unreadable("it follows a `cd` Novadeck can't read")
  if (parsed.unknown !== undefined)
    return unreadable(`\`gh pr ${verb}\` has an option Novadeck doesn't know (${parsed.unknown})`)
  const named =
    parsed.seen.get("--repo") ??
    before ??
    simple.assigns.find((each) => each.startsWith("GH_REPO="))?.slice(8)
  let repo = named === undefined ? await lookups.repo(cursor.cwd) : repoNamed(named)
  if (repo === undefined)
    return unreadable(
      named === undefined
        ? "Novadeck can't tell which repository it is in"
        : "it names a repository Novadeck can't read",
    )
  const [subject, ...more] = parsed.positional
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
  const url =
    subject === undefined
      ? undefined
      : /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(subject)
  if (url !== null && url !== undefined) {
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
    if (parsed.seen.has("--admin"))
      return unreadable(
        "`--admin` bypasses the PR's checks: only a grant that names it covers it, and no grant exists yet",
      )
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
