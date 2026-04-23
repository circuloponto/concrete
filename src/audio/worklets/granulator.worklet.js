// Granulator — pre-allocated voice pool, sample-accurate spawn in process().
//
// Two modes, selected by `mode` AudioParam:
//   mode = 0  "source"  — grains spawn from the loaded AudioBuffer (via
//                         {type:'loadBuffer'} message). `pos` scrubs the
//                         full source duration. Default for backward compat.
//   mode = 1  "live"    — grains spawn from a 5-second ring buffer that
//                         captures incoming chain audio. `pos` scrubs the
//                         last 5s of processed upstream signal. Enables
//                         granulator to respect effect chain order.
//
// Each voice stores a `source` tag so voices spawned in one mode finish
// reading from that source if mode flips mid-flight.

const POOL_SIZE = 64
const RING_SECONDS = 5

class GrainProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'density', defaultValue: 20, minValue: 0.1, maxValue: 500, automationRate: 'k-rate' },
      { name: 'size', defaultValue: 0.08, minValue: 0.005, maxValue: 2.0, automationRate: 'k-rate' },
      { name: 'pos', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'drift', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
      { name: 'spray', defaultValue: 0.02, minValue: 0, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'pitch', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      { name: 'pitchSpread', defaultValue: 0, minValue: 0, maxValue: 24, automationRate: 'k-rate' },
      { name: 'voicePitch', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      { name: 'gain', defaultValue: 1, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
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
    this.cursor = 0
    this.phaseAccum = 0
    this.constQ = false
    this.voices = new Array(POOL_SIZE)
    for (let i = 0; i < POOL_SIZE; i++) {
      this.voices[i] = {
        active: false, source: 'source', bufferId: null,
        readPos: 0, readInc: 1, envPhase: 0, envDur: 1,
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
      } else if (d.type === 'setActiveBuffer') {
        if (this.buffers.has(d.id)) {
          this.activeBufferId = d.id
          this.bufferLen = this.buffers.get(d.id)[0].length
        }
      } else if (d.type === 'setConstQ') {
        this.constQ = !!d.enabled
      } else if (d.type === 'reset') {
        for (const v of this.voices) v.active = false
      }
    }
  }

  spawnGrain(params) {
    const mode = params.mode[0] >= 0.5 ? 'live' : 'source'
    const size = params.size[0]
    const drift = params.drift[0]
    const spray = params.spray[0]
    const pitch = params.pitch[0]
    const pitchSpread = params.pitchSpread[0]
    const voicePitch = params.voicePitch[0]

    if (drift !== 0) this.cursor = ((this.cursor + drift * 0.01) % 1 + 1) % 1
    else this.cursor = params.pos[0]

    const sprayed = this.cursor + (Math.random() - 0.5) * 2 * spray
    const normPos = ((sprayed % 1) + 1) % 1
    const pitchSemi = pitch + voicePitch + (Math.random() - 0.5) * 2 * pitchSpread
    const rate = Math.pow(2, pitchSemi / 12)
    const sizeSamples = Math.max(24, Math.floor(size * sampleRate))

    let source, startSample, bufferId, maxDur
    if (mode === 'live') {
      if (sizeSamples > this.ringLen - 2) return
      // pos=0 → oldest sample in ring (about to be overwritten); pos=1 →
      // about-to-be-newest. Clamp so the grain fits inside the window.
      const offsetFromOldest = Math.min(
        this.ringLen - sizeSamples - 1,
        Math.max(0, Math.floor(normPos * this.ringLen)),
      )
      startSample = ((this.ringWrite + offsetFromOldest) % this.ringLen + this.ringLen) % this.ringLen
      source = 'ring'
      bufferId = null
      maxDur = sizeSamples
    } else {
      const buf = this.buffers.get(this.activeBufferId)
      if (!buf || !buf[0]) return
      startSample = Math.floor(normPos * this.bufferLen)
      maxDur = this.bufferLen - startSample - 10
      const capped = Math.max(24, Math.min(maxDur, sizeSamples))
      if (capped <= 24) return
      source = 'source'
      bufferId = this.activeBufferId
      maxDur = capped
    }

    for (let i = 0; i < POOL_SIZE; i++) {
      const v = this.voices[i]
      if (v.active) continue
      v.active = true
      v.source = source
      v.bufferId = bufferId
      v.readPos = startSample
      v.readInc = rate
      v.envPhase = 0
      v.envDur = maxDur
      return
    }
  }

  process(inputs, outputs, params) {
    const inL = inputs[0]?.[0]
    const inR = inputs[0]?.[1] || inL
    const outDirect = outputs[0]
    const outCq = outputs[1]
    const blockSize = outDirect[0].length

    // Always capture chain input into the ring, regardless of mode.
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

    for (let c = 0; c < outDirect.length; c++) outDirect[c].fill(0)
    for (let c = 0; c < outCq.length; c++) outCq[c].fill(0)

    const density = Math.max(0.001, params.density[0])
    const active = params.active[0] >= 0.5
    const gain = params.gain[0]

    if (active) {
      const spawnsPerBlock = density * blockSize / sampleRate
      this.phaseAccum += spawnsPerBlock
      while (this.phaseAccum >= 1) {
        this.spawnGrain(params)
        this.phaseAccum -= 1
      }
    }

    const out = this.constQ ? outCq : outDirect
    const outL = out[0]
    const outR = out.length > 1 ? out[1] : null

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
        chL = buf[0]; chR = buf.length > 1 ? buf[1] : chL; bufLen = chL.length
      }
      let pos = v.readPos, envPhase = v.envPhase
      const envDur = v.envDur
      const inc = v.readInc
      for (let s = 0; s < blockSize; s++) {
        if (envPhase >= envDur) { v.active = false; break }
        const envT = envPhase / envDur
        const env = envT < 0.5 ? envT * 2 : (1 - envT) * 2
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
        const g = env * gain
        outL[s] += sampL * g
        if (outR) outR[s] += sampR * g
        pos += inc
        envPhase += inc
      }
      v.readPos = pos
      v.envPhase = envPhase
    }
    return true
  }
}

registerProcessor('granulator', GrainProcessor)
