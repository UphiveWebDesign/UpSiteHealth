import { expect, test } from "vitest";
import { BOM, csvCell, toCsv } from "./csv";

test("quotes commas, quotes and newlines per RFC 4180", () => {
  expect(csvCell("plain")).toBe("plain");
  expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
  expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
});

test.each(['=HYPERLINK("http://evil")', "+1+1", "-2+3", "@SUM(A1)", "\tcmd"])(
  "neutralises formula injection in %j",
  (value) => {
    expect(csvCell(value).replace(/^"/, "")).toMatch(/^'/);
  },
);

test("numbers, booleans, dates and nulls", () => {
  expect(csvCell(-5)).toBe("-5"); // numeric negatives are data, not formulas
  expect(csvCell(NaN)).toBe("");
  expect(csvCell(true)).toBe("true");
  expect(csvCell(new Date("2026-10-20T00:00:00Z"))).toBe(
    "2026-10-20T00:00:00.000Z",
  );
  expect(csvCell(null)).toBe("");
  expect(csvCell(undefined)).toBe("");
});

test("toCsv adds a BOM, header row and CRLF line endings", () => {
  expect(
    toCsv(
      ["a", "b"],
      [
        [1, "x"],
        [null, "y,z"],
      ],
    ),
  ).toBe(BOM + 'a,b\r\n1,x\r\n,"y,z"\r\n');
});
