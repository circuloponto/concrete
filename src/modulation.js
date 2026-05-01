// Modulation system — LFOs that write directly to audio-node params,
// bypassing React state so there's no re-render per frame.

export function lfoWave(wave, rate, t, phase = 0) {
  const p = ((t * rate + phase) % 1 + 1) % 1
  switch (wave) {
    case 'sine': return Math.sin(p * Math.PI * 2)
    case 'triangle': return p < 0.5 ? p * 4 - 1 : 3 - p * 4
    case 'square': return p < 0.5 ? 1 : -1
    case 'saw': return p * 2 - 1
    case 'ramp': return 1 - p * 2
    case 'random':
      // deterministic per integer period — S&H style
      return randSH(Math.floor(t * rate + phase))
    default: return 0
  }
}

// Hash-based pseudo-random for Sample & Hold so it's repeatable.
function randSH(i) {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453
  return (x - Math.floor(x)) * 2 - 1
}

// Declarative spec for every modulatable parameter.
// apply(nodes, shifter, val) writes to the audio graph without touching React.
export const MOD_SPEC = {
  tempo: {
    label: 'Speed', min: 0.25, max: 4,
    apply: (_nodes, shifter, val) => { if (shifter) shifter.tempo = val },
  },
  pitch: {
    label: 'Pitch', min: -24, max: 24,
    apply: (_nodes, shifter, val) => { if (shifter) shifter.pitchSemitones = val },
  },
  voiceGain: {
    label: 'Gain', min: 0, max: 1.5,
    apply: (n, _s, val) => { n.master.gain.value = val },
  },
  filterHz: {
    label: 'Cutoff', min: 40, max: 18000,
    apply: (n, _s, val) => { n.filter.frequency.value = val },
  },
  filterQ: {
    label: 'Resonance', min: 0.1, max: 20,
    apply: (n, _s, val) => { n.filter.Q.value = val },
  },
  ringFreq: {
    label: 'Ring Freq', min: 1, max: 2000,
    apply: (n, _s, val) => { n.ringOsc.frequency.value = val },
  },
  ringAmount: {
    label: 'Ring Amt', min: 0, max: 1,
    apply: (n, _s, val) => {
      n.ringDry.gain.value = 1 - val
      n.ringMix.gain.value = val
    },
  },
  flangerRate: {
    label: 'Flanger Rate', min: 0.01, max: 5,
    apply: (n, _s, val) => { n.flangerLfo.frequency.value = Math.max(0.01, val) },
  },
  flangerDepth: {
    label: 'Flanger Depth', min: 0, max: 1,
    apply: (n, _s, val) => { n.flangerDepthGain.gain.value = val * 0.002 },
  },
  flangerFb: {
    label: 'Flanger FB', min: 0, max: 0.95,
    apply: (n, _s, val) => { n.flangerFbGain.gain.value = val },
  },
  flangerMix: {
    label: 'Flanger Mix', min: 0, max: 1,
    apply: (n, _s, val) => { n.flangerMixGain.gain.value = val },
  },
  tremRate: {
    label: 'Trem Rate', min: 0.1, max: 20,
    apply: (n, _s, val) => { n.tremoloLfo.frequency.value = Math.max(0.01, val) },
  },
  tremDepth: {
    label: 'Trem Depth', min: 0, max: 1,
    apply: (n, _s, val) => {
      n.tremoloGain.gain.value = 1 - val / 2
      n.tremoloDepthGain.gain.value = val / 2
    },
  },
  panRate: {
    label: 'Pan Rate', min: 0.05, max: 20,
    apply: (n, _s, val) => { n.panLfo.frequency.value = Math.max(0.01, val) },
  },
  panDepth: {
    label: 'Pan Depth', min: 0, max: 1,
    apply: (n, _s, val) => { n.panDepthGain.gain.value = val },
  },
  panCenter: {
    label: 'Pan Center', min: -1, max: 1,
    apply: (n, _s, val) => { n.autoPan.pan.value = val },
  },
  wowRate: {
    label: 'Wow Rate', min: 0, max: 10,
    apply: (n, _s, val) => { n.wowLfo.frequency.value = Math.max(0.01, val) },
  },
  wowDepth: {
    label: 'Wow Depth', min: 0, max: 1,
    apply: (n, _s, val) => { n.wowDepthGain.gain.value = val * 0.005 },
  },
  delayTime: {
    label: 'Delay Time', min: 0, max: 1.5,
    apply: (n, _s, val) => { n.tapeDelay.delayTime.value = Math.max(0, val) },
  },
  delayFb: {
    label: 'Delay FB', min: 0, max: 0.95,
    apply: (n, _s, val) => { n.tapeFbGain.gain.value = val },
  },
  wet: {
    label: 'Delay Wet', min: 0, max: 1,
    apply: (n, _s, val) => { n.tapeWetGain.gain.value = val },
  },
  reverbWet: {
    label: 'Reverb Wet', min: 0, max: 1,
    apply: (n, _s, val) => { n.reverbWetGain.gain.value = val },
  },
  // granulator params that make sense to modulate continuously
  granPos: {
    label: 'Grain Pos', min: 0, max: 1,
    apply: (_n, _s, _val) => { /* handled by granRef cursor */ },
  },
  granDensity: {
    label: 'Grain Density', min: 1, max: 100,
    apply: (_n, _s, _val) => { /* handled by granRef in scheduler */ },
  },
  granPitch: {
    label: 'Grain Pitch', min: -24, max: 24,
    apply: (_n, _s, _val) => { /* read from granRef */ },
  },
  dopplerSpeed: {
    label: 'Doppler Speed', min: 0.05, max: 5,
    apply: (_n, _s, _val) => { /* read from dopplerRef */ },
  },
  freezeMix: {
    label: 'Freeze Mix', min: 0, max: 1,
    apply: (n, _s, val) => { if (n.freezeMixGain) n.freezeMixGain.gain.value = val },
  },
  freezePos: {
    label: 'Freeze Pos', min: 0, max: 1,
    apply: (_n, _s, _val) => { /* read from freezeRef */ },
  },
}

export function applyModulation(state, nodes, shifter, skipKeys) {
  if (!nodes || !state.modulators) return
  const now = performance.now() / 1000
  const mods = state.modulators
  for (const key in mods) {
    if (skipKeys && skipKeys.has(key)) continue
    const m = mods[key]
    if (!m || !m.enabled) continue
    const spec = MOD_SPEC[key]
    if (!spec) continue
    const base = state[key]
    if (typeof base !== 'number') continue
    const lfo = lfoWave(m.wave || 'sine', m.rate || 1, now, m.phase || 0)
    const range = spec.max - spec.min
    const value = base + lfo * (m.depth || 0) * (range / 2)
    const clamped = Math.max(spec.min, Math.min(spec.max, value))
    try { spec.apply(nodes, shifter, clamped) } catch {}
  }
}

export const DEFAULT_MOD = { enabled: true, wave: 'sine', rate: 1, depth: 0.3 }

// Default for an entry in `autoMods` (the generative modal). Same shape as
// a manual modulator, plus separate from it (manual + auto are independent
// layers; manual M wins if both target the same parameter).
export const DEFAULT_AUTO_MOD = { enabled: true, wave: 'sine', rate: 0.4, depth: 0.5 }

// Generative modulation layer. Each enabled entry in `autoMods` runs its
// own LFO with a random phase + rate jitter + start delay so the parameters
// drift relative to each other instead of all firing in lock-step.
//
// `randomRef.current` is a Map keyed by paramKey, each value holding
// { phase, rateMul, startSec, t0 }. The caller is responsible for rolling
// fresh random values via rollAutoRandom() — typically on master toggle on
// or when the "scramble" button is hit.
export function applyAutoModulation(state, nodes, shifter, randomRef, skipKeys) {
  if (!nodes || !state.autoMods || !state.autoActive) return
  const now = performance.now() / 1000
  const mods = state.autoMods
  const rndMap = randomRef?.current
  // 1-pole smoother per param so .value writes don't snap on every tick.
  // alpha ≈ 0.18 with a 30 Hz tick → ~150 ms time constant. Prevents
  // zipper noise + masks the small discontinuities from scramble re-rolls.
  if (!randomRef.smoothed) randomRef.smoothed = new Map()
  const smoothMap = randomRef.smoothed
  const ALPHA = 0.18
  for (const key in mods) {
    if (skipKeys && skipKeys.has(key)) continue
    const manual = state.modulators?.[key]
    if (manual?.enabled) { smoothMap.delete(key); continue }
    const m = mods[key]
    if (!m || !m.enabled) { smoothMap.delete(key); continue }
    const spec = MOD_SPEC[key]
    if (!spec) continue
    const base = state[key]
    if (typeof base !== 'number') continue
    const r = rndMap?.get(key) || { phase: 0, rateMul: 1, startSec: 0, t0: now }
    const elapsed = now - r.t0
    if (elapsed < r.startSec) { smoothMap.delete(key); continue }
    const effRate = (m.rate || 1) * (r.rateMul || 1)
    const lfo = lfoWave(m.wave || 'sine', effRate, now, r.phase || 0)
    const range = spec.max - spec.min
    const target = base + lfo * (m.depth || 0) * (range / 2)
    const clamped = Math.max(spec.min, Math.min(spec.max, target))
    // First tick after activation: seed the smoother at base so the very
    // first written value isn't a hard step from base to base+offset.
    const prev = smoothMap.has(key) ? smoothMap.get(key) : base
    const next = prev + (clamped - prev) * ALPHA
    smoothMap.set(key, next)
    try { spec.apply(nodes, shifter, next) } catch {}
  }
}

// Re-roll the per-mod random offsets. Pass the global controls so each
// keeps its own phase ∈ [0,1), rateMul ∈ [1-jitter, 1+jitter], and
// startSec ∈ [0, maxStartDelay].
export function rollAutoRandom(randomRef, autoMods, phaseScramble, rateJitter, maxStartDelay) {
  if (!randomRef) return
  const map = randomRef.current || new Map()
  const t0 = performance.now() / 1000
  const ps = Math.max(0, Math.min(1, phaseScramble || 0))
  const rj = Math.max(0, Math.min(1, rateJitter || 0))
  const md = Math.max(0, maxStartDelay || 0)
  for (const key in (autoMods || {})) {
    const phase = ps * Math.random()
    const rateMul = 1 + rj * (Math.random() * 2 - 1)
    const startSec = md * Math.random()
    map.set(key, { phase, rateMul, startSec, t0 })
  }
  randomRef.current = map
  // Don't clear randomRef.smoothed: we want the smoother to ease into the
  // new phase/rate values rather than snap. The next tick will lerp from
  // the existing smoothed value toward the new LFO output.
}
