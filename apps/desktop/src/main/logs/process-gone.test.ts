import { describe, expect, it } from "../../test"
import { goneBadly, goneData } from "./process-gone"

describe("a process that ended", () => {
  it("is told by its type, reason, exit code and name", () => {
    expect(
      goneData({
        type: "Utility",
        reason: "oom",
        exitCode: 9,
        serviceName: "node.mojom.NodeService",
        name: "Novadeck Runner",
      }),
    ).toEqual({
      type: "Utility",
      reason: "oom",
      exitCode: 9,
      service: "node.mojom.NodeService",
      name: "Novadeck Runner",
    })
  })

  it("ended badly unless it exited cleanly, a kill included", () => {
    expect(["crashed", "oom", "abnormal-exit", "launch-failed", "killed"].map(goneBadly)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ])
    expect(goneBadly("clean-exit")).toBe(false)
  })
})
