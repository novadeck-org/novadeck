import "./path-field.css"
import type { FolderMatch, WroteFolder } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import { Folder, PenLine } from "lucide-react"
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"

import type { ItemStore } from "../../store/item-store"
import { answersText, completion, suggestionGroups, targetOf, type Suggestion } from "./path-field"

// How long typing pauses before the runner is asked which folders the text may be.
const askAfterMs = 120

const none: readonly FolderMatch[] = []

// Why a path couldn't be opened, as a sentence: the runner's own reason where it gave one.
const reasonOf = (error: unknown, path: string): string =>
  error instanceof Error && error.message.trim() !== ""
    ? error.message
    : `Novadeck couldn't open ${path}.`

// The first line of a folder's pane while the person types where to go: a text field holding the
// folder's path, selected, with suggestions under it that move with the arrow keys, complete with
// Tab and open with Enter, as the typed path does, in a new folder tab on the terminal's bar. It
// ends by `close(true)` once something opened or Escape was pressed (the pane's focus goes back to
// its body), and by `close(false)` as focus leaves it.
export const PathField = ({
  itemStore,
  target,
  terminal,
  initial,
  now,
  close,
}: {
  readonly itemStore: ItemStore
  readonly target: WorkspaceTarget
  readonly terminal: string | undefined
  readonly initial: string
  readonly now: number
  readonly close: (refocus: boolean) => void
}): React.JSX.Element => {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(initial)
  // Until the person changes the text it is the folder's own path, which names no folder to find.
  const [edited, setEdited] = useState(false)
  const [answered, setAnswered] = useState<readonly FolderMatch[]>([])
  const [wrote, setWrote] = useState<readonly WroteFolder[]>([])
  const [highlighted, setHighlighted] = useState(-1)
  const [problem, setProblem] = useState<string>()
  const [opening, setOpening] = useState(false)
  // Where the caret goes once a completion is written, which the field takes after it renders.
  const [completed, setCompleted] = useState(0)
  const mounted = useRef(true)

  // The session's items are read once, as the field opens, and made again as the clock moves on.
  const items = useMemo(() => itemStore.sessionItems(target), [itemStore, target])
  const { folders, wroteTo } = itemStore

  useEffect(() => {
    mounted.current = true
    input.current?.focus()
    input.current?.select()
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!terminal || !wroteTo) return
    let live = true
    wroteTo(target, terminal).then(
      (found) => live && setWrote(found),
      () => {},
    )
    return () => {
      live = false
    }
  }, [wroteTo, target, terminal])
  useEffect(() => {
    if (!edited || !terminal || !folders) return
    let live = true
    const timer = setTimeout(
      () =>
        void folders(target, terminal, text).then(
          (found) => live && setAnswered(found),
          () => live && setAnswered([]),
        ),
      askAfterMs,
    )
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [folders, target, terminal, text, edited])
  useLayoutEffect(() => {
    if (completed === 0) return
    const field = input.current
    field?.setSelectionRange(field.value.length, field.value.length)
  }, [completed])

  // The folders the text may be are those of the latest answer, once the text was changed.
  // An answer to the text before the last keystroke is held back where it no longer fits, so a
  // quick Tab or Enter never takes a folder of an earlier prefix.
  const matches = useMemo(
    () => (edited ? answered.filter((match) => answersText(match.path, text)) : none),
    [edited, answered, text],
  )
  const groups = useMemo(
    () => suggestionGroups({ matches, items, wrote, now }),
    [matches, items, wrote, now],
  )
  const flat = groups.flatMap((group) => group.suggestions)
  const active = highlighted >= 0 && highlighted < flat.length ? highlighted : -1
  const optionId = (index: number): string => `${id}-${index}`

  const open = (path: string): void => {
    const wanted = targetOf(path)
    if (wanted === "" || opening) return
    if (!terminal) return setProblem("This pane has no terminal to open a folder beside.")
    setOpening(true)
    setProblem(undefined)
    itemStore.attach(target, terminal, wanted).then(
      () => mounted.current && close(true),
      (error: unknown) => {
        if (!mounted.current) return
        setOpening(false)
        setProblem(reasonOf(error, wanted))
      },
    )
  }
  const complete = (suggestion: Suggestion): void => {
    setText(completion(suggestion.path))
    setEdited(true)
    setHighlighted(-1)
    setProblem(undefined)
    setCompleted((count) => count + 1)
  }
  const move = (step: number): void =>
    setHighlighted(
      active === -1
        ? step > 0
          ? 0
          : flat.length - 1
        : (active + step + flat.length) % flat.length,
    )

  // Where each group's suggestions start among all, which the keyboard moves through.
  const starts = groups.map((_group, at) =>
    groups.slice(0, at).reduce((sum, each) => sum + each.suggestions.length, 0),
  )
  return (
    <div
      className="folder-field"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close(false)
      }}
    >
      <input
        ref={input}
        className="folder-field-input"
        role="combobox"
        aria-label="Folder path"
        aria-autocomplete="list"
        aria-expanded={flat.length > 0}
        aria-controls={`${id}-list`}
        aria-activedescendant={active === -1 ? undefined : optionId(active)}
        aria-invalid={problem !== undefined || undefined}
        aria-describedby={
          problem !== undefined ? `${id}-problem` : matches.length > 0 ? `${id}-hint` : undefined
        }
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          setEdited(true)
          setHighlighted(-1)
          setProblem(undefined)
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
          if (event.key === "Escape") {
            // Only the field closes: the pane's own Escape, which hides the pane, is not this one.
            event.preventDefault()
            event.stopPropagation()
            close(true)
          } else if (event.key === "Enter" && plain) {
            event.preventDefault()
            open(active === -1 ? text : flat[active]!.path)
          } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && plain) {
            event.preventDefault()
            if (flat.length > 0) move(event.key === "ArrowDown" ? 1 : -1)
          } else if (
            event.key === "Tab" &&
            edited &&
            text.trim() !== "" &&
            !event.shiftKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey
          ) {
            // With text the person typed in the field, Tab never leaves it, which would end the
            // field and lose the text: the highlighted suggestion, else the first folder the
            // text may be, completes into it, and with none yet (the runner has not answered)
            // nothing happens. Over the folder's own path, as it opened, over nothing, and with
            // Shift, Tab goes on as it does, ending the field.
            event.preventDefault()
            const chosen = active === -1 ? matches[0] && flat[0] : flat[active]
            if (chosen) complete(chosen)
          } else if (event.key.toLowerCase() === "l" && (event.ctrlKey || event.metaKey)) {
            // The shortcut that opened the field, used again, selects the path.
            event.preventDefault()
            event.currentTarget.select()
          }
        }}
      />
      <div className="folder-field-drop">
        {problem !== undefined && (
          <div
            id={`${id}-problem`}
            className="pane-notice folder-field-problem"
            data-tone="danger"
            role="alert"
          >
            <p>{problem}</p>
          </div>
        )}
        {flat.length > 0 && (
          <div
            id={`${id}-list`}
            className="folder-field-list floating"
            role="listbox"
            aria-label="Folders"
            // The list takes no focus from the field, so a click on it doesn't end the field.
            onMouseDown={(event) => event.preventDefault()}
          >
            {groups.map((group, groupAt) => (
              <div
                key={group.id}
                className="folder-field-group"
                role="group"
                aria-label={group.label ?? "Matching folders"}
              >
                {group.label !== undefined && (
                  <div className="folder-field-label" aria-hidden="true">
                    {group.label}
                  </div>
                )}
                {group.suggestions.map((suggestion, within) => {
                  const at = starts[groupAt]! + within
                  const Icon = suggestion.icon === "pen" ? PenLine : Folder
                  return (
                    <div
                      key={`${group.id}:${suggestion.path}`}
                      id={optionId(at)}
                      className="item folder-field-option"
                      role="option"
                      aria-selected={at === active}
                      data-highlighted={at === active ? "" : undefined}
                      onClick={() => open(suggestion.path)}
                      onPointerMove={() => at !== active && setHighlighted(at)}
                    >
                      <Icon size={14} strokeWidth={1.75} aria-hidden />
                      <code>{suggestion.path}</code>
                      <small className="item-detail">{suggestion.meta}</small>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}
        {matches.length > 0 && (
          <p id={`${id}-hint`} className="folder-field-hint floating">
            <kbd>Tab</kbd> completes
          </p>
        )}
      </div>
    </div>
  )
}
