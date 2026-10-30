// A text's secrets, marked by the rules and rendered as placeholders.
import { hide, masks, redacted, render, unmarked } from "./marks.js"
import { soundsSecret } from "./names.js"
import { type Rule, rules, valueCap } from "./rules.js"

// The last group a match holds: its value.
const lastGroup = (found: readonly (string | undefined)[]): string =>
  found.findLast((group) => group !== undefined) ?? ""

const scan = (text: string, rule: Extract<Rule, { scan: unknown }>): string => {
  const { pattern, field } = rule
  let result = ""
  let last = 0
  pattern.lastIndex = 0
  for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
    if (field) {
      if (!soundsSecret(found[field.name] ?? "")) continue
      field.value.lastIndex = pattern.lastIndex
      const value = field.value.exec(text)?.[0]
      if (value === undefined) continue
      found[0] += value
      found.push(value)
      pattern.lastIndex += value.length
    }
    const replaced = rule.scan({ offset: found.index, text }, ...found)
    const value = lastGroup(found)
    if (replaced === found[0]) {
      // Look again from the match's value, the last thing in it: past the name, so that a
      // name which is no secret cannot hide one in its value, and never into the middle of a
      // character that takes two code units, where the same match would come back for ever.
      let next = Math.max(found.index + 1, found.index + found[0].length - value.length)
      const unit = text.charCodeAt(next)
      if (unit >= 0xdc00 && unit <= 0xdfff) next += 1
      pattern.lastIndex = next
      continue
    }
    if (found[0] === "") pattern.lastIndex += 1
    let end = found.index + found[0].length
    let masked = replaced
    // A value that reached the cap goes on to the end of its run, and so does its mask.
    if (value.length >= valueCap) {
      const tail = /^[^\s"',;&]*/.exec(text.slice(end))?.[0] ?? ""
      masked += hide(tail)
      end += tail.length
    }
    result += text.slice(last, found.index) + masked
    last = end
  }
  return result + text.slice(last)
}

/** `text` with each secret's characters replaced by sentinels, so it keeps its length. */
export const mark = (text: string): string =>
  rules.reduce(
    (marked, rule) =>
      "scan" in rule ? scan(marked, rule) : marked.replace(rule.pattern, rule.replace),
    unmarked(text),
  )

/**
 * A redactor that writes each secret, and each run of secrets with only newlines between them,
 * as `placeholder`.
 */
export const redactAs =
  (placeholder: string) =>
  (text: string): string =>
    render(mark(text), placeholder)

/** `text` with each secret written as `[redacted]`. */
export const redact = redactAs(redacted)

/** The pieces of `text` that `redact` masks, for a check on what was masked. */
export const maskedSpans = (text: string): string[] =>
  [...mark(text).matchAll(masks)].map((match) =>
    text.slice(match.index, match.index + match[0].length),
  )
