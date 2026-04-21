// Moving-source pass-by simulation. Replaces the main-thread rAF that hit
// setTargetAtTime(delayTime) + setTargetAtTime(gain) at 60 Hz. Runs entirely
// on the audio thread, emitting two control signals per block:
//   output[0] — delay-time control (seconds, written to DelayNode.delayTime)
//   output[1] — gain control (written to GainNode.gain)
// Main code sets the target AudioParam's baseline to the worklet's rest value
// (delay=0, gain=1) before connecting so summation yields the right result.
// Since the worklet OVERRIDES the summed value here, we output absolute
// target values and main sets param.value = 0 before connecting.

class DopplerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'speed', defaultValue: 0.5, minValue: 0.01, maxValue: 10, automationRate: 'k-rate' },
      { name: 'range', defaultValue: 10, minValue: 0.1, maxValue: 100, automationRate: 'k-rate' },
      { name: 'minDist', defaultValue: 1, minValue: 0.01, maxValue: 100, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'active', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }

  constructor() {
    super()
    this.t = 0
  }

  process(inputs, outputs, params) {
    const outDelay = outputs[0][0]
    const outGain = outputs[1][0]
    const n = outDelay.length
    const active = params.active[0] >= 0.5
    const mix = params.mix[0]
    const speed = params.speed[0]
    const range = params.range[0]
    const minDist = params.minDist[0]

    if (active && mix > 0) {
      // advance time (block-rate is fine for a sub-Hz pass-by)
      this.t += n / sampleRate * speed
      const x = range * Math.sin(this.t * Math.PI * 2)
      const dist = Math.sqrt(x * x + minDist * minDist)
      const delay = Math.min(0.49, dist / 343)
      const amp = minDist / dist
      const tDelay = delay * mix
      const tGain = 1 + (amp - 1) * mix
      for (let i = 0; i < n; i++) { outDelay[i] = tDelay; outGain[i] = tGain }
    } else {
      for (let i = 0; i < n; i++) { outDelay[i] = 0; outGain[i] = 1 }
    }
    return true
  }
}

registerProcessor('doppler', DopplerProcessor)
