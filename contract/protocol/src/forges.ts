import { z } from "zod"

import { openEnum } from "./open.js"
import { singleLine } from "./text.js"

// Forges: where a repository's pull requests live (GitHub, GitLab, Azure DevOps), read with
// the token of the forge's own command-line tool, signed in by the person. An Experimental
// feature: each forge is off until the person switches it on.

/** How long a pull request's title, address or a host's name runs. */
export const forgeLimits = { title: 512, url: 2048, host: 253, hosts: 32 } as const

export const forgeName = z.enum(["github", "gitlab", "azure"])
// A forge as a runner lists it, which a UI reads as `newer` where it doesn't know it: listed as
// needing a newer Novadeck, its switch left alone. `forges.set` takes `forgeName`.
export const forgeNameRead = openEnum(["github", "gitlab", "azure"], {
  since: 3,
  unknown: "placeholder",
})

const command = z
  .string()
  .min(1)
  .max(4096)
  .regex(singleLine, "A command must be one line, without control characters.")

// A branch's pull request (a merge request, on GitLab): `draft` and `open` are open, one not
// yet ready for review and one that is; `merged` and `closed` are done, merged or not.
// `ci` is how its checks stand on the pull request's latest commit, for an open one: `failing`
// where one failed or errored, `running` while any has yet to finish, `passed` once all passed,
// `none` where none ran (as often on a draft). Absent where the forge couldn't say (a token
// that can't read checks, a lookup that failed) and on a merged or closed pull request.
export const pullRequest = z.strictObject({
  number: z.number().int().min(0),
  url: z.url({ protocol: /^https?$/ }).max(forgeLimits.url),
  title: z.string().max(forgeLimits.title),
  state: z.enum(["draft", "open", "merged", "closed"]),
  ci: z.enum(["failing", "running", "passed", "none"]).optional(),
})

// A host a forge's repositories are on, and whether its tool is signed in there:
// `signed-out` with `fix`, the command that signs in; `refused` where the host turned the
// token away (a missing scope, single sign-on, another tenant), with `fix` where a command
// can mend it.
export const forgeHost = z.strictObject({
  host: z.string().min(1).max(forgeLimits.host),
  state: z.enum(["signed-in", "signed-out", "refused"]),
  fix: command.optional(),
})

// Where a forge stands: whether its tool is installed (`available`), whether the person
// switched it on (`enabled`), the command that installs the tool where there is one for this
// platform (only while not `available`), and the hosts its repositories are on (its own
// host, as github.com, where no repository is on one yet). Hosts are looked at only while
// the forge is switched on and its tool is installed; otherwise the list is empty.
export const forgeIntegration = z.strictObject({
  forge: forgeNameRead,
  available: z.boolean(),
  enabled: z.boolean(),
  installer: command.optional(),
  hosts: z.array(forgeHost).max(forgeLimits.hosts),
})

export type ForgeName = z.infer<typeof forgeName>
export type PullRequest = z.infer<typeof pullRequest>
export type ForgeHost = z.infer<typeof forgeHost>
export type ForgeIntegration = z.infer<typeof forgeIntegration>
