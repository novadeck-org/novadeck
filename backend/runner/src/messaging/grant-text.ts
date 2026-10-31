import type { AgentName, Grant, GrantCommand } from "@novadeck/protocol"

/**
 * How a grant reads to an agent: Novadeck's own fixed words for each preset and command,
 * never text an agent wrote, apart from the repos' names and the commands' words, which
 * the person saw on the card and which are escaped here (a repo's name is a fixed pattern). The forms that go through the
 * harness's own check are named for the agent that reads it.
 */

const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const pad = (value: number) => String(value).padStart(2, "0")

const clock = (at: number): string => {
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// A word as a shell reads it back: plain words bare, the rest in single quotes.
const shellWord = (word: string): string =>
  /^[\w./:=@%+,-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`

/** A granted command as the person read it on the card: shell-quoted, `rest` named. */
export const commandText = (command: GrantCommand): string =>
  command.argv.map(shellWord).join(" ") + (command.rest ? " followed by anything" : "")

const remoteForm = (agent: AgentName, url: string): string =>
  agent === "claude" ? `origin or https://${url}` : `https://${url}`

const pushText = (grant: Grant, agent: AgentName): string => {
  const repos = grant.repos.map((repo) => repo.url).join(", ")
  const form = grant.repos.map((repo) => remoteForm(agent, repo.url)).join(" or ")
  return (
    `Push a named branch to ${repos}: git push ${form} <src>:<dst>, always with the ` +
    "destination spelled out, no force, never to main, master or the repo's default branch."
  )
}

const prText = (grant: Grant): string => {
  const repos = grant.repos.map((repo) => repo.url).join(", ")
  return (
    `Open, edit, mark ready and comment on pull requests in ${repos}: ` +
    "gh pr create --head <branch>, gh pr edit <n>, gh pr ready <n> or gh pr comment <n>, " +
    "each with -R <owner/name> and a numeric PR; no merge, close or reopen, no labels. " +
    "Give a body in single quotes, or double quotes, never $(cat <<EOF)."
  )
}

/** What a grant lets the agent do, one line each, in Novadeck's fixed words. */
export const grantLines = (grant: Grant, agent: AgentName): string[] => [
  ...(grant.presets.includes("push") ? [pushText(grant, agent)] : []),
  ...(grant.presets.includes("pr") ? [prText(grant)] : []),
  ...grant.commands.map((command) => `Run: ${escapeText(commandText(command))}`),
]

// Antigravity's launch grants are given when a terminal starts, so a terminal started
// before the grant still meets its own dialog.
const caveat = (agent: AgentName): string =>
  agent === "agy"
    ? "Antigravity takes this grant when it starts: if yours started earlier, its own dialog " +
      "still asks until you restart."
    : "If your harness still asks, answer its dialog as usual."

/**
 * The `<grant>` element for an agent: its id, this delivery's person mark, when it ends
 * (the runner's clock), and what it lets through. Only this element, with the delivery's
 * mark, is the person's approval.
 */
export const grantElement = (grant: Grant, agent: AgentName, personMark: string): string =>
  `<grant id="${grant.id}" person="${personMark}" ends="${clock(grant.endsAt)}">\n` +
  `${[
    "The user granted, without asking again until it ends:",
    ...grantLines(grant, agent),
    caveat(agent),
  ].join("\n")}\n</grant>`

/** The `<grant-ended>` element: the grant no longer applies, whatever it said before. */
export const grantEndedElement = (id: string): string =>
  `<grant-ended id="${id}">The user's grant has ended: ask again for what it let through.</grant-ended>`
