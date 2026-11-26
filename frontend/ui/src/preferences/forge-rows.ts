import { forgePrograms, type ForgeConnection, type ForgeHost } from "@novadeck/core/forges"

// A forge as its row shows it: always on, read with its command-line tool where it is installed.
export type ForgeRow = ForgeConnection

// What the row says under the forge's name: why the last look failed, that its tool is missing,
// or what it reads with. `error` is for an alert.
export type ForgeNote = { readonly text: string; readonly error: boolean }

export const forgeNote = ({ forge, available, error }: ForgeRow): ForgeNote | undefined => {
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
  "The Worktrees panel shows each worktree's pull request and its checks. Novadeck reads them through your signed-in command-line tool (gh, glab or az), and never asks for a password or token."
