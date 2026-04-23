// Stutter / beat-repeat with pitch + amp contours, jitter, curve shapes.
//
// Modes:
//   AUTO   — Poisson-distributed random-interval bursts
//   MANUAL — bursts fire only on {type:'trigger'} port message
//
// Per-burst contours, each with two endpoints interpolated across repeats:
//   • interval: startCycle → endCycle (seconds)
//   • pitch:    startPitch → endPitch (semitones), behind pitchActive toggle
//   • amplitude: derived from ampShape (-1 swell · 0 flat · +1 decay)
//
// Four curve shapes warp the u ∈ [0,1] parameter before interpolation:
//   Linear       — identity ramp
//   Geometric    — log-space on intervals (smooth natural), linear on the rest
//   Exponential  — u^3, lingers at start then snaps to end
//   S-curve      — slow ends, fast middle (cosine ease)
//
// Jitter ∈ [0,1] applies per-repeat randomness to every contour after
// interpolation — ±50% on interval and amp, ±12 st on pitch at max.
//
// randomShape re-rolls startCycle / endCycle / repeats per burst within
// sensible bounds. Pitch / amp / jitter / curveShape / mix stay as user-set.
//
// 50ms musical interval floor preserved. Per-repeat trapezoidal envelope
// (3ms fade in/out, capped at interval/4) kills boundary clicks.

const RING_SECONDS = 0.5
const MIN_INTERVAL_SEC = 0.05
const MAX_REPEATS = 32

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

// u ∈ [0,1] → warped u based on shape code. Shape 1 (geometric) returns
// plain u because the log-space interpolation happens in the value formula.
function warpU(u, shape) {
  if (shape < 0.5) return u                   // 0 linear
  if (shape < 1.5) return u                   // 1 geometric (applied via pow)
  if (shape < 2.5) return u * u * u           // 2 exponential
  return 0.5 - 0.5 * Math.cos(u * Math.PI)    // 3 s-curve
}

class StutterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'active', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mode', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'startCycle', defaultValue: 0.2, minValue: 0.02, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'endCycle', defaultValue: 0.05, minValue: 0.02, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'repeats', defaultValue: 8, minValue: 2, maxValue: MAX_REPEATS, automationRate: 'k-rate' },
      { name: 'autoRate', defaultValue: 1.5, minValue: 0.2, maxValue: 10, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'pitchActive', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'startPitch', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      { name: 'endPitch', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      { name: 'ampShape', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
      { name: 'jitter', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'curveShape', defaultValue: 1, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
      { name: 'randomShape', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }

  constructor() {
    super()
    const ringLen = Math.ceil(sampleRate * RING_SECONDS)
    this.ringL = new Float32Array(ringLen)
    this.ringR = new Float32Array(ringLen)
    this.ringLen = ringLen
    this.ringWrite = 0

    this.inBurst = false
    this.burstSliceStart = 0
    this.burstSliceLen = 0
    this.burstIntervals = new Float32Array(MAX_REPEATS)
    this.burstRates = new Float32Array(MAX_REPEATS)
    this.burstAmps = new Float32Array(MAX_REPEATS)
    this.burstRepeatCount = 0
    this.burstRepeatIdx = 0
    this.burstReadOffset = 0          // output-sample counter since repeat start
    this.burstReadPosF = 0            // fractional source-sample position in slice
    this.burstCurrentInterval = 0

    this.pendingTrigger = false
    this.samplesUntilNextBurst = 0

    this.port.onmessage = (e) => {
      const d = e.data
      if (!d || !d.type) return
      if (d.type === 'trigger') this.pendingTrigger = true
      else if (d.type === 'reset') {
        this.inBurst = false
        this.pendingTrigger = false
        this.samplesUntilNextBurst = 0
      }
    }
  }

  planBurst(params) {
    const floorSamp = Math.floor(MIN_INTERVAL_SEC * sampleRate)
    const randomShape = params.randomShape[0] >= 0.5

    // Effective shape endpoints — either user-set or re-rolled per burst.
    let startCycle = Math.max(MIN_INTERVAL_SEC, params.startCycle[0])
    let endCycle = Math.max(MIN_INTERVAL_SEC, params.endCycle[0])
    let repeats = clamp(Math.round(params.repeats[0]) | 0, 2, MAX_REPEATS)
    if (randomShape) {
      startCycle = 0.03 + Math.random() * 0.27   // 30..300 ms
      endCycle = 0.03 + Math.random() * 0.27
      repeats = 3 + Math.floor(Math.random() * 10)  // 3..12
    }

    const pitchActive = params.pitchActive[0] >= 0.5
    const startPitch = params.startPitch[0]
    const endPitch = params.endPitch[0]
    const ampShape = params.ampShape[0]
    const jitter = clamp(params.jitter[0], 0, 1)
    const curveShape = params.curveShape[0]
    const isGeom = curveShape >= 0.5 && curveShape < 1.5

    const startSamp = Math.max(1, Math.floor(startCycle * sampleRate))
    const endSamp = Math.max(1, Math.floor(endCycle * sampleRate))
    const ratio = endSamp / startSamp

    // amp endpoints from ampShape: +1 decay (1→0), -1 swell (0→1), 0 flat (1→1)
    const ampStart = ampShape >= 0 ? 1 : 1 + ampShape
    const ampEnd = ampShape >= 0 ? 1 - ampShape : 1

    let maxIntervalSamp = 0
    for (let i = 0; i < repeats; i++) {
      const u = repeats === 1 ? 0 : i / (repeats - 1)
      const w = warpU(u, curveShape)

      // Interval — log-space for geometric, linear-on-warped-u otherwise.
      let iv
      if (isGeom) {
        iv = startSamp * Math.pow(ratio, u)
      } else {
        iv = startSamp + (endSamp - startSamp) * w
      }

      // Pitch — linear in semitones, warped u.
      let pitchSt = pitchActive ? (startPitch + (endPitch - startPitch) * w) : 0

      // Amp — linear-on-warped-u between derived endpoints.
      let amp = ampStart + (ampEnd - ampStart) * w

      // Jitter after interpolation so it stacks on top of the shape.
      if (jitter > 0) {
        iv *= 1 + (Math.random() * 2 - 1) * jitter * 0.5
        amp *= 1 + (Math.random() * 2 - 1) * jitter * 0.5
        if (pitchActive) pitchSt += (Math.random() * 2 - 1) * jitter * 12
      }

      iv = Math.max(floorSamp, Math.floor(iv))
      this.burstIntervals[i] = iv
      this.burstRates[i] = Math.pow(2, pitchSt / 12)
      this.burstAmps[i] = clamp(amp, 0, 2)
      if (iv > maxIntervalSamp) maxIntervalSamp = iv
    }

    // Slice size = max interval present in burst (after jitter), capped to
    // ring. Pitched-up repeats that consume source faster still loop via
    // the modulo read in process().
    const sliceSamples = Math.min(this.ringLen, Math.max(floorSamp, maxIntervalSamp))
    this.burstSliceStart = (this.ringWrite - sliceSamples + this.ringLen) % this.ringLen
    this.burstSliceLen = sliceSamples
    this.burstRepeatCount = repeats
    this.burstRepeatIdx = 0
    this.burstReadOffset = 0
    this.burstReadPosF = 0
    this.burstCurrentInterval = this.burstIntervals[0]
    this.inBurst = true
  }

  scheduleNextAutoBurst(autoRate) {
    const u = Math.max(1e-6, Math.random())
    const gapSec = -Math.log(u) / Math.max(0.01, autoRate)
    this.samplesUntilNextBurst = Math.max(1, Math.floor(gapSec * sampleRate))
  }

  process(inputs, outputs, params) {
    const inL = inputs[0]?.[0]
    const inR = inputs[0]?.[1] || inL
    const outL = outputs[0][0]
    const outR = outputs[0][1] || outL
    const n = outL.length
    const active = params.active[0] >= 0.5
    const mode = params.mode[0] >= 0.5 ? 1 : 0
    const mix = params.mix[0]
    const autoRate = params.autoRate[0]

    for (let s = 0; s < n; s++) {
      const drySampL = inL ? inL[s] : 0
      const drySampR = inR ? inR[s] : drySampL

      this.ringL[this.ringWrite] = drySampL
      this.ringR[this.ringWrite] = drySampR
      this.ringWrite = (this.ringWrite + 1) % this.ringLen

      if (active && !this.inBurst) {
        if (mode === 1) {
          if (this.pendingTrigger) {
            this.pendingTrigger = false
            this.planBurst(params)
          }
        } else {
          if (this.samplesUntilNextBurst <= 0) {
            this.planBurst(params)
          } else {
            this.samplesUntilNextBurst--
          }
        }
      }

      let wetL = 0, wetR = 0
      if (this.inBurst) {
        // Fractional read — wrap burstReadPosF within slice for any rate.
        let pos = this.burstReadPosF
        const sliceLen = Math.max(1, this.burstSliceLen)
        if (pos >= sliceLen || pos < 0) {
          pos = ((pos % sliceLen) + sliceLen) % sliceLen
        }
        const pi = Math.floor(pos)
        const frac = pos - pi
        const i0 = (this.burstSliceStart + pi) % this.ringLen
        const i1 = (i0 + 1) % this.ringLen
        wetL = this.ringL[i0] * (1 - frac) + this.ringL[i1] * frac
        wetR = this.ringR[i0] * (1 - frac) + this.ringR[i1] * frac

        // Trapezoidal envelope — output-sample-timed, still fights boundary click.
        const interval = this.burstCurrentInterval
        const outPos = this.burstReadOffset
        const fadeSamples = Math.min(
          Math.floor(0.003 * sampleRate),
          Math.floor(interval / 4)
        )
        let env = 1
        if (fadeSamples > 0) {
          if (outPos < fadeSamples) env = outPos / fadeSamples
          else if (outPos >= interval - fadeSamples) env = Math.max(0, (interval - outPos) / fadeSamples)
        }
        const amp = this.burstAmps[this.burstRepeatIdx]
        wetL *= env * amp
        wetR *= env * amp

        // Advance read head by current repeat's rate (fractional for pitch).
        this.burstReadPosF += this.burstRates[this.burstRepeatIdx]
        this.burstReadOffset++
        if (this.burstReadOffset >= this.burstCurrentInterval) {
          this.burstRepeatIdx++
          if (this.burstRepeatIdx >= this.burstRepeatCount) {
            this.inBurst = false
            if (active && mode === 0) this.scheduleNextAutoBurst(autoRate)
          } else {
            this.burstCurrentInterval = this.burstIntervals[this.burstRepeatIdx]
            this.burstReadOffset = 0
            this.burstReadPosF = 0
          }
        }
      }

      if (this.inBurst) {
        outL[s] = drySampL * (1 - mix) + wetL * mix
        outR[s] = drySampR * (1 - mix) + wetR * mix
      } else {
        outL[s] = drySampL
        outR[s] = drySampR
      }
    }

    if (active && !this.inBurst && mode === 0 && this.samplesUntilNextBurst === 0) {
      this.scheduleNextAutoBurst(autoRate)
    }
    return true
  }
}

registerProcessor('stutter', StutterProcessor)
