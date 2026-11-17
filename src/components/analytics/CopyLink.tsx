"use client";

import { useState } from "react";

/** Copies the current /analytics URL: the URL is the whole view, so it is the share format. */
export function CopyLink() {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2500);
  }
  return (
    <>
      <button type="button" className="an-copy" onClick={copy}>
        {state === "copied" ? "Link copied" : "Copy link to this view"}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {state === "copied" ? "Link copied to clipboard" : state === "failed" ? "Copy failed; copy the address bar instead" : ""}
      </span>
    </>
  );
}
