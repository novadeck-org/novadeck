import type { Backend } from "@novadeck/core/port"
import { pdfAgain, pdfSamples } from "@novadeck/demo/showcase/artifacts"
import { isShowcase } from "@novadeck/demo/showcase/simulation"
import { terminalOf } from "@novadeck/demo/workspace"

import type { DemoAction, DemoActionGroup } from "./types"

// What the PDF pane can be in, shown on the selected terminal's bar as an agent's `show`
// would: each action shows a sample PDF of its own (the same five-page report, or why there
// is none), and the last shows the one that was rewritten.
export const pdfGroups = (companions: Backend["companions"]): readonly DemoActionGroup[] => {
  if (!companions || !isShowcase(companions)) return []
  const show =
    (sample: Parameters<typeof companions.present>[2]): DemoAction["run"] =>
    ({ selected, workspace, note }) => {
      const key = selected()
      if (!key) return note("Select a terminal first.")
      companions.present(key, terminalOf(workspace(), key)?.handle ?? "", sample)
    }
  // How many times the report's file was rewritten: each is a stamp of its own.
  let rewrites = 0
  return [
    {
      section: "Agents",
      title: "PDF",
      actions: [
        {
          label: "Show a PDF",
          hint: "The pane opens quarterly-report.pdf and draws its five Letter pages, each saying its number, with the PDF viewer's page and zoom controls",
          run: show(pdfSamples.shown),
        },
        {
          label: "Show a PDF that loads slowly",
          hint: "The pane says Loading and how much of slow-report.pdf is in, for about 3 s, then draws it",
          run: show(pdfSamples.slow),
        },
        {
          label: "Show a PDF too large to preview",
          hint: "The pane says annual-review.pdf is too large to preview: Novadeck previews PDFs up to 128 MB",
          run: show(pdfSamples.large),
        },
        {
          label: "Show a PDF that may hold secrets",
          hint: "A salaries.pdf tab joins the stack without opening, as an item that may hold secrets does; picking its tab is the yes, and it draws",
          run: show(pdfSamples.secret),
        },
        {
          label: "Show a file that isn't a PDF",
          hint: "The pane loads broken.pdf, then says This file couldn't be read as a PDF.",
          run: show(pdfSamples.broken),
        },
        {
          label: "Rewrite the PDF",
          hint: "The PDF of Show a PDF is read again as a new file: the pane keeps the old one on screen, then swaps in the new, on the page you were on",
          run: (context) => {
            rewrites += 1
            return show(pdfAgain(pdfSamples.shown, `rewritten-${rewrites}`))(context)
          },
        },
      ],
    },
  ]
}
