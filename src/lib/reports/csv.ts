/**
 * RFC 4180 CSV with spreadsheet formula-injection protection: cells that
 * start with = + - @ (or tab/CR) are prefixed with ' so Excel and Sheets
 * treat them as text. Data such as page titles is attacker-controlled.
 */

export type Cell = string | number | boolean | Date | null | undefined;

export const BOM = String.fromCharCode(0xfeff);

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  let s =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "number"
        ? Number.isFinite(value)
          ? String(value)
          : ""
        : String(value);
  if (typeof value === "string" && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: Cell[][]): string {
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map((r) => r.map(csvCell).join(",")),
  ];
  // BOM so Excel opens UTF-8 correctly; CRLF per RFC 4180.
  return `${BOM}${lines.join("\r\n")}\r\n`;
}
