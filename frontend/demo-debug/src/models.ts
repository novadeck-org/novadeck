import type { Backend } from "@novadeck/core/port"
import { bracketAgain, modelSamples } from "@novadeck/demo/showcase/model-samples"
import { isShowcase } from "@novadeck/demo/showcase/simulation"
import { terminalOf } from "@novadeck/demo/workspace"

import type { DemoAction, DemoActionGroup } from "./types"

// What the 3D model pane can be in, shown on the selected terminal's bar as an agent's `show`
// would: each action shows a sample model of its own (or why there is none), and the last
// rewrites the bracket longer, as a CAD loop writes it again.
export const modelGroups = (companions: Backend["companions"]): readonly DemoActionGroup[] => {
  if (!companions || !isShowcase(companions)) return []
  const show =
    (sample: Parameters<typeof companions.present>[2]): DemoAction["run"] =>
    ({ selected, workspace, note }) => {
      const key = selected()
      if (!key) return note("Select a terminal first.")
      companions.present(key, terminalOf(workspace(), key)?.handle ?? "", sample)
    }
  // How many times the bracket was rewritten: each a stamp of its own, 10 mm longer.
  let rewrites = 0
  return [
    {
      section: "Agents",
      title: "3D model",
      actions: [
        {
          label: "Show an STL bracket",
          hint: "The pane opens bracket.stl, an L-bracket fitted in view on a grid, with Fit, Grid, Wireframe and Flat on its bar and 60 × 40 × 40 mm on its size chip",
          run: show(modelSamples.bracket),
        },
        {
          label: "Show an animated glTF",
          hint: "The pane opens arm.gltf, read with arm.bin beside it: a steel base and an orange boom, with Play on its bar, which swings the boom",
          run: show(modelSamples.arm),
        },
        {
          label: "Show an OBJ with materials",
          hint: "The pane opens crate.obj, read with crate.mtl beside it: a wooden crate with a dark band",
          run: show(modelSamples.crate),
        },
        {
          label: "Show a PLY scan of points",
          hint: "The pane opens dome-scan.ply: a dome of coloured points, 100 × 100 × 50 mm on its size chip",
          run: show(modelSamples.scan),
        },
        {
          label: "Show a 3MF spacer",
          hint: "The pane opens spacer.3mf, a tube 20 mm across, with 20 × 20 × 10 mm on its size chip, read from the millimetres its model names",
          run: show(modelSamples.threeMf),
        },
        {
          label: "Show a model that loads slowly",
          hint: "The pane says Loading and how much of slow-arm.gltf and arm.bin is in, for about 4 s, then draws it",
          run: show(modelSamples.slow),
        },
        {
          label: "Show a model too large to preview",
          hint: "The pane says hull-scan.glb is too large to preview: Novadeck previews 3D models up to 256 MB",
          run: show(modelSamples.large),
        },
        {
          label: "Show a model that may hold secrets",
          hint: "A prototype.stl tab joins the stack without opening, as an item that may hold secrets does; picking its tab is the yes, and it draws",
          run: show(modelSamples.secret),
        },
        {
          label: "Show a model whose read fails",
          hint: "The pane says unreachable-bracket.stl couldn't be loaded, as when the link to the runner drops",
          run: show(modelSamples.failing),
        },
        {
          label: "Show a glTF naming a texture elsewhere",
          hint: "The pane draws arm-skinned.gltf without its texture, and says at the top Not read: https://cdn.example.com/arm-skin.png (an address of its own)",
          run: show(modelSamples.outside),
        },
        {
          label: "Show a glTF whose files were refused",
          hint: "The pane draws arm-refused.gltf, and says at the top which files it names weren't read and why: an address of its own, outside the model's folder, may hold secrets, not there, too large",
          run: show(modelSamples.refusals),
        },
        {
          label: "Show a glTF whose buffer can't be read",
          hint: "The pane loads arm-unread.gltf, says Not read: arm.bin (can't be read), and This isn't a model Novadeck can read., as when the link drops while its buffer is read",
          run: show(modelSamples.besideFails),
        },
        {
          label: "Show a glTF claiming 4 GB",
          hint: "The pane loads arm-claims.gltf, then says This model claims more than Novadeck draws., before three.js allocates what it claims",
          run: show(modelSamples.claims),
        },
        {
          label: "Show an STL with nothing in it",
          hint: "The pane loads empty.stl, then says This model has nothing to draw.",
          run: show(modelSamples.empty),
        },
        {
          label: "Show a model past what a peek draws",
          hint: "The pane draws bracket-fine.stl; its peek shows the 3D model badge and 40.0 MB, not a still, as a peek reads no model past 32 MB",
          run: show(modelSamples.pastPeek),
        },
        {
          label: "Show a Draco-compressed glTF",
          hint: "The pane loads arm-draco.gltf, then says it's compressed in a way Novadeck can't read yet (Draco, Meshopt or Basis)",
          run: show(modelSamples.draco),
        },
        {
          label: "Show a file that isn't a model",
          hint: "The pane loads broken.glb, then says This isn't a model Novadeck can read.",
          run: show(modelSamples.broken),
        },
        {
          label: "Stop the 3D viewer",
          hint: "The model showing in the pane says The 3D viewer stopped., as when its frame loads another page than its own",
          // The frame sent elsewhere, as only a script in it could do.
          run: ({ note }) => {
            // The pane's own, not the one out of sight that draws peeks' stills.
            const frames = [
              ...document.querySelectorAll<HTMLIFrameElement>("iframe.model-frame"),
            ].filter((frame) => !frame.closest(".model-stills"))
            if (frames.length === 0) return note("Show a model first.")
            for (const frame of frames) frame.src = "about:blank"
          },
        },
        {
          label: "Rewrite the bracket",
          hint: "The bracket of Show an STL bracket is written again 10 mm longer, read in small parts for about 1 s: the pane keeps the old one in view under a Loading chip, then draws the new one from where you were looking",
          run: (context) => {
            rewrites += 1
            return show(bracketAgain(`rewritten-${rewrites}`, 60 + rewrites * 10))(context)
          },
        },
      ],
    },
  ]
}
