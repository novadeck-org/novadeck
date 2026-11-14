import type { ChatDialogOption, ChatRequest } from "../conversation"

// What Novadeck reads into a permission's or a plan's options beyond their words: which is
// the plain yes, which yes sets something standing, which says no plainly or with the
// person's words, what a standing yes lets the agent do, and which must be armed before it
// is sent. Extras never replace a label: the harness's words show as it wrote them, and an
// option no rule here knows has no extras (`other`), still answerable as it words itself.
// Pure, so every view reads the same options the same way.

// - `yes`: the one plain yes, which grants nothing beyond this answer.
// - `standing`: a yes that sets something for later answers ("don't ask again", a mode).
// - `no`: a plain no, with no words.
// - `words`: a no that carries the person's words.
// - `other`: anything else, as another yes ("Yes, clear context and implement").
export type OptionRole = "yes" | "standing" | "no" | "words" | "other"

export type OptionExtras = {
  readonly role: OptionRole
  // The label's own words in two lines, where it names a scope after what it is:
  // "Yes, and don't ask again" over "for commands that start with `pnpm add`". Null where
  // it reads as one line.
  readonly lines: { readonly head: string; readonly scope: string } | null
  // What follows that the label's words don't say: "It edits without asking."
  readonly effect: string | null
  // Hard to take back: the first press arms it, the second sends.
  readonly hard: boolean
}

export const noExtras: OptionExtras = { role: "other", lines: null, effect: null, hard: false }

// A label as the rules read it: trimmed, and without a key hint the harness prints after
// it, as Codex's "(y)" or Claude Code's "(esc)". Only these keys: any other bracket ("(all)",
// "(a)" for always) may qualify the answer, so it stays.
const keyHint = /\s*\((y|n|esc|enter|tab|shift\+tab)\)$/i
const bare = (label: string): string => label.trim().replace(keyHint, "")

const yes = /^(yes|allow|approve|always allow)\b/i
// Codex's MCP tool dialog says no with "Cancel".
const no = /^(no|deny|reject|cancel)\b/i

// The yes that grants nothing beyond this answer, in each harness's words. Everything else
// that says yes may change more than this answer, whatever it says, so it is never the
// plain one.
const plainYes = [
  // Bare: Claude Code's "Yes", Antigravity's "Approve", Codex's MCP "Allow".
  /^(yes|allow|approve)( once)?[.!]?$/i,
  // Codex: a command or a patch, a request for permissions for this turn, and a plan.
  /^yes, proceed[.!]?$/i,
  /^yes, grant these permissions for this turn$/i,
  /^yes, implement this plan$/i,
  // Claude Code's plan: approve each edit, or (a plan mode left with no plan) go back to
  // asking each time.
  /^yes,( and)? manually approve edits[.!]?$/i,
  /^yes, and switch to default \(ask each time\) for this session$/i,
  // Antigravity: a command, a change to a file, a new file.
  /^yes, (run command|accept this change|allow creation)$/i,
]

// A yes that sets something for later answers, by its own words: Claude Code's "don't ask
// again for …", "and allow access to … commands" and "switch to accept edits … for this
// session"; Codex's "… for this session" and "Always allow"; Antigravity's "always allow in
// this conversation"; and a plan's modes.
const standing =
  /don't ask again|do not ask again|always|allow all|all edits|this session|for session|\band allow\b|auto-accept|bypass permissions|auto mode/i

// The way back that is only the person's words, as Claude Code's plan field "Tell Claude
// what to change" (from 2.1.287; before, "No, keep planning") and "Tell it what to change",
// the label Novadeck's Antigravity adapter gives a review's feedback (Antigravity's screen
// has no such option): it says no only with words. The agent's name may be more than one
// word.
const change = /^tell .+? what to change\b/i

// What a plan's standing yes lets the agent do from then on: only these are said, as their
// words alone don't say what follows, and each is armed before it is sent.
const planEffects: readonly [RegExp, string][] = [
  [/bypass permissions/i, "It edits and runs commands without asking."],
  [/auto-accept/i, "It edits without asking."],
  [/auto mode/i, "It acts without asking."],
]

// Whether an option says yes, plain or not.
export const saysYes = (option: ChatDialogOption): boolean => yes.test(bare(option.label))

// Whether a yes sets something standing, by its own words.
export const setsStanding = (option: ChatDialogOption): boolean =>
  saysYes(option) && standing.test(option.label)

// Whether a way back must carry the person's words: it says no only with them.
export const needsWords = (option: ChatDialogOption): boolean => change.test(bare(option.label))

// A standing yes in two lines, in its own words: what it is, and its scope under it.
const linesOf = (label: string): OptionExtras["lines"] => {
  const match = /^(.*?\bdon't ask again)[,:]?\s+(\S.*)$/i.exec(label.trim())
  return match ? { head: match[1]!, scope: match[2]! } : null
}

const planEffect = (label: string): string | null =>
  planEffects.find(([pattern]) => pattern.test(label))?.[1] ?? null

// The plain yes among the options: a bare one first, else one a harness words so.
const plainOf = (options: readonly ChatDialogOption[]): ChatDialogOption | undefined => {
  const yeses = options.filter(saysYes)
  for (const pattern of plainYes) {
    const found = yeses.find((each) => pattern.test(bare(each.label)))
    if (found) return found
  }
  return undefined
}

const roleOf = (option: ChatDialogOption, plain: ChatDialogOption | undefined): OptionRole => {
  if (option === plain) return "yes"
  if (setsStanding(option)) return "standing"
  const back = no.test(bare(option.label)) || needsWords(option)
  if (back && option.text !== null) return "words"
  if (no.test(bare(option.label))) return "no"
  return "other"
}

// The extras of a request's options, in the order the dialog lists them. A plan's standing
// yes says what it lets the agent do, and is armed.
export const optionExtras = (
  kind: ChatRequest["kind"],
  options: readonly ChatDialogOption[],
): readonly OptionExtras[] => {
  const plain = plainOf(options)
  return options.map((option) => {
    const role = roleOf(option, plain)
    const effect = kind === "plan" && role === "standing" ? planEffect(option.label) : null
    const lines = linesOf(option.label)
    if (role === "other" && !lines) return noExtras
    return { role, lines, effect, hard: effect !== null }
  })
}
