import Anthropic from "@anthropic-ai/sdk";
import {
  AIRouter,
  type AITier,
  type AIUsage,
  type JsonSchema,
  type LLMClient,
  type LLMRequest,
  type LLMResult,
} from "../../../packages/core/src/ai.js";
type Fetch = typeof fetch;
type Price = { input: number; output: number };
/** USD per million tokens, from Anthropic's published pricing. */
const ANTHROPIC_PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const costOf = (price: Price | undefined, input: number | null, output: number | null) =>
  price && input !== null && output !== null
    ? (input * price.input + output * price.output) / 1e6
    : null;
/** Structured-output engines accept a subset of JSON Schema; the router's
 * validators still enforce the bounds removed here. */
function relaxSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(relaxSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema))
    if (!["minimum", "maximum", "maxLength"].includes(k)) out[k] = relaxSchema(v);
  // ["string","null"] → anyOf, which structured outputs support.
  if (Array.isArray(out.type)) {
    const types = out.type as string[];
    delete out.type;
    out.anyOf = types.map((type) => ({ type }));
  }
  return out;
}
type AnthropicLike = {
  beta: { messages: { create: (body: any, options?: any) => Promise<any> } };
};
export class AnthropicLLM implements LLMClient {
  readonly name = "anthropic";
  private client: AnthropicLike;
  constructor(
    readonly model: string,
    apiKey: string,
    client?: AnthropicLike,
  ) {
    this.client = client ?? new Anthropic({ apiKey, maxRetries: 0 });
  }
  async complete(r: LLMRequest, signal: AbortSignal): Promise<LLMResult> {
    const res = await this.client.beta.messages.create(
      {
        model: this.model,
        // Thinking cannot be disabled on current models; it draws from max_tokens.
        max_tokens: Math.max(4000, r.maxTokens * 4),
        system: r.system,
        messages: [{ role: "user", content: r.prompt }],
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: relaxSchema(r.schema) as JsonSchema },
        },
        // A safety decline is re-run server-side on Anthropic's recommended model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal },
    );
    if (res.stop_reason === "refusal") throw Error("refusal");
    if (res.stop_reason === "max_tokens") throw Error("max_tokens");
    const text = (res.content as { type: string; text?: string }[])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const input = res.usage?.input_tokens ?? null,
      output = res.usage?.output_tokens ?? null;
    return {
      text,
      model: res.model,
      inputTokens: input,
      outputTokens: output,
      cost: costOf(ANTHROPIC_PRICES[res.model], input, output),
    };
  }
}
/** Groq, OpenRouter, OpenAI, xAI, DeepSeek: OpenAI chat-completions dialect. */
export class OpenAICompatibleLLM implements LLMClient {
  constructor(
    readonly name: string,
    readonly model: string,
    private baseUrl: string,
    private apiKey: string,
    private options: {
      price?: Price;
      extraBody?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
    private fetchImpl: Fetch = fetch,
  ) {}
  async complete(r: LLMRequest, signal: AbortSignal): Promise<LLMResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...this.options.headers,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: r.system },
          { role: "user", content: r.prompt },
        ],
        response_format: { type: "json_object" },
        // Reasoning models spend part of the budget before answering.
        max_tokens: r.maxTokens * 4,
        temperature: 0,
        ...this.options.extraBody,
      }),
    });
    if (!response.ok) throw Error(`http_${response.status}`);
    const j = (await response.json()) as any;
    const text = j.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw Error("empty_response");
    if (j.choices[0].finish_reason === "length") throw Error("max_tokens");
    const input = j.usage?.prompt_tokens ?? null,
      output = j.usage?.completion_tokens ?? null;
    return {
      text,
      model: j.model ?? this.model,
      inputTokens: input,
      outputTokens: output,
      cost:
        typeof j.usage?.cost === "number"
          ? j.usage.cost
          : costOf(this.options.price, input, output),
    };
  }
}
export class GeminiLLM implements LLMClient {
  constructor(
    readonly model: string,
    private apiKey: string,
    private price?: Price,
    private fetchImpl: Fetch = fetch,
    readonly name = "gemini",
  ) {}
  async complete(r: LLMRequest, signal: AbortSignal): Promise<LLMResult> {
    const response = await this.fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: "POST",
        signal,
        headers: { "x-goog-api-key": this.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: r.system }] },
          contents: [{ role: "user", parts: [{ text: r.prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: r.maxTokens * 4,
            temperature: 0,
          },
        }),
      },
    );
    if (!response.ok) throw Error(`http_${response.status}`);
    const j = (await response.json()) as any;
    const candidate = j.candidates?.[0];
    if (candidate?.finishReason === "MAX_TOKENS") throw Error("max_tokens");
    const text = (candidate?.content?.parts ?? [])
      .map((p: { text?: string }) => p.text ?? "")
      .join("");
    if (!text) throw Error(`empty_response${candidate?.finishReason ? `_${candidate.finishReason}` : ""}`);
    const u = j.usageMetadata ?? {};
    const input = u.promptTokenCount ?? null,
      output =
        u.candidatesTokenCount === undefined
          ? null
          : u.candidatesTokenCount + (u.thoughtsTokenCount ?? 0);
    return {
      text,
      model: j.modelVersion ?? this.model,
      inputTokens: input,
      outputTokens: output,
      cost: costOf(this.price, input, output),
    };
  }
}
type Env = Record<string, string | undefined>;
const priceFrom = (env: Env, name: string): Price | undefined => {
  const input = Number(env[`${name}_PRICE_IN`]),
    output = Number(env[`${name}_PRICE_OUT`]);
  return Number.isFinite(input) && Number.isFinite(output) && env[`${name}_PRICE_IN`]
    ? { input, output }
    : undefined;
};
/** Builds a client per configured provider. Providers whose model name we
 * cannot know (OpenAI, xAI) are only enabled with an explicit *_MODEL. */
export function clientsFromEnv(env: Env, fetchImpl: Fetch = fetch) {
  const clients: Record<string, LLMClient> = {};
  const compat = (
    id: string,
    base: string,
    defaultModel: string | undefined,
    options: ConstructorParameters<typeof OpenAICompatibleLLM>[4] = {},
  ) => {
    const key = env[`${id.toUpperCase()}_API_KEY`],
      model = env[`${id.toUpperCase()}_MODEL`] ?? defaultModel;
    if (key && model)
      clients[id] = new OpenAICompatibleLLM(
        id,
        model,
        base,
        key,
        { ...options, price: priceFrom(env, id.toUpperCase()) },
        fetchImpl,
      );
  };
  // 120b resisted the injection smoke test that 20b fell for.
  compat("groq", "https://api.groq.com/openai/v1", "openai/gpt-oss-120b", {
    extraBody: { reasoning_effort: "low" },
  });
  compat("openrouter", "https://openrouter.ai/api/v1", "google/gemma-4-31b-it:free", {
    extraBody: { usage: { include: true } },
    headers: { "X-Title": "Attention Copilot" },
  });
  compat("openai", "https://api.openai.com/v1", undefined);
  compat("xai", "https://api.x.ai/v1", undefined);
  compat("deepseek", "https://api.deepseek.com", "deepseek-chat");
  if (env.GEMINI_API_KEY) {
    clients.gemini = new GeminiLLM(
      env.GEMINI_MODEL ?? "gemini-flash-lite-latest",
      env.GEMINI_API_KEY,
      priceFrom(env, "GEMINI"),
      fetchImpl,
    );
    // Same key, larger model: the strong-tier fallback when Anthropic is unavailable.
    clients["gemini-pro"] = new GeminiLLM(
      env.GEMINI_PRO_MODEL ?? "gemini-pro-latest",
      env.GEMINI_API_KEY,
      priceFrom(env, "GEMINI_PRO"),
      fetchImpl,
      "gemini-pro",
    );
  }
  if (env.ANTHROPIC_API_KEY)
    clients.anthropic = new AnthropicLLM(
      env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
      env.ANTHROPIC_API_KEY,
    );
  return clients;
}
/** AI_CHEAP / AI_STRONG are ordered fallback chains (§39). AI_PROVIDER (+AI_MODEL)
 * from the spec selects a single strong provider. */
export function routerFromEnv(
  env: Env,
  report: (u: AIUsage) => void,
  clients: Record<string, LLMClient> = clientsFromEnv(env),
) {
  const pick = (list: string) =>
    list
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((id) => clients[id])
      .map((id) => clients[id]);
  if (env.AI_PROVIDER && env.AI_MODEL)
    Object.assign(
      clients,
      clientsFromEnv({ ...env, [`${env.AI_PROVIDER.toUpperCase()}_MODEL`]: env.AI_MODEL }),
    );
  const tiers: Record<AITier, LLMClient[]> = {
    cheap: pick(env.AI_CHEAP ?? "groq,gemini"),
    strong: pick(env.AI_PROVIDER ?? env.AI_STRONG ?? "anthropic,gemini-pro,openrouter"),
  };
  return new AIRouter(tiers, report);
}
