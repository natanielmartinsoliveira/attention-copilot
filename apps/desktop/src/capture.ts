export interface AudioSource {
  start(): Promise<void>;
  stop(): Promise<void>;
}
export interface SystemAudioSource extends AudioSource {
  kind: "system";
}
export interface ApplicationAudioSource extends AudioSource {
  kind: "application";
  processId: number;
}
export function wav(samples: Float32Array, rate: number) {
  const b = new ArrayBuffer(44 + samples.length * 2),
    v = new DataView(b);
  const word = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  word(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  word(8, "WAVE");
  word(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  word(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++)
    v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Blob([b], { type: "audio/wav" });
}
export class BrowserTabAudioSource implements AudioSource {
  stream?: MediaStream;
  ctx?: AudioContext;
  node?: AudioWorkletNode;
  abort?: AbortController;
  stopped = false;
  busy = false;
  chunks: Float32Array[] = [];
  count = 0;
  cursor = 0;
  constructor(
    public meetingId: string,
    private token: string,
    private send: (text: string, start: number, end: number) => Promise<void>,
    private onError: (message: string) => void,
  ) {}
  async start() {
    if ("__TAURI_INTERNALS__" in window)
      throw Error(
        "Use Chrome/Edge para selecionar uma aba. Captura nativa no Tauri ainda não está disponível.",
      );
    // Chrome only offers tab audio together with video; ask for the cheapest video.
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: 320 }, height: { max: 240 }, frameRate: { max: 1 } },
      audio: true,
    });
    if (!this.stream.getAudioTracks().length) {
      await this.stop();
      throw Error(
        "Nenhum áudio selecionado. Escolha uma aba e marque Compartilhar áudio.",
      );
    }
    this.ctx = new AudioContext({ sampleRate: 16000 });
    if (this.ctx.sampleRate !== 16000) {
      await this.stop();
      throw Error(
        "O navegador não aceitou áudio em 16 kHz. Esta configuração ainda não é suportada.",
      );
    }
    const code = `class PCM extends AudioWorkletProcessor {process(inputs){const channels=inputs[0];if(channels?.length){const mono=new Float32Array(channels[0].length);for(const c of channels)for(let i=0;i<c.length;i++)mono[i]+=c[i]/channels.length;this.port.postMessage(mono);}return true;}}registerProcessor('pcm',PCM);`;
    const url = URL.createObjectURL(
      new Blob([code], { type: "text/javascript" }),
    );
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    this.node = new AudioWorkletNode(this.ctx, "pcm");
    this.ctx.createMediaStreamSource(this.stream).connect(this.node);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute).connect(this.ctx.destination);
    this.cursor = Date.now();
    this.node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      if (this.stopped) return;
      this.chunks.push(ev.data);
      this.count += ev.data.length;
      if (this.count >= 48000) {
        const all = new Float32Array(this.count);
        let offset = 0;
        for (const c of this.chunks) {
          all.set(c, offset);
          offset += c.length;
        }
        this.chunks = [];
        this.count = 0;
        const start = this.cursor,
          end = start + all.length / 16;
        this.cursor = end;
        void this.process(all, start, end);
      }
    };
    for (const t of this.stream.getTracks())
      t.onended = () => {
        void this.stop();
        this.onError("A captura da aba foi encerrada.");
      };
    await this.ctx.resume();
  }
  async process(samples: Float32Array, start: number, end: number) {
    if (this.busy) {
      this.onError(
        "STT mais lento que o áudio: trecho descartado para limitar a memória.",
      );
      return;
    }
    this.busy = true;
    this.abort = new AbortController();
    const timeout = setTimeout(() => this.abort?.abort(), 15000);
    try {
      const r = await fetch("http://127.0.0.1:4318/transcribe", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "audio/wav",
        },
        body: wav(samples, 16000),
        signal: this.abort.signal,
      });
      if (!r.ok)
        throw Error(
          `STT indisponível (${r.status}). Verifique o worker local.`,
        );
      const result = await r.json();
      if (!this.stopped && result.text)
        await this.send(result.text, start, end);
    } catch (e) {
      if (!this.stopped)
        this.onError(e instanceof Error ? e.message : "Falha na transcrição");
    } finally {
      clearTimeout(timeout);
      this.busy = false;
    }
  }
  async stop() {
    this.stopped = true;
    this.abort?.abort();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.node?.disconnect();
    await this.ctx?.close();
    this.chunks = [];
    this.count = 0;
  }
}
