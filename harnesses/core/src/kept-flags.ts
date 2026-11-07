import type { Choice } from "./harness.js"

/**
 * Which of a harness's launch flags a resume carries over, and how it reads them off the
 * words an agent was started with. A harness remembers some of what it was started with
 * (its session holds the conversation) and not the rest: a permission or approval mode, a
 * sandbox, a model, an effort come back as its defaults, so a resumed agent may stall
 * on a dialog nobody sees. A flag not listed here is never carried: not a prompt, a
 * positional, the session to resume, a print mode, nor any option the harness gained since.
 */
export type KeptFlags = {
  /** The flags that take a value, by each spelling, to the flag a resume gives. */
  readonly valued: { readonly [spelling: string]: string }
  /** The flags that take none, by each spelling, to the flag a resume gives. */
  readonly bare: { readonly [spelling: string]: string }
  /**
   * The keys of its config overrides (`-c key=value`) that are kept, where it has them, by
   * the spellings of the option, of which the first is the one a resume gives.
   */
  readonly config?: { readonly options: readonly string[]; readonly keys: readonly string[] }
  /** That a long option may be written with one dash, as Go's `flag` allows. */
  readonly oneDash?: boolean
  /** Its options that take a value, and those among them that take a list (`nonSession`). */
  readonly takesValue: readonly string[]
  readonly takesMany: readonly string[]
  /** Its print flags: such a run is no session to resume, and keeps nothing. */
  readonly print: readonly string[]
  /** Whether a kept word, as a resume gives it, sets the model or the effort. */
  readonly sets: (flag: string, value: string | undefined) => "model" | "effort" | undefined
}

/**
 * What a kept value may hold. A resume's words are joined with spaces into the command the
 * person's shell runs, under any shell (sh, zsh, fish, PowerShell, cmd), none of whose
 * quoting is the others': so only characters every one reads as themselves. A model such as
 * `opus[1m]`, which a glob would read, is not kept.
 */
const plain = /^[A-Za-z0-9_][A-Za-z0-9_.:@+=,/-]{0,199}$/

const usable = (value: string | undefined): value is string =>
  value !== undefined && plain.test(value)

/** An option's name and the value written with it (`--model=x`), as the harness reads them. */
const split = (word: string, flags: KeptFlags): { name: string; inline?: string } => {
  if (word.startsWith("--")) {
    const at = word.indexOf("=")
    return at < 0 ? { name: word } : { name: word.slice(0, at), inline: word.slice(at + 1) }
  }
  if (!word.startsWith("-") || word.length === 1) return { name: word }
  const at = word.indexOf("=")
  const whole = at < 0 ? word : word.slice(0, at)
  const inline = at < 0 ? undefined : word.slice(at + 1)
  // Go's `flag`: `-model x` is `--model x`.
  if (flags.oneDash && whole.length > 2) return { name: `-${whole}`, ...(inline && { inline }) }
  // A short option with its value attached (`-mgpt-5`), as clap reads it.
  const short = whole.slice(0, 2)
  if (whole.length > 2 && (flags.takesValue.includes(short) || short in flags.valued))
    return { name: short, inline: word.slice(2).replace(/^=/, "") }
  return { name: whole, ...(inline !== undefined && { inline }) }
}

/**
 * The flags of a launch to carry over, from the words after the program, as words a resume
 * can give: each flag spelled as the harness does and its value after it, once per flag
 * (the last one given wins, as it does for the harness). None for a print run.
 */
export const keptFlags = (argv: readonly string[], flags: KeptFlags): readonly string[] => {
  const kept = new Map<string, readonly string[]>()
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]!
    if (word === "--") break
    if (!word.startsWith("-") || word === "-") continue
    const { name, inline } = split(word, flags)
    if (flags.print.includes(name)) return []
    const give = flags.valued[name]
    const bare = flags.bare[name]
    const config = flags.config?.options.includes(name)
    const value = (): string | undefined => {
      if (inline !== undefined) return inline
      index += 1
      return argv[index]
    }
    if (give !== undefined) {
      const text = value()
      if (usable(text)) kept.set(give, [give, text])
    } else if (bare !== undefined) {
      // A Go boolean may be written `--sandbox=false`.
      if (inline === undefined || /^(?:true|1)$/i.test(inline)) kept.set(bare, [bare])
      else kept.delete(bare)
    } else if (config) {
      const text = value()
      const key = text?.split("=", 1)[0]
      if (usable(text) && key !== undefined && flags.config!.keys.includes(key))
        kept.set(`config:${key}`, [flags.config!.options[0]!, text])
    } else if (flags.takesValue.includes(name)) {
      if (inline === undefined) index += 1
      if (!flags.takesMany.includes(name)) continue
      // A lone `-` is a value to both Commander and clap, never an option.
      while (index + 1 < argv.length && !/^-./.test(argv[index + 1]!)) index += 1
    }
  }
  return [...kept.values()].flat()
}

/**
 * The kept words a resume gives beside the `choice` it is asked for: those of a model or
 * an effort `choice` sets itself are left out, so the model an agent last reported
 * (`/model` changed it) is not undone by the one it was started with.
 */
export const resumeFlags = (
  kept: readonly string[],
  choice: Choice,
  flags: Pick<KeptFlags, "bare" | "sets">,
): readonly string[] => {
  const bare = new Set(Object.values(flags.bare))
  const words: string[] = []
  for (let index = 0; index < kept.length; index += 1) {
    const flag = kept[index]!
    const value = bare.has(flag) ? undefined : kept[index + 1]
    const unit = value === undefined ? [flag] : [flag, value]
    index += unit.length - 1
    const sets = flags.sets(flag, value)
    if ((sets === "model" && choice.model !== undefined) || (sets === "effort" && choice.effort))
      continue
    words.push(...unit)
  }
  return words
}
