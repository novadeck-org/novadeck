import { execFileSync } from "node:child_process"

import type { AgentSetup, KeychainItem } from "./agents/agent.js"

/** Where this system keeps the logins a harness may hold, as a failure names it. */
export const loginStore =
  process.platform === "darwin" ? "the macOS Keychain" : "Windows' Credential Manager"

/**
 * Whether the user's Keychain holds a generic password of the service and account,
 * asked by its attributes alone: `security` reads no secret without `-w`, so this never
 * asks the person to allow access. It fails closed, as Windows' `cmdkey` does: only
 * `security`'s "not found" (exit 44) says it isn't there; a locked keychain, a timeout or
 * a missing `security` throws.
 */
const inKeychain = ({ service, account }: KeychainItem): boolean => {
  try {
    execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account], {
      stdio: "ignore",
      timeout: 10_000,
    })
    return true
  } catch (error) {
    if ((error as { status?: unknown }).status === 44) return false
    throw new Error(`Couldn't ask the macOS Keychain for ${service}:${account}`, {
      cause: error,
    })
  }
}

/**
 * The logins the setups' harnesses keep in this system's login store, by name only, never
 * a secret. On Windows, the targets `cmdkey /list` prints after `target=`
 * (`gemini:antigravity`) that a setup's `credentials` names. On macOS, where only asking
 * for an item tells, those of the setups' `keychain` items the Keychain holds, named as
 * Windows names them (`service:account`). None elsewhere.
 */
export const harnessLogins = (
  setups: readonly Pick<AgentSetup, "credentials" | "keychain">[],
  platform: NodeJS.Platform = process.platform,
  store: { readonly targets?: () => readonly string[]; readonly holds?: typeof inKeychain } = {},
): readonly string[] => {
  if (platform === "darwin")
    return setups
      .flatMap((setup) => setup.keychain ?? [])
      .filter(store.holds ?? inKeychain)
      .map(({ service, account }) => `${service}:${account}`)
  if (platform !== "win32") return []
  return (store.targets ?? cmdkeyTargets)().filter((target) =>
    setups.some((setup) => setup.credentials?.some((pattern) => pattern.test(target))),
  )
}

// What the Credential Manager holds for this user, by target name only.
const cmdkeyTargets = (): readonly string[] => {
  const listed = execFileSync("cmdkey", ["/list"], { encoding: "utf8", windowsHide: true })
  return [...listed.matchAll(/target=([^\r\n]+)/gi)].map((match) => match[1]!.trim())
}
