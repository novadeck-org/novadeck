# @novadeck/toolkit

The controls every feature of the UI draws with: wrappers over Ark UI (dialogs, menus,
popovers, selects, tabs, tooltips and the rest), the recipes that give them their look, the
`cn` class-name helper and the sidebar item. A feature composes them and owns its content and
state; nothing here knows about a terminal, a project or an agent.

## Contract

- **It depends on no other frontend package.** Its manifest holds Ark UI, `clsx`,
  `tailwind-merge`, Lucide and React. The one workspace package it names is `test-kit`, as a
  dev dependency of its tests; `scripts/workspace/graph.test.ts` holds the rest, and that no relative import leaves the package.
- **Ark UI is imported here and nowhere else.** The UI's architecture test reads this package
  as its old `ui-toolkit/` layer, which every feature may use and which may use nothing of
  theirs.
- **How a control looks is its recipe** (`button.css`, `item.css`, `sheet.css`, …), imported by
  the UI's `styles.css` into `layer(components)` at the place it always had. The recipes use
  `@apply`, which compiles in the UI's Tailwind run; the theming contract (`docs/theming.md`)
  covers them as it covers the UI's own.
- **A context styles a control from outside.** The sidebar item's base rules are
  `sidebar-item.css`; what the terminal tabs or the team wire add to it stays with them.

## Subpaths

One per module, named as its file: `./Tooltip`, `./ContextMenu`, `./SidebarItem`,
`./class-name`, `./presence`, `./shown`, `./icons/ClaudeIcon`, and so on, and one per recipe
stylesheet: `./button.css`, `./sidebar-item.css`, …. `src/test.ts` is Vitest's re-export for
the package's own tests and is not exported.

## Tailwind

The package writes utilities in its TSX. The UI's `styles.css` scans `src` with `@source`
(and leaves the tests out), and the build kit's `frontendUtilities` guards the scan with a
utility only this package writes. A new package folder that renders markup needs the same two
edits.
