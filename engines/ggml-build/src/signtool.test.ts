import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { zipOf } from "../test/zip.ts"
import { sha256 } from "./machine.ts"
import {
  type Fetch,
  metadata,
  notPinnedPackage,
  packageUrl,
  type Pin,
  signArguments,
  signingClientPackage,
  signToolPackage,
  signWindowsFiles,
  unpackPinned,
  windowsSigning,
} from "./signtool.ts"

const folders: string[] = []
const scratch = (): string => {
  const folder = mkdtempSync(join(tmpdir(), "ggml-build-"))
  folders.push(folder)
  return folder
}
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true })
})

// A small package and its pin, and a fetch that serves it and counts its requests.
const packaged = zipOf([
  ["Tool.nuspec", "<package/>"],
  ["bin/x64/signtool.exe", "the tool"],
  ["bin/x64/en-US/signtool.exe.mui", "its messages", true],
  ["bin/x86/signtool.exe", "another architecture's"],
])
const pin: Pin = { id: "Tool", version: "1.2.3", sha256: sha256(packaged), folder: "bin/x64" }
const serving = (data: Uint8Array): { get: Fetch; requests: string[] } => {
  const requests: string[] = []
  return {
    requests,
    get: async (url) => {
      requests.push(url)
      return data
    },
  }
}
const listed = (folder: string): string[] =>
  (readdirSync(folder, { recursive: true }) as string[])
    .map((name) => name.split("\\").join("/"))
    .toSorted()

describe("the signing tools' pins", () => {
  it("name one version and one checksum each, and the x64 folder", () => {
    for (const each of [signToolPackage, signingClientPackage]) {
      expect(each.version, each.id).toMatch(/^\d+(\.\d+)+$/)
      expect(each.sha256, each.id).toMatch(/^[0-9a-f]{64}$/)
      expect(each.folder, each.id).toMatch(/x64$/)
    }
  })

  it("are fetched from nuget.org's own file for that version", () => {
    expect(packageUrl(signingClientPackage)).toBe(
      "https://api.nuget.org/v3-flatcontainer/microsoft.trusted.signing.client/1.0.95/microsoft.trusted.signing.client.1.0.95.nupkg",
    )
  })

  it("say what bytes came when they are not the package pinned", () => {
    expect(notPinnedPackage(pin, packaged)).toBeUndefined()
    expect(notPinnedPackage(pin, Buffer.from("<html>"))).toBe(
      "Tool 1.2.3 is not the package pinned " +
        "(https://api.nuget.org/v3-flatcontainer/tool/1.2.3/tool.1.2.3.nupkg): got 6 bytes " +
        `with sha256 ${sha256(Buffer.from("<html>"))}, not ${pin.sha256}.`,
    )
  })
})

describe("unpacking a pinned package", () => {
  it("unpacks the tool's folder from the package fetched, and keeps the package", async () => {
    const folder = scratch()
    const { get, requests } = serving(packaged)
    const tool = await unpackPinned(pin, folder, get)
    expect(requests).toEqual([packageUrl(pin)])
    expect(tool).toBe(join(folder, "Tool.1.2.3"))
    expect(listed(tool)).toEqual(["en-US", "en-US/signtool.exe.mui", "signtool.exe"])
    expect(readFileSync(join(tool, "signtool.exe"), "utf8")).toBe("the tool")
    expect(sha256(readFileSync(join(folder, "Tool.1.2.3.nupkg")))).toBe(pin.sha256)
  })

  it("stops on a package that is not the one pinned, and unpacks none of it", async () => {
    const folder = scratch()
    const other = zipOf([["bin/x64/signtool.exe", "someone else's tool"]])
    await expect(unpackPinned(pin, folder, serving(other).get)).rejects.toThrow(
      /^Tool 1\.2\.3 is not the package pinned .* got \d+ bytes with sha256 [0-9a-f]{64}, not /,
    )
    expect(listed(folder)).toEqual([])
  })

  it("needs no network for a package an earlier build kept", async () => {
    const folder = scratch()
    await unpackPinned(pin, folder, serving(packaged).get)
    const again = serving(packaged)
    await unpackPinned(pin, folder, again.get)
    expect(again.requests).toEqual([])
  })

  it("fetches again when the kept package is no longer the one pinned", async () => {
    const folder = scratch()
    await unpackPinned(pin, folder, serving(packaged).get)
    writeFileSync(join(folder, "Tool.1.2.3.nupkg"), zipOf([["bin/x64/signtool.exe", "changed"]]))
    const again = serving(packaged)
    const tool = await unpackPinned(pin, folder, again.get)
    expect(again.requests).toEqual([packageUrl(pin)])
    expect(readFileSync(join(tool, "signtool.exe"), "utf8")).toBe("the tool")
  })

  it("leaves nothing in the tool's folder but the package's files", async () => {
    const folder = scratch()
    const tool = await unpackPinned(pin, folder, serving(packaged).get)
    // A library beside signtool.exe would be loaded by it, and a changed tool would sign.
    writeFileSync(join(tool, "version.dll"), "planted")
    writeFileSync(join(tool, "signtool.exe"), "changed")
    await unpackPinned(pin, folder, serving(packaged).get)
    expect(listed(tool)).toEqual(["en-US", "en-US/signtool.exe.mui", "signtool.exe"])
    expect(readFileSync(join(tool, "signtool.exe"), "utf8")).toBe("the tool")
  })
})

describe("signing on Windows", () => {
  const named = {
    AZURE_SIGNING_ENDPOINT: "https://weu.codesigning.azure.net",
    AZURE_SIGNING_ACCOUNT: "novadeck",
    AZURE_SIGNING_PROFILE: "release",
  }
  const signing = {
    endpoint: "https://weu.codesigning.azure.net",
    account: "novadeck",
    profile: "release",
  }
  const tools = Promise.resolve({
    signtool: "C:\\tools\\signtool.exe",
    dlib: "C:\\tools\\dlib.dll",
  })

  it("signs only when the release names the endpoint, account and profile", () => {
    expect(windowsSigning(named)).toEqual(signing)
    expect(windowsSigning({ ...named, AZURE_SIGNING_PROFILE: "" })).toBeUndefined()
    expect(windowsSigning({})).toBeUndefined()
  })

  it("names the account to the signing client, and leaves it the release's credentials alone", () => {
    const told = JSON.parse(metadata(signing)) as Record<string, unknown>
    expect(told).toMatchObject({
      Endpoint: "https://weu.codesigning.azure.net",
      CodeSigningAccountName: "novadeck",
      CertificateProfileName: "release",
    })
    const excluded = told.ExcludeCredentials as string[]
    expect(excluded).toContain("AzureCliCredential")
    expect(excluded).toContain("ManagedIdentityCredential")
    expect(excluded).not.toContain("EnvironmentCredential")
  })

  it("gives SignTool the signing library, the account's file and the files, each as one argument", () => {
    expect(
      signArguments("C:\\to ols\\dlib.dll", "C:\\t\\metadata.json", ["a b.exe", "c.dll"]),
    ).toEqual([
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
      "C:\\to ols\\dlib.dll",
      "/dmdf",
      "C:\\t\\metadata.json",
      "a b.exe",
      "c.dll",
    ])
  })

  it("runs the pinned SignTool once over the files, with the account's file there only meanwhile", async () => {
    const runs: { signtool: string; args: readonly string[]; told: string }[] = []
    await signWindowsFiles(["server.exe", "ggml.dll"], signing, tools, (signtool, args) => {
      runs.push({ signtool, args, told: readFileSync(args[args.indexOf("/dmdf") + 1]!, "utf8") })
      return { status: 0, printed: "" }
    })
    expect(runs).toHaveLength(1)
    const [run] = runs
    expect(run!.signtool).toBe("C:\\tools\\signtool.exe")
    expect(run!.args.slice(-2)).toEqual(["server.exe", "ggml.dll"])
    expect(run!.args[run!.args.indexOf("/dlib") + 1]).toBe("C:\\tools\\dlib.dll")
    expect(run!.told).toBe(metadata(signing))
    expect(existsSync(run!.args[run!.args.indexOf("/dmdf") + 1]!)).toBe(false)
  })

  it.each([1, 2, null])("stops the build on exit code %s: any but success", async (status) => {
    const run = () => ({ status, printed: "" })
    await expect(signWindowsFiles(["server.exe"], signing, tools, run)).rejects.toThrow(
      `SignTool failed with exit code ${status}:`,
    )
  })

  it("ends its error with what SignTool printed last, which says why", async () => {
    // electron-builder signs a file again when the error names this cause.
    const printed = [
      ...Array.from({ length: 30 }, (_, line) => `line ${line}`),
      "SignTool Error: The process cannot access the file because it is being used by another process.",
      "",
    ].join("\r\n")
    const failure = signWindowsFiles(["app.node"], signing, tools, () => ({ status: 1, printed }))
    await expect(failure).rejects.toThrow(/being used by another process\.$/)
    await expect(failure).rejects.not.toThrow(/line 10\b/)
  })

  it("stops rather than report a folder with nothing to sign as signed", async () => {
    const run = (): never => {
      throw new Error("SignTool ran")
    }
    await expect(signWindowsFiles([], signing, tools, run)).rejects.toThrow(
      "There are no files to sign.",
    )
  })
})
