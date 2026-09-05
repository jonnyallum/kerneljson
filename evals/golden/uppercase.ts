import { EvaluationSuite } from "../../packages/contracts/src/index.js";
export const uppercaseSuite = EvaluationSuite.parse({
  id: "uppercase",
  version: "1",
  cases: [
    { id: "trim", input: { text: " hello " }, expected: { text: "HELLO" } },
    {
      id: "unicode-expansion",
      input: { text: "Straße" },
      expected: { text: "STRASSE" },
    },
    { id: "accent", input: { text: "é" }, expected: { text: "É" } },
    {
      id: "internal-newline",
      input: { text: "a\nb" },
      expected: { text: "A\nB" },
    },
    { id: "empty", input: { text: "" }, expected: { text: "" } },
  ],
});
