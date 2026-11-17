"use client";

import { useId } from "react";
import { BYOK_PROVIDERS, BYOK_PROVIDER_IDS, isValidModelId, type ByokProviderId } from "@/lib/byok-catalog";
import { forgetKey, setEngine, useEngine } from "./engine-store";

const CUSTOM = "__custom__";

/**
 * Explicit choice between the site's model and the visitor's own key, shown
 * under every Ask box. Nothing is preselected for the visitor-key path:
 * provider and model are always chosen by the visitor and shown on each answer.
 */
export function EngineChooser() {
  const e = useEngine();
  const id = useId();
  const info = e.provider ? BYOK_PROVIDERS[e.provider] : null;
  const modelInvalid = e.customModel && e.model !== "" && !isValidModelId(e.model);
  const selectValue = e.customModel ? CUSTOM : e.model;

  return (
    <div className="engine">
      <fieldset className="engine-mode">
        <legend className="engine-lab">Answer with</legend>
        <label className={"engine-opt" + (e.mode === "site" ? " on" : "")}>
          <input type="radio" name={`${id}-mode`} value="site" checked={e.mode === "site"} onChange={() => setEngine({ mode: "site" })} />
          <span>Site model <small>free · daily limit</small></span>
        </label>
        <label className={"engine-opt" + (e.mode === "byok" ? " on" : "")}>
          <input type="radio" name={`${id}-mode`} value="byok" checked={e.mode === "byok"} onChange={() => setEngine({ mode: "byok" })} />
          <span>Your own API key <small>you choose the model · follow-ups</small></span>
        </label>
      </fieldset>

      {e.mode === "byok" && (
        <div className="engine-panel">
          <div className="engine-grid">
            <label htmlFor={`${id}-prov`}>Provider</label>
            <select
              id={`${id}-prov`}
              value={e.provider}
              onChange={(ev) => setEngine({ provider: ev.target.value as ByokProviderId | "" })}
            >
              <option value="">Choose a provider…</option>
              {BYOK_PROVIDER_IDS.map((p) => (
                <option key={p} value={p}>{BYOK_PROVIDERS[p].label} ({BYOK_PROVIDERS[p].host})</option>
              ))}
            </select>

            <label htmlFor={`${id}-model`}>Model</label>
            <select
              id={`${id}-model`}
              value={selectValue}
              disabled={!info}
              onChange={(ev) =>
                ev.target.value === CUSTOM
                  ? setEngine({ customModel: true, model: "" })
                  : setEngine({ customModel: false, model: ev.target.value })
              }
            >
              <option value="">{info ? "Choose a model…" : "Choose a provider first"}</option>
              {info?.models.map((m) => (
                <option key={m.id} value={m.id}>{m.label} — {m.id}</option>
              ))}
              {info && <option value={CUSTOM}>Other model id…</option>}
            </select>

            {e.customModel && (
              <>
                <label htmlFor={`${id}-cmodel`}>Model id</label>
                <input
                  id={`${id}-cmodel`}
                  value={e.model}
                  maxLength={100}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={info?.models[0]?.id ?? "model id"}
                  aria-invalid={modelInvalid}
                  aria-describedby={modelInvalid ? `${id}-cmodel-err` : undefined}
                  onChange={(ev) => setEngine({ model: ev.target.value.trim() })}
                />
              </>
            )}

            <label htmlFor={`${id}-key`}>API key</label>
            <div className="engine-keyrow">
              <input
                id={`${id}-key`}
                type="password"
                value={e.key}
                disabled={!info}
                placeholder={info?.keyHint ?? ""}
                autoComplete="off"
                spellCheck={false}
                data-lpignore="true"
                data-1p-ignore="true"
                onChange={(ev) => setEngine({ key: ev.target.value.trim() })}
              />
              <button type="button" className="btn" onClick={forgetKey} disabled={!e.key}>Forget key</button>
            </div>
          </div>
          {modelInvalid && (
            <p className="engine-err" id={`${id}-cmodel-err`} role="alert">
              Model ids use letters, digits and . _ : / ~ - only.
            </p>
          )}
          <p className="engine-note">
            {info ? (
              <>
                Your question, the earlier turns of this conversation and the cited public transcript excerpts go to{" "}
                <b>{info.label}</b> at <b>{info.host}</b>. Your key is sent with each question over HTTPS to this site&apos;s
                server, which passes it on to {info.host} for that one request only; it is not stored, logged or cached
                there. In your browser it stays in this page&apos;s memory until you press Forget key, reload or close the
                tab. {info.label} bills you for the answer. If it fails or declines, no other model answers instead.{" "}
              </>
            ) : (
              <>Pick a provider to see exactly where your question is sent. </>
            )}
            Finding the transcript excerpts still uses this site&apos;s shared daily search allowance, which your key does
            not pay for or raise; keyword search in the Library needs neither.
            {info && (
              <>
                {" "}Revoke a key at{" "}
                <a href={info.keysUrl} target="_blank" rel="noopener noreferrer">{new URL(info.keysUrl).host}</a>.
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
