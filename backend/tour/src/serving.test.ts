import { mkdtemp, rm, symlink } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { findServing, freePort, versionOf, type Probe } from "./serving.js"
import { describe, expect, findProgram, it } from "./test.js"

// What each program answers, by name; one not listed isn't there.
const answering =
  (answers: Record<string, string>): Probe =>
  (program) =>
    Promise.resolve(answers[program])

const port = () => Promise.resolve(5555)

describe("how the dev server is run", () => {
  it("is Node where it runs", async () => {
    await expect(
      findServing(answering({ node: "v26.9.0", python3: "Python 3.12.1" }), port),
    ).resolves.toEqual({ command: "node dev.mjs 5555", url: "http://127.0.0.1:5555/" })
  })

  it("is python3 where Node isn't there, and python where python3 isn't", async () => {
    await expect(findServing(answering({ python3: "Python 3.12.1" }), port)).resolves.toEqual({
      command: "python3 dev.py 5555",
      url: "http://127.0.0.1:5555/",
    })
    await expect(findServing(answering({ python: "Python 3.11.4" }), port)).resolves.toEqual({
      command: "python dev.py 5555",
      url: "http://127.0.0.1:5555/",
    })
  })

  it("doesn't take a python that isn't Python 3, or a Windows alias that answers otherwise", async () => {
    await expect(
      findServing(answering({ python3: "Python 2.7.18", python: "Python 2.7.18" }), port),
    ).resolves.toBeNull()
    await expect(
      findServing(answering({ python: "Python was not found; run without arguments" }), port),
    ).resolves.toBeNull()
  })

  it("is none where nothing runs", async () => {
    await expect(findServing(answering({}), port)).resolves.toBeNull()
  })

  it("asks a program that isn't there, and gets no answer", async () => {
    await expect(versionOf(findProgram)("novadeck-no-such-program")).resolves.toBeUndefined()
  })

  it("asks node for its version", async () => {
    await expect(versionOf(findProgram)("node")).resolves.toMatch(/^v\d+\./)
  })
})

describe("where the interpreter is looked for", () => {
  it("is the person's environment given, not the runner's", async () => {
    const seen: (NodeJS.ProcessEnv | undefined)[] = []
    const probe: Probe = (program, env) => {
      seen.push(env)
      return Promise.resolve(program === "node" ? "v26.9.0" : undefined)
    }
    const env = { PATH: "/opt/homebrew/bin" }
    await findServing(probe, port, env)
    expect(seen).toEqual([env])
  })

  it("finds a program by the PATH of that environment alone", async ({ resources }) => {
    const bin = await mkdtemp(join(tmpdir(), "novadeck-bin-"))
    resources.defer(() => rm(bin, { recursive: true, force: true }))
    const program = join(bin, process.platform === "win32" ? "node.exe" : "node")
    await symlink(process.execPath, program)
    await expect(versionOf(findProgram)("node", { PATH: bin })).resolves.toMatch(/^v\d+\./)
    await expect(versionOf(findProgram)("node", { PATH: "/nonexistent" })).resolves.toBeUndefined()
  })
})

describe("the dev server's port", () => {
  it("is free on 127.0.0.1 when it is given", async () => {
    const number = await freePort()
    expect(number).toBeGreaterThan(0)
    await new Promise<void>((resolve, reject) => {
      const server = createServer()
      server.once("error", reject)
      server.listen(number, "127.0.0.1", () => server.close(() => resolve()))
    })
  })
})
