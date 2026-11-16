import { context, describe, expect, it } from "../test"
import { createTeamNews, memberPiece, newPieces, teamPiece } from "./team-news"

const team = (lead: string, ...workers: string[]) => ({ lead, workers })

describe("what of a session's teams is new", () => {
  it("is nothing the first time the session is drawn: what it holds is where it starts", () => {
    expect(newPieces(undefined, [team("a", "b")])).toEqual([])
  })

  it("is a team that formed since, whole, with no tick of its own for its workers", () => {
    expect(newPieces(new Map(), [team("a", "b", "c")])).toEqual([teamPiece("a")])
  })

  it("is each teammate who joined a team already drawn", () => {
    const before = new Map([["a", new Set(["b"])]])
    expect(newPieces(before, [team("a", "b", "c")])).toEqual([memberPiece("a", "c")])
  })

  it("is nothing as a teammate leaves", () => {
    const before = new Map([["a", new Set(["b", "c"])]])
    expect(newPieces(before, [team("a", "b")])).toEqual([])
  })
})

describe("the team news the views share", () => {
  const sessions = () => {
    let current = "one"
    return {
      news: createTeamNews(() => current),
      open: (session: string) => {
        current = session
      },
    }
  }

  context("when the teams are only looked at again", () => {
    it("plays nothing, however often they are drawn", () => {
      const { news } = sessions()
      expect([...news.draw([team("a", "b")], 0)]).toEqual([])
      expect([...news.draw([team("a", "b")], 5000)]).toEqual([])
    })

    it("plays nothing as the person comes back to a session they saw", () => {
      const { news, open } = sessions()
      news.draw([team("a", "b")], 0)
      open("two")
      news.draw([team("x", "y")], 100)
      open("one")
      expect([...news.draw([team("a", "b")], 5000)]).toEqual([])
    })
  })

  context("when a team changes", () => {
    it("plays the change once", () => {
      const { news } = sessions()
      news.draw([], 0)
      expect([...news.draw([team("a", "b")], 1000)]).toEqual([teamPiece("a")])
      expect([...news.draw([team("a", "b")], 2000)]).toEqual([])
    })

    it("plays it in another view that draws the same teams a moment later, as Grid beside the rail", () => {
      const { news } = sessions()
      news.draw([team("a", "b")], 0)
      expect([...news.draw([team("a", "b", "c")], 1000)]).toEqual([memberPiece("a", "c")])
      expect([...news.draw([team("a", "b", "c")], 1050)]).toEqual([memberPiece("a", "c")])
      expect([...news.draw([team("a", "b", "c")], 1500)]).toEqual([])
    })

    it("plays a change made in another session once the person looks at it", () => {
      const { news, open } = sessions()
      news.draw([team("a", "b")], 0)
      open("two")
      news.draw([], 100)
      // Meanwhile "c" joined the first session's team, which nothing drew.
      open("one")
      expect([...news.draw([team("a", "b", "c")], 9000)]).toEqual([memberPiece("a", "c")])
    })
  })
})
