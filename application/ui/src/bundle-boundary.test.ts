import { boundaryViolations } from "./bundle-boundary"
import { context, describe, expect, it } from "./test"

const demo = "/work/ui/src/backend/demo/index.ts"
const debug = "/work/ui/src/backend/demo/debug/connect.ts"
const runner = "/work/ui/src/backend/runner/index.ts"
const app = "/work/ui/src/app/App.tsx"

describe("bundle boundary", () => {
  context("for a build that connects to a runner", () => {
    it("rejects any demo module", () => {
      expect(boundaryViolations("production", [app, runner, demo, debug])).toEqual([demo, debug])
    })

    it("reads Windows-style module ids", () => {
      const id = "C:\\work\\ui\\src\\backend\\demo\\index.ts"
      expect(boundaryViolations("production", [id])).toEqual([id])
    })
  })

  context("for the visitor build", () => {
    it("rejects the runner client and the debug layer but not the demo", () => {
      expect(boundaryViolations("try", [app, demo, runner, debug])).toEqual([runner, debug])
    })
  })

  context("for the content preview", () => {
    it("allows the demo and its debug layer", () => {
      expect(boundaryViolations("content-preview", [demo, debug])).toEqual([])
    })
  })
})
