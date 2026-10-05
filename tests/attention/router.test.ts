import { it, expect } from "vitest";
import { AIRouter, type AIProvider } from "../../packages/core/src/ai";
it("provider outages fall back locally", async () => {
  const provider = {
    name: "failed",
    detectAttention: async () => {
      throw Error("outage");
    },
  } as unknown as AIProvider;
  expect(
    await new AIRouter([provider]).run(
      "m",
      (p) => p.detectAttention([], {} as any),
      () => ({ score: 18 }) as any,
      (v) => typeof v.score === "number",
    ),
  ).toEqual({ score: 18 });
});
it("invalid response never enters the engine", async () => {
  const provider = {
    name: "unsafe",
    detectAttention: async () => ({ score: 900 }),
  } as unknown as AIProvider;
  expect(
    await new AIRouter([provider]).run(
      "m",
      (p) => p.detectAttention([], {} as any),
      () => ({ score: 18 }) as any,
      (v) => v.score >= 0 && v.score <= 100,
    ),
  ).toEqual({ score: 18 });
});
