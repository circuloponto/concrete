// UVI-Phase-style phase rotator for a single voice channel.
// Hilbert-pair architecture: input fans into a delay-aligned "real" path
// and a Hilbert-filtered "imaginary" path. Two gains (cos θ, sin θ) sum
// the paths so a θ slider rotates the phase spectrum without altering the
// magnitude spectrum (transients smear/sharpen, harmonic content stays).
//
// Optional 3-band detail mode wraps the rotator inside a 3-way Linkwitz-
// Riley split so LF / MF / HF can each have their own rotation angle.
// Optional envelope follower scales a wet/dry crossfade by detected
// transient amplitude, so attacks get more rotation than steady state.

const HILBERT_LEN = 511     // odd → exact group delay = (LEN-1)/2 samples
const HILBERT_DELAY = (HILBERT_LEN - 1) / 2

// h[n] for a discrete Hilbert filter, Hann-windowed, length L (odd).
function buildHilbertIR(ctx, length = HILBERT_LEN) {
  const buf = ctx.createBuffer(1, length, ctx.sampleRate)
  const h = buf.getChannelData(0)
  const center = (length - 1) / 2
  for (let i = 0; i < length; i++) {
    const n = i - center
    let v = 0
    if (n !== 0) {
      // ideal Hilbert kernel: 2/(πn) when n is odd, 0 when n is even
      v = (n & 1) ? (2 / (Math.PI * n)) : 0
    }
    // Hann window
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1))
    h[i] = v * w
  }
  return buf
}

// One rotator unit: input → (delay + convolver) → cos/sin gains → output.
// setAngle writes cos(θ) and sin(θ) to the two gains.
function buildRotatorUnit(ctx, hilbertIR) {
  const input = ctx.createGain()
  const output = ctx.createGain()
  // Real path: delay-match the Hilbert filter's group delay.
  const realDelay = ctx.createDelay(1.0)
  realDelay.delayTime.value = HILBERT_DELAY / ctx.sampleRate
  // Imaginary path: convolution with the Hilbert kernel.
  const hilbertConv = ctx.createConvolver()
  hilbertConv.normalize = false
  hilbertConv.buffer = hilbertIR
  // Mix gains.
  const realGain = ctx.createGain(); realGain.gain.value = 1   // cos(0) = 1
  const imagGain = ctx.createGain(); imagGain.gain.value = 0   // sin(0) = 0

  input.connect(realDelay); realDelay.connect(realGain); realGain.connect(output)
  input.connect(hilbertConv); hilbertConv.connect(imagGain); imagGain.connect(output)

  const setAngle = (deg) => {
    const r = (deg * Math.PI) / 180
    const t = ctx.currentTime
    realGain.gain.setTargetAtTime(Math.cos(r), t, 0.01)
    imagGain.gain.setTargetAtTime(Math.sin(r), t, 0.01)
  }

  const dispose = () => {
    try { input.disconnect() } catch {}
    try { realDelay.disconnect() } catch {}
    try { hilbertConv.disconnect() } catch {}
    try { realGain.disconnect() } catch {}
    try { imagGain.disconnect() } catch {}
    try { output.disconnect() } catch {}
  }

  return { input, output, setAngle, dispose }
}

// Linkwitz-Riley 4th-order crossover at `freq` Hz: two cascaded biquads
// per side. Returns { input, low, high, dispose } where low/high are
// the band outputs (each is itself the second filter in its cascade so
// we just expose them as-is — they need to be summed together to get
// allpass-equivalent behavior).
function buildLR4(ctx, freq) {
  const input = ctx.createGain()
  const lp1 = ctx.createBiquadFilter(); lp1.type = 'lowpass';  lp1.frequency.value = freq; lp1.Q.value = Math.SQRT1_2
  const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass';  lp2.frequency.value = freq; lp2.Q.value = Math.SQRT1_2
  const hp1 = ctx.createBiquadFilter(); hp1.type = 'highpass'; hp1.frequency.value = freq; hp1.Q.value = Math.SQRT1_2
  const hp2 = ctx.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = freq; hp2.Q.value = Math.SQRT1_2
  input.connect(lp1); lp1.connect(lp2)
  input.connect(hp1); hp1.connect(hp2)
  return {
    input, low: lp2, high: hp2,
    dispose: () => {
      try { input.disconnect() } catch {}
      ;[lp1, lp2, hp1, hp2].forEach(n => { try { n.disconnect() } catch {} })
    }
  }
}

// Public factory.
//
// Returned API:
//   { input, output,
//     setAngle(deg)            — global angle (used when detail is off)
//     setBandAngles(lo, mi, hi) — used when detail is on
//     setDetail(bool)
//     setMix(0..1)             — wet/dry crossfade
//     setFollowerActive(bool)
//     setFollowerAmount(0..1)
//     dispose() }
export function buildPhaseRotator(ctx) {
  const input = ctx.createGain()
  const output = ctx.createGain()

  const hilbertIR = buildHilbertIR(ctx)

  // The pre-rotation tap goes through a copy of the Hilbert delay so
  // the dry signal is sample-aligned with the wet — otherwise the mix
  // crossfade would comb-filter at low wet values.
  const dryDelay = ctx.createDelay(1.0)
  dryDelay.delayTime.value = HILBERT_DELAY / ctx.sampleRate
  input.connect(dryDelay)

  // Single global rotator (always wired).
  const global = buildRotatorUnit(ctx, hilbertIR)
  input.connect(global.input)

  // 3-band detail rotators (built lazily on first detail enable).
  let detail = null

  // Wet sum bus — both global and detail paths land here.
  const wetSum = ctx.createGain(); wetSum.gain.value = 1
  global.output.connect(wetSum)

  // Wet/dry mix: a manual amount + an envelope-driven amount summed at
  // the wet-gain AudioParam so the follower can be enabled/disabled
  // without rewiring the chain.
  const wetGain = ctx.createGain(); wetGain.gain.value = 1
  const dryGain = ctx.createGain(); dryGain.gain.value = 0
  wetSum.connect(wetGain); wetGain.connect(output)
  dryDelay.connect(dryGain); dryGain.connect(output)

  // Envelope follower: WaveShaper(abs) → LPF → followerGain → wetGain.gain
  const envShaper = ctx.createWaveShaper()
  // 256-point full-wave rectifier curve.
  const envCurve = new Float32Array(256)
  for (let i = 0; i < 256; i++) envCurve[i] = Math.abs((i / 255) * 2 - 1)
  envShaper.curve = envCurve
  const envLPF = ctx.createBiquadFilter(); envLPF.type = 'lowpass'; envLPF.frequency.value = 30; envLPF.Q.value = 0.7
  // followerGain scales the envelope's contribution to the wet param.
  // Connected to wetGain.gain so it ADDS to the manual base value.
  const followerGain = ctx.createGain(); followerGain.gain.value = 0
  input.connect(envShaper); envShaper.connect(envLPF); envLPF.connect(followerGain); followerGain.connect(wetGain.gain)

  // State held by the closure for re-applying when detail toggles.
  let manualMix = 1
  let globalDeg = 0
  let bandLoDeg = 0, bandMiDeg = 0, bandHiDeg = 0
  let detailOn = false
  let followerOn = false
  let followerAmt = 0.5

  const applyAngles = () => {
    if (!detailOn) {
      global.setAngle(globalDeg)
      if (detail) {
        // Mute detail output by setting all band rotator angles to 0
        // and silencing the detail wet sum contribution. We just leave
        // it built but disconnected from wetSum below.
      }
    } else {
      // In detail mode, route global to 0° (effectively pass-through real)
      global.setAngle(0)
      if (detail) {
        detail.lowRot.setAngle(bandLoDeg)
        detail.midRot.setAngle(bandMiDeg)
        detail.highRot.setAngle(bandHiDeg)
      }
    }
  }

  const buildDetail = () => {
    if (detail) return
    const xLow = buildLR4(ctx, 250)   // LF / (MF+HF)
    const xMid = buildLR4(ctx, 2500)  // MF / HF (applied to the high side of xLow)
    const lowRot = buildRotatorUnit(ctx, hilbertIR)
    const midRot = buildRotatorUnit(ctx, hilbertIR)
    const highRot = buildRotatorUnit(ctx, hilbertIR)
    const sum = ctx.createGain(); sum.gain.value = 1

    input.connect(xLow.input)
    xLow.low.connect(lowRot.input); lowRot.output.connect(sum)
    xLow.high.connect(xMid.input)
    xMid.low.connect(midRot.input); midRot.output.connect(sum)
    xMid.high.connect(highRot.input); highRot.output.connect(sum)

    detail = { xLow, xMid, lowRot, midRot, highRot, sum }
  }

  const setDetail = (on) => {
    if (on && !detail) buildDetail()
    if (on) {
      // Disconnect global from wetSum, connect detail.sum instead.
      try { global.output.disconnect(wetSum) } catch {}
      try { detail.sum.connect(wetSum) } catch {}
      detailOn = true
    } else {
      if (detail) { try { detail.sum.disconnect(wetSum) } catch {} }
      try { global.output.connect(wetSum) } catch {}
      detailOn = false
    }
    applyAngles()
  }

  const applyMix = () => {
    const t = ctx.currentTime
    // dryGain = 1 - manualMix (manual mix ranges 0..1; full wet → dryGain=0)
    dryGain.gain.setTargetAtTime(1 - manualMix, t, 0.01)
    // wetGain manual base = manualMix; envelope adds via audio-rate input
    wetGain.gain.setTargetAtTime(manualMix, t, 0.01)
    // follower contribution scale
    followerGain.gain.setTargetAtTime(followerOn ? followerAmt : 0, t, 0.01)
  }

  const setAngle = (deg) => { globalDeg = deg; applyAngles() }
  const setBandAngles = (lo, mi, hi) => {
    bandLoDeg = lo; bandMiDeg = mi; bandHiDeg = hi; applyAngles()
  }
  const setMix = (m) => { manualMix = Math.max(0, Math.min(1, m)); applyMix() }
  const setFollowerActive = (on) => { followerOn = !!on; applyMix() }
  const setFollowerAmount = (a) => { followerAmt = Math.max(0, Math.min(1, a)); applyMix() }

  applyMix()

  const dispose = () => {
    try { input.disconnect() } catch {}
    try { dryDelay.disconnect() } catch {}
    global.dispose()
    if (detail) {
      detail.xLow.dispose()
      detail.xMid.dispose()
      detail.lowRot.dispose()
      detail.midRot.dispose()
      detail.highRot.dispose()
      try { detail.sum.disconnect() } catch {}
    }
    try { wetSum.disconnect() } catch {}
    try { wetGain.disconnect() } catch {}
    try { dryGain.disconnect() } catch {}
    try { envShaper.disconnect() } catch {}
    try { envLPF.disconnect() } catch {}
    try { followerGain.disconnect() } catch {}
    try { output.disconnect() } catch {}
  }

  return {
    input, output,
    setAngle, setBandAngles, setDetail, setMix,
    setFollowerActive, setFollowerAmount,
    dispose,
  }
}
