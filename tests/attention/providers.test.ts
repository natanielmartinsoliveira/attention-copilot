import { describe, expect, it } from "vitest";
import {
  AnthropicLLM,
  GeminiLLM,
  OpenAICompatibleLLM,
  clientsFromEnv,
  routerFromEnv,
} from "../../apps/api/src/providers";
import { PROMPTS } from "../../packages/core/src/ai";
import { defaultProfile } from "../../packages/core/src/types";
const request = { ...PROMPTS.analyzeContext([], defaultProfile), system: "SYS" };
const signal = new AbortController().signal;
/** Captures the outgoing request and answers with `body`. */
const fakeFetch = (body: unknown, status = 200) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
};
describe("OpenAI-compatible adapter (Groq / OpenRouter)", () => {
  it("sends system + user, JSON mode, and reads usage and reported cost", async () => {
    const f = fakeFetch({
      model: "m1",
      choices: [{ message: { content: '{"topic":"api"}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.0002 },
    });
    const llm = new OpenAICompatibleLLM("groq", "m1", "https://x/v1", "KEY", {}, f.impl);
    const out = await llm.complete(request, signal);
    expect(f.calls[0].url).toBe("https://x/v1/chat/completions");
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer KEY");
    const body = JSON.parse(f.calls[0].init.body as string);
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user"]);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(out).toEqual({ text: '{"topic":"api"}', model: "m1", inputTokens: 12, outputTokens: 3, cost: 0.0002 });
  });
  it("HTTP errors and truncation throw so the router can fall back", async () => {
    await expect(new OpenAICompatibleLLM("g", "m", "u", "k", {}, fakeFetch({}, 429).impl).complete(request, signal)).rejects.toThrow("http_429");
    const cut = fakeFetch({ choices: [{ message: { content: "{" }, finish_reason: "length" }] });
    await expect(new OpenAICompatibleLLM("g", "m", "u", "k", {}, cut.impl).complete(request, signal)).rejects.toThrow("max_tokens");
  });
});
describe("Gemini adapter", () => {
  it("uses the key header, JSON mime type and sums thinking tokens", async () => {
    const f = fakeFetch({
      candidates: [{ content: { parts: [{ text: '{"topic":"api"}' }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4, thoughtsTokenCount: 6 },
      modelVersion: "gemini-x",
    });
    const out = await new GeminiLLM("gemini-x", "GKEY", { input: 1, output: 2 }, f.impl).complete(request, signal);
    expect(f.calls[0].url).toContain("/models/gemini-x:generateContent");
    expect((f.calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("GKEY");
    expect(JSON.parse(f.calls[0].init.body as string).generationConfig.responseMimeType).toBe("application/json");
    expect(out).toMatchObject({ inputTokens: 20, outputTokens: 10, cost: (20 * 1 + 10 * 2) / 1e6 });
  });
});
describe("Anthropic adapter", () => {
  const fakeClient = (res: unknown) => {
    const calls: any[] = [];
    return {
      calls,
      beta: { messages: { create: async (body: any) => (calls.push(body), res) } },
    };
  };
  it("requests structured output with server-side fallback and prices the usage", async () => {
    const c = fakeClient({
      model: "claude-opus-5-5",
      stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"topic":"api"}' }],
      usage: { input_tokens: 1000, output_tokens: 100 },
    });
    const out = await new AnthropicLLM("claude-opus-5-5", "k", c).complete(request, signal);
    const body = c.calls[0];
    expect(body.output_config.format.type).toBe("json_schema");
    expect(JSON.stringify(body.output_config.format.schema)).not.toContain("maxLength");
    expect(body.fallbacks).toBe("default");
    expect(body.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(body.system).toBe("SYS");
    expect(out).toEqual({ text: '{"topic":"api"}', model: "claude-opus-5-5", inputTokens: 1000, outputTokens: 100, cost: (1000 * 4 + 100 * 20) / 1e6 });
  });
  it("a refusal is a failure, not an answer", async () => {
    const c = fakeClient({ model: "m", stop_reason: "refusal", content: [], usage: {} });
    await expect(new AnthropicLLM("m", "k", c).complete(request, signal)).rejects.toThrow("refusal");
  });
});
describe("configuration from env", () => {
  it("only providers with keys are enabled; unknown models need *_MODEL", () => {
    const ids = Object.keys(
      clientsFromEnv({ GROQ_API_KEY: "g", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", XAI_API_KEY: "x", XAI_MODEL: "grok-x" }),
    ).sort();
    expect(ids).toEqual(["anthropic", "groq", "xai"]);
  });
  it("default chains: cheap groq→gemini, strong anthropic→openrouter", () => {
    const r = routerFromEnv(
      { GROQ_API_KEY: "g", GEMINI_API_KEY: "m", ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "o" },
      () => {},
    );
    expect(r.providers()).toEqual({
      cheap: ["groq:openai/gpt-oss-120b", "gemini:gemini-flash-lite-latest"],
      strong: [
        "anthropic:claude-opus-5-5",
        "gemini-pro:gemini-pro-latest",
        "openrouter:google/gemma-4-31b-it:free",
      ],
    });
  });
  it("no keys → nothing configured, app stays local", () =>
    expect(routerFromEnv({}, () => {}).configured).toBe(false));
});
