/**
 * Where a prompt's images stand among its words (`agents.prompt`'s `at`): the prompt's text
 * cut into one run of words before each image and one after the last, for the pastes of a
 * prompt whose images are among its words. Pure, so every case is a unit test.
 */

/** Whether `at` is one offset into `text` per image, none before the one ahead of it. */
export const placesFit = (text: string, images: number, at: readonly number[]): boolean =>
  at.length === images &&
  at.every(
    (offset, index) =>
      Number.isInteger(offset) &&
      offset >= (index === 0 ? 0 : at[index - 1]!) &&
      offset <= text.length,
  )

/** Whether any image stands past the start of the text: the others lead it, as before places. */
export const isPlaced = (at: readonly number[] | undefined): at is readonly number[] =>
  at !== undefined && at.some((offset) => offset > 0)

/**
 * The text's runs of words, `at.length + 1` of them: the first before the first image, the last
 * after the last one; each as the box takes it (line breaks as line feeds), and the text's edges
 * trimmed, white space left at the start of a run that the trim took whole going on into the next.
 * An offset between a CR and its LF moves past the LF, as the two are one line break.
 */
export const placedWords = (text: string, at: readonly number[]): readonly string[] => {
  const cuts = at.map((offset) =>
    text[offset - 1] === "\r" && text[offset] === "\n" ? offset + 1 : offset,
  )
  const runs: string[] = []
  let from = 0
  for (const cut of cuts) {
    runs.push(text.slice(from, cut))
    from = cut
  }
  runs.push(text.slice(from))
  const words = runs.map((run) => run.replace(/\r\n?/g, "\n"))
  for (let index = 0; index < words.length; index += 1) {
    words[index] = words[index]!.trimStart()
    if (words[index] !== "") break
  }
  for (let index = words.length - 1; index >= 0; index -= 1) {
    words[index] = words[index]!.trimEnd()
    if (words[index] !== "") break
  }
  return words
}
