import { execFileSync } from "node:child_process"

import type { AgentSetup } from "./agents/agent.js"

/**
 * The targets the Windows Credential Manager holds for this user, by name only, never a
 * secret: what `cmdkey /list` prints after `target=` (`gemini:antigravity`). Empty off
 * Windows.
 */
export const credentialTargets = (): readonly string[] => {
  if (process.platform !== "win32") return []
  const listed = execFileSync("cmdkey", ["/list"], { encoding: "utf8", windowsHide: true })
  return [...listed.matchAll(/target=([^\r\n]+)/gi)].map((match) => match[1]!.trim())
}

/**
 * The logins the setups' harnesses keep in the Credential Manager, as each setup's
 * `credentials` names them, among `targets`.
 */
export const harnessLogins = (
  setups: readonly Pick<AgentSetup, "credentials">[],
  targets: readonly string[] = credentialTargets(),
): readonly string[] =>
  targets.filter((target) =>
    setups.some((setup) => setup.credentials?.some((pattern) => pattern.test(target))),
  )
