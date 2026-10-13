import { expect, test } from "vitest"

import { sqlIn, touchesOf } from "./runner-lens.ts"

const tables = new Set(["terminals", "sessions"])

test("finds statements in templates and strings, and what they do to which table", () => {
  const code = [
    "const a = this.queries.run`INSERT INTO terminals (id) VALUES (${id}) ON CONFLICT (id) DO UPDATE SET id = 1`",
    'for (const sql of ["DELETE FROM terminals WHERE session_id IN (SELECT id FROM sessions)"]) {}',
    '// "SELECT 1 FROM sessions" in a comment',
  ].join("\n")
  const found = sqlIn(code).map((each) => each.sql)
  expect(found).toHaveLength(2)
  expect(touchesOf(found[0]!, tables)).toEqual([{ table: "terminals", verb: "write" }])
  expect(touchesOf(found[1]!, tables)).toEqual([
    { table: "terminals", verb: "delete" },
    { table: "sessions", verb: "read" },
  ])
})
