"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { buttonClass } from "./ui/button";

/**
 * Client-side pieces of the report handoff: copying the client link (with
 * clear feedback and a manual fallback) and opening the print dialog once
 * when the client-ready view is opened to save a PDF.
 */

type CopyState = "idle" | "copied" | "failed";

/** Copies the absolute client link; never claims the report was sent. */
export function CopyClientLink({ path }: { path: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const [url, setUrl] = useState(path);
  const field = useRef<HTMLInputElement>(null);

  async function copy() {
    const href = new URL(path, window.location.origin).href;
    setUrl(href);
    try {
      await navigator.clipboard.writeText(href);
      setState("copied");
    } catch {
      setState("failed");
      // Leave the link selected so it can be copied by hand.
      requestAnimationFrame(() => field.current?.select());
    }
  }

  return (
    <div className="flex min-w-0 max-w-xs flex-col items-start gap-1">
      <button
        type="button"
        onClick={copy}
        className={buttonClass("secondary", "md")}
      >
        Copy client link
      </button>
      <p role="status" aria-live="polite" className="text-xs text-muted">
        {state === "copied" &&
          "Link copied. Nothing has been sent: paste it into your message to the client."}
        {state === "failed" &&
          "Could not copy automatically. Select the link below and copy it."}
      </p>
      {state === "failed" && (
        <input
          ref={field}
          readOnly
          value={url}
          aria-label="Client link"
          className="w-full min-w-0 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
        />
      )}
    </div>
  );
}

/**
 * Opens the print dialog once (Save as PDF), then removes the request from
 * the URL so a reload does not print again.
 */
export function AutoPrint({ cleanHref }: { cleanHref: string }) {
  const router = useRouter();
  const done = useRef(false);
  useEffect(() => {
    // The guard sits in the timer: development runs effects twice, and the
    // first run's cleanup cancels its timer.
    const t = window.setTimeout(() => {
      if (done.current) return;
      done.current = true;
      window.print();
      router.replace(cleanHref, { scroll: false });
    }, 300);
    return () => window.clearTimeout(t);
  }, [cleanHref, router]);
  return null;
}
