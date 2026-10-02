import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildReviewModelArgs } from "../../extensions/review/models.js";

describe("review model arguments", () => {
  for (const [model, expected] of [
    [undefined, []],
    ["openai/gpt-5.6-luna", ["--model", "openai/gpt-5.6-luna"]],
    [
      "llama.cpp/cafe-llama",
      ["--model", "llama.cpp/cafe-llama", "--extension", "builtin:llama.cpp"],
    ],
  ] as const) {
    test(`builds args for ${model ?? "no selected model"}`, () => {
      assert.deepEqual(buildReviewModelArgs(model), expected);
    });
  }
});
