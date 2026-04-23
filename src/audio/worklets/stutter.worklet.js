// Stutter / beat-repeat with explicit start/end cycle times.
//
// Two modes:
//   AUTO (mode = 0)    — bursts fire at random Poisson-distributed intervals
//                        with mean 1 / autoRate. Between bursts, dry passes
//                        through. "Random stutters" happen automatically
//                        while active.
//   MANUAL (mode = 1)  — bursts only fire on {type:'trigger'} port message.
//                        User performs the stutters by pressing a button.
//
// Burst shape is set by startCycle + endCycle + repeats:
//   - intervals are geometrically interpolated between the two endpoints
//   - interval_0 = startCycle, interval_{repeats-1} = endCycle
//   - startCycle > endCycle → accelerating ("gunfire windup")
//   - startCycle < endCycle → decelerating ("ricochet trail")
//   - startCycle = endCycle → flat
//
// Each repeat gets a trapezoidal envelope (3ms fade in/out, capped at
// interval/4) to kill the boundary click from the non-zero slice-start
// sample value.
//
// Musical cap: 50ms interval floor keeps fast accel from crossing into
// audio-rate buzz.

const RING_SECONDS = 0.5
const MIN_INTERVAL_SEC = 0.05
const MAX_REPEATS = 32

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

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
    this.burstRepeatCount = 0
    this.burstRepeatIdx = 0
    this.burstReadOffset = 0
    this.burstCurrentInterval = 0

    this.pendingTrigger = false
    this.samplesUntilNextBurst = 0  // auto-mode countdown

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

  planBurst(startCycle, endCycle, repeats) {
    const floorSamp = Math.floor(MIN_INTERVAL_SEC * sampleRate)
    // Geometric interpolation feels more musical for accel/decel than linear.
    // With a single-repeat guard (ratio undefined), fall back to startCycle.
    const startSamp = Math.floor(startCycle * sampleRate)
    const endSamp = Math.floor(endCycle * sampleRate)
    if (repeats <= 1) {
      this.burstIntervals[0] = Math.max(floorSamp, startSamp)
      return
    }
    const ratio = Math.pow(endSamp / Math.max(1, startSamp), 1 / (repeats - 1))
    for (let i = 0; i < repeats; i++) {
      const iv = Math.max(floorSamp, Math.floor(startSamp * Math.pow(ratio, i)))
      this.burstIntervals[i] = iv
    }
  }

  startBurst(params) {
    const startCycle = Math.max(MIN_INTERVAL_SEC, params.startCycle[0])
    const endCycle = Math.max(MIN_INTERVAL_SEC, params.endCycle[0])
    const repeats = clamp(Math.round(params.repeats[0]) | 0, 2, MAX_REPEATS)
    // Slice size = the larger of the two cycles so the slice buffer always
    // has enough material for any repeat length. Capped by ring duration.
    const sliceSec = Math.min(RING_SECONDS, Math.max(startCycle, endCycle))
    const sliceSamples = Math.floor(sliceSec * sampleRate)

    this.planBurst(startCycle, endCycle, repeats)
    this.burstSliceStart = (this.ringWrite - sliceSamples + this.ringLen) % this.ringLen
    this.burstSliceLen = sliceSamples
    this.burstRepeatCount = repeats
    this.burstRepeatIdx = 0
    this.burstReadOffset = 0
    this.burstCurrentInterval = this.burstIntervals[0]
    this.inBurst = true
  }

  scheduleNextAutoBurst(autoRate) {
    // Exponential-distributed gap: mean = 1/autoRate seconds.
    // -ln(U) / rate. Clamp U away from 0 so log stays finite.
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
    const mode = params.mode[0] >= 0.5 ? 1 : 0  // 0 auto, 1 manual
    const mix = params.mix[0]
    const autoRate = params.autoRate[0]

    for (let s = 0; s < n; s++) {
      const drySampL = inL ? inL[s] : 0
      const drySampR = inR ? inR[s] : drySampL

      // Ring capture always runs — a burst started later references
      // whatever was live at burst-start time.
      this.ringL[this.ringWrite] = drySampL
      this.ringR[this.ringWrite] = drySampR
      this.ringWrite = (this.ringWrite + 1) % this.ringLen

      // Burst start conditions
      if (active && !this.inBurst) {
        if (mode === 1) {
          // Manual: fire only on pending trigger
          if (this.pendingTrigger) {
            this.pendingTrigger = false
            this.startBurst(params)
          }
        } else {
          // Auto: countdown toward next scheduled burst
          if (this.samplesUntilNextBurst <= 0) {
            this.startBurst(params)
          } else {
            this.samplesUntilNextBurst--
          }
        }
      }

      let wetL = 0, wetR = 0
      if (this.inBurst) {
        const rel = this.burstReadOffset % Math.max(1, this.burstSliceLen)
        const ri = (this.burstSliceStart + rel) % this.ringLen
        wetL = this.ringL[ri]
        wetR = this.ringR[ri]

        // Trapezoidal envelope per repeat — kills click at slice-start.
        const interval = this.burstCurrentInterval
        const pos = this.burstReadOffset
        const fadeSamples = Math.min(
          Math.floor(0.003 * sampleRate),
          Math.floor(interval / 4)
        )
        let env = 1
        if (fadeSamples > 0) {
          if (pos < fadeSamples) env = pos / fadeSamples
          else if (pos >= interval - fadeSamples) env = Math.max(0, (interval - pos) / fadeSamples)
        }
        wetL *= env
        wetR *= env

        this.burstReadOffset++
        if (this.burstReadOffset >= this.burstCurrentInterval) {
          this.burstRepeatIdx++
          if (this.burstRepeatIdx >= this.burstRepeatCount) {
            this.inBurst = false
            // After a burst completes, if auto mode is active, schedule the
            // next burst. Manual mode waits for another trigger message.
            if (active && mode === 0) this.scheduleNextAutoBurst(autoRate)
          } else {
            this.burstCurrentInterval = this.burstIntervals[this.burstRepeatIdx]
            this.burstReadOffset = 0
          }
        }
      }

      // Wet replaces dry inside a burst per the mix slider.
      if (this.inBurst) {
        outL[s] = drySampL * (1 - mix) + wetL * mix
        outR[s] = drySampR * (1 - mix) + wetR * mix
      } else {
        outL[s] = drySampL
        outR[s] = drySampR
      }
    }

    // If active just flipped on from off, kick the auto-mode timer so
    // the first burst fires on a natural-feeling delay (not immediately).
    if (active && !this.inBurst && mode === 0 && this.samplesUntilNextBurst === 0) {
      this.scheduleNextAutoBurst(autoRate)
    }
    return true
  }
}

registerProcessor('stutter', StutterProcessor)
