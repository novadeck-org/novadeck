// Where a spec's test is now, from an id a log of an older run gives it. The specs left the
// UI's package (`src/specs/x.spec.tsx` became `src/x.spec.tsx`), then went into domain folders,
// some groups with them into other files, so a flake registered or logged by any of these
// names is the same test. Most specific first: a group that moved on its own comes before its
// file.
const moved: readonly (readonly [string, string])[] = [
  ["src/agents.spec.tsx > A pinned project", "src/projects/pins.spec.tsx > A pinned project"],
  [
    "src/keyboard.spec.tsx > pinned project shortcuts",
    "src/projects/pins.spec.tsx > pinned project shortcuts",
  ],
  ["src/keyboard.spec.tsx > dictation", "src/interaction/dictation.spec.tsx > dictation"],
  ["src/keyboard.spec.tsx > sidebar settings", "src/workspace/sidebar.spec.tsx > sidebar settings"],
  [
    "src/interaction/keyboard.spec.tsx > sidebar settings",
    "src/workspace/sidebar.spec.tsx > sidebar settings",
  ],
  [
    "src/focus.spec.tsx > available view modes",
    "src/workspace/views.spec.tsx > available view modes",
  ],
  [
    "src/preferences.spec.tsx > terminal text size preference",
    "src/preferences/preferences.spec.tsx > Terminal text size preference",
  ],
  ["src/agents.spec.tsx", "src/agents/agents.spec.tsx"],
  ["src/chat.spec.tsx", "src/agents/chat.spec.tsx"],
  ["src/messages.spec.tsx", "src/agents/messages.spec.tsx"],
  ["src/canvas-companion.spec.tsx", "src/companions/canvas.spec.tsx"],
  ["src/companions.spec.tsx", "src/companions/companions.spec.tsx"],
  ["src/companions-space.spec.tsx", "src/companions/space.spec.tsx"],
  ["src/portable.spec.tsx", "src/desktop/portable.spec.tsx"],
  ["src/sandbox.spec.tsx", "src/desktop/sandbox.spec.tsx"],
  ["src/uninstall.spec.tsx", "src/desktop/uninstall.spec.tsx"],
  ["src/updates.spec.tsx", "src/desktop/updates.spec.tsx"],
  ["src/whats-new.spec.tsx", "src/desktop/whats-new.spec.tsx"],
  ["src/inbox-bell.spec.tsx", "src/inbox/bell.spec.tsx"],
  ["src/inbox.spec.tsx", "src/inbox/inbox.spec.tsx"],
  ["src/inbox-landing.spec.tsx", "src/inbox/landing.spec.tsx"],
  ["src/inbox-toasts.spec.tsx", "src/inbox/toasts.spec.tsx"],
  ["src/keyboard.spec.tsx", "src/interaction/keyboard.spec.tsx"],
  ["src/search.spec.tsx", "src/interaction/search.spec.tsx"],
  ["src/tooltips.spec.tsx", "src/interaction/tooltips.spec.tsx"],
  ["src/murmur-offer.spec.tsx", "src/preferences/murmur-offer.spec.tsx"],
  ["src/preferences.spec.tsx", "src/preferences/preferences.spec.tsx"],
  ["src/themes.spec.tsx", "src/preferences/themes.spec.tsx"],
  ["src/project-window.spec.tsx", "src/projects/project-window.spec.tsx"],
  ["src/sessions.spec.tsx", "src/projects/sessions.spec.tsx"],
  ["src/source.spec.tsx", "src/projects/source.spec.tsx"],
  ["src/terminal-keys.spec.tsx", "src/terminals/keys.spec.tsx"],
  ["src/process-windows.spec.tsx", "src/terminals/process-windows.spec.tsx"],
  ["src/terminals.spec.tsx", "src/terminals/terminals.spec.tsx"],
  ["src/WorkspaceTerminal.test.ts", "src/terminals/workspace-terminal.test.ts"],
  ["src/canvas-offscreen.spec.tsx", "src/views/canvas-offscreen.spec.tsx"],
  ["src/canvas-sessions.spec.tsx", "src/views/canvas-sessions.spec.tsx"],
  ["src/canvas.spec.tsx", "src/views/canvas.spec.tsx"],
  ["src/focus.spec.tsx", "src/views/focus.spec.tsx"],
  ["src/grid.spec.tsx", "src/views/grid.spec.tsx"],
  ["src/zen.spec.tsx", "src/views/zen.spec.tsx"],
  ["src/commands.spec.tsx", "src/workspace/commands.spec.tsx"],
  ["src/motion.spec.tsx", "src/workspace/motion.spec.tsx"],
  ["src/WorkspaceOverlays.test.ts", "src/workspace/overlays.test.ts"],
  ["src/render-scope.test.ts", "src/workspace/render-scope.test.ts"],
  ["src/routing.spec.tsx", "src/workspace/routing.spec.tsx"],
  ["src/views.spec.tsx", "src/workspace/views.spec.tsx"],
]

export const currentTest = (test: string): string => {
  const plain = test.replace(/^src\/specs\//, "src/")
  const found = moved.find(([old]) => plain === old || plain.startsWith(`${old} `))
  return found ? found[1] + plain.slice(found[0].length) : plain
}
