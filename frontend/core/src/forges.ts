import type { Store } from "./store"

// Forges: where a repository's pull requests live (GitHub, GitLab, Azure DevOps). A backend
// that offers them reads each with the token of the forge's own command-line tool, signed in
// by the person, and puts a work's pull request on the work (works.ts). An Experimental
// feature: each forge is off until the person switches it on.

export type ForgeName = "github" | "gitlab" | "azure"

export const forgeNames: readonly ForgeName[] = ["github", "gitlab", "azure"]

// A branch's pull request (a merge request, on GitLab): `draft` and `open` are open, one not
// yet ready for review and one that is; `merged` and `closed` are done, merged or not.
export type PullRequest = {
  readonly number: number
  readonly url: string
  readonly title: string
  readonly state: "draft" | "open" | "merged" | "closed"
  // How its checks stand on its latest commit, for an open one: failing, running, passed, or
  // none ran. Absent where the forge couldn't say, and on a merged or closed one.
  readonly ci?: "failing" | "running" | "passed" | "none" | undefined
  // The branch it targets, whatever its state, where the forge says.
  readonly base?: string | undefined
  // Each check on its latest commit, for an open one, in the forge's order (100 at most; `ci`
  // speaks for all). Absent where `ci` is, or the forge listed none.
  readonly checks?: readonly PullRequestCheck[] | undefined
  // Where its review stands, for an open one; absent where the forge couldn't say.
  readonly review?: PullRequestReview | undefined
}

// One check: `passed` or `failed` once finished, else `running`, or `waiting` (for a runner,
// an approval, or an earlier job). A newer backend's state it doesn't know is left out.
export type PullRequestCheck = {
  readonly name: string
  readonly state: "passed" | "failed" | "running" | "waiting"
}

// `approved`, `changes_requested` (outranks approvals), `required` (it needs an approval it
// hasn't got) or `none` (none asked for, none given). A newer backend's value reads as `none`.
export type PullRequestReview = "approved" | "changes_requested" | "required" | "none"

// A host a forge's repositories are on, and whether its tool is signed in there: `fix` is the
// command that signs in (`signed-out`) or mends a refused token (`refused`), where there is one.
export type ForgeHost = {
  readonly host: string
  readonly state: "signed-in" | "signed-out" | "refused"
  readonly fix?: string | undefined
}

export type ForgeConnection = {
  readonly forge: ForgeName
  // Its tool is installed where the backend runs.
  readonly available: boolean
  readonly enabled: boolean
  // A switch is under way.
  readonly busy: boolean
  // Why the last switch did not work, for the person.
  readonly error?: string | undefined
  // While it is not `available`: the command that installs its tool where the backend runs,
  // as a terminal would run it for the person.
  readonly installer?: string | undefined
  // The hosts its repositories are on, looked at while it is switched on.
  readonly hosts: readonly ForgeHost[]
}

export type Forges = {
  readonly state: Store<readonly ForgeConnection[]>
  // Switches a forge on or off; the state shows the change as it goes.
  readonly set: (forge: ForgeName, enabled: boolean) => void
  // Looks again at each forge's tool and hosts; resolves once the state shows what it found
  // (also where it found nothing new, or could not look). With `fresh` the backend reads the
  // person's login environment and asks each tool afresh, as the look after an install or a
  // sign-in needs.
  readonly refresh: (options?: { readonly fresh?: boolean }) => Promise<void>
}

// The forges' names as the person reads them.
export const forgeTitles: Readonly<Record<ForgeName, string>> = {
  github: "GitHub",
  gitlab: "GitLab",
  azure: "Azure DevOps",
}

// Each forge's command-line tool.
export const forgePrograms: Readonly<Record<ForgeName, string>> = {
  github: "gh",
  gitlab: "glab",
  azure: "az",
}
