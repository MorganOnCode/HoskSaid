/**
 * Browser-side visitor-key state: the key lives in module memory only and is
 * forgotten on request, and the follow-up window is bounded. Storage, cookie
 * and URL accessors are trapped so any use fails the test.
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, test } from "node:test";

const touched: string[] = [];
function trapStorage(name: string) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        touched.push(`${name}.${String(prop)}`);
        return () => null;
      },
    }
  );
}

describe("visitor-key client state", () => {
  let store: typeof import("../src/components/ask/engine-store");
  let conversation: typeof import("../src/lib/conversation");

  before(async () => {
    for (const name of ["localStorage", "sessionStorage", "indexedDB"]) {
      Object.defineProperty(globalThis, name, { configurable: true, get: () => trapStorage(name) });
    }
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: new Proxy({}, { get: (_t, p) => (p === "cookie" ? (touched.push("document.cookie"), "") : undefined), set: (_t, p) => (touched.push(`document.${String(p)}=`), true) }),
    });
    Object.defineProperty(globalThis, "history", { configurable: true, get: () => trapStorage("history") });
    store = await import("../src/components/ask/engine-store");
    conversation = await import("../src/lib/conversation");
  });

  beforeEach(() => {
    store.resetEngineForTests();
    touched.length = 0;
  });

  test("defaults to the site model with nothing preselected for a visitor key", () => {
    const e = store.getEngine();
    assert.equal(e.mode, "site");
    assert.equal(e.provider, "");
    assert.equal(e.model, "");
    assert.equal(e.key, "");
    assert.equal(store.engineProblem({ ...e, mode: "byok" }), "Choose a provider.");
  });

  test("the key is held in memory only and Forget key clears it", () => {
    store.setEngine({ mode: "byok", provider: "anthropic" });
    assert.equal(store.engineProblem(store.getEngine()), "Choose a model.");
    store.setEngine({ model: "claude-opus-5-5", key: "sk-ant-fixture-browser-key" });
    assert.equal(store.engineProblem(store.getEngine()), null);
    assert.equal(store.getEngine().key, "sk-ant-fixture-browser-key");
    store.forgetKey();
    assert.equal(store.getEngine().key, "");
    assert.equal(store.getEngine().model, "claude-opus-5-5", "forgetting the key keeps the explicit model choice");
    assert.match(store.engineProblem(store.getEngine()) ?? "", /Enter your Anthropic API key/);
    assert.deepEqual(touched, [], "no storage, cookie or history API was touched");
  });

  test("switching provider never carries a key or model across", () => {
    store.setEngine({ mode: "byok", provider: "openai", model: "gpt-6.1-sol", key: "sk-fixture-openai-key" });
    store.setEngine({ provider: "openrouter" });
    const e = store.getEngine();
    assert.equal(e.key, "");
    assert.equal(e.model, "");
    store.setEngine({ provider: "not-a-provider" as never });
    assert.equal(store.getEngine().provider, "");
    assert.deepEqual(touched, []);
  });

  test("follow-ups send a bounded window, trim answers and disclose exclusions", () => {
    const turn = (i: number) => ({
      query: `question ${i}`,
      response: {
        query: `question ${i}`,
        answer: "a".repeat(2500),
        lede: "",
        citations: Array.from({ length: 15 }, (_x, k) => ({ n: k + 1, segment_id: `00000000-0000-4000-8000-${String(i * 100 + k).padStart(12, "0")}`, video_id: "v", timestamp: "0:00", quote: "" })),
        sources: [],
      },
    });
    const w = conversation.buildHistory(Array.from({ length: 6 }, (_x, i) => turn(i)));
    assert.equal(w.history.length, 4);
    assert.equal(w.excluded, 2);
    assert.deepEqual(w.history.map((h) => h.question), ["question 2", "question 3", "question 4", "question 5"]);
    for (const h of w.history) {
      assert.equal(h.answer.length, 2000);
      assert.equal(h.segment_ids?.length, 12);
    }
    assert.deepEqual(conversation.buildHistory([]), { history: [], excluded: 0 });
  });
});
