"use client";

import { useEffect } from "react";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("App error boundary:", error);
  }, [error]);

  return (
    <div className="wrap" style={{ paddingTop: 80 }}>
      <div className="state-card error" style={{ maxWidth: 620, margin: "0 auto" }}>
        <span className="glyph">!</span>
        <h3>Something broke on our end</h3>
        <p>An unexpected error occurred while loading this page. This one&apos;s on us — try again in a moment.</p>
        <div className="row">
          <button className="btn accent" onClick={reset} type="button">↻ Try again</button>
        </div>
        {error.digest ? <span className="mono">ERR · {error.digest}</span> : null}
      </div>
    </div>
  );
}
