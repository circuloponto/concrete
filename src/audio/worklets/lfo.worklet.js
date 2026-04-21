// Single-channel LFO emitting an absolute control signal suitable for
// summing into any AudioParam. Supports the same six wave shapes as
// modulation.js' lfoWave() — sine/triangle/square/saw/ramp/random —
// via a k-rate `wave` param mapped 0..5.
//
// Output formula: offset + lfo(t) * depth
// Main sets the target AudioParam's .value to the modulation base, sets
// this worklet's `offset` to 0 and its `depth` to the scaled amplitude,
// then connects output[0] to the param — summation yields the modulated
// value sample-accurately on the audio thread.

const TAU = Math.PI * 2

function randSH(i) {
  // Matches modulation.js so sample-and-hold sequences are bit-identical
  // to the main-thread implementation.
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453
  return (x - Math.floor(x)) * 2 - 1
}

function shape(wave, p) {
  if (wave < 0.5) return Math.sin(p * TAU)
  if (wave < 1.5) return p < 0.5 ? p * 4 - 1 : 3 - p * 4
  if (wave < 2.5) return p < 0.5 ? 1 : -1
  if (wave < 3.5) return p * 2 - 1
  if (wave < 4.5) return 1 - p * 2
  return 0
}

class LfoProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'wave', defaultValue: 0, minValue: 0, maxValue: 5, automationRate: 'k-rate' },
      { name: 'rate', defaultValue: 1, minValue: 0.001, maxValue: 100, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0, minValue: -1e6, maxValue: 1e6, automationRate: 'k-rate' },
      { name: 'phase', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'offset', defaultValue: 0, minValue: -1e6, maxValue: 1e6, automationRate: 'k-rate' },
    ]
  }

  constructor() {
    super()
    this.t = 0
    this.lastSHIndex = -1
    this.sh = 0
  }

  process(inputs, outputs, params) {
    const out = outputs[0][0]
    const n = out.length
    const wave = params.wave[0]
    const rate = params.rate[0]
    const depth = params.depth[0]
    const phase = params.phase[0]
    const offset = params.offset[0]

    // Advance once per block (k-rate). At typical LFO rates (<20 Hz) block
    // granularity is inaudible and saves per-sample trig work.
    this.t += n / sampleRate
    const p = ((this.t * rate + phase) % 1 + 1) % 1

    let v
    if (wave >= 4.5) {
      const idx = Math.floor(this.t * rate + phase)
      if (idx !== this.lastSHIndex) {
        this.sh = randSH(idx)
        this.lastSHIndex = idx
      }
      v = this.sh
    } else {
      v = shape(wave, p)
    }

    const y = offset + v * depth
    for (let i = 0; i < n; i++) out[i] = y
    return true
  }
}

registerProcessor('lfo', LfoProcessor)
