// The runner's functions and methods, found by indentation, so a call can be followed a
// hop or two into the code it reaches.

export type Unit = {
  name: string
  // The class it is a method of, when it is one.
  owner: string | null
  prop: boolean
  file: string
  line: number
  body: string
  offset: number
}

// The class methods (two-space indent) and top-level functions of a file, with bodies.
export const unitsIn = (file: string, source: string): Unit[] => {
  const lines = source.split("\n")
  const units: Unit[] = []
  let offset = 0
  const offsets = lines.map((text) => {
    const at = offset
    offset += text.length + 1
    return at
  })
  let owner: string | null = null
  lines.forEach((text, index) => {
    const declared = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/.exec(text)
    if (declared) owner = declared[1]!
    else if (text.startsWith("}")) owner = null
    const method =
      /^ {2}(?:(?:async|private|public|static|protected|get|set|readonly)\s+)*\*?(\w+)\s*(?:<[^>]*>)?\(/.exec(
        text,
      ) ??
      /^ {2}(?:(?:private|public|protected|readonly)\s+)*(\w+)\s*=\s*(?:async\s*)?[(<]/.exec(text)
    const fn = /^(?:export\s+)?(?:async\s+)?function\*?\s+(\w+)/.exec(text)
    const prop = /^( {4,8})(\w+): (?:async )?\(/.exec(text)
    const name = method?.[1] ?? fn?.[1] ?? prop?.[2]
    if (!name || ["if", "for", "while", "switch", "catch", "constructor"].includes(name)) return
    const closes = method ? ["  }"] : prop ? [`${prop[1]}},`, `${prop[1]}}`] : ["}"]
    let end = index
    // A method written on one line ends there; otherwise at its closing brace.
    const oneLine =
      text.trimEnd().endsWith("}") &&
      text.split("{").length === text.split("}").length &&
      text.includes("{")
    if (!oneLine) while (end < lines.length && !closes.includes(lines[end]!)) end += 1
    units.push({
      name,
      owner: method ? owner : null,
      prop: Boolean(prop && !method && !fn),
      file,
      line: index + 1,
      body: lines.slice(index, end + 1).join("\n"),
      offset: offsets[index]!,
    })
  })
  // Methods and functions first, so a lookup by name finds them before an object's property.
  return units.toSorted((a, b) => Number(a.prop) - Number(b.prop))
}
