import { expect, it } from "vitest"

import { failFirst } from "../attempts.ts"

it("fails first, then passes", ({ task }) => {
  failFirst(`${import.meta.dirname} ${task.file.projectName}`)
  expect(task.file.projectName).not.toBe("")
})
