import type { Harness } from "@novadeck/harness-core/harness"

/**
 * Which of its screens holds it, by their headings (fixtures/startup.probe.json): its hooks
 * review, "Hooks need review" over "N hooks are new or changed." and its choices, which shows
 * until the person trusts Novadeck's hooks or skips them (probed 2026-11-15, 0.167.0); its
 * sign-in screen, "Sign in with ChatGPT" among the ways to use it (probed 2026-11-06,
 * 0.167.0). Its update screen, trust dialog and resume picker are only its startup screens.
 */
export const heldScreen: NonNullable<Harness["heldScreen"]> = (rows) => {
  const lines = rows.map((row) => row.trim())
  if (
    lines.includes("Hooks need review") &&
    lines.some((line) => / hooks? (?:is|are) new or changed\.$/.test(line))
  )
    return "hooks"
  if (
    lines.includes("Choose how you want to use Codex.") &&
    lines.some((line) => /\bSign in with ChatGPT$/.test(line))
  )
    return "sign-in"
  return undefined
}
