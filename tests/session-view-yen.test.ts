import assert from "node:assert/strict";
import { test } from "node:test";
import { yenText } from "../lib/session/view";

test("yenText: 桁区切りと ¥ を付けるだけで、値は変えない", () => {
  assert.equal(yenText(3300), "¥3,300");
  assert.equal(yenText(0), "¥0");
  assert.equal(yenText(15180), "¥15,180");
});

test("yenText: null は null のまま（推測の金額を作らない）", () => {
  assert.equal(yenText(null), null);
});
