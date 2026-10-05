import { it, expect } from "vitest";
import { wav } from "../../apps/desktop/src/capture";
it("produces valid mono PCM WAV with bounded sample conversion", async () => {
  const b = await wav(new Float32Array([-2, -1, 0, 1, 2]), 16000).arrayBuffer();
  const v = new DataView(b);
  expect(new TextDecoder().decode(b.slice(0, 4))).toBe("RIFF");
  expect(v.getUint16(22, true)).toBe(1);
  expect(v.getUint32(24, true)).toBe(16000);
  expect(v.getUint32(40, true)).toBe(10);
  expect(v.getInt16(44, true)).toBe(-32767);
  expect(v.getInt16(52, true)).toBe(32767);
});
