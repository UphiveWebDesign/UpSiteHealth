"use client";

import { buttonClass } from "./ui/button";

/** Opens the browser's print dialog (save as PDF from there). */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className={buttonClass("secondary", "md", "print:hidden")}
    >
      Print or save as PDF
    </button>
  );
}
