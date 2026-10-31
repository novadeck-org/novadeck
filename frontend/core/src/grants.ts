import type { Store } from "./store"

// The person's grants (#587, #588): what a lead's team, or one terminal, may run without asking
// again, made only by the person's click on Novadeck's own card. These are the protocol's
// shapes as the UI reads them (`@novadeck/protocol`'s grants.ts); the runner enforces them.

// The fixed scopes the Grant card words itself.
export type GrantPreset = "push" | "pr"

// How long a grant lasts, in hours: the card offers these, and 24 is the most.
export type GrantHours = 1 | 8 | 24
export const grantHoursChoices: readonly GrantHours[] = [1, 8, 24]
export const defaultGrantHours: GrantHours = 8

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
  readonly endsAt: number
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
  readonly hours: GrantHours
  // The lead's own words, shown as quoted agent text.
  readonly reason: string
  readonly covered: readonly {
    readonly handle: string
    readonly agent: string
  }[]
}

// The person's Grant on a card: what stayed ticked (commands by index into the proposal's,
// repos by url) and the time they chose.
export type GrantAnswer = {
  readonly type: "grant"
  readonly presets: readonly GrantPreset[]
  readonly commands: readonly number[]
  readonly repos: readonly string[]
  readonly withLead: boolean
  readonly hours: GrantHours
}

// The live grants, and the way to end one at once. Absent from a backend that has none.
export type Grants = {
  readonly state: Store<readonly Grant[]>
  readonly revoke: (id: string) => void
}

// A word of a command as a shell would take it back: left bare where it is plain, else in
// single quotes.
const shellWord = (word: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`

// A granted command as the card shows it: its words, shell-quoted, and `rest` as the `…` that
// the card marks in the warning colour. `rest` is false for an exact command.
export const commandWords = (command: GrantCommand): string[] => command.argv.map(shellWord)

export const commandText = (command: GrantCommand): string => commandWords(command).join(" ")

export const hoursWords = (hours: GrantHours): string => (hours === 1 ? "1 hour" : `${hours} hours`)

// What the Grant card says each preset allows, in Novadeck's own words. `repos` names where:
// the one repo ticked, or the repos ticked below.
export const presetSentence = (preset: GrantPreset, repos: string): string =>
  preset === "push"
    ? `Push a named branch to ${repos} (no force, never to main/master or its default branch)`
    : `Open, edit, mark ready and comment on pull requests in ${repos} (no merge commands, close or reopen; no labels)`

// The line over an `approval` card's commands.
export const approvalSentence = (handle: string, hours: GrantHours | null): string =>
  `Lets @${handle} run, without asking again, for ${hoursWords(hours ?? 1)}:`
