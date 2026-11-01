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

const prText = (grant: Grant, quoteFree: boolean): string => {
  const repos = grant.repos.map((repo) => repo.url).join(", ")
  return (
    `Open, edit, mark ready and comment on pull requests in ${repos}: ` +
    "gh pr create --head <branch>, gh pr edit <n>, gh pr ready <n> or gh pr comment <n>, " +
    "each with -R <owner/name> and a numeric PR; no merge, close or reopen, no labels. " +
    (quoteFree
      ? "Give a body as --body-file <full path of a file in the project> (double quotes only around a path with a space), never $(cat <<EOF)."
      : "Give a body in single quotes, or double quotes, never $(cat <<EOF).")
  )
}

/**
 * The most the commands of one grant may take rendered, in bytes: a delivery holds 8 KiB
 * (`maxDeliveryBytes`), and the rest of a `<grant>` (its repos, note and mark) must fit beside them.
 */
export const maxGrantCommandBytes = 4096

/** The bytes the commands of a grant take in its `<grant>`, escaping and quoting included. */
export const grantCommandBytes = (commands: readonly GrantCommand[]): number =>
  commands.reduce(
    (total, command) => total + Buffer.byteLength(`Run: ${escapeText(commandText(command))}\n`),
    0,
  )

/** The sentence for an agent whose commands are over `maxGrantCommandBytes`, or undefined. */
export const grantCommandsRefusal = (commands: readonly GrantCommand[]): string | undefined =>
  grantCommandBytes(commands) > maxGrantCommandBytes
    ? `Those commands are too long to grant together (over ${maxGrantCommandBytes} bytes as the user would read them): offer fewer or shorter commands.`
    : undefined

/** What a grant lets the agent do, one line each, in Novadeck's fixed words. */
export const grantLines = (
  grant: Grant,
  agent: AgentName,
  platform: NodeJS.Platform = process.platform,
): string[] => [
  ...(grant.presets.includes("push") ? [pushText(grant, agent)] : []),
  ...(grant.presets.includes("pr")
    ? [prText(grant, agent !== "claude" && platform === "win32")]
    : []),
  ...grant.commands.map((command) => `Run: ${escapeText(commandText(command))}`),
]

// What a grant reaches in an agent's own check, which differs by harness and machine. A
// Codex or Antigravity terminal on Windows is told how to write a command its matcher reads there (design A1);
// an Antigravity where cmd prints something first is told why nothing reaches it.
const caveat = (agent: AgentName, platform: NodeJS.Platform, cmdPrints: boolean): string => {
  if (agent === "agy" && platform === "win32" && cmdPrints)
    return (
      "This grant cannot reach Antigravity here: the user's cmd prints text of its own before every " +
      "command (an AutoRun), which Antigravity's check cannot read past, so its own dialog asks " +
      "for each command. The user can change this from Novadeck's Inbox; do not change cmd's AutoRun yourself."
    )
  const quoteFree =
    agent !== "claude" && platform === "win32"
      ? `On Windows, write each command plainly: ${agent === "codex" ? "Codex" : "Antigravity"}'s shell may be PowerShell or cmd, and ` +
        "this grant covers a command only when both read it alike. You may wrap a path or a " +
        "single-line title in double quotes when it has a space, with no $, %, ! or backtick " +
        "inside and no backslash before the closing quote; never single quotes. For a pull request's or " +
        "comment's body use --body-file <full path of a file in the project> or gh pr create --fill; any " +
        "other quoting still asks in the user's Inbox. "
      : ""
  return (
    quoteFree +
    (agent === "agy"
      ? "Antigravity takes this grant when it starts: if yours started earlier, its own dialog " +
        "still asks until you restart, and a version of Antigravity before 1.4.10 never takes it."
      : "If your harness still asks, answer its dialog as usual.")
  )
}

/**
 * The `<grant>` element for an agent: its id, this delivery's person mark, when it ends
 * (the runner's clock), and what it lets through. Only this element, with the delivery's
 * mark, is the person's approval.
 */
export const grantElement = (
  grant: Grant,
  agent: AgentName,
  personMark: string,
  platform: NodeJS.Platform,
  cmdPrints = false,
): string =>
  `<grant id="${grant.id}" person="${personMark}" ends="${clock(grant.endsAt)}">\n` +
  `${[
    "The user granted, without asking again until it ends:",
    ...grantLines(grant, agent, platform),
    caveat(agent, platform, cmdPrints),
  ].join("\n")}\n</grant>`

/** The `<grant-ended>` element: the grant no longer applies, whatever it said before. */
export const grantEndedElement = (id: string): string =>
  `<grant-ended id="${id}">The user's grant has ended: ask again for what it let through.</grant-ended>`
