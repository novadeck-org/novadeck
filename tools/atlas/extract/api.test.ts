import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, expect, test } from "vitest"

import { createAnchors } from "./anchors.ts"
import { contractAnchor, findProcedureLine } from "./api.ts"

const contract = [
  'import { list } from "./sessions.js"', // 1
  "export const contract = {", // 2
  "  ...wireContract,", // 3
  "  projects: {", // 4
  "    list: oc.output(z.object({ items: z.array(z.object({ create: z.string() })) })),", // 5
  "    folder: oc.input(", // 6
  "      z.object({", // 7
  "        create: z.boolean(),", // 8
  "      }),", // 9
  "    ),", // 10
  "  },", // 11
  "  sessions: {", // 12
  "    nested: {", // 13
  "      create: oc.input(z.string()),", // 14
  "    },", // 15
  "    create: oc.input(z.string()),", // 16
  "  },", // 17
  "}", // 18
].join("\n")

test("finds a procedure's line in its own namespace, at its own indent", () => {
  expect(findProcedureLine(contract, ["projects", "folder"])).toBe(6)
  // Not the deeper `create:` of a nested namespace or a schema field above it.
  expect(findProcedureLine(contract, ["sessions", "create"])).toBe(16)
  expect(findProcedureLine(contract, ["sessions", "nested", "create"])).toBe(14)
})

test("finds nothing for a procedure its namespace does not hold", () => {
  // `projects` has a schema field named `create`, but no procedure.
  expect(findProcedureLine(contract, ["projects", "create"])).toBeNull()
  expect(findProcedureLine(contract, ["wire", "handshake"])).toBeNull()
})

const repo = mkdtempSync(join(tmpdir(), "atlas-api-"))
afterAll(() => rmSync(repo, { recursive: true, force: true }))

test("anchors the wire's procedures in the wire, and reports one found nowhere", () => {
  mkdirSync(join(repo, "libraries/wire/src"), { recursive: true })
  writeFileSync(
    join(repo, "libraries/wire/src/handshake.ts"),
    'import { oc } from "@orpc/contract"\n\nconst handshake = oc\n\nexport const wireContract = { wire: { handshake } }\n',
  )
  const anchors = createAnchors(repo)
  expect(contractAnchor(anchors, contract, ["wire", "handshake"])).toEqual({
    file: "libraries/wire/src/handshake.ts",
    line: 3,
  })
  expect(anchors.broken()).toEqual([])
  expect(contractAnchor(anchors, contract, ["projects", "gone"])).toEqual({
    file: "contract/protocol/src/contract.ts",
    line: null,
  })
  expect(anchors.broken().map((each) => each.reason)).toEqual(["no line found for projects.gone"])
})
