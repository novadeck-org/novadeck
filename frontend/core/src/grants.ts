import type { Store } from "./store"

// The person's grants (#587, #588): what a lead's team, or one terminal, may run without asking
// again, made only by the person's click on Novadeck's own card. These are the protocol's
// shapes as the UI reads them (`@novadeck/protocol`'s grants.ts); the runner enforces them.

// The fixed scopes the Grant card words itself.
export type GrantPreset = "push" | "pr"

// How long a grant lasts: until the agent reports done (or is released, or exits), which is
// the default, or at most an hour. The card's menu offers these two.
export type GrantLifetime = "until-done" | "hour"

// A command that is granted: exact words, or with `rest`, followed by anything.
export type GrantCommand = {
  readonly argv: readonly string[]
  readonly rest: boolean
}

// A repo `push` and `pr` may reach, with its default branch and where that came from: GitHub
// itself, the remote's HEAD ref (which an agent can write), or the main/master guess.
export type GrantRepo = {
  readonly url: string
  readonly defaultBranch: string
  readonly defaultFrom: "github" | "remote-head" | "guess"
}

export type GrantHolder =
  // The terminals the lead leads directly, now and later; the lead itself only if `withLead`.
  | { readonly kind: "team"; readonly lead: string; readonly withLead: boolean }
  | { readonly kind: "terminal"; readonly handle: string }

// A live grant, as the grants list shows it. `lastUse` the last command it allowed.
export type Grant = {
  readonly id: string
  readonly projectId: string
  readonly workspaceSessionId: string
  readonly holder: GrantHolder
  readonly presets: readonly GrantPreset[]
  readonly commands: readonly GrantCommand[]
  readonly repos: readonly GrantRepo[]
  readonly entryId: string
  readonly proposedBy: string
  readonly madeAt: number
  readonly lifetime: GrantLifetime
  // The clock time an hour grant ends; null for one that lasts until done.
  readonly endsAt: number | null
  // Who the grant covers right now, as the runner sends it: the live holders only.
  readonly covering: readonly { readonly terminalId: string; readonly handle: string }[]
  readonly revokedAt: number | null
  readonly lastUse: {
    readonly at: number
    readonly handle: string
    readonly command: string
  } | null
}

// A repo the Grant card offers: ticked when it is the `origin` of a repo that wasn't made or
// re-pointed in the last day; `flag` says why one isn't.
export type GrantRepoChoice = {
  readonly repo: GrantRepo
  readonly ticked: boolean
  readonly flag: "added-remote" | "recent" | null
}

// A lead's proposal, as the Grant card shows it. `covered` the teammates it covers now, with
// the harness each runs.
export type GrantProposal = {
  readonly presets: readonly GrantPreset[]
  readonly commands: readonly GrantCommand[]
  readonly repos: readonly GrantRepoChoice[]
  readonly withLead: boolean
  readonly lifetime: GrantLifetime
  // The lead's own words, shown as quoted agent text.
  readonly reason: string
  readonly covered: readonly {
    readonly handle: string
    readonly agent: string
    // Its agent is already running (an Antigravity started after the grant is the one it reaches).
    readonly started: boolean
  }[]
  // The installed Antigravity is older than 1.4.10, which takes no launch grant, and a covered
  // teammate runs it.
  readonly agyOutdated: boolean
}

// The person's Grant on a card: what stayed ticked (commands by index into the proposal's,
// repos by url) and the lifetime they chose.
export type GrantAnswer = {
  readonly type: "grant"
  readonly presets: readonly GrantPreset[]
  readonly commands: readonly number[]
  readonly repos: readonly string[]
  readonly withLead: boolean
  readonly lifetime: GrantLifetime
}

// The live grants, and the way to end one at once. Absent from a backend that has none.
export type Grants = {
  readonly state: Store<readonly Grant[]>
  readonly revoke: (id: string) => void
  // Why the last revoke of a grant failed, by grant id, until it is tried again or the grant
  // is gone. Absent where a revoke cannot fail.
  readonly failed?: Store<Readonly<Record<string, string>>>
}

// A word of a command as a shell would take it back: left bare where it is plain, else in
// single quotes.
const shellWord = (word: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`

// A granted command as the card shows it: its words, shell-quoted, and `rest` as the `…` that
// the card marks in the warning colour. `rest` is false for an exact command.
export const commandWords = (command: GrantCommand): string[] => command.argv.map(shellWord)

export const commandText = (command: GrantCommand): string => commandWords(command).join(" ")

// A lifetime inside a sentence: "until it's done" or "for 1 hour".
export const lifetimeWords = (lifetime: GrantLifetime): string =>
  lifetime === "hour" ? "for 1 hour" : "until it's done"

// The Grant card's title and body, in Novadeck's words, from the proposal's fixed fields only:
// its presets, repos and the teammates it covers. The lead's own words (`reason`) and the
// commands never go into them.

// Who the card names: the covered teammates (and the lead when it is included, as the person
// has the switch), or "my team" where there are none or more than three.
export const grantHolders = (
  proposal: GrantProposal,
  lead: string,
  withLead: boolean = proposal.withLead,
): string => {
  const handles = [
    ...(withLead ? [lead] : []),
    ...proposal.covered.map(({ handle }) => handle),
  ].map((handle) => `@${handle}`)
  if (handles.length === 0 || handles.length > 3) return "my team"
  return handles.length === 1
    ? handles[0]!
    : `${handles.slice(0, -1).join(", ")} and ${handles.at(-1)}`
}

export const grantTitle = (
  proposal: GrantProposal,
  lead: string,
  withLead: boolean = proposal.withLead,
): string => `Let ${grantHolders(proposal, lead, withLead)} work without asking?`

export type GrantBodyPart = { readonly text: string } | { readonly code: string }

const repoName = (url: string): string => url.replace(/^github\.com\//, "")

// The repos the card ticks as proposed, by url.
export const proposedRepos = (proposal: GrantProposal): readonly string[] =>
  proposal.repos.filter(({ ticked }) => ticked).map(({ repo }) => repo.url)

// What they'd do, where, and what still needs the person: `ticked` the repos as the person has
// them ticked now (the proposed ones to start with).
export const grantBody = (
  proposal: GrantProposal,
  ticked: readonly string[] = proposedRepos(proposal),
): readonly GrantBodyPart[] => {
  const push = proposal.presets.includes("push")
  const pr = proposal.presets.includes("pr")
  const what =
    push && pr
      ? "push their branches and open pull requests"
      : push
        ? "push their branches"
        : pr
          ? "open and edit pull requests"
          : "run a few commands"
  const repos = proposal.repos.map(({ repo }) => repo.url).filter((url) => ticked.includes(url))
  const where: GrantBodyPart[] =
    push || pr
      ? repos.length === 0
        ? [{ text: " in a repo you tick under Review" }]
        : [
            { text: " in " },
            { code: repoName(repos[0]!) },
            ...(repos.length > 1 ? [{ text: ` and ${repos.length - 1} more` }] : []),
          ]
      : []
  const still =
    push && pr
      ? "Merges and pushes to main still need you."
      : push
        ? "Pushes to main still need you."
        : pr
          ? "Merges still need you."
          : "Review shows which."
  const parts: GrantBodyPart[] = [
    { text: `They'd ${what}` },
    ...where,
    { text: ` without asking you each time. ${still}` },
  ]
  // Words next to words are one run of text.
  return parts.reduce<GrantBodyPart[]>((merged, part) => {
    const last = merged.at(-1)
    return last && "text" in last && "text" in part
      ? [...merged.slice(0, -1), { text: last.text + part.text }]
      : [...merged, part]
  }, [])
}

// What the lead asked for beyond the presets and the repos that it ticks: every command, and
// each repo it leaves unticked (where there are presets for a repo to matter). They stay
// unticked until the person ticks them.
export type GrantExtra =
  | { readonly kind: "command"; readonly at: number; readonly reason: string }
  | { readonly kind: "repo"; readonly url: string; readonly reason: string }

const repoReasons = {
  recent: "This repo was just created or changed",
  "added-remote": "This remote was added recently and isn't yours",
} as const

export const grantExtras = (proposal: GrantProposal): readonly GrantExtra[] => [
  ...proposal.commands.map((command, at): GrantExtra => ({
    kind: "command",
    at,
    reason: command.rest
      ? "This could do more than pushing"
      : "This isn't pushing or a pull request",
  })),
  ...(proposal.presets.length === 0 ? [] : proposal.repos)
    .filter(({ ticked }) => !ticked)
    .map(({ repo, flag }): GrantExtra => ({
      kind: "repo",
      url: repo.url,
      reason: flag ? repoReasons[flag] : "This isn't the repo's origin",
    })),
]

// What the extras line says: "also asked for 3 more things", or with no presets to add to,
// "asked for 3 things".
export const askedFor = (count: number, proposal: GrantProposal): string => {
  const more = proposal.presets.length > 0
  return `${more ? "also " : ""}asked for ${count}${more ? " more" : ""} ${count === 1 ? "thing" : "things"}`
}
