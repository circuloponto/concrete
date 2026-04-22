// Spectral freeze — multi-voice grain cloud locked to a position. Replaces a
// main-thread setTimeout loop that at default settings (voices=4, grain=0.06)
// fires at ~133 Hz per voice and allocates a fresh AudioBufferSource + Gain +
// 4 envelope automation points each wake. Six voices with freeze active was
// ~800 node allocations/sec of steady GC pressure.
//
// Design mirrors granulator.worklet.js: pre-allocated voice pool, spawn
// inside process() via phase accumulator, trapezoidal envelope with a 25%
// fade-in / 50% sustain / 25% fade-out shape.

const POOL_SIZE = 32

class FreezeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'pos', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'grain', defaultValue: 0.06, minValue: 0.005, maxValue: 1.0, automationRate: 'k-rate' },
      { name: 'gain', defaultValue: 1, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
      { name: 'pitch', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      { name: 'voicePitch', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      { name: 'voices', defaultValue: 4, minValue: 1, maxValue: 8, automationRate: 'k-rate' },
      { name: 'phase', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'active', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }

  constructor() {
    super()
    this.buffers = new Map()
    this.activeBufferId = null
    this.bufferLen = 0
    this.phaseAccum = 0
    this.voiceIdx = 0
    this.voices = new Array(POOL_SIZE)
    for (let i = 0; i < POOL_SIZE; i++) {
      this.voices[i] = { active: false, bufferId: null, readPos: 0, readInc: 1, envPhase: 0, envDur: 1, fadeLen: 0, amp: 1 }
    }
    this.port.onmessage = (e) => {
      const d = e.data
      if (!d || !d.type) return
      if (d.type === 'loadBuffer') {
        this.buffers.set(d.id, d.channels)
        this.activeBufferId = d.id
        this.bufferLen = d.channels[0].length
      } else if (d.type === 'freeBuffer') {
        this.buffers.delete(d.id)
        if (this.activeBufferId === d.id) this.activeBufferId = null
      } else if (d.type === 'reset') {
        for (const v of this.voices) v.active = false
      }
    }
  }

  spawnGrain(params) {
    const buf = this.buffers.get(this.activeBufferId)
    if (!buf || !buf[0]) return
    const grainSec = params.grain[0]
    const pos = params.pos[0]
    const pitch = params.pitch[0]
    const voicePitch = params.voicePitch[0]
    const phase = params.phase[0]
    const nv = Math.max(1, Math.round(params.voices[0]))

    const vi = this.voiceIdx % nv
    this.voiceIdx = (this.voiceIdx + 1) % nv
    const phaseOffset = phase * (vi / nv) * grainSec
    const startSec = Math.max(0, Math.min((this.bufferLen / sampleRate) - 0.005, pos * (this.bufferLen / sampleRate) + phaseOffset))
    const startSample = Math.floor(startSec * sampleRate)
    const grainSamples = Math.min(Math.floor(grainSec * sampleRate), this.bufferLen - startSample - 1)
    if (grainSamples <= 24) return
    const rate = Math.pow(2, (pitch + voicePitch) / 12)
    const fadeLen = Math.max(1, Math.floor(grainSamples * 0.25))
    const amp = 1 / Math.sqrt(nv)

    for (let i = 0; i < POOL_SIZE; i++) {
      const v = this.voices[i]
      if (v.active) continue
      v.active = true
      v.bufferId = this.activeBufferId
      v.readPos = startSample
      v.readInc = rate
      v.envPhase = 0
      v.envDur = grainSamples
      v.fadeLen = fadeLen
      v.amp = amp
      return
    }
  }

  process(inputs, outputs, params) {
    const out = outputs[0]
    const outL = out[0]
    const outR = out.length > 1 ? out[1] : outL
    const blockSize = outL.length

    outL.fill(0)
    if (outR !== outL) outR.fill(0)

    const active = params.active[0] >= 0.5
    if (active) {
      const grainSec = Math.max(0.005, params.grain[0])
      const nv = Math.max(1, Math.round(params.voices[0]))
      // interval between grain onsets in seconds; density = 1/interval
      const interval = Math.max(0.005, grainSec / 2 / nv)
      const spawnsPerBlock = (blockSize / sampleRate) / interval
      this.phaseAccum += spawnsPerBlock
      while (this.phaseAccum >= 1) {
        this.spawnGrain(params)
        this.phaseAccum -= 1
      }
    }

    const gain = params.gain[0]

    for (let i = 0; i < POOL_SIZE; i++) {
      const v = this.voices[i]
      if (!v.active) continue
      const buf = this.buffers.get(v.bufferId)
      if (!buf) { v.active = false; continue }
      const chL = buf[0]
      const chR = buf.length > 1 ? buf[1] : chL
      const bufLen = chL.length
      let pos = v.readPos
      let envPhase = v.envPhase
      const envDur = v.envDur
      const fadeLen = v.fadeLen
      const inc = v.readInc
      const voiceAmp = v.amp
      for (let s = 0; s < blockSize; s++) {
        if (envPhase >= envDur) { v.active = false; break }
        // trapezoidal envelope: ramp-up fadeLen, sustain, ramp-down fadeLen
        let env
        if (envPhase < fadeLen) env = envPhase / fadeLen
        else if (envPhase > envDur - fadeLen) env = (envDur - envPhase) / fadeLen
        else env = 1
        const i0 = pos | 0
        if (i0 >= bufLen - 1) { v.active = false; break }
        const frac = pos - i0
        const sampL = chL[i0] * (1 - frac) + chL[i0 + 1] * frac
        const sampR = chR[i0] * (1 - frac) + chR[i0 + 1] * frac
        const g = env * voiceAmp * gain
        outL[s] += sampL * g
        if (outR !== outL) outR[s] += sampR * g
        pos += inc
        envPhase += inc
      }
      v.readPos = pos
      v.envPhase = envPhase
    }
    return true
  }
}

registerProcessor('freeze', FreezeProcessor)
