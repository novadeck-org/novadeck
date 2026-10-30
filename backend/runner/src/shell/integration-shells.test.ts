import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect } from "../test.js"
import { it, create, fakeAgent, fakeClaude } from "./integration.test-support.js"

const zsh = "/bin/zsh"

describe.skipIf(process.platform === "win32" || !existsSync(zsh))("zsh shell integration", () => {
  it("loads the person's own .zshrc and reports each prompt's directory", async ({ shell }) => {
    const directory = join(shell.home, "my dir ż")
    mkdirSync(directory)
    writeFileSync(join(shell.home, ".zshrc"), "FROM_ZSHRC=loaded\n")
    const manager = shell.manager({ shell: zsh })
    const next = shell.watch(manager)
    const terminal = await create(manager, shell)
    manager.write(
      { terminalId: terminal.id, data: `cd '${directory}'; echo $FROM_ZSHRC $ZDOTDIR\r` },
      "owner",
    )
    await next((summary) => summary.cwd === directory)
    // ZDOTDIR is the person's again once their .zshrc has loaded.
    await shell.until(manager, terminal.id, `loaded ${shell.home}`)
  })

  it("resumes the saved agent session at the first prompt, as if typed there", async ({
    shell,
  }) => {
    writeFileSync(
      join(shell.home, ".zshrc"),
      [
        'export PATH="$HOME/bin:$PATH"',
        'sleep 0.5; read -t 0.5 early; echo "rc read [$early]"',
        "precmd() { export FROM_PROMPT=yes }",
      ].join("\n"),
    )
    fakeAgent(shell.home, "claude")
    const id = randomUUID()
    shell.saveSession(id, "claude", "abc-1")
    const manager = shell.manager({ shell: zsh })
    await create(manager, shell, { id, restore: true, resume: "claude" })
    const shown = await shell.until(
      manager,
      id,
      "claude args: --resume abc-1 prompt=[yes] resume=[]",
    )
    expect(shown).toContain("rc read []")
  })

  it("starts a command on the terminal's own device, not /dev/tty, which macOS's kqueue refuses", async ({
    shell,
  }) => {
    const manager = shell.manager({ shell: zsh })
    const terminal = await create(manager, shell, {
      command: 'echo "in=$(tty) err=$(tty <&2)"',
    })
    const shown = await shell.until(manager, terminal.id, /in=\S+ err=\S+/)
    expect(shown).toMatch(/in=\/dev\/(?:ttys|pts\/)\d+ err=\/dev\/(?:ttys|pts\/)\d+/)
  })

  it("resumes an agent that then reports its session from the foreground", async ({ shell }) => {
    const session = randomUUID()
    fakeClaude(shell.home, shell.plugins, session)
    writeFileSync(join(shell.home, ".zshrc"), 'export PATH="$HOME/bin:$PATH"\n')
    const id = randomUUID()
    shell.saveSession(id, "claude", session)
    const manager = shell.manager({ shell: zsh })
    const next = shell.watch(manager)
    await create(manager, shell, { id, restore: true, resume: "claude" })
    await next((summary) => summary.id === id && summary.agent === "claude")
    // Its exit shows as the shell's prompt.
    manager.write({ terminalId: id, data: "\r" }, "owner")
    await next((summary) => summary.id === id && summary.agent === null)
  })
})

describe.runIf(process.platform === "win32")("Windows shell integration", () => {
  const shells = [
    {
      name: "cmd",
      shell: process.env.COMSPEC ?? "cmd.exe",
      cd: (path: string) => `cd /d "${path}"`,
      prompt: /[A-Za-z]:\\[^\r\n]*>/,
    },
    {
      name: "PowerShell 7",
      shell: "pwsh.exe",
      cd: (path: string) => `Set-Location '${path}'`,
      prompt: /PS .*>/,
    },
  ]

  for (const { name, shell: program, cd, prompt } of shells) {
    it(`${name} reports each prompt's directory through ConPTY`, async ({ shell }) => {
      const directory = join(shell.home, "my dir")
      mkdirSync(directory)
      const manager = shell.manager({ shell: program })
      const next = shell.watch(manager)
      const terminal = await create(manager, shell)
      // Typed once the prompt shows, as a person would.
      await shell.until(manager, terminal.id, prompt)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      manager.write({ terminalId: terminal.id, data: `${cd(directory)}\r` }, "owner")
      await next((summary) => summary.cwd.toLowerCase() === directory.toLowerCase())
    })
  }

  // Windows PowerShell 5.1 shows nothing through the bundled ConPTY on CI, resuming or not.
  for (const { name, shell: program } of shells)
    it(`${name} resumes the saved agent session as it starts`, async ({ shell }) => {
      const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
      const bin = join(shell.home, "bin")
      mkdirSync(bin)
      writeFileSync(join(bin, "claude.cmd"), "@echo claude args: %*\r\n")
      const id = randomUUID()
      shell.saveSession(id, "claude", "abc-1")
      const manager = shell.manager({
        shell: program,
        // Windows spells it Path; a second spelling would leave which one wins open.
        env: { HOME: shell.home, [pathKey]: `${bin};${process.env[pathKey]}` },
      })
      await create(manager, shell, { id, restore: true, resume: "claude" })
      await shell.until(manager, id, "claude args: --resume abc-1")
    })
})
