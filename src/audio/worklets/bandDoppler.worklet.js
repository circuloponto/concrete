// Per-band pass-by simulation. Emits three absolute control signals per band
// (delay, pan, gain) on separate outputs, up to 12 bands × 3 params = 36
// outputs total. Replaces the main-thread rAF that hit 3 setTargetAtTime
// calls per band per frame — for 12 bands across 6 voices that was
// >2000 param updates per second from JS.
//
// Only the first numBands*3 outputs carry meaningful signal. The rest stay
// at zero so unwired outputs don't steal CPU.

const MAX_BANDS = 12
const TAU = Math.PI * 2
const MIN_DIST = 0.8

class BandDopplerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'speed', defaultValue: 0.4, minValue: 0, maxValue: 10, automationRate: 'k-rate' },
      { name: 'spread', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'panWidth', defaultValue: 0.9, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'distance', defaultValue: 1, minValue: 0, maxValue: 5, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'active', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }

  constructor() {
    super()
    this.t = 0
    this.phases = new Float32Array(MAX_BANDS)
    this.numBands = 0
    this.port.onmessage = (e) => {
      const d = e.data
      if (!d || !d.type) return
      if (d.type === 'setPhases') {
        const n = Math.min(MAX_BANDS, d.phases.length)
        for (let i = 0; i < n; i++) this.phases[i] = d.phases[i]
      } else if (d.type === 'setNumBands') {
        this.numBands = Math.max(0, Math.min(MAX_BANDS, d.n | 0))
      }
    }
  }

  process(inputs, outputs, params) {
    const blockSize = outputs[0][0].length
    const active = params.active[0] >= 0.5
    const mix = params.mix[0]
    const N = this.numBands

    // Zero every output first — unwired bands and inactive state both land here.
    for (let i = 0; i < outputs.length; i++) {
      const chs = outputs[i]
      for (let c = 0; c < chs.length; c++) chs[c].fill(0)
    }

    if (!active || mix <= 0 || N === 0) return true

    const speed = params.speed[0]
    const spread = params.spread[0]
    const panWidth = params.panWidth[0]
    const distance = params.distance[0]
    this.t += blockSize / sampleRate

    const sqrtN = Math.sqrt(N)
    for (let i = 0; i < N; i++) {
      const evenPhase = i / N
      const phaseOffset = evenPhase * (1 - spread) + this.phases[i] * spread
      const theta = this.t * speed * TAU + phaseOffset * TAU
      const x = Math.sin(theta) * 6 * distance
      const dist = Math.hypot(x, MIN_DIST)
      const tDelay = Math.min(0.09, dist / 343)
      const pan = Math.max(-1, Math.min(1, (x / 6) * panWidth))
      const amp = (MIN_DIST / dist) * mix / sqrtN

      const outDelay = outputs[i * 3][0]
      const outPan = outputs[i * 3 + 1][0]
      const outGain = outputs[i * 3 + 2][0]
      for (let s = 0; s < blockSize; s++) {
        outDelay[s] = tDelay
        outPan[s] = pan
        outGain[s] = amp
      }
    }
    return true
  }
}

registerProcessor('bandDoppler', BandDopplerProcessor)
