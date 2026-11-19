import type { Backend } from "@novadeck/core/port"
import { folderSamples } from "@novadeck/demo/showcase/folder-samples"
import {
  createFolder,
  folderItem,
  numberedFiles,
  type DemoFile,
} from "@novadeck/demo/showcase/folders"
import { isShowcase } from "@novadeck/demo/showcase/simulation"
import { terminalOf } from "@novadeck/demo/workspace"

import type { DemoAction, DemoActionGroup } from "./types"

const picture = (name: string, size: number): DemoFile => ({
  name,
  kind: "image",
  size,
  modifiedAt: Date.now(),
  read: async () => new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
})

// What the folder pane can be in, on the selected terminal's bar as an agent's `show` of a
// folder would put it: the dev server's folder (render) is listed, written into and taken away,
// and one folder each for the pane's other states.
export const folderViewGroups = (companions: Backend["companions"]): readonly DemoActionGroup[] => {
  if (!companions || !isShowcase(companions)) return []
  const render = folderSamples.render
  const empty = folderItem("debug-folder-empty", "empty-run", createFolder("~/empty-run", []))
  const huge = folderItem(
    "debug-folder-huge",
    "node_modules",
    createFolder("~/node_modules", numberedFiles(48, Date.now()), "huge"),
  )
  const secret = folderItem("debug-folder-secret", ".ssh", createFolder("~/.ssh", [], "secret"))
  const show =
    (sample: Parameters<typeof companions.present>[2]): DemoAction["run"] =>
    ({ selected, workspace, note }) => {
      const key = selected()
      if (!key) return note("Select a terminal first.")
      companions.present(key, terminalOf(workspace(), key)?.handle ?? "", sample)
    }
  let landed = 0
  return [
    {
      section: "Agents",
      title: "Folder",
      actions: [
        {
          label: "Show a folder",
          hint: "The pane lists ~/render as a grid of thumbnails (a still per picture, the clip's first frame with its length, icons for the PDF, the log, notes.md and results.json), newest first, with a folder of its own, a secret and a link out named and never opened; right-click, Alt+double-click on notes.md or results.json (opens on its source) and Space (a quick look) work on its entries",
          run: show(render),
        },
        {
          label: "A file lands in the folder",
          hint: "A new picture takes the top of ~/render, with a dot, and its folder's taskbar mark is new while the pane shows something else; with the pointer in the grid it waits in a pill (N new files) instead",
          run: () => {
            landed += 1
            render.folder.put("", picture(`checkout-run-${landed}.svg`, 9_000))
          },
        },
        {
          label: "A file is being written",
          hint: "A file in ~/render grows for about 3 s: its tile shows the Files panel's write cursor and pulse until it stops",
          run: () => {
            landed += 1
            const name = `render-pass-${landed}.svg`
            for (let step = 0; step < 8; step += 1)
              setTimeout(
                () => render.folder.put("", picture(name, 4_000 + step * 6_000)),
                step * 400,
              )
          },
        },
        {
          label: "Show a folder with nothing in it",
          hint: "The pane says Nothing in empty-run yet, and that files show here as they're written",
          run: show(empty),
        },
        {
          label: "Show a folder too large to list whole",
          hint: "The pane lists the first 48 files of node_modules and says it holds 5,000 items, more than Novadeck lists whole",
          run: show(huge),
        },
        {
          label: "Show a folder that may hold secrets",
          hint: "The pane says .ssh may hold secrets, so Novadeck won't list what is in it; its crumbs and Up stay",
          run: show(secret),
        },
        {
          label: "The folder goes away",
          hint: "~/render is gone: its tab is struck through, the pane says render is gone: it was moved or deleted with a Close action, and the last listing stays faded",
          run: () => {
            render.folder.state = "gone"
            render.folder.changed()
          },
        },
        {
          label: "Bring the folder back",
          hint: "~/render is listed again as it was, and the notice goes",
          run: () => {
            render.folder.state = "ready"
            render.folder.changed()
          },
        },
      ],
    },
  ]
}
