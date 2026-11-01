import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { vi } from "vitest"

import { describe, expect, it as base } from "../test.js"

const it = base.extend<{ directory: string }>({
  directory: async ({ resources }, use) => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-save-")))
    resources.defer(() => rmSync(directory, { recursive: true, force: true }))
    await use(directory)
  },
})

// Failures of the disk that a real folder can't be made to give.
const failure = vi.hoisted(() => ({
  /** The code the next `renames` renames fail with. */
  rename: undefined as string | undefined,
  renames: 0,
  renamed: 0,
  /** The code reading the plan (opening it read-only) fails with. */
  read: undefined as string | undefined,
  /** Whether chmod of the temporary file fails, as on a file system without modes. */
  chmod: false,
}))

const fail = (code: string) => Object.assign(new Error(code), { code })

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      failure.renamed++
      if (failure.rename && failure.renames-- > 0) throw fail(failure.rename)
      return actual.rename(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      // eslint-disable-next-line no-bitwise -- Flags.
      const writing = typeof args[1] === "number" && (args[1] & 3) !== 0
      if (!writing && failure.read) throw fail(failure.read)
      const handle = await actual.open(...args)
      if (writing && failure.chmod) handle.chmod = () => Promise.reject(fail("EPERM"))
      return handle
    },
  }
})

import { DomainError } from "../errors.js"

const { loadPlan, readPlanFile, savePlan } = await import("./content.js")

describe("saving a plan when the disk fails", () => {
  const plan = (path: string) =>
    ({ path, plan: { agent: "claude", session: "s", actor: null, format: "file" } }) as const

  const setup = async (directory: string) => {
    failure.rename = undefined
    failure.renames = 0
    failure.renamed = 0
    failure.read = undefined
    failure.chmod = false
    const path = join(directory, "p.md")
    writeFileSync(path, "# Plan\n")
    return { path, stamp: (await readPlanFile(path))?.stamp ?? "" }
  }
  const settle = async (path: string, stamp: string) => {
    try {
      return await savePlan(plan(path), "# Edited\n", stamp, [tmpdir()])
    } catch (error) {
      return error
    } finally {
      failure.rename = undefined
      failure.read = undefined
      failure.chmod = false
    }
  }

  for (const code of ["EIO", "ENOSPC"])
    it(`leaves ${code} on the rename unclassified, untried again, and no temporary file`, async ({
      directory,
    }) => {
      const { path, stamp } = await setup(directory)
      failure.rename = code
      failure.renames = 99
      const error = await settle(path, stamp)
      expect(error).toMatchObject({ code })
      expect(error).not.toBeInstanceOf(DomainError)
      expect(failure.renamed).toBe(1)
      expect(readdirSync(directory)).toEqual(["p.md"])
      expect(readFileSync(path, "utf8")).toBe("# Plan\n")
    })

  it("tries a rename that keeps meeting EBUSY a few times, then leaves it unclassified", async ({
    directory,
  }) => {
    const { path, stamp } = await setup(directory)
    failure.rename = "EBUSY"
    failure.renames = 99
    const error = await settle(path, stamp)
    expect(error).toMatchObject({ code: "EBUSY" })
    expect(error).not.toBeInstanceOf(DomainError)
    expect(failure.renamed).toBe(3)
    expect(readdirSync(directory)).toEqual(["p.md"])
  })

  for (const code of ["EACCES", "EPERM", "EBUSY"])
    it(`saves when a rename meeting ${code} gets through on a later try`, async ({ directory }) => {
      const { path, stamp } = await setup(directory)
      failure.rename = code
      failure.renames = 2
      await expect(settle(path, stamp)).resolves.toMatchObject({ saved: true })
      expect(failure.renamed).toBe(3)
      expect(readFileSync(path, "utf8")).toBe("# Edited\n")
      expect(readdirSync(directory)).toEqual(["p.md"])
    })

  for (const code of ["EACCES", "EPERM"])
    it(`leaves ${code} on a rename that never gets through unclassified: the plan is held, not the folder`, async ({
      directory,
    }) => {
      const { path, stamp } = await setup(directory)
      failure.rename = code
      failure.renames = 99
      const error = await settle(path, stamp)
      expect(error).toMatchObject({ code })
      expect(error).not.toBeInstanceOf(DomainError)
      expect(failure.renamed).toBe(3)
      expect(readdirSync(directory)).toEqual(["p.md"])
    })

  it("names EROFS as a folder it can't write, without trying again", async ({ directory }) => {
    const { path, stamp } = await setup(directory)
    failure.rename = "EROFS"
    failure.renames = 99
    await expect(settle(path, stamp)).resolves.toMatchObject({
      code: "PLAN_UNWRITABLE",
      data: { reason: "folder" },
    })
    expect(failure.renamed).toBe(1)
    expect(readdirSync(directory)).toEqual(["p.md"])
  })

  it("saves on a file system that refuses chmod", async ({ directory }) => {
    const { path, stamp } = await setup(directory)
    failure.chmod = true
    await expect(settle(path, stamp)).resolves.toMatchObject({ saved: true })
    expect(readFileSync(path, "utf8")).toBe("# Edited\n")
    expect(readdirSync(directory)).toEqual(["p.md"])
  })

  for (const code of ["EACCES", "EBUSY", "EMFILE", "EIO"])
    it(`does not take ${code} on reading the plan for a gone file`, async ({ directory }) => {
      const { path, stamp } = await setup(directory)
      failure.read = code
      const error = await settle(path, stamp)
      expect(error).toMatchObject({ code })
      expect(error).not.toBeInstanceOf(DomainError)
      expect(readdirSync(directory)).toEqual(["p.md"])
      failure.read = code
      await expect(loadPlan(plan(path), undefined)).resolves.toMatchObject({
        state: "unavailable",
        reason: "unreadable",
      })
      failure.read = undefined
    })
})
