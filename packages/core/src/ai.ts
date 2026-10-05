import type { Detection, UserProfile, TranscriptSegment } from "./types.js";
export interface AIUsage {
  provider: string;
  model: string | null;
  tokens: number | null;
  latency: number;
  estimatedCost: number | null;
  meetingId: string;
  eventId?: string;
}
export interface AIProvider {
  readonly name: string;
  analyzeContext(
    context: readonly TranscriptSegment[],
    profile: UserProfile,
  ): Promise<string>;
  detectAttention(
    context: readonly TranscriptSegment[],
    profile: UserProfile,
  ): Promise<Detection>;
  generateResponse(
    context: readonly TranscriptSegment[],
    question: string,
  ): Promise<string[]>;
  summarizeMeeting(context: readonly TranscriptSegment[]): Promise<string[]>;
  extractTasks(
    context: readonly TranscriptSegment[],
  ): Promise<{ text: string; confidence: number }[]>;
}
/** Optional remote providers are injected; empty chain runs the supplied local function.
 * Transcript data never gains tool access. Only schema-validated values may enter engine.
 */
export class AIRouter {
  private failures = new Map<string, { count: number; retryAt: number }>();
  constructor(
    private providers: AIProvider[],
    private report: (usage: AIUsage) => void = () => {},
  ) {}
  async run<T>(
    meetingId: string,
    call: (p: AIProvider) => Promise<T>,
    local: () => T,
    valid: (value: T) => boolean,
  ): Promise<T> {
    for (const p of this.providers) {
      const f = this.failures.get(p.name);
      if (f && f.retryAt > Date.now()) continue;
      const start = Date.now();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([
          call(p),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(Error("provider_timeout")), 3000);
          }),
        ]);
        if (!valid(value)) throw Error("invalid_schema");
        this.failures.delete(p.name);
        this.report({
          provider: p.name,
          model: null,
          tokens: null,
          latency: Date.now() - start,
          estimatedCost: null,
          meetingId,
        });
        return value;
      } catch {
        const count = (f?.count ?? 0) + 1;
        this.failures.set(p.name, {
          count,
          retryAt: count >= 3 ? Date.now() + 30000 : 0,
        });
      } finally {
        clearTimeout(timeout);
      }
    }
    return local();
  }
}
