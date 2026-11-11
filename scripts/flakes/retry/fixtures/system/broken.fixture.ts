import { expect, it } from "vitest"

it("always fails", () => {
  expect("broken").toBe("working")
})
