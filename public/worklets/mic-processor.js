// AudioWorklet: microphone → 16 kHz mono PCM16, posted in ~100 ms chunks.
// Plain JS on purpose: worklets are loaded by URL and run outside the bundle.

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100 ms

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.out = new Int16Array(CHUNK_SAMPLES);
    this.filled = 0;
    // Fractional read position carried across render quanta, plus a running sum for box-filter downsampling.
    this.pos = 0;
    this.acc = 0;
    this.accCount = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      // Average the input samples that fall into each output sample (cheap anti-aliasing).
      this.acc += channel[i];
      this.accCount++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.accCount));
        this.acc = 0;
        this.accCount = 0;
        this.out[this.filled++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.filled === CHUNK_SAMPLES) {
          const chunk = this.out;
          this.port.postMessage(chunk.buffer, [chunk.buffer]);
          this.out = new Int16Array(CHUNK_SAMPLES);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('mic-processor', MicProcessor);
