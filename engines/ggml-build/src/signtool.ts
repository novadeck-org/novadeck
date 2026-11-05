import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { replaceFile, sha256 } from "./machine.ts"
import { unzip } from "./zip.ts"

// Windows signing, for the engines and the app alike: SignTool, with the Azure Artifact
// Signing client as its signing library, each from a NuGet package pinned by version and
// checksum. Nothing else is fetched to sign, and nothing a package's owner publishes later
// can reach a release without a change to the pins below.

/** A NuGet package pinned by its version and its bytes, and the folder of it that is used. */
export type Pin = {
  readonly id: string
  readonly version: string
  /** The `.nupkg` file's SHA-256, as nuget.org serves it. */
  readonly sha256: string
  /** The folder inside the package that holds the x64 tool. */
  readonly folder: string
}

// The pair Microsoft's own TrustedSigning PowerShell module 0.5.8 installs. To move a pin,
// download the new package, compare its SHA-512 with the `packageHash` nuget.org's catalog
// lists for that version, and put its SHA-256 here; Check Signing Tools in the Package
// workflow then tries the new pair on a pull request.

/** SignTool, from the Windows SDK's build tools. */
export const signToolPackage: Pin = {
  id: "Microsoft.Windows.SDK.BuildTools",
  version: "10.0.26100.4188",
  sha256: "180deb372659029864c10a0c04787833234d64aacd1d2c0661d2c00295d8e022",
  folder: "bin/10.0.26100.0/x64",
}

/** The Artifact Signing client: the library SignTool signs through (`/dlib`). */
export const signingClientPackage: Pin = {
  id: "Microsoft.Trusted.Signing.Client",
  version: "1.0.95",
  sha256: "3bfcf1e0a3cb42af1692f0a8ed45c15de070c2de86f28a59b2795d904d8a920f",
  folder: "bin/x64",
}

/** Where nuget.org serves the package's file: a version's file never changes there. */
export const packageUrl = ({ id, version }: Pin): string => {
  const name = id.toLowerCase()
  return `https://api.nuget.org/v3-flatcontainer/${name}/${version}/${name}.${version}.nupkg`
}

/** Why the bytes are not the pinned package, naming what they are, or nothing when they are it. */
export const notPinnedPackage = (pin: Pin, data: Uint8Array): string | undefined => {
  const digest = sha256(data)
  if (digest === pin.sha256) return undefined
  return (
    `${pin.id} ${pin.version} is not the package pinned (${packageUrl(pin)}): ` +
    `got ${data.length} bytes with sha256 ${digest}, not ${pin.sha256}.`
  )
}

/** Fetches a package's bytes. */
export type Fetch = (url: string) => Promise<Uint8Array>

const downloadTimeout = 5 * 60 * 1000
const attempts = 3

// nuget.org's files are served from a CDN; a failed request is tried again after a pause,
// as a release should not fail on one.
const download = async (url: string, attempt = 1): Promise<Uint8Array> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(downloadTimeout) })
    if (!response.ok) throw new Error(`${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (attempt === attempts) {
      throw new Error(`Downloading ${url} failed: ${reason}`, { cause: error })
    }
    console.log(`Downloading ${url} failed (${reason}); trying again.`)
    await new Promise((resolve) => setTimeout(resolve, attempt * 10_000))
    return download(url, attempt + 1)
  }
}

// The package's bytes, checked against the pin: the copy an earlier build kept when it is
// still the pinned one, or else a fresh download, kept for the next build.
const pinned = async (pin: Pin, folder: string, get: Fetch): Promise<Uint8Array> => {
  const file = join(folder, `${pin.id}.${pin.version}.nupkg`)
  if (existsSync(file)) {
    const kept = readFileSync(file)
    if (!notPinnedPackage(pin, kept)) return kept
  }
  console.log(`Downloading ${pin.id} ${pin.version}`)
  const data = await get(packageUrl(pin))
  const problem = notPinnedPackage(pin, data)
  if (problem) throw new Error(problem)
  await mkdir(folder, { recursive: true })
  await replaceFile(file, data)
  return data
}

/**
 * Unpacks the package's tool folder in `folder`, afresh from the checked bytes, and answers
 * where. The folder then holds exactly the package's files: one left beside a tool could be
 * loaded by it.
 */
export const unpackPinned = async (pin: Pin, folder: string, get: Fetch): Promise<string> => {
  const files = unzip(await pinned(pin, folder, get), pin.folder)
  const into = join(folder, `${pin.id}.${pin.version}`)
  // Windows may still hold a tool an earlier step ran a moment ago.
  await rm(into, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  await Promise.all(
    [...files].map(async ([name, data]) => {
      const path = join(into, name)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, data)
    }),
  )
  return into
}

/** The tools that sign: SignTool and the library it signs through. */
export type SigningTools = { readonly signtool: string; readonly dlib: string }

const found = (path: string, pin: Pin): string => {
  if (!existsSync(path)) throw new Error(`${pin.id} ${pin.version} holds no ${pin.folder}.`)
  return path
}

/**
 * The pinned signing tools, unpacked in `folder` from packages checked against their pins.
 * The packages are kept there, so later builds on this computer need no network.
 */
export const signingTools = async (
  folder: string = join(tmpdir(), "novadeck-signing-tools"),
  get: Fetch = (url) => download(url),
): Promise<SigningTools> => ({
  signtool: found(
    join(await unpackPinned(signToolPackage, folder, get), "signtool.exe"),
    signToolPackage,
  ),
  dlib: found(
    join(await unpackPinned(signingClientPackage, folder, get), "Azure.CodeSigning.Dlib.dll"),
    signingClientPackage,
  ),
})

/** The Azure Artifact Signing account that signs. */
export type WindowsSigning = {
  readonly endpoint: string
  readonly account: string
  readonly profile: string
}

/** The Azure Artifact Signing account a release names, or nothing when it names none. */
export const windowsSigning = (env: NodeJS.ProcessEnv): WindowsSigning | undefined => {
  const endpoint = env.AZURE_SIGNING_ENDPOINT
  const account = env.AZURE_SIGNING_ACCOUNT
  const profile = env.AZURE_SIGNING_PROFILE
  return endpoint && account && profile ? { endpoint, account, profile } : undefined
}

// Every way the client can find an Azure identity but the one a release gives it: the
// service principal in AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET. Which
// identity signs is then never the client's choice, and with no credentials it stops at
// once rather than asking the computer's other sign-ins.
const otherCredentials = [
  "WorkloadIdentityCredential",
  "ManagedIdentityCredential",
  "SharedTokenCacheCredential",
  "VisualStudioCredential",
  "VisualStudioCodeCredential",
  "AzureCliCredential",
  "AzurePowerShellCredential",
  "AzureDeveloperCliCredential",
  "InteractiveBrowserCredential",
]

/** The file that tells the signing client which account signs (`/dmdf`). */
export const metadata = ({ endpoint, account, profile }: WindowsSigning): string =>
  JSON.stringify({
    Endpoint: endpoint,
    CodeSigningAccountName: account,
    CertificateProfileName: profile,
    ExcludeCredentials: otherCredentials,
  })

/** SignTool's arguments: SHA-256 digests, a timestamp from Microsoft's server, the files last. */
export const signArguments = (
  dlib: string,
  metadataFile: string,
  files: readonly string[],
): string[] => [
  "sign",
  "/v",
  "/debug",
  "/fd",
  "SHA256",
  "/tr",
  "http://timestamp.acs.microsoft.com",
  "/td",
  "SHA256",
  "/dlib",
  dlib,
  "/dmdf",
  metadataFile,
  ...files,
]

/** Runs SignTool and answers its exit code. */
export type SignTool = (signtool: string, args: readonly string[]) => number | null

// SignTool is the one command given the whole environment, the Azure credentials with it:
// the signing client reads them from there.
const signTool: SignTool = (signtool, args) => {
  const result = spawnSync(signtool, args, { stdio: "inherit" })
  if (result.error) throw new Error(`${signtool} failed to start: ${result.error.message}`)
  return result.status
}

let fetched: Promise<SigningTools> | undefined

/**
 * Signs the files through the Azure Artifact Signing account, with the pinned tools, which
 * are fetched once for the process. Any exit code but success stops the build.
 */
export const signWindowsFiles = async (
  files: readonly string[],
  signing: WindowsSigning,
  tools: Promise<SigningTools> = (fetched ??= signingTools()),
  run: SignTool = signTool,
): Promise<void> => {
  if (files.length === 0) throw new Error("There are no files to sign.")
  const { signtool, dlib } = await tools
  const folder = await mkdtemp(join(tmpdir(), "novadeck-signing-"))
  try {
    const metadataFile = join(folder, "metadata.json")
    await writeFile(metadataFile, metadata(signing))
    const status = run(signtool, signArguments(dlib, metadataFile, files))
    if (status !== 0) throw new Error(`SignTool failed with exit code ${status}.`)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}
