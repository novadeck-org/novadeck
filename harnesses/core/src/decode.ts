import { createHash } from "node:crypto"
import { posix, win32 } from "node:path"

import { agentLimits, agentSessionId, maxTurnError, replyPreviewLength } from "@novadeck/protocol"

import type { Continuity, HarnessEvent } from "./events.js"
import type { Report } from "./report.js"

/**
 * What every harness's decoder shares to read its hooks' payloads and records into
 * events: the checks on the values they hold, the text they show bounded and made plain,
 * and the ids Novadeck derives where no harness names one.
 */

/** A payload's string field, or undefined. */
export const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

/** A session id a shell can run as a plain word, or undefined. */
export const sessionId = (value: unknown): string | undefined =>
  agentSessionId.safeParse(value).success ? (value as string) : undefined

/**
 * An absolute path, or undefined: a POSIX one, or a Windows one from its drive (`C:\\…`,
 * `C:/…`) or share (`\\\\host\\…`), whatever system runs the runner, as an agent's paths
 * are its own system's.
 */
export const absolute = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.length <= 4096 &&
  !value.includes("\0") &&
  (posix.isAbsolute(value) || windowsAbsolute.test(value))
    ? value
    : undefined

/** The start of an absolute Windows path: a drive and its root, or a share. */
const windowsAbsolute = /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/])/i

// A leading move and the folder it names: a shell's `cd` (also `chdir`, `pushd`), or
// PowerShell's `Set-Location` and its aliases `sl`, `chdir` and `cd`, or `Push-Location` and
// `pushd`, in any case and with its folder after `-Path` or `-LiteralPath` or alone; the
// folder bare or in single or double quotes, followed by `&&`, `;`, the end of its line or
// the command's end.
const leadingCd =
  /^\s*(?:cd|chdir|pushd|sl|set-location|push-location)\s+(?:-(?:literalpath|path)\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|'"]+))[ \t]*(?:&&|;|\r?\n|$)/i

/**
 * The folder a shell command runs in, as an absolute path: its tool's own working-directory
 * field where it takes one (Codex's `workdir`, Antigravity's `Cwd`), else the folder a
 * leading move takes it to (`cd /x && …`, `cd x; …`, PowerShell's `Set-Location -LiteralPath
 * 'C:\\x'; …`), else `cwd`, the directory its hook
 * ran in. A relative folder resolves against `cwd`, unless `cwd` already ends in it, as
 * where the harness reports its directory after the `cd` it kept; one naming a variable,
 * `~` or `-` is no folder, nor is anything where `cwd` isn't absolute to resolve it against.
 * The paths follow the agent's own rules, Windows' or POSIX's (see `flavorOf`), so the folder
 * comes back native: `C:\\w\\b` for a Windows agent. It tells where an agent works now, as the
 * agents listing shows it, whichever harness runs it.
 */
export const commandFolder = (
  command: string | undefined,
  cwd: unknown,
  workdir?: unknown,
): string | undefined => {
  const base =
    typeof cwd === "string" && cwd.length <= 4096 && !cwd.includes("\0") ? cwd : undefined
  const named = (folder: string): string | undefined => {
    if (/^[~$-]/.test(folder) || folder.includes("\0") || folder.length > 4096) return undefined
    const path = flavorOf(base ?? folder)
    const target = path === win32 ? msysDrive(folder) : folder
    if (base === undefined || !absoluteIn(path, base))
      return absoluteIn(path, target) ? path.resolve(target) : undefined
    const moved = path.resolve(base, target)
    // Already there: the directory the hook names is the `cd`'s own, not where it began.
    const here = path.resolve(base)
    const tail = path.sep + path.normalize(target).replace(/[\\/]+$/, "")
    const same =
      path === win32 ? here.toLowerCase().endsWith(tail.toLowerCase()) : here.endsWith(tail)
    return same && !absoluteIn(path, target) && !target.startsWith("..") ? here : moved
  }
  const own = text(workdir)?.trim()
  if (own) return named(own)
  const cd = command === undefined ? null : leadingCd.exec(command)
  const target = cd?.[1] ?? cd?.[2] ?? cd?.[3]
  if (target !== undefined) return named(target)
  return absolute(base)
}

/**
 * The path rules a harness's paths follow, from one of its paths: Windows' for a drive
 * (`C:\\…`, `C:/…`) or a share (`\\\\host\\…`), else POSIX's, whatever the runner runs on,
 * so a Windows agent's native paths resolve as Windows paths and a test can give either.
 */
const flavorOf = (path: string): typeof posix =>
  /^(?:[a-z]:|[\\/]{2}[^\\/])/i.test(path) ? win32 : posix

/** Whether a folder is absolute by these rules, a Windows one only with its drive or share. */
const absoluteIn = (path: typeof posix, folder: string): boolean =>
  path === win32 ? windowsAbsolute.test(folder) : path.isAbsolute(folder)

/** Git Bash's `/c/x` for Windows' `C:\\x`, as Claude Code's Bash on Windows writes a drive. */
const msysDrive = (folder: string): string =>
  folder.replace(/^\/([a-z])(?=\/|$)/i, (_, drive: string) => `${drive.toUpperCase()}:\\`)

/** A `tool-called` event's `folder` field where there is one, to spread into it. */
export const folderField = (folder: string | undefined): { readonly folder?: string } =>
  folder === undefined ? {} : { folder }

/**
 * A SessionStart `source`: `startup` for a fresh session, anything else (resume, clear,
 * compact) a switch the harness made itself. Without one, only that the conversation runs.
 */
export const sessionStart = (source: string | undefined): Continuity =>
  source === undefined
    ? "conversation-observed"
    : source === "startup"
      ? "startup"
      : "native-switch"

/**
 * What a hook's report decoded to, each fact its hook told (started at its `seq`, not
 * read from a transcript) with when the agent fired that hook (`Report.firedAt`), where
 * the relay could tell.
 */
export const firedFacts = <Fact extends { readonly startedAt: number }>(
  facts: readonly Fact[],
  { seq, firedAt }: { readonly seq: number; readonly firedAt?: number | undefined },
): readonly Fact[] =>
  firedAt === undefined
    ? facts
    : facts.map((fact) => (fact.startedAt === seq ? { ...fact, firedAt } : fact))

/**
 * The facts of a hook, and whether the agent plans: the root agent's turn, tool and stop
 * hooks name its permission mode, `plan` while it plans. None fires when the mode
 * changes, and Claude Code's SessionStart names none, so a session started or cleared in
 * plan mode shows it from its first prompt.
 */
export const withMode = (
  facts: readonly HarnessEvent[],
  payload: Report["payload"],
): readonly HarnessEvent[] => {
  const mode = text(payload.permission_mode)
  const [first] = facts
  if (!mode || !first || text(payload.agent_id)) return facts
  const { agent, instance, startedAt } = first
  return [
    ...facts,
    {
      type: "mode-observed",
      agent,
      sessionId: first.sessionId,
      instance,
      startedAt,
      planning: mode === "plan",
    },
  ]
}

// Terminal escape sequences: CSI (ESC [ … final), OSC (ESC ] … BEL or ST), and other
// two-character escapes; then any control character left, and the bidirectional
// overrides and isolates that could reorder what the Inbox or a notification shows.
// eslint-disable-next-line no-control-regex -- These are the characters it removes.
const escapes = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?/g
// eslint-disable-next-line no-control-regex -- As above.
const controls = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g
// As above, a line break left out.
// eslint-disable-next-line no-control-regex -- As above.
const inlineControls = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g
// As above, with the invisible and line-breaking marks a name shouldn't hold either.
// eslint-disable-next-line no-control-regex -- As above.
const control = /[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/

/**
 * A short name a harness gives, such as its model's, which is shown as it is: not blank,
 * within `max` characters, and with no control character or reordering in it.
 */
export const shortName = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined
  const name = value.trim()
  return name && name.length <= max && !control.test(name) ? name : undefined
}

// Markdown's marks that read as noise in plain text: emphasis, code, a heading's or a
// quote's lead, a list's bullet, and a link's brackets around its text.
const marks = /(\*\*|`+|~~)/g
const lead = /^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?)/
const links = /!?\[([^\]]*)\]\([^)]*\)/g

/**
 * The start of an agent's reply as one line of plain text, at most
 * `replyPreviewLength` long: escapes and control characters out, Markdown's marks
 * dropped, lines joined, whitespace collapsed, and an ellipsis where it was cut, never
 * inside a character. Undefined when nothing is left.
 */
export const replyPreview = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const line = value
    // Only as much as can show: a reply may be long, and the hook already cut it.
    .slice(0, replyPreviewLength * 8)
    .replace(escapes, "")
    .split(/\r\n|\r|\n/)
    .map((part) => part.replace(lead, "").replace(links, "$1").replace(marks, ""))
    .join(" ")
    .replace(controls, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!line) return undefined
  if (line.length <= replyPreviewLength) return line
  let end = replyPreviewLength - 1
  const last = line.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${line.slice(0, end).trimEnd()}…`
}

/** A turn's end's `reply`, from a field holding the agent's last reply; nothing without one. */
export const replied = (value: unknown): { readonly reply?: string } => {
  const reply = replyPreview(value)
  return reply === undefined ? {} : { reply }
}

/**
 * What a harness said of a failed turn, as plain text a person reads: escapes, control
 * characters and reordering marks out (a line break kept), cut to the protocol's
 * `maxTurnError`. Undefined when nothing is left.
 */
export const errorText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const plain = value
    .slice(0, maxTurnError * 2)
    .replace(escapes, "")
    .replace(inlineControls, " ")
    .trim()
  return plain === "" ? undefined : plain.slice(0, maxTurnError)
}

/**
 * Each request among `events` with the directory its hook named, where it named an
 * absolute one, so a dialog's relative paths resolve where that agent runs.
 */
export const withRequestCwd = (
  events: readonly HarnessEvent[],
  payload: { readonly cwd?: unknown },
): readonly HarnessEvent[] => {
  const cwd = absolute(payload.cwd)
  if (!cwd) return events
  return events.map((event) =>
    event.type === "attention-requested" && event.cwd === undefined ? { ...event, cwd } : event,
  )
}

const field = (input: Record<string, unknown>, ...names: string[]): string | undefined => {
  for (const name of names) {
    const value = input[name]
    if (typeof value === "string" && value.trim()) return value
    if (Array.isArray(value) && value.length > 0 && value.every((each) => typeof each === "string"))
      return value.join(" ")
  }
  return undefined
}

/**
 * What a tool call asks the person about, from its input, in the harness's own words: a
 * question and its choices, a plan's file, a command, or the path or address it touches.
 */
export const subjectOf = (
  input: unknown,
): { readonly subject: string | null; readonly choices: readonly string[] } => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return { subject: null, choices: [] }
  const fields = input as Record<string, unknown>
  const [question] = Array.isArray(fields.questions) ? fields.questions : []
  if (typeof question === "object" && question !== null) {
    const { question: prompt, options } = question as { question?: unknown; options?: unknown }
    const choices = (Array.isArray(options) ? options : [])
      .map((option) => (option as { label?: unknown } | null)?.label)
      .filter((label): label is string => typeof label === "string" && label.length > 0)
      .slice(0, agentLimits.choices)
      .map((label) => label.slice(0, agentLimits.name))
    return {
      subject: typeof prompt === "string" ? prompt.slice(0, agentLimits.subject) : null,
      choices,
    }
  }
  const subject = field(fields, "planFilePath", "command", "file_path", "path", "url", "pattern")
  return { subject: subject?.slice(0, agentLimits.subject) ?? null, choices: [] }
}

/** A value as JSON with every object's keys sorted, so the same value reads the same. */
const canonical = (value: unknown): string =>
  JSON.stringify(value ?? null, (_, each: unknown) =>
    typeof each === "object" && each !== null && !Array.isArray(each)
      ? Object.fromEntries(
          Object.entries(each).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : each,
  )

/**
 * An id for the tool call a permission request asks about, which no harness names: the
 * actor that asks (null for the root agent), the tool and a digest of its input, so the
 * call's own result can resolve it. Its keys may come in another order elsewhere, as
 * Claude Code's transcript records a call's input in the model's order, unlike its hooks.
 */
export const callId = (actor: string | null, toolName: string, input: unknown): string => {
  const digest = createHash("sha256").update(canonical(input)).digest("hex")
  return `${actor ?? ""}:${toolName}:${digest.slice(0, 16)}`
}

/**
 * An opaque reference to a native identity: clients tell actors and requests apart by
 * it, never by a harness's own ids.
 */
export const ref = (...parts: readonly string[]): string =>
  createHash("sha256").update(parts.join("\0")).digest("base64url").slice(0, 16)

/** The longest plan text kept, as the protocol takes it. */
export const maxPlan = 256 * 1024

/** A plan's text cut short to what the protocol takes, a character left whole. */
export const planText = (value: string): { readonly text: string; readonly truncated: boolean } => {
  let end = Math.min(value.length, maxPlan)
  const last = value.charCodeAt(end - 1)
  if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1
  return { text: value.slice(0, end), truncated: end < value.length }
}
