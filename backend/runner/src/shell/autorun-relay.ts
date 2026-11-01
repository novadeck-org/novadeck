import { execFile } from "node:child_process"

import { decodeValue, unwrapped } from "./autorun-value.js"
import { withoutInherited } from "./inherited.js"

// The runner's calls of the relay's `autorun` and `autorun-set` (backend/relay/src/autorun.rs),
// which read and swap cmd's AutoRun in the registry. Always the build's own relay, never the
// copy installed for agents.

/** What the registry holds under one scope's AutoRun, as the relay prints it. */
export type Scope =
  | { readonly found: "absent" }
  | { readonly found: "unreadable" }
  | {
      readonly found: "value"
      readonly type: "sz" | "expand" | "other"
      /** The raw bytes in base64, as the relay printed them. */
      readonly encoded: string
    }

/** The person's AutoRun (HKCU) and the machine's (HKLM, the 64-bit view cmd reads). */
export type AutoRunRead = { readonly user: Scope; readonly machine: Scope }

/** How `autorun-set` ended, by its exit code. */
export type Swap = "ok" | "changed" | "unverified" | "failed"

type Ran = { readonly code: number | undefined; readonly stdout: string }

/** Runs the relay with `args`; the exit code is undefined where it did not start or ran long. */
export const runRelay = (relay: string, args: readonly string[], timeoutMs = 10_000) =>
  new Promise<Ran>((resolve) => {
    execFile(
      relay,
      [...args],
      { env: withoutInherited(process.env), timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (!error) return resolve({ code: 0, stdout })
        const code = (error as { code?: unknown }).code
        const killed = (error as { killed?: boolean }).killed === true
        resolve({ code: typeof code === "number" && !killed ? code : undefined, stdout })
      },
    )
  })

const base64 = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * What the relay's `autorun` printed: a line for each scope that holds a value (see the
 * relay), none for one that holds nothing. Undefined for an answer that isn't one.
 */
export const parseAutoRun = (output: string): AutoRunRead | undefined => {
  const scopes: { user: Scope; machine: Scope } = {
    user: { found: "absent" },
    machine: { found: "absent" },
  }
  const seen = new Set<string>()
  for (const line of output.split(/\r?\n/).filter((each) => each !== "")) {
    const [scope, kind, encoded, ...more] = line.split(" ")
    if ((scope !== "user" && scope !== "machine") || seen.has(scope) || more.length > 0)
      return undefined
    seen.add(scope)
    if (kind === "unreadable" && encoded === undefined) {
      scopes[scope] = { found: "unreadable" }
      continue
    }
    if (
      (kind !== "sz" && kind !== "expand" && kind !== "other") ||
      encoded === undefined ||
      !base64.test(encoded)
    )
      return undefined
    scopes[scope] = { found: "value", type: kind, encoded }
  }
  return scopes
}

/** The registry's AutoRun values through the relay, or undefined where it could not be read. */
export const readAutoRun = async (relay: string): Promise<AutoRunRead | undefined> => {
  const { code, stdout } = await runRelay(relay, ["autorun"])
  return code === 0 ? parseAutoRun(stdout) : undefined
}

/**
 * Whether the person's AutoRun is exactly Novadeck's wrapper (`(<inner>) >nul 2>&1`) round
 * something `silenced` accepts, whoever wrote it, which the state `silenced` is read from.
 */
export const wrappedBy = (read: AutoRunRead | undefined): boolean => {
  if (read?.user.found !== "value") return false
  const value = decodeValue(read.user.type, read.user.encoded)
  return value !== undefined && unwrapped(value.text) !== undefined
}

/**
 * Compares HKCU's AutoRun with the expected bytes and sets the new ones, the same type
 * (`autorun-set`): "changed" where it was not as expected, "unverified" where the read-back
 * differed, "failed" for anything else.
 */
export const swapAutoRun = async (
  relay: string,
  kind: "sz" | "expand",
  expected: string,
  next: string,
): Promise<Swap> => {
  const { code } = await runRelay(relay, ["autorun-set", kind, expected, next])
  if (code === 0) return "ok"
  if (code === 3) return "changed"
  if (code === 4) return "unverified"
  return "failed"
}
