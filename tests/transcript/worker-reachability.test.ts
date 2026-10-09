import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserTabAudioSource,
  WORKER_DOWN,
  checkWorker,
} from "../../apps/desktop/src/capture";
// Seen in real use: capture started while the worker was not running and the
// only feedback was the browser's raw "Failed to fetch".
describe("worker reachability", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("checkWorker passes when /health answers", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    await expect(checkWorker(f as unknown as typeof fetch)).resolves.toBeUndefined();
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe("http://127.0.0.1:4318/health");
  });
  it("checkWorker explains what to do when the worker is down", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(checkWorker(f as unknown as typeof fetch)).rejects.toThrow(WORKER_DOWN);
  });
  it("a network failure while transcribing reports the worker, not 'Failed to fetch'", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const errors: string[] = [];
    const source = new BrowserTabAudioSource("m", "t", async () => {}, (m) => errors.push(m));
    await source.process(new Float32Array(16000), 0, 1000);
    expect(errors).toEqual([WORKER_DOWN]);
  });
  it("API failures after a good transcription keep their own message", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ text: "olá" }), { status: 200 }));
    const errors: string[] = [];
    const source = new BrowserTabAudioSource(
      "m",
      "t",
      async () => {
        throw Error("Captura real não está ativa");
      },
      (m) => errors.push(m),
    );
    await source.process(new Float32Array(16000), 0, 1000);
    expect(errors).toEqual(["Captura real não está ativa"]);
  });
});
