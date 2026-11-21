import type { Backend } from "@novadeck/core/port"
import { htmlSamples, stripAgain } from "@novadeck/demo/showcase/html-samples"
import { isShowcase } from "@novadeck/demo/showcase/simulation"
import { terminalOf } from "@novadeck/demo/workspace"

import type { DemoAction, DemoActionGroup } from "./types"

// What the pane can be in for an HTML file, shown on the selected terminal's bar as an agent's
// `show` would: each action shows a sample page of its own, drawn as a page in a sandboxed frame
// with the stylesheet and pictures beside it, or why it isn't; the last rewrites the strip's
// stylesheet, as an agent iterating on it would, so the page has another ground.
export const pageGroups = (companions: Backend["companions"]): readonly DemoActionGroup[] => {
  if (!companions || !isShowcase(companions)) return []
  const show =
    (sample: Parameters<typeof companions.present>[2]): DemoAction["run"] =>
    ({ selected, workspace, note }) => {
      const key = selected()
      if (!key) return note("Select a terminal first.")
      companions.present(key, terminalOf(workspace(), key)?.handle ?? "", sample)
    }
  // How many times the strip's stylesheet was rewritten: each a stamp of its own, on the next ground.
  let rewrites = 0
  const grounds = ["#dfe9f3", "#e5efe0", "#f1e0e8", "#f6f1e7"]
  return [
    {
      section: "Agents",
      title: "Web page",
      actions: [
        {
          label: "Show a web page",
          hint: "The pane opens strip.html drawn as a page: a cream three-panel comic strip, its stylesheet and pictures read from beside it, with a Show source switch in the pane's row",
          run: show(htmlSamples.shown),
        },
        {
          label: "Show a web page that loads slowly",
          hint: "The pane opens slow-strip.html blank and busy for about 1 s while its stylesheet and pictures are read, then draws the strip",
          run: show(htmlSamples.slow),
        },
        {
          label: "Show a web page whose files are missing",
          hint: "The pane opens bare-strip.html drawn plain: its stylesheet and pictures aren't beside it, so it has no styles and no pictures",
          run: show(htmlSamples.bare),
        },
        {
          label: "Show a web page with no styles",
          hint: "The pane opens hello.html, a heading and a line on white, as a browser draws a bare page",
          run: show(htmlSamples.plain),
        },
        {
          label: "Show a web page too long to draw",
          hint: "The pane opens long-strip.html on its source, with a line above it saying the page is too long to draw",
          run: show(htmlSamples.long),
        },
        {
          label: "Rewrite the page's stylesheet",
          hint: "strip.css is written again with another ground for the page: the pane draws the strip again on it, as it does when an agent saves a stylesheet",
          run: (context) => {
            rewrites += 1
            return show(
              stripAgain(`rewritten-${rewrites}`, grounds[(rewrites - 1) % grounds.length]!),
            )(context)
          },
        },
        {
          label: "Stop the page viewer",
          hint: "The page showing in the pane says The page viewer stopped., as when its frame loads another page than its own",
          // The frame sent elsewhere, as only a script in it could do.
          run: ({ note }) => {
            const frames = [...document.querySelectorAll<HTMLIFrameElement>("iframe.html-frame")]
            if (frames.length === 0) return note("Show a web page first.")
            for (const frame of frames) frame.src = "about:blank"
          },
        },
      ],
    },
  ]
}
