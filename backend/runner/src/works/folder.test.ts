import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path, { join } from "node:path"

import { describe, expect, it } from "../test.js"
import { folderBetween, folderOf } from "./folder.js"

describe("the folder of a repository in a project", () => {
  it("is empty both ways where the project's folder is the checkout's", () => {
    expect(folderBetween("/w/app", "/w/app")).toEqual({ repo: "", project: "" })
  })

  it("names the checkout's path where it is inside the project's folder", () => {
    expect(folderBetween("/w", "/w/source/app")).toEqual({ repo: "", project: "source/app" })
  })

  it("names the project's path from the top where the project's folder is inside the checkout", () => {
    expect(folderBetween("/w/app/packages/ui", "/w/app")).toEqual({
      repo: "packages/ui",
      project: "",
    })
    expect(folderBetween("/w/app/src", "/w/app")).toEqual({ repo: "src", project: "" })
  })

  it("names nothing where the checkout is a sibling or elsewhere", () => {
    expect(folderBetween("/w/app", "/w/other")).toBeUndefined()
    expect(folderBetween("/w/app/src", "/w/other/deep")).toBeUndefined()
  })

  it("separates with slashes on Windows, and names nothing across drives", () => {
    expect(folderBetween("C:\\w", "C:\\w\\source\\app", path.win32)).toEqual({
      repo: "",
      project: "source/app",
    })
    expect(folderBetween("C:\\w\\app\\src", "C:\\w\\app", path.win32)).toEqual({
      repo: "src",
      project: "",
    })
    expect(folderBetween("C:\\w", "D:\\w\\app", path.win32)).toBeUndefined()
  })

  it("is found from the common git dir, through a symlinked project folder", async ({
    resources,
  }) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "novadeck-folder-test-")))
    resources.defer(() => rm(base, { recursive: true, force: true }))
    await mkdir(join(base, "real", "source", "app", ".git"), { recursive: true })
    await symlink(join(base, "real"), join(base, "link"))
    const common = join(base, "real", "source", "app", ".git")
    expect(await folderOf(join(base, "link"), common)).toEqual({ repo: "", project: "source/app" })
    expect(await folderOf(join(base, "real", "source", "app"), common)).toEqual({
      repo: "",
      project: "",
    })
    expect(await folderOf(join(base, "real", "source", "app", ".git"), common)).toEqual({
      repo: ".git",
      project: "",
    })
    expect(await folderOf(join(base, "elsewhere"), common)).toBeUndefined()
    expect(await folderOf(undefined, common)).toBeUndefined()
    // A bare repository has no main checkout.
    expect(await folderOf(base, join(base, "bare.git"))).toBeUndefined()
  })
})
