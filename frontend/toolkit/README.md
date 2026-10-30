# @novadeck/toolkit

The controls every feature of the UI draws with: wrappers over Ark UI (dialogs, menus,
popovers, selects, tabs, tooltips, toasts and the rest), the recipes that give them their look,
the sidebar item, the Nova mark and the agents' icons, what a terminal surface lays over its
output, and `Markdown`, which draws an agent's text (read by `@novadeck/viewers/markdown-blocks`,
highlighted by `@novadeck/viewers/code`) for the chat and the Inbox alike. A feature composes them
and owns its content and state: the controls take plain values, never the core's terminals,
projects or agents. The one piece of the app's vocabulary it holds is `./views`, the layouts'
names and icons: the shell and two features (Preferences and the welcome preview) all show them,
and a feature can't import the shell.

## Contract

- **It depends on no other frontend package.** Its manifest holds Ark UI, `clsx`,
  `tailwind-merge`, Lucide, React and the viewers library. The workspace packages it names are
  the viewers library (for `Markdown`) and `test-kit`, as a dev dependency of its tests;
  `scripts/workspace/graph.test.ts` holds the rest, and that no relative import leaves the
  package.
- **Ark UI is imported here and nowhere else.** The UI's architecture test reads this package
  as one of its base layers, which every feature may use and which may use nothing of theirs.
- **How a control looks is its recipe** (`button.css`, `item.css`, `sheet.css`, …), imported by
  the UI's `styles.css` into `layer(components)` at the place it always had. The recipes use
  `@apply`, which compiles in the UI's Tailwind run; the theming contract (`docs/theming.md`)
  covers them as it covers the UI's own.
- **`markdown.css` is imported just before `chat.css`**, not with the recipes above, so the
  Markdown's rules still come after the Inbox's and win their ties as they always did.
- **A context styles a control from outside.** The sidebar item's base rules are
  `sidebar-item.css`; what the terminal tabs or the team wire add to it stays with them.

## Subpaths

One per module a feature uses, named as its file: `./Tooltip`, `./ContextMenu`,
`./SidebarItem`, `./presence`, `./shown`, `./icons/ClaudeIcon`, and so on, and one per recipe
stylesheet: `./button.css`, `./sidebar-item.css`, …. The modules only the controls use are not
exported: `class-name` (`cn`, which merges Tailwind classes), `resting-pointer`, `toast-rules`,
and `test.ts`, Vitest's re-export for the package's own tests.

## Tailwind

The package writes utilities in its TSX. The UI's `styles.css` scans `src` with `@source`
(and leaves the tests out), and the build kit's `frontendUtilities` guards the scan with a
utility only this package writes. A new package folder that renders markup needs the same two
edits.
