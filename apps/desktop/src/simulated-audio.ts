import {
  PcmBlocker,
  type ApplicationAudioSource,
  type BlockHandler,
  type SystemAudioSource,
} from "./capture";
/**
 * Native system/per-process capture is not implemented yet (ADR 002): it needs
 * WASAPI process loopback (Windows build 20348+) inside the Tauri shell, and a
 * browser PID does not identify a meeting. Until then these sources replay a
 * PCM buffer in real time through the same PcmBlocker as BrowserTabAudioSource,
 * so the block → STT → transcript path can run without a live meeting.
 */
export interface SimulatedAudioOptions {
  rate?: number;
  /** Samples pushed per tick; 1600 at 16 kHz ≈ the 100 ms cadence of a worklet. */
  frameSamples?: number;
}
class SimulatedAudioSource {
  private timer?: ReturnType<typeof setInterval>;
  private blocker?: PcmBlocker;
  private offset = 0;
  constructor(
    private pcm: Float32Array,
    private onBlock: BlockHandler,
    private options: SimulatedAudioOptions = {},
  ) {}
  get running() {
    return this.timer !== undefined;
  }
  async start() {
    if (this.running) throw Error("Fonte simulada já está ativa.");
    const rate = this.options.rate ?? 16000,
      frame = this.options.frameSamples ?? 1600;
    this.offset = 0;
    const blocker = (this.blocker = new PcmBlocker(
      this.onBlock,
      Date.now(),
      rate,
    ));
    this.timer = setInterval(
      () => {
        blocker.push(this.pcm.subarray(this.offset, this.offset + frame));
        this.offset += frame;
        if (this.offset < this.pcm.length) return;
        // End of the recording: deliver the tail like a stream that ended.
        blocker.flush();
        this.halt();
      },
      (frame * 1000) / rate,
    );
  }
  async stop() {
    this.blocker?.clear();
    this.halt();
  }
  private halt() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
export class SimulatedSystemAudioSource
  extends SimulatedAudioSource
  implements SystemAudioSource
{
  readonly kind = "system" as const;
}
export class SimulatedApplicationAudioSource
  extends SimulatedAudioSource
  implements ApplicationAudioSource
{
  readonly kind = "application" as const;
  constructor(
    readonly processId: number,
    pcm: Float32Array,
    onBlock: BlockHandler,
    options?: SimulatedAudioOptions,
  ) {
    super(pcm, onBlock, options);
  }
}
