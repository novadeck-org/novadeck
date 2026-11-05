import { lstatSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

import { macos, type Run, windows } from "./machine.ts"
import { isLibrary } from "./stage.ts"

/** Signs the staged server and its libraries as the app is signed on this platform. */
export const sign = async (staging: string, executable: string, run: Run): Promise<void> => {
  if (macos) await signMac(staging, executable, run)
  if (windows) signWindows(staging, run)
}

// Apple silicon runs only signed code, so on macOS every Mach-O is signed: with the
// Developer ID that NOVADECK_MAC_IDENTITY names, under the hardened runtime as the app is,
// or else ad hoc.
const signMac = async (staging: string, executable: string, run: Run): Promise<void> => {
  const identity = process.env.NOVADECK_MAC_IDENTITY
  const how = identity
    ? ["--options", "runtime", "--timestamp", "--sign", identity]
    : ["--sign", "-"]
  for (const name of await readdir(staging)) {
    const path = join(staging, name)
    // A link points at a file signed under its own name.
    if (lstatSync(path).isFile() && (name === executable || isLibrary(name, "darwin"))) {
      run("codesign", ["--force", ...how, path])
    }
  }
}

// The signing module, pinned: it runs with the Azure credentials in its environment.
// electron-builder installs its own, the newest, to sign the app.
const trustedSigning = "0.5.8"

/** A PowerShell string literal. */
export const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`

/** The Azure Artifact Signing account a release names, or nothing when it names none. */
export const windowsSigning = (
  env: NodeJS.ProcessEnv,
):
  | { readonly endpoint: string; readonly account: string; readonly profile: string }
  | undefined => {
  const endpoint = env.AZURE_SIGNING_ENDPOINT
  const account = env.AZURE_SIGNING_ACCOUNT
  const profile = env.AZURE_SIGNING_PROFILE
  return endpoint && account && profile ? { endpoint, account, profile } : undefined
}

// On Windows the server and its modules are signed through Azure Artifact Signing, as the
// app is, when the release names the account; the module reads its credentials from
// AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET, which only this call is given.
const signWindows = (staging: string, run: Run): void => {
  const signing = windowsSigning(process.env)
  if (!signing) return
  const { endpoint, account, profile } = signing
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Install-Module -Name TrustedSigning -RequiredVersion ${trustedSigning} -Force -Repository PSGallery -Scope CurrentUser`,
    `Import-Module -Name TrustedSigning -RequiredVersion ${trustedSigning}`,
    [
      "Invoke-TrustedSigning",
      `-Endpoint ${quote(endpoint)}`,
      `-CodeSigningAccountName ${quote(account)}`,
      `-CertificateProfileName ${quote(profile)}`,
      `-FilesFolder ${quote(staging)}`,
      "-FilesFolderFilter 'exe,dll'",
      "-FileDigest SHA256",
      "-TimestampRfc3161 'http://timestamp.acs.microsoft.com'",
      "-TimestampDigest SHA256",
    ].join(" "),
  ].join("\n")
  run("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], { credentials: true })
}
