import { spawnSync } from "node:child_process"
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { sha256, withoutCredentials } from "../src/machine.ts"
import {
  signingClientPackage,
  signingTools,
  signToolPackage,
  signWindowsFiles,
} from "../src/signtool.ts"

// `node scripts/signing-tools.ts`: checks the Windows signing tools without signing anything,
// which the Package workflow does on every run, pull requests included. It fetches the
// pinned packages, checks them against their pins and unpacks them, as a signing build
// does. On Windows it then has SignTool sign a scratch file through the signing library
// for an account that does not exist, with no credentials. That must fail, and for want of
// credentials alone, once the library has loaded, read the account's file and gone to
// submit the digest: so a pair of pins that cannot sign together, or a runner without the
// .NET runtime, fails here and not in a release. A real signature needs the release's
// credentials, and only a release has them.

// What the signing library prints once it is loaded and is about to ask the service, and
// what its Azure client says when the environment holds no credentials for it.
const submitting = "Submitting digest for signing"
const noCredentials = "EnvironmentCredential authentication unavailable"

// A reserved name no request can reach.
const nowhere = { endpoint: "https://signing.invalid", account: "none", profile: "none" }

const tried = async (signtool: string, dlib: string): Promise<string | undefined> => {
  const folder = mkdtempSync(join(tmpdir(), "novadeck-signing-check-"))
  try {
    const scratch = join(folder, "scratch.exe")
    copyFileSync(signtool, scratch)
    const before = sha256(readFileSync(scratch))
    let printed = ""
    let failure: string | undefined
    try {
      await signWindowsFiles(
        [scratch],
        nowhere,
        Promise.resolve({ signtool, dlib }),
        (command, args) => {
          const result = spawnSync(command, args, {
            encoding: "utf8",
            env: withoutCredentials(process.env),
            timeout: 5 * 60 * 1000,
          })
          if (result.error) throw result.error
          printed = `${result.stdout}${result.stderr}`
          return { status: result.status, printed }
        },
      )
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    console.log(printed)
    if (failure === undefined) return "SignTool signed a file with no credentials."
    if (!printed.includes(submitting)) {
      return "SignTool stopped before the signing library went to sign."
    }
    if (!printed.includes(noCredentials)) {
      return "SignTool failed, but not for want of credentials."
    }
    if (sha256(readFileSync(scratch)) !== before)
      return "SignTool changed the file it did not sign."
    console.log("SignTool failed for want of credentials, as it must.")
    return undefined
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

const { signtool, dlib } = await signingTools()
for (const { id, version, sha256: pinned } of [signToolPackage, signingClientPackage]) {
  console.log(`${id} ${version} is the package pinned (sha256 ${pinned}).`)
}
if (process.platform === "win32") {
  const problem = await tried(signtool, dlib)
  if (problem) {
    console.error(problem)
    process.exitCode = 1
  } else {
    console.log("The signing tools load and stop only for want of credentials.")
  }
}
