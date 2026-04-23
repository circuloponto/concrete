// Spectral freeze — multi-voice grain cloud locked to a position.
//
// Two modes, selected by `mode` AudioParam:
//   mode = 0  "source"  — grains spawn from the loaded AudioBuffer (via
//                         {type:'loadBuffer'} message). `pos` scrubs the
//                         full source duration. Default for backward compat.
//   mode = 1  "live"    — grains spawn from a 5-second ring buffer that
//                         captures incoming chain audio. `pos` scrubs the
//                         last 5s of processed upstream signal. Enables
//                         freeze to respect effect chain order.
//
// Grain voice structure stores a `source` tag so voices that spawned
// while in one mode continue reading their original source when mode
// flips mid-flight.

const POOL_SIZE = 32
const RING_SECONDS = 5

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
      { name: 'mode', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }

  constructor() {
    super()
    // Source-mode state
    this.buffers = new Map()
    this.activeBufferId = null
    this.bufferLen = 0
    // Live-mode state — 5s stereo ring buffer
    this.ringLen = Math.ceil(RING_SECONDS * sampleRate)
    this.ringL = new Float32Array(this.ringLen)
    this.ringR = new Float32Array(this.ringLen)
    this.ringWrite = 0
    // Voice pool
    this.phaseAccum = 0
    this.voiceIdx = 0
    this.voices = new Array(POOL_SIZE)
    for (let i = 0; i < POOL_SIZE; i++) {
      this.voices[i] = {
        active: false, source: 'source', bufferId: null,
        readPos: 0, readInc: 1, envPhase: 0, envDur: 1, fadeLen: 0, amp: 1,
      }
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
    const mode = params.mode[0] >= 0.5 ? 'live' : 'source'
    const grainSec = params.grain[0]
    const pos = params.pos[0]
    const pitch = params.pitch[0]
    const voicePitch = params.voicePitch[0]
    const phase = params.phase[0]
    const nv = Math.max(1, Math.round(params.voices[0]))
    const vi = this.voiceIdx % nv
    this.voiceIdx = (this.voiceIdx + 1) % nv
    const phaseOffsetSec = phase * (vi / nv) * grainSec
    const grainSamples = Math.max(24, Math.floor(grainSec * sampleRate))

    let source, startSample, bufferId
    if (mode === 'live') {
      if (grainSamples > this.ringLen) return
      // Ring layout: ringWrite is the NEXT write position. Positions
      // ringWrite..ringWrite+ringLen-1 (wrapped) span the 5s window, oldest
      // to newest. pos=0 → oldest, pos=1 → about-to-be-newest.
      const phaseOffsetSamples = Math.floor(phaseOffsetSec * sampleRate)
      const offsetFromOldest = Math.min(
        this.ringLen - grainSamples - 1,
        Math.max(0, Math.floor(pos * this.ringLen) + phaseOffsetSamples),
      )
      startSample = ((this.ringWrite + offsetFromOldest) % this.ringLen + this.ringLen) % this.ringLen
      source = 'ring'
      bufferId = null
    } else {
      const buf = this.buffers.get(this.activeBufferId)
      if (!buf || !buf[0]) return
      const bufLen = buf[0].length
      const startSec = Math.max(0, Math.min((bufLen / sampleRate) - 0.005, pos * (bufLen / sampleRate) + phaseOffsetSec))
      startSample = Math.floor(startSec * sampleRate)
      if (startSample + grainSamples >= bufLen) return
      source = 'source'
      bufferId = this.activeBufferId
    }

    for (let i = 0; i < POOL_SIZE; i++) {
      const v = this.voices[i]
      if (v.active) continue
      v.active = true
      v.source = source
      v.bufferId = bufferId
      v.readPos = startSample
      v.readInc = Math.pow(2, (pitch + voicePitch) / 12)
      v.envPhase = 0
      v.envDur = grainSamples
      v.fadeLen = Math.max(1, Math.floor(grainSamples * 0.25))
      v.amp = 1 / Math.sqrt(nv)
      return
    }
  }

  process(inputs, outputs, params) {
    const inL = inputs[0]?.[0]
    const inR = inputs[0]?.[1] || inL
    const out = outputs[0]
    const outL = out[0]
    const outR = out.length > 1 ? out[1] : outL
    const blockSize = outL.length

    // Always capture chain input into the ring, regardless of mode.
    // Cheap compared to the spawn/playback loop; keeps live-mode ready
    // to respond to the very next spawn if mode flips on.
    if (inL) {
      for (let s = 0; s < blockSize; s++) {
        this.ringL[this.ringWrite] = inL[s]
        this.ringR[this.ringWrite] = inR ? inR[s] : inL[s]
        this.ringWrite = (this.ringWrite + 1) % this.ringLen
      }
    } else {
      for (let s = 0; s < blockSize; s++) {
        this.ringL[this.ringWrite] = 0
        this.ringR[this.ringWrite] = 0
        this.ringWrite = (this.ringWrite + 1) % this.ringLen
      }
    }

    outL.fill(0)
    if (outR !== outL) outR.fill(0)

    const active = params.active[0] >= 0.5
    if (active) {
      const grainSec = Math.max(0.005, params.grain[0])
      const nv = Math.max(1, Math.round(params.voices[0]))
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
      const isRing = v.source === 'ring'
      let chL, chR, bufLen
      if (isRing) {
        chL = this.ringL; chR = this.ringR; bufLen = this.ringLen
      } else {
        const buf = this.buffers.get(v.bufferId)
        if (!buf) { v.active = false; continue }
        chL = buf[0]; chR = buf.length > 1 ? buf[1] : buf[0]; bufLen = chL.length
      }
      let pos = v.readPos
      let envPhase = v.envPhase
      const envDur = v.envDur
      const fadeLen = v.fadeLen
      const inc = v.readInc
      const voiceAmp = v.amp
      for (let s = 0; s < blockSize; s++) {
        if (envPhase >= envDur) { v.active = false; break }
        let env
        if (envPhase < fadeLen) env = envPhase / fadeLen
        else if (envPhase > envDur - fadeLen) env = (envDur - envPhase) / fadeLen
        else env = 1
        let i0, i1, frac
        if (isRing) {
          const wp = ((pos % bufLen) + bufLen) % bufLen
          i0 = wp | 0
          i1 = (i0 + 1) % bufLen
          frac = wp - i0
        } else {
          i0 = pos | 0
          if (i0 >= bufLen - 1) { v.active = false; break }
          i1 = i0 + 1
          frac = pos - i0
        }
        const sampL = chL[i0] * (1 - frac) + chL[i1] * frac
        const sampR = chR[i0] * (1 - frac) + chR[i1] * frac
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
