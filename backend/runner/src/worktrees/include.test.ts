import { execFileSync } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { copyIncluded, patternLines, reaching } from "./include.js"

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  }).trim()

const write = (path: string, text = "x\n") => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

type Fixture = { readonly repo: string; readonly worktree: string }

// A repository that ignores node_modules, certs and .env files, with a worktree of it on `w`
// that has only its tracked files.
const it = base.extend<{ fx: Fixture }>({
  fx: async ({ resources }, use) => {
    const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-include-")))
    resources.defer(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5 }))
    const repo = join(parent, "repo")
    mkdirSync(repo)
    git(repo, "init", "--quiet", "-b", "main")
    write(join(repo, ".gitignore"), "node_modules/\ncerts/\n.env*\n!.env.example\n")
    write(join(repo, ".env.example"), "TRACKED=1\n")
    write(join(repo, "a.txt"))
    git(repo, "add", "-A")
    git(repo, "commit", "--quiet", "-m", "first")
    const worktree = join(parent, "w")
    git(repo, "worktree", "add", "--quiet", "-b", "w", worktree)
    await use({ repo, worktree })
  },
})

const has = (fx: Fixture, path: string) => existsSync(join(fx.worktree, path))

describe("patterns of a .worktreeinclude", () => {
  it("drops comments, blank lines and Windows line ends", () => {
    expect(patternLines("# secrets\r\n.env\r\n\r\ncerts/**\r\n")).toEqual([".env", "certs/**"])
  })

  it("reaches into an ignored folder only by a path, or a negation that may undo one", () => {
    expect(reaching([".env*", "certs/local/**", ".venv/", "!certs/local/*.pem"])).toEqual([
      "certs/local/**",
      ".venv/",
      "!certs/local/*.pem",
    ])
  })
})

describe("copying ignored files into a new worktree", () => {
  it("copies the checkout's ignored .env files by default, at any depth outside ignored folders", async ({
    fx,
  }) => {
    write(join(fx.repo, ".env"), "SECRET=1\n")
    write(join(fx.repo, "apps/web/.env.local"))
    // Untracked but not ignored: it stays in the checkout.
    write(join(fx.repo, "notes.txt"))
    // A package's own .env inside an ignored folder: copying it would leave a node_modules
    // that is no install.
    write(join(fx.repo, "node_modules/pkg/.env"))
    const included = await copyIncluded(fx.repo, fx.worktree)
    expect(included).toEqual({
      from: fx.repo,
      by: "default",
      copied: [".env", "apps/web/.env.local"],
      left: 0,
    })
    expect(readFileSync(join(fx.worktree, ".env"), "utf8")).toBe("SECRET=1\n")
    expect(has(fx, "notes.txt")).toBe(false)
    expect(has(fx, "node_modules")).toBe(false)
  })

  it("copies what .worktreeinclude names instead, ignored files only, a path reaching into an ignored folder", async ({
    fx,
  }) => {
    write(
      join(fx.repo, ".worktreeinclude"),
      "# local\r\ncerts/local/**\r\n!certs/local/*.pem\r\nconfig.local.json\r\nnotes.txt\r\n",
    )
    write(join(fx.repo, ".env"))
    write(join(fx.repo, "certs/local/dev.crt"))
    write(join(fx.repo, "certs/local/dev.pem"))
    write(join(fx.repo, "certs/prod/prod.crt"))
    write(join(fx.repo, "notes.txt"))
    write(join(fx.repo, "config.local.json"))
    git(fx.repo, "config", "core.excludesFile", join(fx.repo, "..", "global-ignore"))
    write(join(fx.repo, "..", "global-ignore"), "config.local.json\n")
    const included = await copyIncluded(fx.repo, fx.worktree)
    expect(included).toMatchObject({
      by: "file",
      copied: ["config.local.json", "certs/local/dev.crt"],
      left: 0,
    })
    // `.env` matches the default, which a .worktreeinclude replaces; notes.txt isn't ignored.
    expect(has(fx, ".env")).toBe(false)
    expect(has(fx, "notes.txt")).toBe(false)
    expect(has(fx, "certs/local/dev.pem")).toBe(false)
  })

  it("copies nothing by an empty .worktreeinclude", async ({ fx }) => {
    write(join(fx.repo, ".worktreeinclude"), "")
    write(join(fx.repo, ".env"))
    expect(await copyIncluded(fx.repo, fx.worktree)).toMatchObject({ by: "file", copied: [] })
    expect(has(fx, ".env")).toBe(false)
  })

  it("never writes over a file the worktree has", async ({ fx }) => {
    write(join(fx.repo, ".env"), "checkout\n")
    write(join(fx.worktree, ".env"), "worktree\n")
    expect(await copyIncluded(fx.repo, fx.worktree)).toMatchObject({ copied: [], left: 1 })
    expect(readFileSync(join(fx.worktree, ".env"), "utf8")).toBe("worktree\n")
  })

  it.skipIf(process.platform === "win32")(
    "copies a symlink as a symlink to the same target",
    async ({ fx }) => {
      write(join(fx.repo, "shared.env"))
      symlinkSync("shared.env", join(fx.repo, ".env"))
      expect(await copyIncluded(fx.repo, fx.worktree)).toMatchObject({ copied: [".env"] })
      expect(lstatSync(join(fx.worktree, ".env")).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(fx.worktree, ".env"))).toBe("shared.env")
    },
  )

  it("keeps to the limit, shallowest first, and counts what it left", async ({ fx }) => {
    write(join(fx.repo, "a/b/.env"))
    write(join(fx.repo, "a/.env"))
    write(join(fx.repo, ".env"))
    expect(
      await copyIncluded(fx.repo, fx.worktree, { files: 2, bytes: 1024 * 1024 }),
    ).toMatchObject({ copied: [".env", "a/.env"], left: 1 })
    write(join(fx.repo, ".env.big"), "x".repeat(100))
    rmSync(join(fx.worktree, ".env"))
    rmSync(join(fx.worktree, "a"), { recursive: true })
    expect(await copyIncluded(fx.repo, fx.worktree, { files: 10, bytes: 50 })).toMatchObject({
      copied: [".env"],
      left: 3,
    })
  })

  it("says git couldn't list the checkout, and copies nothing", async ({ fx }) => {
    const notRepo = dirname(fx.repo)
    expect(await copyIncluded(notRepo, fx.worktree)).toMatchObject({ copied: [], unread: true })
  })
})
