import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PcmBlocker } from "../../apps/desktop/src/capture";
import {
  SimulatedApplicationAudioSource,
  SimulatedSystemAudioSource,
} from "../../apps/desktop/src/simulated-audio";
const T0 = 1_700_000_000_000;
type Block = { length: number; start: number; end: number };
const collect = () => {
  const blocks: Block[] = [];
  return {
    blocks,
    onBlock: (s: Float32Array, start: number, end: number) =>
      blocks.push({ length: s.length, start, end }),
  };
};
describe("PcmBlocker", () => {
  it("emits contiguous 3 s blocks with wall-clock timestamps", () => {
    const { blocks, onBlock } = collect(),
      b = new PcmBlocker(onBlock, T0);
    for (let i = 0; i < 70; i++) b.push(new Float32Array(1600));
    expect(blocks).toEqual([
      { length: 48000, start: T0, end: T0 + 3000 },
      { length: 48000, start: T0 + 3000, end: T0 + 6000 },
    ]);
  });
  it("clear drops a partial block; flush emits it", () => {
    const { blocks, onBlock } = collect(),
      b = new PcmBlocker(onBlock, T0);
    b.push(new Float32Array(8000));
    b.clear();
    b.flush();
    expect(blocks).toHaveLength(0);
    b.push(new Float32Array(8000));
    b.flush();
    expect(blocks).toEqual([{ length: 8000, start: T0, end: T0 + 500 }]);
  });
});
describe("simulated native sources", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());
  it("system source replays PCM in real time and flushes the tail", async () => {
    const { blocks, onBlock } = collect(),
      source = new SimulatedSystemAudioSource(new Float32Array(56000), onBlock);
    expect(source.kind).toBe("system");
    await source.start();
    vi.advanceTimersByTime(2900);
    expect(blocks).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(blocks).toEqual([{ length: 48000, start: T0, end: T0 + 3000 }]);
    vi.advanceTimersByTime(1000);
    expect(blocks[1]).toEqual({ length: 8000, start: T0 + 3000, end: T0 + 3500 });
    expect(source.running).toBe(false);
  });
  it("stop discards buffered audio and halts delivery", async () => {
    const { blocks, onBlock } = collect(),
      source = new SimulatedSystemAudioSource(new Float32Array(160000), onBlock);
    await source.start();
    vi.advanceTimersByTime(2000);
    await source.stop();
    vi.advanceTimersByTime(10000);
    expect(blocks).toHaveLength(0);
    expect(source.running).toBe(false);
  });
  it("application source keeps its process id and rejects double start", async () => {
    const { onBlock } = collect(),
      source = new SimulatedApplicationAudioSource(4242, new Float32Array(16000), onBlock);
    expect(source.kind).toBe("application");
    expect(source.processId).toBe(4242);
    await source.start();
    await expect(source.start()).rejects.toThrow();
    await source.stop();
  });
});
