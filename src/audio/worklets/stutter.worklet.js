// Stutter / beat-repeat with curve-shaped repeat intervals.
//
// Continuously writes incoming audio into a 500 ms ring buffer. While
// `active` is on, captures a slice at each burst start and plays N
// repeats with intervals shaped by a curve (-1 decel … 0 flat … +1 accel).
// Bursts run back-to-back; the burst output crossfades with dry via `mix`.
// No pitch manipulation — each repeat reads at rate 1.
//
// Musical cap: interval floor at 50 ms so an accel burst can't cross into
// audio-rate buzzing.

const RING_SECONDS = 0.5
const MIN_INTERVAL_SEC = 0.05
const MAX_REPEATS = 32

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

class StutterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'active', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'slice', defaultValue: 0.1, minValue: 0.02, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'repeats', defaultValue: 6, minValue: 2, maxValue: MAX_REPEATS, automationRate: 'k-rate' },
      { name: 'curve', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
      { name: 'randomize', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }

  constructor() {
    super()
    const ringLen = Math.ceil(sampleRate * RING_SECONDS)
    this.ringL = new Float32Array(ringLen)
    this.ringR = new Float32Array(ringLen)
    this.ringLen = ringLen
    this.ringWrite = 0

    // Burst playback state
    this.inBurst = false
    this.burstSliceStart = 0       // ring index where the captured slice begins
    this.burstSliceLen = 0         // samples — how far the slice extends (for looping within a repeat)
    this.burstIntervals = new Float32Array(MAX_REPEATS)  // samples per repeat
    this.burstRepeatCount = 0
    this.burstRepeatIdx = 0
    this.burstReadOffset = 0       // samples since current repeat started
    this.burstCurrentInterval = 0
  }

  // Fill burstIntervals[0..repeats-1] from curve + slice length (in samples).
  planBurst(repeats, curve, sliceSamples) {
    // Ratio: accel shrinks (<1), decel grows (>1). Magnitude of |curve|
    // controls how aggressively.
    const ratio = curve >= 0 ? 0.6 : 1.6
    const amount = Math.abs(curve)
    const floorSamp = Math.floor(MIN_INTERVAL_SEC * sampleRate)
    const ceilSamp = Math.floor(sliceSamples * 4)
    for (let i = 0; i < repeats; i++) {
      const factor = Math.pow(ratio, i * amount)
      let iv = Math.floor(sliceSamples * factor)
      iv = clamp(iv, floorSamp, ceilSamp)
      this.burstIntervals[i] = iv
    }
  }

  startBurst(params) {
    const randomize = params.randomize[0] >= 0.5
    const sliceSec = Math.max(MIN_INTERVAL_SEC, params.slice[0])
    const sliceSamples = Math.floor(sliceSec * sampleRate)
    let repeats = Math.round(params.repeats[0]) | 0
    let curve = params.curve[0]
    if (randomize) {
      repeats = 3 + Math.floor(Math.random() * 10)      // 3..12
      curve = Math.random() * 2 - 1                      // −1..+1
    }
    repeats = clamp(repeats, 2, MAX_REPEATS)
    this.planBurst(repeats, curve, sliceSamples)
    // Slice begins at the oldest sample that's still "fresh" — i.e. read
    // backwards from the write head by sliceSamples. The ring holds
    // RING_SECONDS of history which bounds sliceSamples.
    const start = (this.ringWrite - sliceSamples + this.ringLen) % this.ringLen
    this.burstSliceStart = start
    this.burstSliceLen = sliceSamples
    this.burstRepeatCount = repeats
    this.burstRepeatIdx = 0
    this.burstReadOffset = 0
    this.burstCurrentInterval = this.burstIntervals[0]
    this.inBurst = true
  }

  process(inputs, outputs, params) {
    const inL = inputs[0]?.[0]
    const inR = inputs[0]?.[1] || inL
    const outL = outputs[0][0]
    const outR = outputs[0][1] || outL
    const n = outL.length
    const active = params.active[0] >= 0.5
    const mix = params.mix[0]

    for (let s = 0; s < n; s++) {
      const drySampL = inL ? inL[s] : 0
      const drySampR = inR ? inR[s] : drySampL

      // 1) Always write incoming audio to the ring so the slice capture
      // at burst-start reflects real-time input even in passthrough.
      this.ringL[this.ringWrite] = drySampL
      this.ringR[this.ringWrite] = drySampR
      this.ringWrite = (this.ringWrite + 1) % this.ringLen

      // 2) State machine
      if (!this.inBurst && active) {
        this.startBurst(params)
      }

      let wetL = 0, wetR = 0
      if (this.inBurst) {
        // Read sample from the captured slice. burstReadOffset wraps within
        // burstSliceLen — if interval > slice, the slice loops inside the
        // repeat; if interval < slice, only the beginning plays.
        const rel = this.burstReadOffset % this.burstSliceLen
        const ri = (this.burstSliceStart + rel) % this.ringLen
        wetL = this.ringL[ri]
        wetR = this.ringR[ri]

        this.burstReadOffset++
        if (this.burstReadOffset >= this.burstCurrentInterval) {
          // Advance to next repeat
          this.burstRepeatIdx++
          if (this.burstRepeatIdx >= this.burstRepeatCount) {
            // Burst complete — immediately start the next one if still
            // active, else return to passthrough.
            if (active) {
              this.startBurst(params)
            } else {
              this.inBurst = false
            }
          } else {
            this.burstCurrentInterval = this.burstIntervals[this.burstRepeatIdx]
            this.burstReadOffset = 0
          }
        }
      }

      // 3) Mix wet/dry. When !inBurst, output is pure dry regardless of mix.
      if (this.inBurst) {
        outL[s] = drySampL * (1 - mix) + wetL * mix
        outR[s] = drySampR * (1 - mix) + wetR * mix
      } else {
        outL[s] = drySampL
        outR[s] = drySampR
      }
    }
    return true
  }
}

registerProcessor('stutter', StutterProcessor)
