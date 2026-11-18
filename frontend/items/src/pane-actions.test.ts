import { onPaneAction, raisePaneAction } from "./pane-actions"
import { describe, expect, it } from "./test"

describe("a pane's actions", () => {
  it("reach the pane holding the viewer that raised them, and stop there", () => {
    const outer = document.createElement("div")
    const pane = document.createElement("section")
    const viewer = document.createElement("div")
    pane.append(viewer)
    outer.append(pane)
    const heard: string[] = []
    const outside: string[] = []
    outer.addEventListener("novadeck:pane-action", () => outside.push("heard"))
    const stop = onPaneAction(pane, (action) => heard.push(action))
    raisePaneAction(viewer, "hide")
    raisePaneAction(viewer, "next-tab")
    expect(heard).toEqual(["hide", "next-tab"])
    expect(outside).toEqual([])
    stop()
    raisePaneAction(viewer, "hide")
    expect(heard).toEqual(["hide", "next-tab"])
  })

  it("are only the pane's own, whatever else is raised under their name", () => {
    const pane = document.createElement("section")
    const heard: string[] = []
    onPaneAction(pane, (action) => heard.push(action))
    pane.dispatchEvent(new CustomEvent("novadeck:pane-action", { detail: "type rm -rf ~" }))
    expect(heard).toEqual([])
  })
})
