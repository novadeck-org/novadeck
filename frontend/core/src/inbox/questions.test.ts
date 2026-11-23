import type { AskQuestion } from "../inbox"
import { describe, expect, it } from "../test"
import { askAnswerOf, askDialog, questionsWords } from "./questions"

const questions: readonly AskQuestion[] = [
  {
    header: "Theme",
    question: "Which theme?",
    options: [
      { label: "Fantasy", summary: "Castles" },
      { label: "Sci-fi", summary: null },
    ],
    multiSelect: false,
    recommend: 0,
  },
  {
    header: null,
    question: "Which genres?",
    options: [
      { label: "RPG", summary: null },
      { label: "FPS (Recommended)", summary: null },
      { label: "RTS", summary: null },
    ],
    multiSelect: true,
    recommend: 1,
  },
]

describe("an agent's ask of several questions", () => {
  it("is a dialog of questions, each taking the person's own words, that can't be set aside", () => {
    expect(askDialog("ask-1", questions)).toEqual({
      type: "questions",
      id: "ask-1",
      chat: null,
      questions: [
        {
          id: "q0",
          header: "Theme",
          question: "Which theme?",
          options: [
            { id: "0", label: "Fantasy (Recommended)", description: "Castles" },
            { id: "1", label: "Sci-fi", description: null },
          ],
          multiSelect: false,
          text: true,
        },
        {
          id: "q1",
          header: null,
          question: "Which genres?",
          options: [
            { id: "0", label: "RPG", description: null },
            // The agent's own mark isn't said twice.
            { id: "1", label: "FPS (Recommended)", description: null },
            { id: "2", label: "RTS", description: null },
          ],
          multiSelect: true,
          text: true,
        },
      ],
    })
  })

  it("makes the dialog's answer the ask's, a question to an answer in its order", () => {
    expect(
      askAnswerOf(questions, {
        type: "questions",
        dialog: "ask-1",
        answers: [
          { question: "q1", options: ["0", "2"] },
          { question: "q0", options: [], text: "Steampunk" },
        ],
      }),
    ).toEqual({
      type: "questions",
      answers: [
        { options: [], text: "Steampunk" },
        { options: [0, 2], text: "" },
      ],
    })
    expect(askAnswerOf(questions, { type: "chat", dialog: "ask-1" })).toBeUndefined()
  })

  it("says the answer a question to a part, by its header or else the question", () => {
    expect(
      questionsWords(questions, [
        { options: [0], text: "" },
        { options: [0, 2], text: " no shooters " },
      ]),
    ).toBe("Theme: Fantasy; Which genres?: RPG, RTS, no shooters")
  })
})
