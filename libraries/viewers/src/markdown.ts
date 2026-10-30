import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { Language, LanguageSupport, defineLanguageFacet } from "@codemirror/language"
import {
  Annotation,
  Compartment,
  EditorState,
  MapMode,
  Transaction,
  type Extension,
} from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { GFM, parser } from "@lezer/markdown"

import type { Mount, Target, Viewer, ViewerState } from "./index.js"
import { livePreview } from "./markdown/live-preview.js"
import { currentRanges, setRanges, type ClassedRange } from "./markdown/ranges.js"
import {
  followScroll,
  restoreScroll,
  scrollLineToTop,
  type Scroll,
  type ScrollRestore,
} from "./markdown/scroll.js"
import { lineChanges } from "./markdown/sync.js"
import { theme } from "./markdown/theme.js"

export { rowAnnotations, type RowAnnotations } from "./markdown/annotations.js"
export type { ClassedRange, Range } from "./markdown/ranges.js"
export { findTables, type Table } from "./markdown/tables.js"

// Markdown shown as a formatted document, and edited in place: formatting marks show only
// on the lines being edited, tables edit cell by cell, and task lists tick. External changes
// to the text apply as a minimal line diff, outside undo history, with the cursor kept. Its
// looks are markdown.css's. It doesn't scroll itself: the nearest ancestor that does is
// its scroller, which it follows and restores.

export type MarkdownContent = {
  readonly text: string
  /**
   * Lines to carry a class, set along with the text: the viewer moves them along with the
   * person's edits, and reports them back through `onEdit`. A change of text replaces
   * them; ranges alone, with the text it already has, don't.
   */
  readonly ranges?: readonly ClassedRange[]
}

export type MarkdownOptions = {
  /** Whether the person can edit. A live viewer switches it through `editable()`. */
  readonly editable: boolean
  /**
   * The person's edits, never `update()`'s: the whole text, and the ranges as they stand
   * after the edit.
   */
  readonly onEdit?: (text: string, ranges: readonly ClassedRange[]) => void
  /**
   * More behaviour for the editor, which a restored state takes too. A saved state holds
   * the ones it was last given until the next viewer sets its own, so they shouldn't hold
   * what the app can't let go of.
   */
  readonly extensions?: readonly Extension[]
}

export type MarkdownViewer = Viewer<MarkdownContent> & {
  /** Lets the person edit, or not, on the live viewer: its history and place stay. */
  readonly editable: (on: boolean) => void
}

// Markdown with GitHub's tables and task lists, and nothing embedded: HTML, CSS and
// JavaScript highlighting would triple the editor's size.
const markdown = new LanguageSupport(
  new Language(defineLanguageFacet(), parser.configure(GFM), [], "markdown"),
)

// Marks changes that came in through `update()`, which are not the person's edits.
const fromUpdate = Annotation.define<boolean>()

// What changes with a mount rather than with the state: whether it takes edits, its name
// and the app's own extensions. A saved state outlives the viewer that made it, so these
// are set again when it's opened.
const live = new Compartment()

// What follows an editor: its app's listener, and where its scroller is scrolled in the
// text, moved along with every change to it. Kept apart from the state, which outlives the
// viewer that made it, so a saved state holds none of a viewer's closures: its extensions
// reach these through the view showing it now.
type Followers = {
  readonly onEdit: MarkdownOptions["onEdit"]
  scroll: Scroll | null
  restoring: ScrollRestore | null
}
const followersOf = new WeakMap<EditorView, Followers>()

const base: Extension = [
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  markdown,
  EditorView.lineWrapping,
  // Read-only holds for every change, not only typing: an app's keys, checkboxes and the
  // table's own edits dispatch directly. Only `update()`'s changes land.
  EditorState.transactionFilter.of((transaction) =>
    transaction.docChanged && transaction.startState.readOnly && !transaction.annotation(fromUpdate)
      ? []
      : transaction,
  ),
  livePreview,
  theme,
  EditorView.updateListener.of((update) => {
    const followers = followersOf.get(update.view)
    if (!followers) return
    if (update.geometryChanged) followers.restoring?.layout()
    if (!update.docChanged) return
    const { scroll } = followers
    // Inserted right above, the line stays; rewritten, the place is where the rewrite starts.
    if (scroll)
      followers.scroll = {
        ...scroll,
        at:
          update.changes.mapPos(scroll.at, 1, MapMode.TrackDel) ??
          update.changes.mapPos(scroll.at, -1),
      }
    if (
      update.transactions.some(
        (transaction) => transaction.docChanged && !transaction.annotation(fromUpdate),
      )
    )
      followers.onEdit?.(update.state.doc.toString(), currentRanges(update.state))
  }),
]

// What the viewer holds of where it was: the parsed text with its undo history and
// selection, and where its scroller was scrolled.
type MarkdownState = {
  readonly markdown: { readonly state: EditorState; readonly scroll: Scroll | null }
}

const isMarkdownState = (state: unknown): state is MarkdownState & ViewerState =>
  (state as Partial<MarkdownState> | null)?.markdown?.state instanceof EditorState

const nothing = (): void => {}

export const mountMarkdown: Mount<MarkdownContent, MarkdownOptions, MarkdownViewer> = (
  element,
  { content, label, saved, editable, onEdit, extensions = [] },
) => {
  const root = element.ownerDocument.createElement("div")
  root.className = "md-viewer"
  element.append(root)

  const followers: Followers = { onEdit, scroll: null, restoring: null }
  let stopFollowing = nothing
  let stopRestore = nothing
  let closing = false
  let taking = editable

  const perMount = (): Extension => [
    EditorState.readOnly.of(!taking),
    EditorView.contentAttributes.of({ "aria-label": label }),
    ...extensions,
  ]

  const first = isMarkdownState(saved) ? saved.markdown : undefined
  const view = new EditorView({
    parent: root,
    state:
      first?.state ??
      EditorState.create({ doc: content.text, extensions: [base, live.of(perMount())] }),
  })

  followersOf.set(view, followers)

  // The text as the app has it now, applied as an outside change: not the person's to
  // undo, since undoing it would only write the old text back.
  const sync = (next: MarkdownContent): void => {
    const doc = view.state.doc.toString()
    if (doc === next.text) return
    view.dispatch({
      changes: lineChanges(doc, next.text),
      effects: setRanges.of(next.ranges ?? []),
      annotations: [fromUpdate.of(true), Transaction.addToHistory.of(false)],
    })
  }

  // Follows the scroller, after restoring its place if there is one to restore.
  const begin = (from: MarkdownState["markdown"] | undefined): void => {
    stopRestore()
    stopFollowing()
    followers.restoring = null
    followers.scroll = from?.scroll ?? null
    // A state saved by another viewer takes this one's behaviour.
    if (from) view.dispatch({ effects: live.reconfigure(perMount()) })
    // Where the scroller is scrolled counts once it's back where it was left.
    const follow = (): void => {
      // A restore ended by closing leaves the place it was restoring to.
      if (closing) return
      stopFollowing = followScroll(view, (at) => {
        followers.scroll = at
      })
    }
    if (followers.scroll) {
      followers.restoring = restoreScroll(view, () => followers.scroll, follow)
      stopRestore = followers.restoring.stop
    } else {
      stopRestore = nothing
      follow()
    }
  }
  // A state opened for this content takes its ranges, then any text it has since changed.
  if (first) begin(first)
  view.dispatch({ effects: setRanges.of(content.ranges ?? []) })
  sync(content)
  if (!first) begin(undefined)

  return {
    update: sync,
    state: () =>
      ({
        markdown: { state: view.state, scroll: followers.scroll },
      }) satisfies MarkdownState as unknown as ViewerState,
    // Takes the saved history, selection and place, and keeps the content the viewer has:
    // what differs applies as an outside change, as `update()`'s does, so the app hears
    // nothing and nothing it changed meanwhile is lost.
    restore: (state) => {
      if (!isMarkdownState(state)) return
      const text = view.state.doc.toString()
      const ranges = currentRanges(view.state)
      view.setState(state.markdown.state)
      begin(state.markdown)
      view.dispatch({ effects: setRanges.of(ranges) })
      sync({ text, ranges })
    },
    // A jump wins over a restore still under way.
    jumpTo: (target: Target) => {
      stopRestore()
      const { doc } = view.state
      scrollLineToTop(
        view,
        "offset" in target
          ? Math.min(Math.max(target.offset, 0), doc.length)
          : doc.line(Math.min(Math.max(target.line, 1), doc.lines)).from,
      )
    },
    focus: () => view.focus(),
    editable: (on) => {
      if (on === taking) return
      taking = on
      view.dispatch({ effects: live.reconfigure(perMount()) })
    },
    destroy: () => {
      closing = true
      stopRestore()
      stopFollowing()
      view.destroy()
      root.remove()
    },
  }
}
