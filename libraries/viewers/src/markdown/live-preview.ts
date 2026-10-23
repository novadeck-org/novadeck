import { syntaxTree } from "@codemirror/language"
import { type Range } from "@codemirror/state"
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view"

import { rangedLines } from "./ranges.js"
import { tables } from "./table-widget.js"

// Markdown shown as a document and edited in place. Formatting marks show, dimmed, only on
// the lines being edited, where the text reads exactly as the file has it and typing
// Markdown is how the text gets formatted. Nothing here changes the text on its own.

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked
  }
  override toDOM(): HTMLElement {
    const box = document.createElement("span")
    box.className = "cm-md-checkbox"
    box.dataset.checked = String(this.checked)
    box.setAttribute("aria-hidden", "true")
    if (this.checked) {
      // A real tick, drawn as an icon.
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
      for (const [name, value] of Object.entries({
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "3.5",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      }))
        svg.setAttribute(name, value)
      const tick = document.createElementNS("http://www.w3.org/2000/svg", "path")
      tick.setAttribute("d", "M20 6 9 17l-5-5")
      svg.append(tick)
      box.append(svg)
    }
    return box
  }
  // Clicks reach the plugin, which flips the marker in the text.
  override ignoreEvent(): boolean {
    return false
  }
}

const hide = Decoration.replace({})
const line = (className: string) => Decoration.line({ class: className })
const mark = (className: string) => Decoration.mark({ class: className })

// The lines the cursor or selection is on, where syntax shows as written.
const activeLines = (view: EditorView): Set<number> => {
  const lines = new Set<number>()
  for (const range of view.state.selection.ranges) {
    const first = view.state.doc.lineAt(range.from).number
    const last = view.state.doc.lineAt(range.to).number
    for (let number = first; number <= last; number++) lines.add(number)
  }
  return lines
}

type Rendered = { decorations: DecorationSet; atomic: DecorationSet }

const decorate = (view: EditorView): Rendered => {
  const { doc } = view.state
  const active = activeLines(view)
  const editing = (from: number): boolean => view.hasFocus && active.has(doc.lineAt(from).number)
  const ranges: Range<Decoration>[] = []
  // Ranges the cursor steps over whole, and Backspace removes whole.
  const atomic: Range<Decoration>[] = []
  const eachLine = (from: number, to: number, decoration: Decoration): void => {
    for (let at = doc.lineAt(from); ; at = doc.line(at.number + 1)) {
      ranges.push(decoration.range(at.from))
      if (at.to >= to || at.number === doc.lines) break
    }
  }
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const { name } = node
        const heading = /^ATXHeading(\d)$/.exec(name)
        if (heading) ranges.push(line(`cm-md-h${heading[1]}`).range(doc.lineAt(node.from).from))
        else if (name === "HeaderMark") {
          // Shown only on the line being edited, where changing them changes the heading.
          // They hang left of the heading, so its text stays put. Elsewhere they're hidden
          // with the space after them, and the cursor steps over them whole.
          const end = Math.min(node.to + 1, doc.lineAt(node.from).to)
          if (editing(node.from))
            ranges.push(mark("cm-md-syntax cm-md-hashes").range(node.from, end))
          else {
            ranges.push(hide.range(node.from, end))
            atomic.push(hide.range(node.from, end))
          }
        } else if (name === "Blockquote") {
          const nested = (kind: string): boolean => {
            for (let up = node.node.parent; up; up = up.parent) if (up.name === kind) return true
            return false
          }
          // In a list, the quote's rows start after its bar, so the indent that nests it
          // is hidden, except on the line being edited.
          const listed = nested("ListItem")
          eachLine(
            node.from,
            node.to,
            line(listed ? "cm-md-quote cm-md-quote-listed" : "cm-md-quote"),
          )
          if (listed && !nested("Blockquote"))
            for (let at = doc.lineAt(node.from); ; at = doc.line(at.number + 1)) {
              const indent = /^\s*/.exec(at.text)![0].length
              if (indent > 0 && !editing(at.from))
                ranges.push(hide.range(at.from, at.from + indent))
              if (at.to >= node.to || at.number === doc.lines) break
            }
        } else if (name === "FencedCode") {
          eachLine(node.from, node.to, line("cm-md-codeblock"))
          if (!editing(node.from))
            ranges.push(line("cm-md-fence").range(doc.lineAt(node.from).from))
          if (!editing(node.to)) ranges.push(line("cm-md-fence").range(doc.lineAt(node.to).from))
          return false
        } else if (name === "Table") return false
        else if (name === "StrongEmphasis")
          ranges.push(mark("cm-md-strong").range(node.from, node.to))
        else if (name === "Emphasis") ranges.push(mark("cm-md-em").range(node.from, node.to))
        else if (name === "InlineCode") {
          const code = doc.sliceString(node.from, node.to)
          ranges.push(
            mark(/[/.]\w/.test(code) ? "cm-md-code cm-md-path" : "cm-md-code").range(
              node.from,
              node.to,
            ),
          )
        } else if (name === "ListItem") {
          // Wrapped item text hangs under the item's text, not its marker.
          const task = /^\s*(?:\d+[.)]|[-*+])\s+\[[ xX]\]/.test(doc.lineAt(node.from).text)
          eachLine(node.from, node.to, line(task ? "cm-md-item cm-md-item-task" : "cm-md-item"))
        } else if (name === "ListMark")
          ranges.push(mark("cm-md-listmark").range(node.from, node.to))
        else if (name === "TaskMarker") {
          const done = /x/i.test(doc.sliceString(node.from, node.to))
          // A done task recedes, so what's left stands out.
          if (done) eachLine(node.from, node.node.parent?.to ?? node.to, line("cm-md-task-done"))
          ranges.push(
            editing(node.from)
              ? mark("cm-md-syntax").range(node.from, node.to)
              : Decoration.replace({
                  widget: new CheckboxWidget(done),
                }).range(node.from, node.to),
          )
        } else if (
          (name === "QuoteMark" || name === "EmphasisMark" || name === "CodeMark") &&
          node.node.parent?.name !== "FencedCode"
        ) {
          // Formatting marks: dimmed on the line being edited, where typing them formats
          // the text, and hidden elsewhere, taking a quote mark's space with it.
          const end =
            name === "QuoteMark" ? Math.min(node.to + 1, doc.lineAt(node.from).to) : node.to
          ranges.push(
            editing(node.from)
              ? mark("cm-md-syntax").range(node.from, node.to)
              : hide.range(node.from, end),
          )
        }
        return undefined
      },
    })
  }
  return { decorations: Decoration.set(ranges, true), atomic: Decoration.set(atomic, true) }
}

const preview = ViewPlugin.fromClass(
  class {
    rendered: Rendered
    constructor(view: EditorView) {
      this.rendered = decorate(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged)
        this.rendered = decorate(update.view)
    }
  },
  {
    decorations: (plugin) => plugin.rendered.decorations,
    eventHandlers: {
      // A checkbox flips its marker in the text, as typing would.
      mousedown: (event, view) => {
        const target = event.target as HTMLElement
        if (!target.classList.contains("cm-md-checkbox")) return false
        const at = view.posAtDOM(target)
        const marker = view.state.doc.sliceString(at, at + 3)
        if (!/^\[[ xX]\]$/.test(marker)) return false
        view.dispatch({
          changes: { from: at + 1, to: at + 2, insert: marker[1] === " " ? "x" : " " },
        })
        return true
      },
    },
  },
)

export const livePreview = [
  preview,
  tables,
  rangedLines,
  EditorView.atomicRanges.of((view) => view.plugin(preview)?.rendered.atomic ?? Decoration.none),
]
