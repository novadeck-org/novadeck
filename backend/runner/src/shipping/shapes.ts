/**
 * The commands the shim has Antigravity allow by rule while the shipping gate is on
 * (`shippingRules`), read coarsely: more counts than the rules allow, never less. Where the
 * runner can't decide a command (its read failed, or was late), these are refused rather than
 * left to a rule that would run them unasked. The relay holds the same list and the same coarse
 * reading for where the runner gives no answer at all (backend/relay `hook.rs`, `command_ships`);
 * both are tested against `backend/relay/src/rule-cases.json`.
 */
import { shippingRules } from "@novadeck/harness-agy/shim"

const words = (rule: string): string[] =>
  rule
    .replace(/^command\(/, "")
    .replace(/\)$/, "")
    .split(/\s+/)
    .filter(Boolean)

/** Whether `command` holds a segment of a shape of `shippingRules`. */
export const shipsByRule = (command: string): boolean =>
  command.split(/[;&|\n\r]/).some((segment) => {
    // Leading `NAME=value` words are no program.
    const tokens = segment.split(/\s+/).filter(Boolean)
    const first = tokens.findIndex((word) => !(word.includes("=") && !word.startsWith("-")))
    const named = first < 0 ? [] : tokens.slice(first)
    const [program, ...rest] = named
    const name = program?.split(/[/\\]/).at(-1)
    return shippingRules.some((rule) => {
      const [head, ...tail] = words(rule)
      let next = 0
      for (const word of rest) if (word === tail[next]) next += 1
      return name === head && next === tail.length
    })
  })
