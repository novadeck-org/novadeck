import { forgePrograms, type ForgeConnection, type ForgeHost } from "@novadeck/core/forges"

// A forge the person can switch on, as its row shows it.
export type ForgeSwitch = ForgeConnection

// What the row says beside or under the forge's name: why it can't be switched, what the switch
// is doing, why the last one failed, or what it reads with. `error` is for an alert.
export type ForgeNote = { readonly text: string; readonly error: boolean }

export const forgeNote = ({
  forge,
  available,
  enabled,
  busy,
  error,
}: ForgeSwitch): ForgeNote | undefined => {
  if (busy) return { text: enabled ? "Switching off…" : "Switching on…", error: false }
  if (error) return { text: error, error: true }
  if (!available) return { text: `Not installed. Needs ${forgePrograms[forge]}`, error: false }
  return { text: `Uses your signed-in ${forgePrograms[forge]}`, error: false }
}

// What a host says of itself, under its forge: its state in words, and the command the person
// can run for it. A signed-out host with a command offers Sign in running it; a refused one
// shows its command to read and run.
export type HostLine = {
  readonly host: string
  readonly words: string
  readonly signIn: string | undefined
  readonly fix: string | undefined
}

export const hostLine = ({ host, state, fix }: ForgeHost): HostLine => ({
  host,
  words:
    state === "signed-in" ? "Signed in" : state === "signed-out" ? "Signed out" : "Token refused",
  signIn: state === "signed-out" ? fix : undefined,
  fix: state === "refused" ? fix : undefined,
})

// What the section is, above the rows.
export const forgesExplanation =
  "Show each worktree's pull request in the Worktrees panel. Novadeck reads them with the signed-in command-line tool of the forge (gh, glab or az), and never asks for a password or token."
