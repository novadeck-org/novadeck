import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AttachedTerminal } from "@novadeck/protocol/client"

import { describe, expect, it } from "./test.js"
import { launchCli } from "./testing/cli.js"
import type { Resources } from "./testing/resources.js"

const token = "novadeck-cli-tests-only-not-a-production-credential"

const directoryFixture = async (resources: Resources) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "novadeck-cli-")))
  resources.defer(() => rm(directory, { recursive: true, force: true }))
  await writeFile(
    join(directory, ".env"),
    [
      "HOST=127.0.0.1",
      "PORT=0",
      `NOVADECK_TOKEN=${token}`,
      `NOVADECK_DATABASE="${join(directory, "workspace.sqlite").replaceAll("\\", "/")}"`,
      process.platform === "win32" ? "COMSPEC=cmd.exe" : "SHELL=/bin/sh",
    ].join("\n"),
  )
  return directory
}

const reader = (terminal: AttachedTerminal, resources: Resources) => {
  const timeout = setTimeout(() => void terminal.detach(), 10_000)
  timeout.unref()
  resources.defer(() => {
    clearTimeout(timeout)
    return terminal.detach()
  })
  let output = ""
  const next = async () => {
    const result = await terminal.next()
    if (result.done) throw new Error("CLI terminal ended before the expected event")
    const event = result.value
    if (event.type === "snapshot") output = event.data
    if (event.type === "output") output += event.data
    return event
  }
  const untilOutput = async (pattern: RegExp) => {
    while (!pattern.test(output)) {
      // eslint-disable-next-line no-await-in-loop -- Read ordered events until the shell's output checkpoint.
      await next()
    }
    return output
  }
  return { next, untilOutput, output: () => output }
}

describe("built runner CLI", () => {
  it("environment, authentication, shell I/O and metadata persistence after restart", async ({
    resources,
  }) => {
    const directory = await directoryFixture(resources)
    await writeFile(
      join(directory, "check.mjs"),
      [
        'import { strict as assert } from "node:assert"',
        "assert.equal(process.env.NOVADECK_TOKEN, undefined)",
        "assert.equal(process.stdin.isTTY, true)",
        "assert.equal(process.stdout.isTTY, true)",
        `assert.equal(process.cwd(), ${JSON.stringify(directory)})`,
        'console.log("CLI_" + "SHELL_OK")',
      ].join("\n"),
    )
    const cli = await launchCli(directory, resources)
    expect(
      (await fetch(`${cli.origin}/api/status`, { signal: AbortSignal.timeout(10_000) })).status,
    ).toBe(200)
    expect((await stat(join(directory, "workspace.sqlite"))).isFile()).toBe(true)
    expect(cli.output()).not.toContain(token)
    await expect(cli.connect("wrong")).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    const runner = await cli.connect(token)
    expect(runner.status).toEqual({ state: "connected", runnerId: expect.any(String) })
    const project = await runner.projects.create({ name: "CLI workspace", cwd: directory })
    const session = await runner.sessions.create({ projectId: project.id, name: "CLI session" })
    const created = await runner.terminals.create({ sessionId: session.id, cols: 80, rows: 24 })
    const terminal = await runner.terminals.attach(created.id)
    const output = reader(terminal, resources)
    const command =
      process.platform === "win32"
        ? `"${process.execPath}" "${join(directory, "check.mjs")}"\r`
        : `'${process.execPath.replaceAll("'", "'\\''")}' '${join(directory, "check.mjs").replaceAll("'", "'\\''")}'\r`
    await terminal.write(command)
    await output.untilOutput(/CLI_SHELL_OK/)
    await terminal.write("exit 7\r")
    let event = await output.next()
    while (event.type !== "exited") {
      // eslint-disable-next-line no-await-in-loop -- The exit follows the shell's remaining output.
      event = await output.next()
    }
    expect(event.exitCode).toBe(7)
    await expect(terminal.next()).resolves.toEqual({ value: undefined, done: true })
    expect(output.output()).not.toContain(token)
    const first = runner.status
    await runner.close()
    const stopped = await cli.stop()
    if (process.platform !== "win32") expect(stopped).toEqual({ code: 0, signal: null })

    const restarted = await launchCli(directory, resources)
    const again = await restarted.connect(token)
    expect(again.status).toEqual({ state: "connected", runnerId: expect.any(String) })
    expect(again.status).not.toEqual(first)
    await expect(again.projects.list()).resolves.toEqual([project])
    await expect(again.sessions.list({ projectId: project.id })).resolves.toEqual([session])
    await expect(again.terminals.list({ sessionId: session.id })).resolves.toEqual([])
  }, 30_000)

  it.skipIf(process.platform === "win32")(
    "POSIX SIGTERM shutdown exits cleanly and terminates the owned shell",
    async ({ resources }) => {
      const directory = await directoryFixture(resources)
      const cli = await launchCli(directory, resources)
      const runner = await cli.connect(token)
      const project = await runner.projects.create({ name: "Shutdown", cwd: directory })
      const session = await runner.sessions.create({ projectId: project.id, name: "Live shell" })
      const created = await runner.terminals.create({ sessionId: session.id, cols: 80, rows: 24 })
      const terminal = await runner.terminals.attach(created.id)
      const output = reader(terminal, resources)
      await terminal.write("printf 'OWNED_%s_PID=%s\\n' SHELL \"$$\"\r")
      const text = await output.untilOutput(/OWNED_SHELL_PID=\d+/)
      const pid = Number(/OWNED_SHELL_PID=(\d+)/.exec(text)?.[1])
      expect(pid).toBeGreaterThan(0)
      expect(() => process.kill(pid, 0)).not.toThrow()
      expect(await cli.stop()).toEqual({ code: 0, signal: null })
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
    },
    20_000,
  )
})
