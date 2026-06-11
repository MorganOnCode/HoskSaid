"use client";

import { useState } from "react";

/** Small copy-to-clipboard button used in the agents docs copybar. */
export function CopyInline({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className={ok ? "ok" : ""}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setOk(true);
          setTimeout(() => setOk(false), 1500);
        } catch { /* ignore */ }
      }}
      type="button"
    >
      {ok ? "COPIED" : "COPY"}
    </button>
  );
}
