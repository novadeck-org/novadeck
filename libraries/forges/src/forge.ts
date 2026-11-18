// The contract every forge implements, and what crosses it. A forge never spawns a program or
// opens a connection by itself: the caller hands it a `Run` and a `fetch`, so the same code
// runs wherever those can, and tests script them.

export type ForgeName = "github" | "gitlab" | "azure"

/** What running a program answered: its standard output, or why there is none. */
export type Ran =
  // `said` is what it wrote to standard error, where the caller keeps it: some tools write
  // what they report there even when they succeed.
  | { readonly ok: true; readonly out: string; readonly said?: string | undefined }
  | {
      readonly ok: false
      // `missing`: no such program; `exit`: it ended with a failing status; `timeout`: it was
      // stopped for taking too long.
      readonly kind: "missing" | "exit" | "timeout"
      // What it wrote to standard error (or out), for telling one failure from another.
      readonly said: string
    }

/**
 * Runs a program with arguments, no shell between, and answers once it ends. The caller
 * decides where it is found, its environment, its timeout and its working folder; it must
 * never prompt (a program that would read a terminal gets none).
 */
export type Run = (program: string, args: readonly string[]) => Promise<Ran>

export type Fetch = typeof globalThis.fetch

/** A git remote's address, parsed: the host and the path's segments, without `.git`. */
export type Remote = {
  readonly host: string
  // For `git@github.com:owner/name.git`, ["owner", "name"].
  readonly path: readonly string[]
  // The user named before the host, as `git` in `git@host:…` or `org` in `org@dev.azure.com/…`.
  readonly user?: string | undefined
}

/** A repository on a forge, as its API names it. */
export type Repository =
  | {
      readonly forge: "github"
      readonly host: string
      readonly owner: string
      readonly name: string
    }
  // `path` is the project's full path, subgroups included ("group/sub/project").
  | { readonly forge: "gitlab"; readonly host: string; readonly path: string }
  | {
      readonly forge: "azure"
      readonly host: string
      readonly organization: string
      readonly project: string
      readonly name: string
    }

/** A bearer token for a host, from the forge's tool, and when it stops working if it says. */
export type Token = {
  readonly value: string
  // Epoch milliseconds; absent where the tool doesn't say (a token that lasts until revoked).
  readonly expiresAt?: number | undefined
}

/** A branch's pull request (a merge request, on GitLab). */
export type PullRequest = {
  readonly number: number
  readonly url: string
  readonly title: string
  // `draft` and `open` are open, one not yet ready for review and one that is.
  readonly state: "draft" | "open" | "merged" | "closed"
  // How its checks stand on its latest commit, for an open one. Absent where the forge couldn't
  // say (a token that can't read checks, a read that failed), and on a merged or closed one.
  readonly ci?: Ci | undefined
  // The branch it targets, where the forge says (a stacked pull request targets another's branch).
  readonly base?: string | undefined
  // The checks of an open one that have not finished, where the forge could list them; absent
  // where it couldn't, which says nothing of whether any run.
  readonly checks?: readonly Check[] | undefined
}

/**
 * A check that has not finished: waiting for a runner (`queued`) or running. `since` is when
 * it was queued or started, epoch milliseconds, where the forge says. `runner` names the kind
 * of runner it needs or holds (GitHub's `runs-on` labels, GitLab's job tags, Azure's agent
 * pool), where the forge says; a forge that can't leaves it out.
 */
export type Check = {
  readonly name: string
  readonly state: "queued" | "running"
  readonly since?: number | undefined
  readonly runner?: string | undefined
}

/** How a pull request's checks stand: one failed, any still running, all passed, or none ran. */
export type Ci = "failing" | "running" | "passed" | "none"

/**
 * Why there is no answer, and whether the person can do something about it. `fix` is the
 * command that mends it, where one does.
 */
export type Problem =
  // The forge's tool isn't installed.
  | { readonly kind: "missing" }
  // The tool isn't signed in to the host; `fix` signs in.
  | { readonly kind: "signed-out"; readonly fix: string }
  // The host turned the token away: a missing scope, single sign-on not granted, another
  // tenant. `fix` where a command can mend it.
  | { readonly kind: "refused"; readonly fix?: string | undefined }
  // Offline, the host failing (5xx) or too slow: try again later, telling nobody.
  | { readonly kind: "unreachable" }
  // Rate limited until then (epoch milliseconds).
  | { readonly kind: "limited"; readonly until: number }
  // Anything else, as it said: logged, telling nobody.
  | { readonly kind: "unknown"; readonly said: string }

/** One forge: how to read its remotes, get a token from its tool, and find pull requests. */
export type Forge = {
  readonly name: ForgeName
  // Its command-line tool: "gh", "glab", "az".
  readonly program: string
  // The host its tool signs in to without being told one (github.com, gitlab.com,
  // dev.azure.com).
  readonly defaultHost: string
  /**
   * The repository a remote names where this forge could host it. A host the forge is known
   * by (github.com; dev.azure.com and *.visualstudio.com by their path's shape) is claimed
   * outright; any other host only when `hosts` (the hosts its tool is signed in to, from
   * `signedIn`) has it, as a GitHub Enterprise or a self-managed GitLab.
   */
  readonly repository: (remote: Remote, hosts?: readonly string[]) => Repository | undefined
  /** The hosts its tool is signed in to; a Problem where the tool is missing or fails. */
  readonly signedIn: (run: Run) => Promise<readonly string[] | Problem>
  /** A token for the host, from its tool. Never stored by the forge. */
  readonly token: (run: Run, host: string) => Promise<Token | Problem>
  /**
   * The pull requests whose source branch is one of `branches`, in the repository itself (a
   * fork's same-named branch is not one), by branch: an open one before the latest merged,
   * before the latest closed. A branch with none is not in the map; a repository the token
   * can't see answers an empty map.
   */
  readonly pullRequests: (
    fetch: Fetch,
    token: Token,
    repository: Repository,
    branches: readonly string[],
  ) => Promise<ReadonlyMap<string, PullRequest> | Problem>
  /** What the person runs to sign the tool in to the host. */
  readonly signIn: (host: string) => string
}

/** Whether a forge's answer is a Problem. */
export const isProblem = (value: unknown): value is Problem =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  typeof (value as { kind: unknown }).kind === "string" &&
  !("value" in value)
