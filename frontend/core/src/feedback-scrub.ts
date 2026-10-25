// What a feedback draft says that could identify the person, found before it is sent: a
// path under their home directory, their user and host names as a shell prompt prints them,
// and email addresses. The draft is the agent's text, written from a terminal that is full
// of such things. Pure: the Inbox draws the struck parts through and sends the text with a
// placeholder in their place. It is conservative: it strikes what clearly points at one person or machine, and
// leaves prose, repo-relative paths (`frontend/ui/src/Toast.tsx`), `@handle`s, scoped
// packages (`@novadeck/core`) and `name@version` alone.

export type StrikeKind = "path" | "user" | "host" | "email"

// A run of the text: kept (`struck` null) or struck, and by what.
export type Segment = {
  readonly text: string
  readonly struck: StrikeKind | null
}

export type StrikeCounts = Readonly<Record<StrikeKind, number>>

export type Scrubbed = {
  readonly segments: readonly Segment[]
  readonly counts: StrikeCounts
  // How many parts are struck.
  readonly total: number
}

type Found = {
  readonly start: number
  readonly end: number
  readonly kind: StrikeKind
  // 0 wins over 1 where both start together: a login's user and host over an email address.
  readonly rank?: 0
}

// What a path runs to: a space, a quote, a bracket. Punctuation that ends a sentence
// (`.`, `,`, `:`, `;`, `!`, `?`) is not part of it.
const pathTail = String.raw`[^\s"'` + "`" + String.raw`<>()\[\]{}|]*`
// A home directory: Linux, macOS, Silverblue's `/var/home` and WSL's view of a Windows one.
const home =
  String.raw`(?:/var/home|/home|/mnt/[a-z]/Users|/Users)/[^\s/"'` + "`" + String.raw`<>()\[\]{}|]+`
// A Windows user name may hold spaces ("Alice Smith"): up to three words that a backslash
// follows, else one word.
const word = String.raw`[^\s\\/:,;"'` + "`" + String.raw`<>()\[\]{}|]+`
const winUser = String.raw`(?:${word}(?: ${word}){0,2}(?=[\\/])|${word})`
const patterns: readonly { readonly kind: StrikeKind; readonly pattern: RegExp }[] = [
  // `~/notes`, `~\notes`.
  { kind: "path", pattern: new RegExp(String.raw`(?<![\w/~.\\-])~[/\\]${pathTail}`, "g") },
  // `/home/alice`, `/Users/alice/Work/x.ts`, `file:///home/alice/x`: what comes before
  // may be a slash, not a word, so `src/home/x` is no home.
  { kind: "path", pattern: new RegExp(String.raw`(?<![\w.~\\-])${home}(?:/${pathTail})?`, "g") },
  // `C:\Users\alice\Work`, `C:/Users/alice`.
  {
    kind: "path",
    pattern: new RegExp(
      String.raw`(?<![\w])[A-Za-z]:[\\/]+Users[\\/]+${winUser}(?:[\\/]${pathTail})?`,
      "gi",
    ),
  },
]

// Names that are no person's: git's own account, and the mailboxes tools write for themselves.
const impersonal = new Set(["git", "noreply", "no-reply", "donotreply"])

const email =
  /(?<![\w.%+-])([A-Za-z0-9][A-Za-z0-9._%+-]*)@([A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![\w-])/g

// `alice@laptop:~/work$`, `[alice@laptop work]$`, `alice@laptop $`, zsh's `alice@laptop ~ %`
// and `alice@laptop project %`, fish's `alice@laptop ~/dir>`: a user and a host only where a
// shell prompt prints them, else `pnpm@11` or `react@latest` would be struck.
const prompt =
  /(?<![\w.@-])\[?([A-Za-z_][\w-]{0,31})@([A-Za-z0-9][A-Za-z0-9-]*)(?=:[~/\\]|\s+[^\s]*\]\s*[$#%](?:\s|$)|(?:\s+[\w.~/-][^\s]*)?\s*[$#%](?:\s|$)|\s+[~/][^\s]*>(?:\s|$))/g

// `ssh alice@devbox`, `scp f alice@host:/tmp`: a login is a user and a host wherever the line
// has such a command.
const remoteCommand = /(?<![\w-])(?:ssh|scp|sftp|mosh)\b[^\n]*/g
const login = /(?<![\w.%+-])([A-Za-z_][\w.-]*)@([A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9])/g

const find = (text: string): Found[] => {
  const found: Found[] = []
  for (const { kind, pattern } of patterns)
    for (const match of text.matchAll(pattern)) {
      // A trailing full stop or comma ends the sentence, not the path.
      const trimmed = match[0].replace(/[.,:;!?]+$/, "")
      found.push({ start: match.index, end: match.index + trimmed.length, kind })
    }
  for (const match of text.matchAll(email)) {
    if (impersonal.has(match[1]!.toLowerCase())) continue
    found.push({ start: match.index, end: match.index + match[0].length, kind: "email" })
  }
  for (const match of text.matchAll(prompt)) {
    const user = match[1]!
    if (impersonal.has(user.toLowerCase())) continue
    const userStart = match.index + match[0].indexOf(user)
    const hostStart = userStart + user.length + 1
    found.push({ start: userStart, end: userStart + user.length, kind: "user" })
    found.push({ start: hostStart, end: hostStart + match[2]!.length, kind: "host" })
  }
  for (const command of text.matchAll(remoteCommand))
    for (const match of command[0].matchAll(login)) {
      const user = match[1]!
      if (impersonal.has(user.toLowerCase())) continue
      const userStart = command.index + match.index
      const hostStart = userStart + user.length + 1
      found.push({ start: userStart, end: userStart + user.length, kind: "user", rank: 0 })
      found.push({ start: hostStart, end: hostStart + match[2]!.length, kind: "host", rank: 0 })
    }
  // Earliest first, a login first and then the longer where they start together; one that overlaps an earlier is
  // part of it (an email address inside a path is the path).
  found.sort((a, b) => a.start - b.start || (a.rank ?? 1) - (b.rank ?? 1) || b.end - a.end)
  const kept: Found[] = []
  for (const each of found) if (each.start >= (kept.at(-1)?.end ?? 0)) kept.push(each)
  return kept.filter((each) => each.end > each.start)
}

const none: StrikeCounts = { path: 0, user: 0, host: 0, email: 0 }

export const scrub = (text: string): Scrubbed => {
  const segments: Segment[] = []
  const counts = { ...none }
  let at = 0
  for (const each of find(text)) {
    if (each.start > at) segments.push({ text: text.slice(at, each.start), struck: null })
    segments.push({ text: text.slice(each.start, each.end), struck: each.kind })
    counts[each.kind] += 1
    at = each.end
  }
  if (at < text.length) segments.push({ text: text.slice(at), struck: null })
  return {
    segments,
    counts,
    total: counts.path + counts.user + counts.host + counts.email,
  }
}

// What stands in the sent text for each struck part, so it still reads: "ran the build in
// [path], then split". A prompt's `alice@laptop` becomes `[user]@[host]`.
const placeholders: Readonly<Record<StrikeKind, string>> = {
  path: "[path]",
  user: "[user]",
  host: "[host]",
  email: "[email]",
}

// The text to send: the kept runs, with a placeholder where a part was struck.
export const textToSend = (scrubbed: Scrubbed): string =>
  scrubbed.segments
    .map((segment) => (segment.struck ? placeholders[segment.struck] : segment.text))
    .join("")

const nouns: readonly (readonly [StrikeKind, string, string])[] = [
  ["path", "path", "paths"],
  ["user", "user name", "user names"],
  ["host", "host name", "host names"],
  ["email", "email address", "email addresses"],
]

// The counts as a line says them, "1 path" or "2 paths, 1 email address"; null where nothing
// is struck.
export const strikeSummary = (counts: StrikeCounts): string | null => {
  const parts = nouns.flatMap(([kind, one, many]) =>
    counts[kind] === 0 ? [] : [`${counts[kind]} ${counts[kind] === 1 ? one : many}`],
  )
  return parts.length === 0 ? null : parts.join(", ")
}
