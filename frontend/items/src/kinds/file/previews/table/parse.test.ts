import { context, describe, expect, it } from "../../../../test"
import { delimiterOf, parseDelimited } from "./parse"

describe("reading delimited text", () => {
  it("splits records by line and fields by the delimiter", () => {
    expect(parseDelimited(["a,b,c", "1,2,3"], ",").records).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ])
  })

  it("keeps a quoted field's delimiters, line breaks and doubled quotes", () => {
    const { records, lines } = parseDelimited(
      ["name,note", '"Smith, J","said ""hi""', 'then left"', "x,y"],
      ",",
    )
    expect(records).toEqual([
      ["name", "note"],
      ["Smith, J", 'said "hi"\nthen left'],
      ["x", "y"],
    ])
    expect(lines).toEqual([0, 1, 3])
  })

  it("leaves out a byte-order mark and blank lines", () => {
    expect(parseDelimited(["﻿id,name", "1,Ann", "", "2,Bo", ""], ",").records).toEqual([
      ["id", "name"],
      ["1", "Ann"],
      ["2", "Bo"],
    ])
  })

  it("keeps empty fields, a record's last one too", () => {
    expect(parseDelimited(["a,,c,", ",,,"], ",").records).toEqual([
      ["a", "", "c", ""],
      ["", "", "", ""],
    ])
  })

  context("where a file strays", () => {
    it("joins text after a closing quote to its field, and keeps a quote inside a bare one", () => {
      expect(parseDelimited(['"a"b,c"d'], ",").records).toEqual([["ab", 'c"d']])
    })

    it("lets spaces lead an opening quote", () => {
      expect(parseDelimited(['a, "b, c",d'], ",").records).toEqual([["a", "b, c", "d"]])
    })

    it("closes a quote left open at the end, and says where it opened", () => {
      const parsed = parseDelimited(["id,text", '1,"cut sho'], ",")
      expect(parsed.records).toEqual([
        ["id", "text"],
        ["1", "cut sho"],
      ])
      expect(parsed.open).toBe(1)
    })

    it("reads quotes as text when asked", () => {
      expect(parseDelimited(['"12 inch\tx', "b\ty"], "\t", { quotes: false }).records).toEqual([
        ['"12 inch', "x"],
        ["b", "y"],
      ])
    })
  })
})

describe("a file's delimiter", () => {
  it("is a tab for TSV", () => {
    expect(delimiterOf("data/people.TSV", ["a,b,c"])).toBe("\t")
  })

  it("is what a CSV's lines hold most steadily, outside quotes", () => {
    expect(delimiterOf("a.csv", ["id,name,city", "1,Ann;Bo,Oslo", "2,Cy,Rome"])).toBe(",")
    expect(delimiterOf("a.csv", ['id;name;"Smith, J"'])).toBe(";")
    expect(delimiterOf("a.csv", ["id\tname\tcity"])).toBe("\t")
    expect(delimiterOf("a.csv", ["single"])).toBe(",")
  })

  it("isn't a character only a few lines hold in their text", () => {
    expect(
      delimiterOf("a.csv", ["id,name,city", "1,Ann", "2;3,Bo,Rome,x", "4,Cy,Bern", "5,Di"]),
    ).toBe(",")
  })

  it("is the semicolon where numbers take decimal commas", () => {
    expect(delimiterOf("a.csv", ["1,5;2,25;x", "3,75;4,1;y"])).toBe(";")
  })
})
