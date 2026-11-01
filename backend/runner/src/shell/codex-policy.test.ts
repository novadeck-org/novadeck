import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { codexPolicy, policyOf } from "./codex-policy.js"

const clean = { git: false, gh: false }

describe("what a Codex config.toml sets for its commands", () => {
  it.each([
    ["a set table", '[shell_environment_policy]\ninherit = "all"\nset = { GIT_DIR = "/x" }\n'],
    ["a dotted key", 'shell_environment_policy.set.GIT_DIR = "/x"\n'],
    ["a table of its own", '[shell_environment_policy.set]\nGIT_DIR = "/x"\n'],
    ["a quoted key", '[shell_environment_policy.set]\n"GIT_DIR" = "/x"\n'],
    ["a literal key", "[shell_environment_policy.set]\n'GIT_DIR' = '/x'\n"],
    ["a profile", '[profiles.work.shell_environment_policy]\nset = { GIT_SSH_COMMAND = "x" }\n'],
    ["another case", '[shell_environment_policy]\nset = { git_dir = "/x" }\n'],
    ["GIT_CONFIG_COUNT", '[shell_environment_policy]\nset = { GIT_CONFIG_COUNT = "1" }\n'],
  ])("names a git variable through %s", (_name, text) => {
    expect(policyOf(text)).toEqual({ git: true, gh: false })
  })

  it.each([
    ["GH_HOST", '[shell_environment_policy]\nset = { GH_HOST = "evil" }\n'],
    ["GH_REPO", '[shell_environment_policy.set]\nGH_REPO = "o/n"\n'],
    [
      "GH_CONFIG_DIR in a profile",
      '[profiles.p.shell_environment_policy]\nset = { GH_CONFIG_DIR = "/x" }\n',
    ],
  ])("names a gh variable: %s", (_name, text) => {
    expect(policyOf(text)).toEqual({ git: false, gh: true })
  })

  it("names both kinds where it names both", () => {
    expect(
      policyOf('[shell_environment_policy]\nset = { GIT_DIR = "a", GH_HOST = "b" }\n'),
    ).toEqual({
      git: true,
      gh: true,
    })
  })

  it("counts a \\u escape, which could spell any name, as naming them all", () => {
    expect(policyOf('[shell_environment_policy.set]\n"GIT\\u005fDIR" = "x"\n')).toEqual({
      git: true,
      gh: true,
    })
  })

  it("sets nothing where the table is not there, or names no such variable", () => {
    expect(policyOf('model = "gpt"\n# GIT_DIR in a comment\n')).toEqual(clean)
    expect(policyOf('[shell_environment_policy]\ninherit = "core"\nset = { FOO = "1" }\n')).toEqual(
      clean,
    )
    expect(policyOf("")).toEqual(clean)
  })
})

describe("the configuration Codex reads", () => {
  const scratch = () => {
    const base = mkdtempSync(join(tmpdir(), "novadeck-codex-policy-"))
    const home = join(base, "codex-home")
    const project = join(base, "project")
    mkdirSync(home)
    mkdirSync(join(project, "pkg", "sub"), { recursive: true })
    const write = (file: string, text: string) => {
      mkdirSync(join(file, ".."), { recursive: true })
      writeFileSync(file, text)
    }
    return {
      base,
      home,
      project,
      write,
      done: () => rmSync(base, { recursive: true, force: true }),
    }
  }
  const git = '[shell_environment_policy]\nset = { GIT_DIR = "/x" }\n'
  const gh = '[shell_environment_policy]\nset = { GH_HOST = "x" }\n'

  it("sets nothing where no file exists", async () => {
    const { base, home, project, done } = scratch()
    try {
      expect(
        await codexPolicy({ home, project, folder: project, system: [], userHome: base }),
      ).toEqual(clean)
    } finally {
      done()
    }
  })

  it("reads the user's layer from CODEX_HOME, else ~/.codex, and the system's", async () => {
    const { base, home, project, write, done } = scratch()
    try {
      write(join(home, "config.toml"), git)
      expect(await codexPolicy({ home, project, system: [], userHome: base })).toEqual({
        git: true,
        gh: false,
      })
      // Without CODEX_HOME the layer is ~/.codex of the user.
      expect(await codexPolicy({ home: null, project, system: [], userHome: base })).toEqual(clean)
      write(join(base, ".codex", "config.toml"), gh)
      expect(await codexPolicy({ home: null, project, system: [], userHome: base })).toEqual({
        git: false,
        gh: true,
      })
      const system = join(base, "etc", "config.toml")
      write(system, git)
      expect(await codexPolicy({ home: null, project, system: [system], userHome: base })).toEqual({
        git: true,
        gh: true,
      })
    } finally {
      done()
    }
  })

  it("reads each project layer from the call's folder up to the project's, and none outside", async () => {
    const { base, home, project, write, done } = scratch()
    try {
      const layers = (folder: string) =>
        codexPolicy({ home, project, folder, system: [], userHome: base })
      write(join(project, "pkg", ".codex", "config.toml"), gh)
      expect(await layers(join(project, "pkg", "sub"))).toEqual({ git: false, gh: true })
      expect(await layers(join(project, "pkg"))).toEqual({ git: false, gh: true })
      // A sibling folder's layer isn't on the way up.
      expect(await layers(project)).toEqual(clean)
      write(join(project, ".codex", "config.toml"), git)
      expect(await layers(join(project, "pkg", "sub"))).toEqual({ git: true, gh: true })
      // A folder outside the project reads the project's layer alone.
      expect(await layers(join(base, "elsewhere"))).toEqual({ git: true, gh: false })
    } finally {
      done()
    }
  })

  it("sets everything where a layer can't be read, and where the launch line carries -c", async () => {
    const { base, home, project, write, done } = scratch()
    try {
      // A folder where the file should be.
      mkdirSync(join(home, "config.toml"))
      expect(await codexPolicy({ home, project, system: [], userHome: base })).toEqual({
        git: true,
        gh: true,
      })
      rmSync(join(home, "config.toml"), { recursive: true })
      write(join(home, "config.toml"), "x".repeat(2 * 1024 * 1024))
      expect(await codexPolicy({ home, project, system: [], userHome: base })).toEqual({
        git: true,
        gh: true,
      })
      rmSync(join(home, "config.toml"))
      expect(
        await codexPolicy({
          home,
          project,
          system: [],
          userHome: base,
          command: `codex -c 'shell_environment_policy.set={GIT_DIR="x"}'`,
        }),
      ).toEqual({ git: true, gh: true })
      expect(
        await codexPolicy({
          home,
          project,
          system: [],
          userHome: base,
          command: "codex --profile work",
        }),
      ).toEqual(clean)
    } finally {
      done()
    }
  })
})
