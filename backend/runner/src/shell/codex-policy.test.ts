import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { codexPolicy, policyOf } from "./codex-policy.js"

const clean = { git: false, gh: false, path: false }

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
    expect(policyOf(text)).toEqual({ git: true, gh: false, path: false })
  })

  it.each([
    ["GH_HOST", '[shell_environment_policy]\nset = { GH_HOST = "evil" }\n'],
    ["GH_REPO", '[shell_environment_policy.set]\nGH_REPO = "o/n"\n'],
    [
      "GH_CONFIG_DIR in a profile",
      '[profiles.p.shell_environment_policy]\nset = { GH_CONFIG_DIR = "/x" }\n',
    ],
  ])("names a gh variable: %s", (_name, text) => {
    expect(policyOf(text)).toEqual({ git: false, gh: true, path: false })
  })

  it("names both kinds where it names both", () => {
    expect(
      policyOf('[shell_environment_policy]\nset = { GIT_DIR = "a", GH_HOST = "b" }\n'),
    ).toEqual({ git: true, gh: true, path: false })
  })

  it.each([
    ["a \\u escape in the name", '[shell_environment_policy.set]\n"GIT\\u005fDIR" = "x"\n'],
    [
      "a \\x escape in the name (TOML 1.1)",
      '[shell_environment_policy.set]\n"\\x47IT_DIR" = "x"\n',
    ],
    ["a \\U escape", '[shell_environment_policy.set]\n"\\U00000047IT_DIR" = "x"\n'],
    ["a \\u escape in the table's name", '["shell\\u005fenvironment_policy".set]\nGIT_DIR = "x"\n'],
    [
      "a \\x escape in the table's name",
      '["shell_\\x65nvironment_policy"]\nset = { GIT_DIR = "x" }\n',
    ],
    ["a quoted table name", '["shell_environment_policy".set]\nGIT_DIR = "x"\n'],
    ["a line-ending backslash", '[shell_environment_policy.set]\n"GIT_\\\n   DIR" = "x"\n'],
  ])("reads %s as the name it spells", (_name, text) => {
    expect(policyOf(text)).toMatchObject({ git: true })
  })

  it("reads a gh name and a PATH spelled with escapes too", () => {
    expect(policyOf('[shell_environment_policy.set]\n"GH\\x5fHOST" = "x"\n')).toMatchObject({
      gh: true,
    })
    expect(policyOf('[shell_environment_policy.set]\n"PA\\u0054H" = "x"\n')).toMatchObject({
      path: true,
    })
  })

  it.each([
    "HOME",
    "XDG_CONFIG_HOME",
    "USERPROFILE",
    "GIT_SSL_NO_VERIFY",
    "https_proxy",
    "SSH_ASKPASS",
    "GIT_TRACE",
  ])("counts %s as a git variable", (name) => {
    expect(policyOf(`[shell_environment_policy]\nset = { ${name} = "x" }\n`)).toMatchObject({
      git: true,
    })
  })

  it.each([
    "HOME",
    "XDG_CONFIG_HOME",
    "APPDATA",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "EDITOR",
    "VISUAL",
    "HTTPS_PROXY",
  ])("counts %s as a gh variable", (name) => {
    expect(policyOf(`[shell_environment_policy]\nset = { ${name} = "x" }\n`)).toMatchObject({
      gh: true,
    })
  })

  it("sees a PATH the policy sets, in either case, and not the word elsewhere", () => {
    for (const text of [
      '[shell_environment_policy]\nset = { PATH = "/x" }\n',
      '[shell_environment_policy.set]\nPath = "/x"\n',
      '[shell_environment_policy]\nset = { "PATH" = "/x" }\n',
    ])
      expect(policyOf(text)).toMatchObject({ path: true })
    expect(
      policyOf(
        '[shell_environment_policy]\ninherit = "all"\n[projects."/home/x/path"]\ntrust_level = "trusted"\n',
      ),
    ).toEqual(clean)
    // A path or a home in a value or a table name is no variable.
    expect(policyOf('[shell_environment_policy]\nset = { FOO = "/home/me" }\n')).toEqual(clean)
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
        path: false,
      })
      // Without CODEX_HOME the layer is ~/.codex of the user.
      expect(await codexPolicy({ home: null, project, system: [], userHome: base })).toEqual(clean)
      write(join(base, ".codex", "config.toml"), gh)
      expect(await codexPolicy({ home: null, project, system: [], userHome: base })).toEqual({
        git: false,
        gh: true,
        path: false,
      })
      const system = join(base, "etc", "config.toml")
      write(system, git)
      expect(await codexPolicy({ home: null, project, system: [system], userHome: base })).toEqual({
        git: true,
        gh: true,
        path: false,
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
      expect(await layers(join(project, "pkg", "sub"))).toEqual({
        git: false,
        gh: true,
        path: false,
      })
      expect(await layers(join(project, "pkg"))).toEqual({ git: false, gh: true, path: false })
      // A sibling folder's layer isn't on the way up.
      expect(await layers(project)).toEqual(clean)
      write(join(project, ".codex", "config.toml"), git)
      expect(await layers(join(project, "pkg", "sub"))).toEqual({
        git: true,
        gh: true,
        path: false,
      })
      // A folder outside the project reads the project's layer alone.
      expect(await layers(join(base, "elsewhere"))).toEqual({ git: true, gh: false, path: false })
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
        path: true,
      })
      rmSync(join(home, "config.toml"), { recursive: true })
      write(join(home, "config.toml"), "x".repeat(2 * 1024 * 1024))
      expect(await codexPolicy({ home, project, system: [], userHome: base })).toEqual({
        git: true,
        gh: true,
        path: true,
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
      ).toEqual({ git: true, gh: true, path: true })
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
