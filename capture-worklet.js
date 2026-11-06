/* Collects microphone audio into ~43 ms chunks off the main thread,
   so a busy screen never drops speech. */
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 2048;
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.size) {
          let s = 0;
          for (let k = 0; k < this.size; k += 4) s += this.buf[k] * this.buf[k];
          this.port.postMessage({ buf: this.buf, rms: Math.sqrt(s / (this.size / 4)) }, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("capture", Capture);
