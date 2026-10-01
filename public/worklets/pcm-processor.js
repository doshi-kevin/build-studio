// AudioWorklet processor that converts Float32 microphone samples to
// Int16 PCM for ElevenLabs Scribe v2. Runs on a separate thread to
// avoid blocking the main UI thread during live classroom sessions.

class PcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0]
    if (!input || input.length === 0) return true

    const int16 = new Int16Array(input.length)
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]))
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }

    this.port.postMessage(int16.buffer, [int16.buffer])
    return true
  }
}

registerProcessor('pcm-processor', PcmProcessor)
