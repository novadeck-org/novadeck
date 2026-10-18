import { StateEffect, StateField, type EditorState } from "@codemirror/state"
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view"

// Stretches of the text, by offset.
export type Range = { readonly from: number; readonly to: number }

// A stretch the host has set a class on: every line it touches carries the class, and
// the viewer moves it along with the person's edits.
export type ClassedRange = Range & { readonly className: string }

// Replaces the classed ranges, as the host's latest content has them.
export const setRanges = StateEffect.define<readonly ClassedRange[]>()

const linesOf = (state: EditorState, ranges: readonly ClassedRange[]): DecorationSet => {
  const lines = new Map<string, Set<number>>()
  for (const { from, to, className } of ranges) {
    const first = state.doc.lineAt(Math.min(from, state.doc.length)).number
    const last = state.doc.lineAt(Math.min(Math.max(to - 1, from), state.doc.length)).number
    const numbers = lines.get(className) ?? new Set<number>()
    for (let number = first; number <= last; number++) numbers.add(number)
    lines.set(className, numbers)
  }
  return Decoration.set(
    [...lines].flatMap(([className, numbers]) =>
      [...numbers]
        .toSorted((a, b) => a - b)
        .map((number) => Decoration.line({ class: className }).range(state.doc.line(number).from)),
    ),
    true,
  )
}

const ranged = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (ranges, transaction) => {
    for (const effect of transaction.effects)
      if (effect.is(setRanges)) return linesOf(transaction.state, effect.value)
    return ranges.map(transaction.changes)
  },
  provide: (field) => EditorView.decorations.from(field),
})

export const rangedLines = ranged

// The classed lines as they stand, moved along with the edits made since they were set.
export const currentRanges = (state: EditorState): ClassedRange[] => {
  const ranges: ClassedRange[] = []
  const iterator = state.field(ranged).iter()
  for (; iterator.value; iterator.next()) {
    const { from, to } = state.doc.lineAt(iterator.from)
    ranges.push({ from, to, className: iterator.value.spec.class as string })
  }
  return ranges
}
