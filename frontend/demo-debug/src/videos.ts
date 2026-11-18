import type { Backend } from "@novadeck/core/port"
import { videoAgain, videoSamples } from "@novadeck/demo/showcase/artifacts"
import { isShowcase } from "@novadeck/demo/showcase/simulation"
import { terminalOf } from "@novadeck/demo/workspace"

import type { DemoAction, DemoActionGroup } from "./types"

// What the video pane can be in, shown on the selected terminal's bar as an agent's `show`
// would: each action shows a sample video of its own (the same four-second clip, or why
// there is none), and the last two show the one that plays again.
export const videoGroups = (companions: Backend["companions"]): readonly DemoActionGroup[] => {
  if (!companions || !isShowcase(companions)) return []
  const show =
    (sample: Parameters<typeof companions.present>[2]): DemoAction["run"] =>
    ({ selected, workspace, note }) => {
      const key = selected()
      if (!key) return note("Select a terminal first.")
      companions.present(key, terminalOf(workspace(), key)?.handle ?? "", sample)
    }
  // The playable one as it stands: the shows of it so far, and the stamp of its file, which
  // a later show carries on from.
  let shown = 0
  let stamp = "1"
  const play =
    (fields: { stamp?: string; at?: number }): DemoAction["run"] =>
    (context) => {
      shown += 1
      stamp = fields.stamp ?? stamp
      return show(videoAgain(videoSamples.playable, { shown, stamp, ...fields }))(context)
    }
  return [
    {
      section: "Agents",
      title: "Video",
      actions: [
        {
          label: "Show a video",
          hint: "The pane opens walkthrough.webm, 4 s, paused on its first frame, with its own bar: play, scrubber, frame steps, loop, speed, mute, full screen",
          run: play({}),
        },
        {
          label: "Show a video that loads slowly",
          hint: "The pane says Loading and how much of the video is in, for about 5 s, then it plays",
          run: show(videoSamples.slow),
        },
        {
          label: "Show a video too large to play",
          hint: "The pane says launch-film.webm is too large to preview (740 MB); its peek says Too large to preview",
          run: show(videoSamples.large),
        },
        {
          label: "Show a video that's gone",
          hint: "The pane says old-cut.webm isn't there any more, with Copy path",
          run: show(videoSamples.missing),
        },
        {
          label: "Show a video that can't be read",
          hint: "The pane says Novadeck can't read locked.webm",
          run: show(videoSamples.unreadable),
        },
        {
          label: "Show a file the browser can't play",
          hint: "The pane loads broken.webm, then says it can't be played here",
          run: show(videoSamples.broken),
        },
        {
          label: "Show a video that may hold secrets",
          hint: "A review.webm tab joins the video stack without opening, as an item that may hold secrets does; picking its tab is the yes, and it plays",
          run: show(videoSamples.secret),
        },
        {
          label: "Show the video again from 0:02",
          hint: "The video of Show a video starts again from 0:02, once, as the agent's later show says",
          run: play({ at: 2 }),
        },
        {
          label: "Rewrite the video",
          hint: "The video of Show a video is read again as a new file; the pane keeps playing the old one, a chip says Loading, then it swaps in where it was, playing or paused",
          run: play({ stamp: `rewritten-${shown + 1}` }),
        },
      ],
    },
  ]
}
