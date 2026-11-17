/** What a visitor is told when /api/ask fails (audit F2 follow-up, prior review F1). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeAskFailure } from "../src/lib/ask-errors";
import { describeError } from "../src/lib/errors";
import { BudgetExceededError, BusyError } from "../src/lib/usage";

test("server error bodies carry the exhausted cap kind", () => {
  const a = describeError(new BudgetExceededError("answer"));
  const e = describeError(new BudgetExceededError("embedding"));
  assert.equal(a.status, 503);
  assert.equal(a.body.budget, "answer");
  assert.equal(e.body.budget, "embedding");
  assert.notEqual(a.body.message, e.body.message);
  assert.ok(Number(a.headers["Retry-After"]) > 0);
  assert.equal(describeError(new BusyError()).body.error, "busy");
  assert.deepEqual(describeError(new Error("secret db detail")).body, { error: "internal" }, "internal errors are not echoed");
});

test("the Ask UI distinguishes answer-cap from embedding-cap exhaustion", () => {
  const ans = describeAskFailure(503, describeError(new BudgetExceededError("answer")).body);
  const emb = describeAskFailure(503, describeError(new BudgetExceededError("embedding")).body);
  assert.equal(ans.code, "ANSWER BUDGET");
  assert.equal(emb.code, "SEARCH BUDGET");
  assert.equal(ans.retryable, false);
  assert.equal(emb.retryable, false);
  for (const f of [ans, emb]) {
    assert.doesNotMatch(f.message, /model|engine|api key|your key/i, "no advice that another model bypasses the shared budget");
    assert.match(f.message, /Library keyword search still works/);
  }
  assert.match(emb.message, /every answer needs one/);
});

test("other failures map to specific, honest states", () => {
  assert.equal(describeAskFailure(503, { error: "busy" }).retryable, true);
  assert.equal(describeAskFailure(429, { error: "rate_limited" }).code, "RATE LIMIT");
  assert.equal(describeAskFailure(400, { error: "query_too_long" }).retryable, false);
  assert.equal(describeAskFailure(500, { error: "internal" }).code, "SYNTHESIS");
  assert.equal(describeAskFailure(null, null).code, "SYNTHESIS", "network failure");
  assert.equal(describeAskFailure(503, "not json").code, "SYNTHESIS");
});
