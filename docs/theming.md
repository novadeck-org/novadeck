# Theming

Novadeck's look is a theme. Components give the interface its shape; a theme decides
how that shape is drawn: colours, borders, depth, corners, type, and the texture of the
workspace. The app ships three themes: Graphite, the default, with a light and a dark
scheme, and Phosphor Green and Phosphor Amber, a monochrome CRT in two tubes, in dark
only. The person picks a theme, and a mode where the theme offers more than one. The
token tiers and the component hooks below are general, so a theme can change them
without touching a component.

This guide is the contract between the two sides. Change it when the contract changes.

## Layers

`styles.css` declares one cascade order, before Tailwind loads:

```css
@layer theme, base, components, themes, accessibility, utilities;
```

| Layer           | Holds                                                                                                                                              | Written in                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `theme`         | Tailwind's layout scale: spacing, breakpoints, type sizes. No colours, radii or shadows (see below).                                               | `theme/contract.css`                                |
| `base`          | Defaults for optional tokens, element defaults (body, focus ring, scrollbars, selection, font features, ligatures), the bundled fonts, vendor CSS. | `theme/base.css`, `theme/fonts.css`, vendor imports |
| `components`    | Recipes: one per component, shape only, every visual value a token.                                                                                | beside each component                               |
| `themes`        | Each theme's file: token values, and the rules tokens can't express.                                                                               | `theme/graphite.css`, `theme/phosphor.css`          |
| `accessibility` | Reduced motion and forced colours, so no theme can defeat them.                                                                                    | `theme/accessibility.css`                           |
| `utilities`     | Tailwind layout utilities from the TSX.                                                                                                            | Tailwind                                            |

Every stylesheet is layered, vendor CSS included: CSS outside a layer beats every
layer, so one unlayered rule would override every theme. `styles.css` imports each
stylesheet into a layer, except Tailwind and `theme/contract.css`, which Tailwind
layers itself; CSS imported from a script wraps its rules in `@layer`. This covers the
stylesheets the app ships; styles a library injects while it runs are outside any
layer, and [Exceptions](#exceptions) says how each is met. Recipes and
themes never use `!important`, because it turns the layer order around; the few rules
that must are listed under [Exceptions](#exceptions).

`theme/contract.css` clears Tailwind's colour, radius, shadow, blur, font family,
letter spacing, easing and animation namespaces, so those utilities don't exist: not in
the TSX, and not through `@apply`, where a recipe may use only layout utilities.
`styles.css` also keeps Tailwind from building utilities out of the unit tests and out
of words the code uses in other senses, such as `outline` and `transition`.

## Tokens

Three tiers, each reading only from the one above it.

1. **Foundation tokens** are the theme's vocabulary. A theme defines every required one
   for each scheme; `theme/contract.test.ts` checks this.
2. **Component tokens** are each recipe's knobs, such as `--button-bg` or
   `--window-selected-border-color`. A recipe falls back to foundation tokens when a
   theme leaves one unset, so a theme that sets none still looks whole.
3. **Private values** are what a recipe computes for itself, named `--_<name>`. The
   markup may hand a recipe one through `style`, such as a boot slot's `--_order` or
   the canvas's `--_canvas-chrome-scale`; a theme never sets them.

### Who declares what

Only themes declare foundation and component tokens. A recipe never declares one; it
reads each component token, with its fallback, into a private value on its own element,
and its states change only private values:

```css
.button {
  --_bg: var(--button-bg, var(--color-paper));
  background: var(--_bg);
}
.button:hover:not(:disabled) {
  --_bg: var(--button-hover-bg, var(--color-soft));
}
```

This is load-bearing. A declaration on an element beats the value it inherits, whatever
the layers, so `.button { --button-bg: … }` in a recipe would hide the theme's
`--button-bg` from every button. Reading tokens on the element also lets a theme
restyle a region: `.sidebar { --color-paper: … }` reaches every
recipe inside the sidebar.

A token whose value reads another token is resolved where it is declared, and its
descendants inherit the result. So an `--item-selected-bg` that a theme mixes from
`--color-strong` on `:root` keeps the root's strong colour inside a restyled
region. A theme that restyles a region declares each such token again on the region,
in the same rule as on its root, so it reads the region's own foundation tokens.

Optional foundation tokens with a plain value get their defaults in `theme/base.css`,
on `:root` in the `base` layer, never in Tailwind's `@theme`, which would turn them
back into utilities. An optional token whose default reads other tokens
(`--focus-ring-color`, `--brand-tile-bg`, `--brand-tile-fg`) has no `:root` default:
each recipe that reads it carries the default as its fallback, so it resolves on the
element and follows a restyled region.

### Foundation tokens

Required in every scheme:

| Group    | Tokens                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Grounds  | `--color-canvas` (the workspace behind windows), `--color-shell` (sidebar, rail, settings), `--color-paper` (windows, cards, header, popovers), `--color-soft` (hover and pressed fills)               |
| Text     | `--color-ink` (primary), `--color-muted` (secondary)                                                                                                                                                   |
| Lines    | `--color-line` (dividers, resting borders), `--color-line-strong` (emphasised borders)                                                                                                                 |
| Emphasis | `--color-strong`, `--color-strong-hover`, `--color-on-strong`: primary actions, on states, what is selected, focus                                                                                     |
| Overlays | `--color-scrim`, `--color-selection`, `--color-shadow` (the colour every shadow is made from)                                                                                                          |
| Tones    | `--color-{success,warning,danger,note}` (a tint) and `--color-{success,warning,danger,note}-fg` (text on it)                                                                                           |
| Syntax   | `--color-syntax-{keyword,string,number,property,definition,type,comment}`                                                                                                                              |
| Terminal | `--terminal-{bg,fg,cursor,selection}`; `--terminal-ansi-{black,red,green,yellow,blue,magenta,cyan,white}`, and each again as `--terminal-ansi-{black,red,green,yellow,blue,magenta,cyan,white}-bright` |
| Depth    | `--shadow-control`, `--shadow-panel`, `--shadow-floating`, `--shadow-modal`                                                                                                                            |

Optional, with defaults in `theme/base.css` or, for those that read other tokens, in
each recipe's fallback:

| Group   | Tokens                                                                                                         |
| ------- | -------------------------------------------------------------------------------------------------------------- |
| Shape   | `--radius-control`, `--radius-panel`, `--radius-popover`, `--border-width`                                     |
| Type    | `--font-sans`, `--font-mono`                                                                                   |
| Focus   | `--focus-ring-color`, `--focus-ring-width`, `--focus-ring-offset`                                              |
| Motion  | `--motion-feedback`, `--motion-state`, `--motion-layout`, `--motion-view`, `--ease-interface`                  |
| Texture | `--canvas-grain-opacity`, `--canvas-dots-opacity`, `--terminal-idle-opacity`, `--terminal-hover-opacity`       |
| Brand   | `--brand-tile-bg`, `--brand-tile-fg`, `--brand-tile-border-color` (the logo tile and the welcome start button) |

Don't register colour tokens with `@property`: a registered token given a value of the
wrong type silently falls back to its initial value.

### Component tokens

Names follow `--<component>[-<variant>][-<part>][-<state>]-<property>`:
`--button-bg`, `--button-primary-hover-bg`, `--item-selected-indicator-bg`,
`--toggle-track-on-bg`, `--window-phase-running-border-color`. Properties come from a
short vocabulary: `bg`, `fg`, `border-color`, `border-width`, `radius`, `shadow`,
`opacity`, `blur`, `image` (hatches, grain, dot grids), `font`, `height`, `padding`,
`ring-color`, `ring-offset`, `border-style`.

Each recipe opens with a comment that lists its tokens and what each one paints. That
comment is the component's theming reference; there is no separate list to keep in step.

The shared recipes, and what they cover:

| Recipe               | Covers                                                                                                                      | Example tokens                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `button`             | `.button`: dialog actions, empty states, create buttons; `.primary`, `.ghost`, `.quiet` (a ghost muted at rest), `.link`    | `--button-{bg,fg,border-color,shadow}`, `--button-hover-bg`, `--button-primary-bg`, `--button-quiet-fg`, `--button-link-{fg,hover-fg}`                                                                                                                                                                                                                                            |
| `icon-button`        | Header, window, tab, sidebar actions; `.dim` faint until hovered; `.quiet` toggles; `.small`, `.raised`; on: `aria-pressed` | `--icon-button-fg`, `--icon-button-hover-bg`, `--icon-button-pressed-{bg,fg}`, `--icon-button-raised-{bg,border-color,shadow}`, `--icon-button-dim-opacity`                                                                                                                                                                                                                       |
| `surface`            | `.panel`, `.card`, `.floating` (a `.peek` rises from its trigger), `.modal` with its `.modal-header` and `.modal-footer`    | `--{panel,card,floating,modal}-{bg,border-color,shadow,radius}`, `--modal-header-border-color`, `--modal-footer-{bg,fg,border-color}`                                                                                                                                                                                                                                             |
| `overlay`            | The scrim behind dialogs and the mobile sidebar                                                                             | `--overlay-bg`, `--overlay-blur`                                                                                                                                                                                                                                                                                                                                                  |
| `region`             | The app's chrome: header, footer, sidebar, rail, settings ground                                                            | `--region-{header,footer,sidebar,rail}-{bg,fg,border-color,image}`, `--region-settings-bg`                                                                                                                                                                                                                                                                                        |
| `item`               | Sidebar rows, menu and select items, search results                                                                         | `--item-{hover,highlighted,selected}-bg`, `--item-highlighted-fg` (also on a `.standalone` item, one no Ark list manages, under the pointer or the keyboard), `--item-selected-{border-color,shadow}`, `--item-selected-indicator-{bg,shadow}`                                                                                                                                    |
| `segmented`          | View switch, segment groups, toggle groups, tabs                                                                            | `--segmented-bg`, `--segmented-active-{bg,fg,shadow}`, `--tabs-indicator-{bg,shadow}`                                                                                                                                                                                                                                                                                             |
| `field`              | Select and combobox triggers, inputs                                                                                        | `--field-{bg,fg,border-color,shadow}`, `--field-open-border-color`                                                                                                                                                                                                                                                                                                                |
| `toggle`             | Switch and checkbox                                                                                                         | `--toggle-track-{on,off}-bg`, `--toggle-{track,track-on,thumb}-shadow`, `--toggle-box-{shadow,checked-shadow}`, `--toggle-thumb-bg`, `--toggle-mark-fg`                                                                                                                                                                                                                           |
| `progress`           | A bar filling as known work goes                                                                                            | `--progress-track-{bg,border-color,shadow}`, `--progress-range-bg`, `--progress-radius`                                                                                                                                                                                                                                                                                           |
| `dictation`          | Voice input's status line and the mic while it records                                                                      | `--dictation-{bg,fg,border-color,shadow,radius,muted-fg,recording-fg,error-fg}`                                                                                                                                                                                                                                                                                                   |
| `tone`               | Anything marked `data-tone`: success, warning, danger or note                                                               | read straight from the foundation tones                                                                                                                                                                                                                                                                                                                                           |
| `badge`              | Counts, `kbd`, small labels, and a `kbd.hint` set quietly inside a control                                                  | `--badge-{bg,fg,border-color}`, `--kbd-{bg,fg,border-color,shadow}`, `--kbd-hint-{fg,opacity}`                                                                                                                                                                                                                                                                                    |
| `separator`          | Dividers and the panel sashes                                                                                               | `--separator-bg`, `--sash-{bg,hover-bg}`; a sash at rest falls back to `--region-sidebar-border-color`                                                                                                                                                                                                                                                                            |
| `label`              | `.section-label`, the small capitals that title a sidebar panel or a group of preferences                                   | `--section-label-{fg,font}`                                                                                                                                                                                                                                                                                                                                                       |
| `sidebar`            | The sidebar's panels, its rows (items) and its create button                                                                | `--sidebar-create-border-color`; rows read the item tokens                                                                                                                                                                                                                                                                                                                        |
| `workspace-switcher` | The header's project switcher: its trigger, rows and open-folder button                                                     | `--workspace-switcher-icon-fg`; reads the button and item tokens                                                                                                                                                                                                                                                                                                                  |
| `empty-state`        | The empty workspace's card                                                                                                  | `--empty-state-description-fg`; reads the surface and button tokens                                                                                                                                                                                                                                                                                                               |
| `zen-dock`           | Zen's dock of icon buttons                                                                                                  | `--zen-dock-{bg,border-color,shadow,radius,blur,idle-opacity}`                                                                                                                                                                                                                                                                                                                    |
| `deck-logo`          | The Deck mark and wordmark                                                                                                  | `--brand-tile-{bg,fg,border-color}`, `--deck-mark-card-{near,far}-bg`, `--deck-word-fg`                                                                                                                                                                                                                                                                                           |
| `window`             | The terminal window, its header, metadata, done chip, selection bar and phase line, the rename field                        | `--window-{bg,border-color,shadow}`, `--window-selected-{border-color,header-bg,shadow}`, `--window-indicator-{bg,shadow}`, `--window-phase-{running,starting,attention,unheard,done,failed,ended}-border-color`, `--window-phase-running-shadow`, `--window-phase-border-width`, `--window-{done,failed}-{bg,fg}`, `--window-ended-{image,border-style}`, `--window-glass-image` |
| `tabs`               | A terminal's sidebar tab: its phase glyph, ended hatch, actions and companion icons                                         | `--tab-{glyph,starting,attention,unheard,done,failed,ended}-fg`, `--tab-ended-image`, `--tab-hidden-opacity`, `--tab-kind-{fg,opacity,new-opacity,new-bg}`                                                                                                                                                                                                                        |
| `switcher`           | What the terminal switcher adds to its `.modal` and `.item`s: the header's count, a row's parts                             | `--switcher-header-fg`, `--switcher-go-opacity`                                                                                                                                                                                                                                                                                                                                   |
| `workspace`          | The ground behind Focus, Grid and Canvas, its dots and grain, resize grips and drop ghosts                                  | `--workspace-{bg,glow-bg,edge-bg,dots-fg,dots-image,grain-image,inset-shadow}`, `--workspace-grip-{fg,image}`, `--workspace-ghost-{bg,border-color}`, `--workspace-placeholder-bg`                                                                                                                                                                                                |
| `runner`             | The runner's surface: where xterm draws, greyed while locked, and its paste notice                                          | none; the notice and ending bar are `terminal-status`'s                                                                                                                                                                                                                                                                                                                           |
| `terminal-status`    | Over a terminal surface: the lock notice, the ending bar and Restart                                                        | `--terminal-lock-bg`, `--terminal-notice-{bg,fg,border-color,shadow}`, `--terminal-ending-{bg,fg,border-color,reason-fg}`, `--terminal-restart-{hover-bg,disabled-opacity}`                                                                                                                                                                                                       |
| `boot-splash`        | The boot splash, its field of slots and hairline, and a failure with its details                                            | `--boot-splash-{bg,fg,slot-border-color,hairline-bg,hairline-fill-bg}`, `--boot-failure-details-bg`                                                                                                                                                                                                                                                                               |
| `demo`               | The demo backend's made-up terminal and agent output                                                                        | `--demo-{font,muted-fg,rule-color,request-bg}`, `--demo-badge-{bg,fg}`, `--demo-form-{bg,border-color,shadow}`                                                                                                                                                                                                                                                                    |
| `debug-panel`        | The demo's debug panel and the floating button that opens it                                                                | `--debug-panel-{bg,fg,border-color,radius,shadow}`, `--debug-mark-{bg,fg}`, `--debug-{muted-fg,action-bg,action-border-color,action-hover-bg}`, `--debug-floater-{bg,fg,border-color,rest-fill,rest-opacity,shadow,active-fg}`                                                                                                                                                    |
| `demo-notices`       | The demo backend's in-page notifications, the browser's stand-in for desktop ones                                           | `--demo-notice-{bg,fg,border-color,shadow,body-fg,hover-bg}`                                                                                                                                                                                                                                                                                                                      |
| `taskbar`            | A terminal's taskbar: its icons, their marks and counts, the empty drop bar                                                 | `--taskbar-{bg,border-color}`, `--taskbar-item-{hover,pressed}-{bg,fg}`, `--taskbar-mark-active-bg`, `--taskbar-count-{held,paused}-bg`                                                                                                                                                                                                                                           |
| `peek`               | The cards above a taskbar icon, and the previews in miniature                                                               | `--peek-card-{hover,pressed}-bg`, `--peek-thumb-{bg,border-color}`, `--peek-page-bar-bg`                                                                                                                                                                                                                                                                                          |
| `pane`               | The split, attached and undocked pane, its divider, the outline and the plan's header                                       | `--pane-{bg,border-color}`, `--pane-attached-{border-color,shadow}`, `--spine-{bg,fg,hover-bg}`, `--plan-meta-hint-fg`                                                                                                                                                                                                                                                            |
| `artifact`           | The viewers for what an agent shows: image, file, page and document                                                         | `--artifact-meta-{fg,border-color}`, `--artifact-image-image`, `--artifact-browser-bg`, `--artifact-webview-bg`                                                                                                                                                                                                                                                                   |
| `mail`               | A terminal's threads with the other agents                                                                                  | `--mail-{border-color,meta-fg,sent-border-color,held-fg}`                                                                                                                                                                                                                                                                                                                         |
| `chat`               | A terminal's agent as a conversation: bubbles, prose and code, tool rows, requests, the composer                            | `--chat-{bg,fg,muted-fg}`, `--chat-user-{bg,fg,border-color,radius}`, `--chat-tool-{bg,border-color,hover-bg}`, `--chat-code-bg`                                                                                                                                                                                                                                                  |
| `prose`              | Plans and documents in the plan editor, its notes, tables and checkboxes                                                    | `--prose-{fg,heading-fg,code-bg,quote-fg}`, `--prose-changed-bg`, `--prose-note-{bg,fg}`, `--prose-table-border-color`                                                                                                                                                                                                                                                            |
| `syntax`             | `.tok-*` highlighting in files an agent shows                                                                               | read straight from the syntax tokens                                                                                                                                                                                                                                                                                                                                              |
| `settings`           | Preferences: its cards and rows, notes; `.choice-card`, shared with the welcome, whose cards are `.solid`                   | `--settings-description-fg`, `--settings-card-shadow`, `--choice-card-{bg,fg,border-color}`, `--choice-card-checked-{bg,fg,border-color,shadow}`, `--choice-card-solid-{bg,fg,hover-bg}`                                                                                                                                                                                          |
| `welcome`            | The welcome dialog, its start button and its miniature workspace                                                            | `--welcome-{intro-bg,pattern-fg,caret-bg,skip-fg}`, `--welcome-stage-{border-color,dots-fg}`; reads `--brand-tile-*`, `--window-*`, `--workspace-*`                                                                                                                                                                                                                               |
| `search`             | The terminal search dialog: result details, the empty state                                                                 | `--search-action-opacity`, `--search-empty-fg`                                                                                                                                                                                                                                                                                                                                    |

`shell/panels.css`, `layouts/transition.css` and the Canvas and Grid stylesheets place
and move what the recipes draw; they have no tokens of their own.

### Type scale

`theme/contract.css` holds one type scale, a size per role, in a `@theme static` block:
`--text-label` (section labels, counts, badges), `--text-caption` (metadata, hints, the
footer), `--text-control` (buttons, menus, tooltips), `--text-code` (code in panes),
`--text-body` (names, dialog and pane text), `--text-lead` (the page's own size, plans'
prose), `--text-heading` (dialog headings) and `--text-title` (a section's title). TSX
takes a step as `text-<role>` and a recipe as `var(--text-<role>)`, so the whole app's
type moves from one place. Miniatures (the welcome's stage, a peek's thumbnail), the
brand's wordmark and display text keep their own sizes. It is layout, not look, so it is
not a theme token: every theme shares it.

### Fonts

The app ships its fonts: Inter for the interface, the official build in
`assets/fonts/` declared in `theme/fonts.css` (Google Fonts' build drops the character
variants below), and JetBrains Mono from `@fontsource-variable/jetbrains-mono` for
terminals and code, both imported in `styles.css` into `layer(base)`. A theme with its
own face imports it at the top of its own file, `@import "<package>" layer(base);`, as
`theme/phosphor.css` does for Share Tech Mono; inside `layer(themes)` it nests as
`themes.base`, which is harmless, since `@font-face` ignores layers. A face loads only
once a theme uses it. The Content Security Policy loads
fonts only from the app itself, so they always ship as files: `vite.config.ts` never
inlines a font as a `data:` URL, and `build.test.ts` checks the built stylesheets.

A terminal measures its cells when its font changes, with whatever has loaded by then
(`backend/runner/screens.ts`). One opened before its font arrives measures again when it
does; on a theme change it keeps the font it has until the new theme's font has loaded,
then measures once, and a font that fails to load is taken all the same, so the family
falls back.

`theme/base.css` sets Inter's character variants on `body` (a tailed l, a serifed I, a
slashed 0) and tabular digits; they belong to that face, so a theme that changes
`--font-sans` should reconsider them. Ligatures stay off in terminals and code unless
the person turns them on in Preferences, which sets `data-ligatures="on"` on `<html>`;
`theme/base.css` lists the surfaces that count as code. A recipe that sets its type
should use the font longhands: the `font` shorthand resets the variants and features
these rules set.

## Hooks

A theme's rules may select:

- a recipe's classes: the component (`.button`, `.terminal-window`), its parts
  (`.terminal-heading`) and its variants (`.primary`, `.ghost`, `.compact`);
- state attributes the app or Ark UI sets: `data-state`, `data-selected`,
  `data-highlighted`, `data-disabled`, `data-focus-visible`, `aria-checked`,
  `aria-pressed`, `aria-current`, `aria-disabled`, `data-tone`, `data-terminal-phase`
  and the others each recipe lists;
- `data-theme` and `data-scheme` on `<html>` (each theme's own scope, see
  [Themes](#themes)), and `data-ligatures`, `on` while the person has turned ligatures on
  (see [Fonts](#fonts));
- layers free for a theme:
  - `body::before` and `body::after`, over the whole screen;
  - the workspace ground's `.workspace-background::after`, behind every window, and its
    `::before`, the recipe's grain, which a theme that sets `--canvas-grain-opacity` to 0
    may take over. A ground clips what overflows it and never scrolls, so these may
    extend past it; anything that scrolls inside a ground, such as the empty workspace's
    card, scrolls in its own inner wrapper;
  - the window's `::before`. The window is positioned, and its `::after` is the glass
    (`--window-glass-image`), which lies over everything the window holds, its chat,
    dictation strip, taskbar and a plan's menus included, at z-index 300 and lets clicks
    through; `::before` is a second, empty layer at that level, under the glass unless a
    theme lifts it. An ended window's hatch is drawn in the glass. A theme that clips the
    window with `clip-path` draws its ring and flash on `::after`, since the window's own
    outlines fall outside the clip or under its content;
- `.terminal-content`, the terminal's output, which a theme may filter.

A theme may also apply the SVG filters `index.html` carries, by id: Chromium applies
only filters in the page itself, so a theme file can't bring its own. `crt-barrel`
bulges an element like a tube's face, by the same pixels whatever its size; it moves
pixels without moving clicks, so apply it where a few pixels' error near the edge does
no harm. `theme/contract.test.ts` checks that every filter a theme uses is there.

Recipe classes and the attributes a recipe lists are public. Renaming one breaks every
theme that uses it, so rename it in the same change as the theme. Anything else in the
DOM may change without notice. CSS modules aren't used, because their class names
aren't stable.

Variants are classes (`.button.primary`); states are attributes. A component never
holds a state only in its class list or only in JS: if it can be on, checked, open or
selected, the DOM says so in an attribute.

## Contrast

For every scheme a theme defines, `--color-ink` and `--color-muted` reach 4.5:1 on
`--color-canvas`, `--color-shell`, `--color-paper` and `--color-soft`, and
`--color-line-strong` reaches 3:1 on them. Where a theme sets them,
`--item-highlighted-fg` on `--item-highlighted-bg`, `--segmented-active-fg` on
`--segmented-active-bg` and `--color-on-strong` on `--color-strong` reach 4.5:1.
`theme/contrast.test.ts` computes these from the token values and names the theme,
scheme and pair that falls short. A pair a theme misses is listed there with its ratio
and reason; none is listed today.

## Rules for components

- **TSX arranges; recipes draw.** A `className` in TSX may use Tailwind only for how
  elements are arranged: display, flex and grid, gap, margin, outer padding, position,
  inset, overflow, z-index, order, visibility, transforms, pointer and scroll
  behaviour, opacity of exactly 0 or 1, sizes that come from the layout rather than
  the component, and the size and flow of type (a step of the [type scale](#type-scale) such as `text-control`, line
  height, weight, alignment, wrapping and truncation). Everything a component looks
  like comes from its recipe: colour (every other `text-*`), background, borders
  (every `border*`: width, sides and colour), radius, shadow, ring, opacity between 0
  and 1, outline, fill, stroke, filters and backdrop filters, font family, letter
  spacing, text transform and decoration, motion (transitions, durations, easing,
  animations), and the component's own geometry, such as a control's height or a
  row's padding. `theme/contract.test.ts` checks every string in a class context, at
  any depth (a `className` or `…ClassName`, a `cn()` or `clsx()` call, `classList.add`,
  `toggle` or `replace`, `setAttribute("class", …)`, a constant or function named
  `…Class`, `…Classes` or `…ClassName`, and a lookup map or helper the context reads),
  and every `@apply`, against an allowlist of layout utilities; it can't tell a
  component's own geometry from layout, so that part is for review.
- **A recipe reads only tokens.** No hex, `rgb()` or named colours outside theme
  files; the contract test enforces it. Every `var()` a recipe reads either has a
  fallback or names a foundation token, a private value, or a variable Ark UI sets
  (such as `--transform-origin` or `--height`). System colours (`Canvas`, `CanvasText`,
  `Highlight`) are allowed in the accessibility layer. A recipe may mix tokens, as in
  `color-mix(in srgb, var(--color-ink) 4%, transparent)`.
- **One recipe per look.** When a second component needs a look that exists, it uses
  that recipe or adds a variant to it. Copying a look into another recipe forks the
  theme surface.
- **Recipes live beside their components** (`ui-toolkit/button.css`,
  `terminals/window.css`); `styles.css` imports each into `layer(components)`.
- **Draw absence, don't remove it.** A recipe with no visible border draws a
  transparent one, and an elevated surface keeps a transparent outline, so forced
  colours can show them. A selected item has an indicator, not only a fill.
- **JS reads tokens, never colours.** Code that needs a colour outside CSS, such as the
  xterm theme, resolves the token through a hidden probe element (`color:
var(--terminal-bg)` read back with `getComputedStyle`), because a token can hold
  `color-mix()`, and reads again on `novadeck:themechange`. `tokenColors` in
  `theme/probe.ts` does this.

## Exceptions

A few rules break the contract on purpose, each because it must beat a style no layer
can: one set inline, by the app or a library. `theme/contract.test.ts` keeps the same
list of `!important`s, pinned to the exact declarations, so a new one in a listed file
fails too, and fails when one is no longer needed.

- `theme/base.css` uses `!important` in the rule that stills every transition, inline
  ones too, while the scheme changes.
- `theme/accessibility.css` uses `!important` for reduced motion, to beat the
  transitions libraries set inline or inject with `!important`, such as dnd-kit's drag
  feedback.
- `backend/runner/runner.css` uses `!important` to thin xterm's scrollbar slider, whose
  position and width xterm sets inline.
- `theme/accessibility.css` may name system colours (`Canvas`, `Highlight`) for forced
  colours; no other stylesheet may.
- CodeMirror, the plan editor, injects its own styles as CSS-in-JS at run time, outside
  every layer, so no recipe can override them, and its base theme carries colours of its
  own. `terminals/companion/plan-editor/editor-theme.ts` overrides the ones the plan
  shows (the gutter, selection and caret) in an editor theme, which CodeMirror orders
  after its base theme, with token `var()`s and their fallbacks.

## Themes

A theme is one file in `theme/`, imported into `layer(themes)`, whose selectors all
start with its own scope. A theme sets its first scheme on that scope and each other
one on the scope plus `[data-scheme]`, with `color-scheme` and every required token in
each. Graphite is the default, so its scope also matches when no theme is set (the
`:where()` adds no specificity); every other theme matches only its own `data-theme`:

```css
:root:where(:not([data-theme]), [data-theme="graphite"]) {
  color-scheme: light;
  --color-paper: #f5f3ee;
  /* every required token */
}

:root:where(:not([data-theme]), [data-theme="graphite"])[data-scheme="dark"] {
  color-scheme: dark;
  --color-paper: #1d1f23;
  /* every required token again */
}

:root[data-theme="phosphor-green"] {
  color-scheme: dark;
  /* a theme with one scheme: just this block */
}
```

Themes that differ only in their palette may share a file. Its rules for all of them
start with their shared scope, `:root:is()` over each one's `data-theme`, and each
theme's own block holds what is its own; a token counts as set when either block sets
it. Phosphor's two tubes share `theme/phosphor.css` this way:

```css
:root:is([data-theme="phosphor-green"], [data-theme="phosphor-amber"]) {
  color-scheme: dark;
  /* what both tubes share, the CRT's effects included */
}

:root[data-theme="phosphor-amber"] {
  --color-paper: #0e0803;
  /* the rest of amber's palette */
}
```

Scoping keeps themes apart: a theme declares the component tokens it wants to change
and nothing else, so one that omits a token gets the recipe's own fallback, never
another theme's value. The recipes' [hooks](#hooks) and component tokens are the theme
author's surface.

A theme with two schemes shares its first block: what it declares holds in the second
too. An alias (`var()`) or an offset from the paper declared there need not be
repeated, since it resolves again against the other scheme's values; a literal colour
does, unless it truly holds in both schemes, and `theme/contract.test.ts` checks that
each one is restated or listed with its reason. The second block restates every
foundation token, as the contract requires, and only the component tokens whose value
differs.

After the tokens come any rules tokens can't express, each against a [hook](#hooks):

```css
.section-label {
  letter-spacing: normal;
  text-transform: none;
}
```

Prefer tokens. The `themes` layer beats every recipe whatever the specificity, so a
theme rule that sets a property on a component's resting selector also overrides its
hover, selected and disabled looks; a rule that sets properties restates each state it
needs. When many such rules pile up, the recipe is missing a token: add it to the
recipe instead, and every theme gains it.

`theme/themes.ts` lists the themes: an id, the name Preferences shows, the schemes it
defines, and its file, `theme/<id>.css` unless it names a shared one. The first is the
default, and the fallback for an unknown id. To add a theme:

1. Copy `theme/graphite.css` to `theme/<id>.css`, rename the scope and change the
   values; or, for another palette of an existing theme, add a block to its file and
   its id to the shared scope.
2. Import a new file in `styles.css` into `layer(themes)`, add `{ id, name, schemes }`
   (and `file` when shared) to `theme/themes.ts`. The boot script needs nothing: it
   takes the theme's schemes from the boot record, which the app writes from the
   manifest entry.
3. Run `pnpm --filter @novadeck/ui exec vitest run --project unit src/theme/`.

## Choosing a theme

Preferences holds `appearance: { theme, scheme }`, where `scheme` is `system`, `light`
or `dark`; it starts as Graphite following the system. The theme is a plain id
(lowercase letters, digits and hyphens), and reading a preference never swaps it for the
default: an id the app doesn't know right now, such as an imported theme whose registry
loads later, a theme from a newer version in another window, or a retired one, stays in
storage, and only drawing resolves it, to Graphite, in the page and in the picker. A
missing or malformed id is read as the default. Preferences shows a Theme list
from `theme/themes.ts` and a Mode choice (System, Light, Dark), disabled with a note
for a theme with one scheme. `theme/apply.ts` resolves the preference against the
system's scheme and the schemes the theme offers: a theme with one scheme always uses
it, whatever was chosen, while the chosen mode stays saved for the theme that has it.
An unknown theme, and a saved preference or boot record with no theme (older versions
saved only `{ scheme }`, or a theme since retired such as Sandstone), is Graphite, with
its mode kept. It then sets `data-theme` and `data-scheme` on `<html>` and dispatches
`novadeck:themechange`. `app/appearance.ts` is the one place that does this while the
app runs: whenever the preference changes, and whenever the system's scheme does.

- **Switching** sets `data-scheme-switching` on `<html>`, which stills transitions so
  the whole page changes at once instead of fading control by control. `apply.ts` reads
  a style right after, so the browser applies the new scheme while transitions are
  still, whatever started the change, and clears the attribute once a frame has drawn it.
- **Before the first paint**, `public/theme-boot.js` sets the same attributes. It is a
  plain script loaded in the head without `defer`, because the Content Security Policy
  allows same-origin scripts but not inline ones. `app/appearance.ts` saves a record
  under `novadeck.theme-boot` whenever the appearance changes:
  `{ v, theme, scheme, schemes, ground, groundScheme }`: the record's version (2), the
  shown theme's id, the person's mode, the schemes that theme defines, copied from its
  manifest entry, and, when the page could resolve it, the ground it paints first as
  `#rrggbb` (`<html>`'s own where the theme gives it an opaque one, as Phosphor's black,
  else `--color-paper`) with the scheme it was shown in. The script paints a valid
  ground (`/^#[0-9a-f]{6}$/i`, anything else ignored) as `<html>`'s inline
  `background-color` only when this start resolves to that same scheme, so a theme the
  stylesheets don't know yet still shows its ground and a start in another scheme never
  shows the old one; `apply.ts` removes it with the inline `color-scheme`. The ground is
  optional, so it needs no new version: bump `v` only when an existing field's meaning
  changes, and, while a record without a ground can name a theme since retired, when a
  theme is retired.
  The script holds no list of themes. It checks the record's shape (`v` 2, `theme` a
  lowercase id of letters, digits and hyphens, `scheme` a mode, `schemes` a non-empty
  list of `light` and `dark`), resolves `system` against `matchMedia`, and takes the
  theme's first scheme when the wanted one isn't in `schemes`. A record that is
  missing, corrupt or of another shape shows Graphite in the saved mode; that includes
  records older versions saved with the same fields for themes since retired, such as
  Sandstone, which is why the record carries its version. A well-formed id the app no
  longer has is painted as it is until the app starts and applies Graphite. Since the
  script needs only the record, a theme the manifest gains while the app runs, such as
  an imported one, boots like a built-in one: its attributes do, while its stylesheet
  loads with the app. The script also sets the scheme as `<html>`'s inline
  `color-scheme`, so the browser's own ground matches it before the stylesheets arrive;
  `apply.ts` removes that once the theme's file sets `color-scheme`.
- **Windows** stay in step: each listens for the `storage` event and takes up the
  preferences another window saved, theme included.
- **The desktop host** follows the page. On every change the page reports its scheme
  and its `--color-paper`, the ground `body` paints before anything draws on it, as
  `#rrggbb` through the preload bridge, so the window and the first paint are one
  colour. The host sets `nativeTheme.themeSource` so native menus and
  `prefers-color-scheme` agree, sets the window's background, and keeps that ground to
  open new windows on, so a dark theme never flashes white. While the page follows the
  system it reports `system`, not the scheme it resolved (a theme with one scheme
  reports its own, since it never follows): a fixed `themeSource` would hide the
  system's own scheme from `matchMedia`. For the same reason, a window pinned to a
  scheme that goes back to the system is released first: the page reports `system`,
  keeps what it shows, and shows the system's scheme once `matchMedia` reports it, or
  after `releaseMs` (200ms) when nothing changes (`app/appearance.ts`). The host
  accepts only `system`, `light` or `dark` and an opaque hex colour. In a browser
  there is no host, and nothing is reported.
