# @novadeck/items

What Novadeck shows as items: an image, a code file, a Markdown file's document view, a page, a
plan in its editor, the changes an agent made; and beside them, a terminal's messages. The
registry of kinds, the item view each kind draws, the store behind them (`ItemStore`), the
taskbar of the items on a bar, the peek over a slot, and the bar drag that carries a slot to a
terminal, a view or out into a window.

An item lives in a home, a place that shows it. There are two: the companion pane beside a
terminal (`src/homes/terminal/`, with the marks of the kinds on the terminal's tab) and the
window an item is undocked into (`src/homes/undocked/`). The kinds live in `src/kinds/<kind>/`,
one folder each. The top of `src/` holds what more than one home will use: the kinds' registry, the
item view and the store, and the bar, taskbar, peek and bar drag. Today only the terminal's
home has a bar; they stay at the top for a home of the project's, which will have one too.
Some of the store still serves the terminal's home alone: how a plan presents beside its
terminal (`presentationOf`) and the follower that puts messages on a terminal's bar.

## Contract

- **It depends on `core`, `toolkit` and `viewers`, and on no other frontend package.** Not
  `frontend/ui`, `frontend/runner-adapter` or any backend. Two checks in `scripts/workspace/graph.test.ts` hold this: the
  manifest edges (what it declares, and what those reach), and a source check that no relative
  import in a frontend package's `src` leaves that package's folder, so a path into the UI
  can't bypass the manifest. The host (`frontend/ui`) composes it and passes in what it needs: the workspace's
  items and each terminal's bar (`TerminalCompanion`'s props), the commands that act on them,
  and the `ItemStore` it creates once.
- **A view reads state and never writes it.** `ItemStore` (`state.ts`) is the one place that loads
  content and writes plans, content and the revealed item; the views read it through
  `use-item-store.ts`. The items and the bar are core's workspace store, and mail is core's
  `Messages`. The host's part is `CompanionActions` (`actions.ts`): the named actions
  (`undock`, `dock`, `place`, `closeItem`, `markSeen`, `openBarTab`, `closeBarPane`,
  `hideOnBar`, `moveBarSlot`) that `frontend/ui`'s `app/commands/companion.ts` implements and
  declares it `satisfies`.
- **A registration draws one kind, and only its body.** `registry.ts` holds one registration
  per `PaneKind` (an item kind or `messages`), each a folder of `src/kinds/`. The pane's
  chrome stays in the terminal home's `CompanionPane`: its header, its actions, the "from another terminal" line
  and the states of what can't show. A registration never switches on another kind.
- **What a kind means as data is core's** (`kindRules` in `core/src/items.ts`: what it
  points at, whether it is followed always or while shown, and whether closing hides or
  removes it). The package reads the table where it needs one of those rules.
- **CodeMirror stays out of the first chunk.** The plan editor loads through `lazy()`
  (`kinds/plan/PlanTab.tsx`, `kinds/file/DocumentViewer.tsx`), and `state.ts` loads
  `@novadeck/viewers/sync` and `./kinds/plan/plan-editor/notes` with `import()`. A change that
  imports them statically pulls the editor into every window and can break the try build's
  first-load budget; compare the builds' chunk lists when touching either. The graph test keeps
  `@codemirror/*` imports inside `src/kinds/plan/plan-editor/`.
- **Viewers mount through `ViewerSlot.ts`.** A registration shows an image, code or a page by
  `useViewerSlot(mountImage | mountCode | mountBrowser, ...)`, which keeps each viewer's place
  by item id (24 places per mount). The editor is the exception: `mountMarkdown` stays inside
  the lazily loaded `PlanEditor`, with its own store (12), shared by plans and by Markdown files'
  document view.
- **The window's controls are the host's.** `TerminalCompanion` (`homes/terminal/`) declares the one callback it
  gets from a window (`onReveal`) as its own type, so the package never imports `WindowShell`.

## Subpaths

Only what the host imports: `./TerminalCompanion`, `./UndockedWindow` (the pane in its
terminal, and an item in a window of its own), `./state` (`createItemStore`, `ItemStore`, the plan
actions), `./bar` (`barMembers`, `composeBar`), `./mail` (`useHasMail`, `useMailBadge`),
`./TabKinds` (the kinds' marks on a terminal's tab), `./registry` (`iconOf`: whoever draws an
item's icon), `./actions` (`CompanionActions`),
`./drag-session` (`createDragSession`, `DragSessionContext`, `useDrag`, `useDragSession` and
their types: the views' drop spaces read it too) and the recipe stylesheets (`./taskbar.css`,
`./peek.css`, `./pane.css`, `./artifact.css`, `./mail.css`, `./prose.css`, `./syntax.css`).
`src/test.ts` is Vitest's re-export for the package's own tests and is not exported. A module is
exported when something outside imports it; the rest of `src` is internal.

## Tailwind

The package writes utilities in its TSX, and the UI's `styles.css` scans `src` with `@source`
(and leaves the tests out). It writes no utility that no other scanned folder writes, so the
build kit has no guard for it (as for `terminal-views`); the screenshots of the pane hold the
scan. The recipe stylesheets are imported by `styles.css` into `layer(components)` at the
places they always had, so the cascade holds.

## Adding a kind

A new artifact type is one folder and one line in the registry, plus its data parts. A new kind
that is not an item (as the messages are) touches more, listed at the end.

1. **The folder**, `src/kinds/<kind>/`: its components, and `index.ts` exporting the
   registration. Everything it needs of the pane is on the `PaneRegistration` type
   (`registration.ts`): the kind, the names of its stack, its icon (for one member and for a
   stack), how it looks (name and label), its peek miniature (`Thumb`) and the pane's body
   (`View`). An artifact kind builds its `View` and `Thumb` with `artifactView` and
   `artifactThumb` (`ArtifactViewer.tsx`), which give it the loading and unavailable states, and
   shows content through `useViewerSlot`. A registration never imports the plan editor or
   CodeMirror statically.
2. **The line**, in `registry.ts`: add it to `registry`. `Registry` maps every `PaneKind`, so a
   kind that has no registration fails to compile.
3. **For a new item kind**, the data parts that stay closed: the `companionItem.kind` enum and
   its content schema in `contract/protocol/src/schemas.ts`, its type in core's `ItemKind` and its
   line in `kindRules` in `frontend/core/src/items.ts` (what it points at, whether it is
   followed always, whether closing hides it), the SQLite `CHECK` on the kind in
   `backend/runner/src/workspaces/store.ts`, and its loaders in the runner
   (`backend/runner/src/companions/`). The pane kind is `ItemKind | "messages"`, so adding the
   kind to core's `ItemKind` makes the registry's missing line a compile error.

A skeleton for an artifact kind (an `audio` item, say):

```ts
// src/kinds/audio/index.ts
import { Volume2 } from "lucide-react"

import { artifactLook, artifactThumb, artifactView } from "../../ArtifactViewer"
import type { ItemMember } from "../../bar"
import type { PaneRegistration } from "../../registration"
import { AudioThumb, AudioViewer } from "./AudioViewer"

export const audio = {
  kind: "audio",
  names: { one: "clip", many: "Clips" },
  icon: () => Volume2,
  stackIcon: Volume2,
  look: artifactLook,
  Thumb: artifactThumb("audio", AudioThumb), // `AudioThumb({ content })`
  View: artifactView("audio", AudioViewer), // `AudioViewer({ item, content, actions })`
} satisfies PaneRegistration<ItemMember, "audio">

// src/registry.ts
export const registry = { image, file, page, plan, changes, messages, audio } satisfies Registry
```

A kind that is not an item (as the messages are) has no data parts, but it is not one line
either: add the kind to `PaneKind` in `registration.ts`, give it a member shape in `bar.ts`
(`BarMember`, and `composeBar` and the key logic with it, plus `BarKey` in core's
`companion-bar`), widen the `M` constraint on `PaneRegistration`, `ThumbProps` and `ViewProps` and
the conditional in `ThumbProps` and `Registry`, and teach `kindOf` in `registry.ts` to name it.
Its registration is `PaneRegistration<TheMember, "kind">`, and its `View` draws the whole body
itself.
