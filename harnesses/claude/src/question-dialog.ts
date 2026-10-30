import type {
  AnswerableDialog,
  DialogRead,
  KeyStep,
  RequestFacts,
} from "@novadeck/harness-core/dialogs"
import type { RequestAnswer } from "@novadeck/protocol"

import {
  digit,
  Down,
  editorHint,
  Enter,
  fieldsOf,
  flat,
  idle,
  landed,
  marked,
  nonBlank,
  Right,
  rule,
  settled,
  timeoutMs,
  typeable,
  Up,
} from "./dialog-screen.js"

/**
 * Claude Code's AskUserQuestion dialog: one question at a time, each a tab once there are
 * several. A digit selects its option and, with several questions, moves to the next one;
 * a multi-select's digits tick and Right moves on; after the last question a review screen
 * takes `1` to submit. "Type something" is the option after the last, whose digit focuses
 * a field that takes the text and Enter once the screen shows it focused. With any option
 * previewed, digits only move the highlight: arrows and Enter.
 */

type Ask = {
  readonly question: string
  readonly header: string
  readonly multiSelect: boolean
  readonly options: readonly {
    readonly label: string
    readonly description: string
    readonly preview: boolean
  }[]
}

/** The questions AskUserQuestion's input asks, when it is one this reads. */
const asks = (input: unknown): Ask[] | undefined => {
  const questions = fieldsOf(input)?.questions
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 8) return undefined
  const read: Ask[] = []
  for (const each of questions as unknown[]) {
    const fields = fieldsOf(each)
    const question = nonBlank(fields?.question)
    const header = nonBlank(fields?.header)
    const options = fields?.options
    if (!fields || !question || !header || !Array.isArray(options)) return undefined
    if (options.length < 1 || options.length > 16) return undefined
    if (fields.multiSelect !== undefined && typeof fields.multiSelect !== "boolean") {
      return undefined
    }
    const listed: Ask["options"][number][] = []
    for (const option of options as unknown[]) {
      const choice = fieldsOf(option)
      const label = nonBlank(choice?.label)
      if (!choice || !label) return undefined
      const { description = "" } = choice
      if (typeof description !== "string") return undefined
      listed.push({ label, description, preview: nonBlank(choice.preview) !== undefined })
    }
    read.push({ question, header, multiSelect: fields.multiSelect === true, options: listed })
  }
  return read
}

const questionFooter = /^Enter to select · (?:↑\/↓|Tab\/Arrow keys) to navigate/
const tabBar = /^←\s+(.+?)\s+✔ Submit\s+→$/
const tabs = /([☐☒]) (.+?)(?=  [☐☒] |$)/g
const loneHeader = /^ ☐ .+$/
const questionOption = /^(❯| ) (\d+)\. (.+)$/
const review = "Ready to submit your answers?"

const footerAt = (rows: readonly string[]): number =>
  rows.findLastIndex((each) => questionFooter.test(each))

/** A question screen's parts, by row: its tab bar or lone header, first option and footer. */
type QuestionScreen = {
  readonly first: number
  readonly footer: number
  /** Whether its header is a tab bar, as several questions or a multi-select have. */
  readonly bar: boolean
  /** Each tab's header, and whether it is still open (`☐`) rather than answered (`☒`). */
  readonly tabs: readonly { readonly open: boolean; readonly name: string }[]
  /** The rows between the header and the first option, without their quote bar. */
  readonly question: readonly string[]
}

/** The question a screen shows; undefined where the screen is no question's. */
const questionScreen = (rows: readonly string[]): QuestionScreen | undefined => {
  const footer = footerAt(rows)
  if (footer < 0) return undefined
  const first = rows.slice(0, footer).findLastIndex((each) => /^(❯| ) 1\. /.test(each))
  if (first < 1) return undefined
  for (let at = first - 1; at >= 0 && first - at <= 12; at--) {
    const row = rows[at]!
    if (rule.test(row)) return undefined
    const bar = tabBar.exec(row)
    if (!bar && !loneHeader.test(row)) continue
    return {
      first,
      footer,
      bar: bar !== null,
      tabs: bar
        ? [...bar[1]!.matchAll(tabs)].map((each) => ({ open: each[1] === "☐", name: each[2]! }))
        : [{ open: true, name: row.slice(3) }],
      question: rows
        .slice(at + 1, first)
        .filter((each) => each !== "")
        .map((each) => each.replace(/^│ ?/, "")),
    }
  }
  return undefined
}

/** Where a question stands in its dialog: alone, the last of several, or before others. */
type Place = { readonly asked: number; readonly final: boolean }

// Whether a question screen is `ask`'s own: its question is all that stands above its
// options, its header is among the tabs, and its options are its own, read as the first
// question's are.
const showing = (rows: readonly string[], ask: Ask, place: Place): boolean => {
  const shown = questionScreen(rows)
  return (
    shown !== undefined &&
    flat(shown.question.join("")) === flat(ask.question) &&
    shown.tabs.some(({ name }) => flat(name) === flat(ask.header)) &&
    optionsOf(rows, shown, ask, false, place) !== undefined
  )
}

const reviewing = (rows: readonly string[]): boolean => rows.includes(review)

type OptionRow = { n: number; marker: boolean; text: string; lines: string[] }

/**
 * The option rows of a question screen, between its first option and its footer, when
 * they are `ask`'s in full and in the layout probed: its options with their descriptions,
 * then Type something, a rule, and Chat about this (or the preview layout's rows); the
 * highlight on one row and not on the free-text field.
 */
const optionsOf = (
  rows: readonly string[],
  { first, footer }: Pick<QuestionScreen, "first" | "footer">,
  ask: Ask,
  preview: boolean,
  { asked, final }: Place,
): OptionRow[] | undefined => {
  const count = ask.options.length
  const entries: OptionRow[] = []
  let ruledAt = -1
  for (const row of rows.slice(first, footer)) {
    if (row === "") continue
    if (rule.test(row)) {
      ruledAt = entries.length
      continue
    }
    const match = questionOption.exec(row)
    if (match) {
      entries.push({ n: Number(match[2]), marker: match[1] === "❯", text: match[3]!, lines: [] })
    } else if (preview && /^ {3,}/.test(row)) {
      // The preview's box, and its notes.
    } else if (preview && row === "  Chat about this" && ruledAt === entries.length) {
      entries.push({ n: 0, marker: false, text: "Chat about this", lines: [] })
    } else if (!preview && /^ {5,}\S/.test(row) && entries.length > 0) {
      entries[entries.length - 1]!.lines.push(row.trim())
    } else return undefined
  }
  if (entries.filter(({ marker }) => marker).length !== 1) return undefined

  if (preview) {
    if (entries.length !== count + 1 || entries[count]!.n !== 0) return undefined
    for (const [at, each] of ask.options.entries()) {
      const entry = entries[at]!
      // The label ends where the preview's box begins.
      if (entry.n !== at + 1 || entry.text.split(/\s{2,}/)[0] !== each.label) return undefined
    }
    if (!rows[first]!.includes("┌")) return undefined
  } else {
    if (entries.length !== count + 2 || ruledAt !== count + 1) return undefined
    for (const [at, each] of ask.options.entries()) {
      const entry = entries[at]!
      const label = ask.multiSelect ? /^\[ \] (.+)$/.exec(entry.text)?.[1] : entry.text
      if (entry.n !== at + 1 || label !== each.label) return undefined
      if (flat(entry.lines.join("")) !== flat(each.description)) return undefined
    }
    const other = entries[count]!
    const chat = entries[count + 1]!
    const typed = ask.multiSelect ? "[ ] Type something" : "Type something."
    if (other.n !== count + 1 || other.text !== typed) return undefined
    // The row after "Type something" of a multi-select goes on: to the next question, or
    // to submit the last one.
    const goes = asked === 1 ? ["Submit"] : final ? ["Next", "Submit"] : ["Next"]
    if (!(ask.multiSelect ? goes : [""]).includes(flat(other.lines.join("")))) return undefined
    if (chat.n !== count + 2 || chat.text !== "Chat about this" || chat.lines.length > 0) {
      return undefined
    }
    // With the highlight on the free-text row a digit would be typed into its field.
    if (other.marker) return undefined
    // Digits reach one digit's rows; a longer list is beyond what is probed.
    if (count + 2 > 9) return undefined
  }

  return entries
}

export const questions = (rows: readonly string[], facts: RequestFacts): DialogRead | undefined => {
  if (facts.kind !== "question" || facts.tool !== "AskUserQuestion") return undefined
  const asked = asks(facts.input)
  if (!asked) return undefined
  const preview = asked.some(({ options }) => options.some(({ preview: shown }) => shown))
  if (preview) {
    // Only one question, singly selected, with every option previewed, is probed.
    if (asked.length !== 1 || asked[0]!.multiSelect) return undefined
    if (asked[0]!.options.some(({ preview: shown }) => !shown)) return undefined
  }

  const shown = questionScreen(rows)
  if (!shown) return undefined
  // A lone multi-select question has a tab bar too, for its Submit; a lone single-select
  // question has none.
  if (shown.bar ? asked.length < 2 && !asked[0]!.multiSelect : asked.length !== 1) return undefined
  if (shown.bar && preview) return undefined
  if (shown.tabs.length !== asked.length) return undefined
  if (shown.tabs.some(({ open, name }, at) => !open || flat(name) !== flat(asked[at]!.header))) {
    return undefined
  }
  const ask = asked[0]!
  if (shown.question.length === 0 || flat(shown.question.join("")) !== flat(ask.question)) {
    return undefined
  }

  const place = { asked: asked.length, final: asked.length === 1 }
  const entries = optionsOf(rows, shown, ask, preview, place)
  if (!entries) return undefined

  const marker = entries.findIndex((each) => each.marker)
  const dialog: AnswerableDialog = {
    type: "questions",
    // The "Chat about this" row, read in full above: it rejects the questions, tells the
    // model the person wants to clarify them, and the person's words go as the next prompt.
    chat: "prompt",
    questions: asked.map((each, index) => ({
      id: `q${index + 1}`,
      header: each.header,
      question: each.question,
      options: each.options.map(({ label, description }, at) => ({
        id: String(at + 1),
        label,
        description: description === "" ? null : description,
      })),
      multiSelect: each.multiSelect,
      text: !preview,
    })),
  }

  return {
    dialog,
    keys: (answer) =>
      answer.type === "chat"
        ? chatKeys(ask.options.length, preview, marker)
        : keysFor(asked, preview, marker, answer),
    answered: (later) =>
      idle(later) && !reviewing(later) && !(footerAt(later) >= 0 && showing(later, ask, place)),
  }
}

/**
 * The keys that set the questions aside: the digit of the "Chat about this" row, the one
 * after "Type something"; in the preview layout, which has no digits, arrows down to it
 * and Enter. The words, if any, are the driver's to send as the next prompt.
 */
const chatKeys = (
  count: number,
  preview: boolean,
  marker: number,
): readonly KeyStep[] | undefined => {
  if (!preview) {
    const key = digit(count + 2)
    return key ? [{ press: key }] : undefined
  }
  const steps: KeyStep[] = []
  for (let step = 0; step < count - marker; step++) steps.push({ press: Down })
  steps.push({
    until: settled((rows) => rows.some((each) => each === "❯ Chat about this")),
    timeoutMs,
    why: "the highlight on Chat about this",
  })
  steps.push({ press: Enter })
  return steps
}

const checked = (n: number) => (rows: readonly string[]) =>
  rows.some((each) => {
    const match = questionOption.exec(each)
    return match !== null && Number(match[2]) === n && match[3]!.startsWith("[✔] ")
  })

// The "Type something" row `n` focused, its field taking words.
const freeTextFocused = (n: number) => (rows: readonly string[]) =>
  marked(rows, questionOption, n) && rows.some((each) => editorHint.test(each))

const keysFor = (
  asked: readonly Ask[],
  preview: boolean,
  marker: number,
  answer: RequestAnswer,
): readonly KeyStep[] | undefined => {
  if (answer.type !== "questions" || answer.answers.length !== asked.length) return undefined
  // Several questions, or a multi-select, end on a review screen that takes 1 to submit.
  const reviewed = asked.length > 1 || asked[0]!.multiSelect
  const steps: KeyStep[] = []
  for (const [index, ask] of asked.entries()) {
    const given = answer.answers.filter(({ question }) => question === `q${index + 1}`)
    if (given.length !== 1) return undefined
    const { options, text } = given[0]!
    const picked = options.map((id) => ask.options.findIndex((_, at) => String(at + 1) === id))
    if (picked.some((at) => at < 0) || new Set(picked).size !== picked.length) return undefined
    const count = ask.options.length

    if (preview) {
      // Digits only move the highlight here: arrows to the option, then Enter.
      if (text !== undefined || picked.length !== 1) return undefined
      const target = picked[0]!
      for (let step = 0; step < Math.abs(target - marker); step++) {
        steps.push({ press: target > marker ? Down : Up })
      }
      steps.push({
        until: (rows) => marked(rows, questionOption, target + 1),
        timeoutMs,
        why: `the highlight on option ${target + 1}`,
      })
      steps.push({ press: Enter })
    } else if (ask.multiSelect) {
      if (picked.length < 1 && text === undefined) return undefined
      if (text !== undefined && !typeable(text)) return undefined
      for (const at of picked) {
        const key = digit(at + 1)
        if (!key) return undefined
        steps.push({ press: key })
        steps.push({ until: checked(at + 1), timeoutMs, why: `option ${at + 1} ticked` })
      }
      if (text === undefined) steps.push({ press: Right })
      else {
        // Its digit only ticks the "Type something" row: arrows from where the highlight
        // starts (the read's for the first question, the first row after) focus it, and
        // the text ticks it. Down leaves it for the row that goes on.
        const start = index === 0 ? marker : 0
        for (let step = 0; step < Math.abs(count - start); step++) {
          steps.push({ press: count > start ? Down : Up })
        }
        steps.push({
          until: freeTextFocused(count + 1),
          timeoutMs,
          why: "the free-text row focused",
        })
        steps.push({ type: text })
        steps.push({
          until: (rows) => landed(rows, questionOption, count + 1, text, "[✔] "),
          timeoutMs,
          why: "the words in the free-text row",
        })
        steps.push({ press: Down })
        steps.push({
          until: (rows) => rows.some((each) => /^❯ {4}(?:Next|Submit)$/.test(each)),
          timeoutMs,
          why: "the row that goes on highlighted",
        })
        steps.push({ press: Enter })
      }
    } else if (text !== undefined) {
      // The "Type something" row opens a field once the screen shows it focused.
      const key = digit(count + 1)
      if (!key || picked.length > 0 || !typeable(text)) return undefined
      steps.push({ press: key })
      steps.push({ until: freeTextFocused(count + 1), timeoutMs, why: "the free-text row focused" })
      steps.push({ type: text })
      steps.push({
        until: (rows) => landed(rows, questionOption, count + 1, text),
        timeoutMs,
        why: "the words in the free-text row",
      })
      steps.push({ press: Enter })
    } else {
      const key = picked.length === 1 ? digit(picked[0]! + 1) : undefined
      if (!key) return undefined
      steps.push({ press: key })
    }

    // Several questions: wait for the next one, or for the review screen after the last.
    if (reviewed) {
      const next = asked[index + 1]
      const place = { asked: asked.length, final: index + 1 === asked.length - 1 }
      steps.push({
        // The next question shows with its highlight on its first row, never on a field.
        until: next
          ? (rows) => showing(rows, next, place) && marked(rows, questionOption, 1)
          : reviewing,
        timeoutMs,
        why: next ? `question ${index + 2} shown` : "the review screen",
      })
    }
  }
  if (reviewed) steps.push({ press: "1" })
  return steps
}
