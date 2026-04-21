const POOL_SIZE = 64

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
    ]
  }

  constructor() {
    super()
    this.buffers = new Map()
    this.activeBufferId = null
    this.bufferLen = 0
    this.cursor = 0
    this.phaseAccum = 0
    this.constQ = false
    this.voices = new Array(POOL_SIZE)
    for (let i = 0; i < POOL_SIZE; i++) {
      this.voices[i] = { active: false, bufferId: null, readPos: 0, readInc: 1, envPhase: 0, envDur: 1 }
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
    const buf = this.buffers.get(this.activeBufferId)
    if (!buf || !buf[0]) return
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
    const startSample = Math.floor(normPos * this.bufferLen)
    const pitchSemi = pitch + voicePitch + (Math.random() - 0.5) * 2 * pitchSpread
    const rate = Math.pow(2, pitchSemi / 12)
    const maxDur = this.bufferLen - startSample - 10
    const sizeSamples = Math.max(24, Math.min(maxDur, Math.floor(size * sampleRate)))
    if (sizeSamples <= 24) return

    for (let i = 0; i < POOL_SIZE; i++) {
      const v = this.voices[i]
      if (v.active) continue
      v.active = true
      v.bufferId = this.activeBufferId
      v.readPos = startSample
      v.readInc = rate
      v.envPhase = 0
      v.envDur = sizeSamples
      return
    }
  }

  process(inputs, outputs, params) {
    const outDirect = outputs[0]
    const outCq = outputs[1]
    const blockSize = outDirect[0].length

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
      const buf = this.buffers.get(v.bufferId)
      if (!buf) { v.active = false; continue }
      const chL = buf[0]
      const chR = buf.length > 1 ? buf[1] : chL
      const bufLen = chL.length
      let pos = v.readPos, envPhase = v.envPhase
      const envDur = v.envDur
      const inc = v.readInc
      for (let s = 0; s < blockSize; s++) {
        if (envPhase >= envDur) { v.active = false; break }
        const envT = envPhase / envDur
        const env = envT < 0.5 ? envT * 2 : (1 - envT) * 2
        const i0 = pos | 0
        if (i0 >= bufLen - 1) { v.active = false; break }
        const frac = pos - i0
        const sampL = chL[i0] * (1 - frac) + chL[i0 + 1] * frac
        const sampR = chR[i0] * (1 - frac) + chR[i0 + 1] * frac
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
