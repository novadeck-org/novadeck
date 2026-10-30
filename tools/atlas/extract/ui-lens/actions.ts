import { stateFile, type UiScan } from "./scan.ts"

// The workspace actions: the types `WorkspaceAction` declares and the reducer's cases.

export type ActionTypes = {
  // Each action type with the line that declares it.
  declared: Map<string, number>
  known: Set<string>
  // Each action type with the line of its reducer case.
  caseLines: Map<string, number>
  // The reducer's code for one action type.
  reducerText: (type: string) => string
}

export const readActionTypes = ({ anchors, source }: UiScan): ActionTypes => {
  const stateLines = source(stateFile)?.lines ?? []
  const unionStart = stateLines.findIndex((line) =>
    line.startsWith("export type WorkspaceAction ="),
  )
  if (unionStart === -1)
    anchors.report("ui actions", stateFile, 'expected "export type WorkspaceAction ="')
  const unionEnd = stateLines.findIndex(
    (line, i) => i > unionStart && /^export (const|type) /.test(line),
  )
  const declared = new Map<string, number>()
  for (let i = unionStart; i >= 0 && i < unionEnd; i++) {
    for (const match of stateLines[i]!.matchAll(/\btype:\s*"([a-z]+\/[a-z-]+)"/g))
      if (!declared.has(match[1]!)) declared.set(match[1]!, i + 1)
  }
  if (unionStart !== -1 && declared.size === 0)
    anchors.report("ui actions", stateFile, "found 0 actions in `WorkspaceAction`")

  const reducerStart = stateLines.findIndex((line) =>
    line.startsWith("export const workspaceReducer"),
  )
  const caseLines = new Map<string, number>()
  for (let i = reducerStart; i >= 0 && i < stateLines.length; i++) {
    const match = /^ {4}case "([a-z]+\/[a-z-]+)":/.exec(stateLines[i]!)
    if (match && !caseLines.has(match[1]!)) caseLines.set(match[1]!, i + 1)
  }
  if (reducerStart === -1)
    anchors.report("ui reducer", stateFile, 'expected "export const workspaceReducer"')
  else if (caseLines.size === 0)
    anchors.report("ui reducer", stateFile, "found 0 `case` lines in `workspaceReducer`")
  const reducerText = (type: string): string => {
    const line = caseLines.get(type)
    if (!line) return ""
    let end = line
    while (end < stateLines.length && !/^ {4}(case "|default:)|^ {2}\}/.test(stateLines[end]!))
      end++
    return stateLines.slice(line - 1, end).join("\n")
  }
  return { declared, known: new Set(declared.keys()), caseLines, reducerText }
}
