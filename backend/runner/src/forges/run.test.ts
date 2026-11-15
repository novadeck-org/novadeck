import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "../test.js"
import { createRun, quietEnv } from "./run.js"

const posix = process.platform !== "win32"

// A program named `tool` in a folder of its own, first on a PATH that still has the system's.
const program = (body: string, resources: { defer: (undo: () => void) => void }) => {
  const folder = mkdtempSync(join(tmpdir(), "novadeck-forge-run-"))
  resources.defer(() => rmSync(folder, { recursive: true, force: true }))
  writeFileSync(join(folder, "tool"), `#!/bin/sh\n${body}\n`)
  chmodSync(join(folder, "tool"), 0o755)
  return { PATH: `${folder}:/usr/bin:/bin` } satisfies NodeJS.ProcessEnv
}

describe.skipIf(!posix)("running a forge's tool", () => {
  it("answers what it printed, with the variables that keep it quiet", async ({ resources }) => {
    const env = program('printf "%s %s" "$GH_PROMPT_DISABLED" "$NO_PROMPT"', resources)
    const run = createRun({ environment: () => env })
    expect(await run("tool", [])).toEqual({ ok: true, out: "1 1", said: "" })
    expect(quietEnv.GH_PROMPT_DISABLED).toBe("1")
  })

  it("answers what it wrote to its error output on success too, all of it", async ({
    resources,
  }) => {
    const env = program("echo hi; head -c 100000 /dev/zero | tr '\\0' x >&2", resources)
    const run = createRun({ environment: () => env })
    const ran = await run("tool", [])
    expect(ran).toMatchObject({ ok: true, out: "hi\n" })
    expect((ran as { said: string }).said).toHaveLength(100_000)
  })

  it("says it is missing where the person's PATH has none", async () => {
    const run = createRun({ environment: () => ({ PATH: "/nonexistent" }) })
    expect(await run("tool", [])).toMatchObject({ ok: false, kind: "missing" })
  })

  it("says why it failed, from what it wrote to its error output", async ({ resources }) => {
    const env = program("echo not signed in >&2; exit 1", resources)
    const run = createRun({ environment: () => env })
    expect(await run("tool", [])).toEqual({
      ok: false,
      kind: "exit",
      said: "not signed in\n",
    })
  })

  it("is ended with all it started once it takes too long", async ({ resources }) => {
    const env = program("sleep 30 & wait", resources)
    const run = createRun({ environment: () => env, timeoutMs: 100 })
    expect(await run("tool", [])).toMatchObject({ ok: false, kind: "timeout" })
  })
})
