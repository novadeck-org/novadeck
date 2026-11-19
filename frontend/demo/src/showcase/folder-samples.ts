import { clip, clipSize } from "./clip"
import { createFolder, folderItem, renderFiles, type RenderMedia } from "./folders"
import { quarterlyReport } from "./pdf"

// The media a render folder holds.
export const renderMedia: RenderMedia = { clip, clipSize, report: quarterlyReport }

// The folder an agent rendered into, shown beside the dev server's terminal, and the ones the
// debug panel shows to reach the pane's other states.
export const folderSamples = {
  render: folderItem(
    "dev-render",
    "render",
    createFolder("~/render", renderFiles(Date.now(), renderMedia)),
  ),
}
