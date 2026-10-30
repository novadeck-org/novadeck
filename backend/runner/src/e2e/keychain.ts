import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"

import { agentNames } from "@novadeck/protocol"
import { createSandbox, type Sandbox as Base } from "@novadeck/sandbox"

/**
 * The e2e suite's sandbox (see `createSandbox`), with its gap on macOS closed for Claude
 * Code: it names its login's Keychain items after the sandbox's folder, and its `security`
 * is the sandbox's own, which refuses it any item with no such suffix (`keychainGuard`);
 * Codex keeps its login in a file; a test of Antigravity, whose item has a fixed name,
 * refuses to start while it is there (`credentials.ts`); and Codex reads Reduce motion
 * from the defaults. On Windows, a terminal's `cmd /k`, as the runner starts one, and
 * Antigravity's `cmd /c` for its hooks run the developer's AutoRun, as the runner leaves
 * it so, as a person's terminal should run it.
 */
export type Sandbox = Base & {
  /**
   * On macOS, where the sandbox's `security` writes the Keychain service each program
   * asked it for, one a line (see `keychainGuard`); none elsewhere.
   */
  readonly keychainLog?: string
}

/**
 * Claude Code's Keychain items with no folder's suffix: the person's own login, never one a
 * Claude Code given the sandbox's `CLAUDE_CONFIG_DIR` should ask for, as it names each
 * item `-` and 8 hex digits of that folder's SHA-256 after it (`harness-coverage.md`).
 */
export const unsuffixedClaudeItem = /^Claude Code(?!.*-[0-9a-f]{8}$)/

/**
 * On macOS, a `security` of the sandbox's own, on its PATH before the system's, as Claude
 * Code calls it by name (`keychain-guard.sh`): it writes each service asked for to `log`,
 * whether given as `-s`, joined as `-sName` or, as Claude Code writes its items, anywhere
 * on the input of `security -i` (an interactive `-i` read among the global options, as
 * getopt does), and answers "not found" (exit 44), passing nothing on, where one
 * is a Claude Code item with no folder's suffix, the person's own, such as its fixed
 * `Claude Code-device-keys`; the rest goes to `real`. Claude Code is then never given the
 * person's items, nor can it overwrite them, and its test fails, in CI too, which holds
 * none. Antigravity calls `/usr/bin/security` by its path, which this can't see; its login
 * is refused as Windows' is (`credentials.ts`).
 */
export const keychainGuard = (folder: string, log: string, real = "/usr/bin/security"): void => {
  const program = join(folder, "security")
  const guard = readFileSync(new URL("keychain-guard.sh", import.meta.url), "utf8")
  writeFileSync(program, `#!/bin/sh\nlog=${shellQuote(log)}\nreal=${shellQuote(real)}\n${guard}`)
  chmodSync(program, 0o755)
}

// A word sh reads as the text itself, whatever it holds.
const shellQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`

/** The Keychain services the sandbox's programs asked for, in order (see `keychainGuard`). */
export const keychainAsks = (sandbox: Pick<Sandbox, "keychainLog">): readonly string[] => {
  if (!sandbox.keychainLog || !existsSync(sandbox.keychainLog)) return []
  return readFileSync(sandbox.keychainLog, "utf8").split("\n").filter(Boolean)
}

/**
 * The sandbox's folder name, before its random part: with a space where
 * NOVADECK_E2E_SPACED=1 asks for one, as a profile folder like `C:\Users\Ada Lovelace`
 * has, so the home, and Novadeck's launcher inside the sandbox, are named with one too:
 * Windows CI's quirks job runs so, where cmd reads the launcher by its short name.
 */
const prefix = (): string =>
  process.env.NOVADECK_E2E_SPACED === "1" ? "novadeck e2e-" : "novadeck-e2e-"

/**
 * Makes the e2e suite's sandbox, with the fake model's proxy and the pinned harnesses'
 * folders first on PATH, none of the harnesses anywhere else on it; on macOS the
 * sandbox's `security` comes before them (see `keychainGuard`). The caller removes `root`.
 */
export const createE2ESandbox = (options: {
  readonly proxy: string
  readonly bins: readonly string[]
}): Sandbox => {
  const sandbox = createSandbox({
    ...options,
    prefix: prefix(),
    forbidden: agentNames,
    user: "novadeck",
  })
  if (process.platform !== "darwin") return sandbox
  const keychain = join(sandbox.root, "keychain")
  mkdirSync(keychain, { mode: 0o700 })
  const keychainLog = join(sandbox.root, "run", "keychain.log")
  keychainGuard(keychain, keychainLog)
  const env = { ...sandbox.env, PATH: [keychain, sandbox.env.PATH].join(delimiter) }
  return { ...sandbox, env, keychainLog }
}
