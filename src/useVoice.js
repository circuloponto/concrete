import { useRef, useState, useEffect, useCallback } from 'react'
import { PitchShifter } from 'soundtouchjs'
import { useStore } from './state'
import { reverseBuffer, makeReverbIR, makeSaturationCurve } from './audio'
import { applyModulation, DEFAULT_MOD, MOD_SPEC, lfoWave } from './modulation'

const VIRTUAL_MOD_KEYS = ['granPos', 'granDensity', 'granPitch', 'dopplerSpeed', 'freezePos']

function modulatedValue(key, base, mod) {
  const spec = MOD_SPEC[key]
  if (!spec) return base
  const lfo = lfoWave(mod.wave || 'sine', mod.rate || 1, performance.now() / 1000, mod.phase || 0)
  const range = spec.max - spec.min
  const value = base + lfo * (mod.depth || 0) * (range / 2)
  return Math.max(spec.min, Math.min(spec.max, value))
}

export function useVoice(voiceNumber, outputNode, initial = {}, onSnapshot = null) {
  const { getAudioCtx, getBuffer, pool } = useStore()
  const [buffer, setBuffer] = useState(null)
  const [sourceName, setSourceName] = useState('')
  const [loadedPoolId, setLoadedPoolId] = useState(initial.loadedPoolId || '')
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)

  // tape
  const [tempo, setTempo] = useState(initial.tempo ?? 1)
  const [pitch, setPitch] = useState(initial.pitch ?? 0)
  const [voiceGain, setVoiceGain] = useState(initial.voiceGain ?? 1)
  const [satActive, setSatActive] = useState(initial.satActive ?? true)
  const [saturation, setSaturation] = useState(initial.saturation ?? 0)
  const [wowActive, setWowActive] = useState(initial.wowActive ?? true)
  const [wowRate, setWowRate] = useState(initial.wowRate ?? 0)
  const [wowDepth, setWowDepth] = useState(initial.wowDepth ?? 0)

  // filter
  const [filterActive, setFilterActive] = useState(initial.filterActive ?? true)
  const [filterType, setFilterType] = useState(initial.filterType ?? 'lowpass')
  const [filterHz, setFilterHz] = useState(initial.filterHz ?? 18000)
  const [filterQ, setFilterQ] = useState(initial.filterQ ?? 0.7)

  // modulation
  const [ringActive, setRingActive] = useState(initial.ringActive ?? true)
  const [ringFreq, setRingFreq] = useState(initial.ringFreq ?? 100)
  const [ringAmount, setRingAmount] = useState(initial.ringAmount ?? 0)
  const [flangerActive, setFlangerActive] = useState(initial.flangerActive ?? true)
  const [flangerRate, setFlangerRate] = useState(initial.flangerRate ?? 0.3)
  const [flangerDepth, setFlangerDepth] = useState(initial.flangerDepth ?? 0.4)
  const [flangerFb, setFlangerFb] = useState(initial.flangerFb ?? 0.3)
  const [flangerMix, setFlangerMix] = useState(initial.flangerMix ?? 0)
  const [tremActive, setTremActive] = useState(initial.tremActive ?? true)
  const [tremRate, setTremRate] = useState(initial.tremRate ?? 4)
  const [tremDepth, setTremDepth] = useState(initial.tremDepth ?? 0)
  const [panActive, setPanActive] = useState(initial.panActive ?? true)
  const [panRate, setPanRate] = useState(initial.panRate ?? 0.6)
  const [panDepth, setPanDepth] = useState(initial.panDepth ?? 0)
  const [panCenter, setPanCenter] = useState(initial.panCenter ?? 0)
  const [panWave, setPanWave] = useState(initial.panWave ?? 'sine')

  // space
  const [delayActive, setDelayActive] = useState(initial.delayActive ?? true)
  const [delayTime, setDelayTime] = useState(initial.delayTime ?? 0.25)
  const [delayFb, setDelayFb] = useState(initial.delayFb ?? 0.35)
  const [wet, setWet] = useState(initial.wet ?? 0)
  const [reverbActive, setReverbActive] = useState(initial.reverbActive ?? true)
  const [reverbSize, setReverbSize] = useState(initial.reverbSize ?? 1.5)
  const [reverbWet, setReverbWet] = useState(initial.reverbWet ?? 0)
  const [reverbIRPoolId, setReverbIRPoolId] = useState(initial.reverbIRPoolId ?? '')

  // loop
  const [reversed, setReversed] = useState(initial.reversed ?? false)
  const [loopStart, setLoopStart] = useState(initial.loopStart ?? 0)
  const [loopEnd, setLoopEnd] = useState(initial.loopEnd ?? 1)
  const [view, setView] = useState(initial.view ?? 'disk')

  // granulator
  const [granActive, setGranActive] = useState(initial.granActive ?? false)
  const [granSize, setGranSize] = useState(initial.granSize ?? 0.08)
  const [granDensity, setGranDensity] = useState(initial.granDensity ?? 20)
  const [granPos, setGranPos] = useState(initial.granPos ?? 0.5)
  const [granDrift, setGranDrift] = useState(initial.granDrift ?? 0)
  const [granSpray, setGranSpray] = useState(initial.granSpray ?? 0.02)
  const [granPitch, setGranPitch] = useState(initial.granPitch ?? 0)
  const [granPitchSpread, setGranPitchSpread] = useState(initial.granPitchSpread ?? 0)
  const [granGain, setGranGain] = useState(initial.granGain ?? 1)
  const [granConstQ, setGranConstQ] = useState(initial.granConstQ ?? false)
  const [granCQBands, setGranCQBands] = useState(initial.granCQBands ?? 16)
  const [granCQResonance, setGranCQResonance] = useState(initial.granCQResonance ?? 8)

  // doppler
  const [dopplerActive, setDopplerActive] = useState(initial.dopplerActive ?? false)
  const [dopplerSpeed, setDopplerSpeed] = useState(initial.dopplerSpeed ?? 0.5)
  const [dopplerRange, setDopplerRange] = useState(initial.dopplerRange ?? 10)
  const [dopplerMinDist, setDopplerMinDist] = useState(initial.dopplerMinDist ?? 1)
  const [dopplerMix, setDopplerMix] = useState(initial.dopplerMix ?? 1)

  // spectral freeze
  const [freezeActive, setFreezeActive] = useState(initial.freezeActive ?? false)
  const [freezePos, setFreezePos] = useState(initial.freezePos ?? 0.5)
  const [freezeGrain, setFreezeGrain] = useState(initial.freezeGrain ?? 0.06)
  const [freezeMix, setFreezeMix] = useState(initial.freezeMix ?? 1)
  const [freezeGainVal, setFreezeGainVal] = useState(initial.freezeGainVal ?? 1)
  const [freezePitch, setFreezePitch] = useState(initial.freezePitch ?? 0)
  const [freezeVoices, setFreezeVoices] = useState(initial.freezeVoices ?? 4)
  const [freezePhase, setFreezePhase] = useState(initial.freezePhase ?? 0.5)

  // effect chain order
  const [effectOrder, setEffectOrder] = useState(initial.effectOrder ?? [
    'saturation', 'wow', 'filter', 'ringmod', 'tremolo', 'flanger', 'delay', 'reverb', 'freeze', 'doppler', 'autopan',
  ])
  const effectOrderRef = useRef(effectOrder)
  effectOrderRef.current = effectOrder

  // modulators: key → { enabled, wave, rate, depth }
  const [modulators, setModulators] = useState(initial.modulators ?? {})
  const setModulator = useCallback((key, patch) => {
    setModulators(prev => {
      if (patch === null) {
        const { [key]: _, ...rest } = prev
        return rest
      }
      const existing = prev[key] || { ...DEFAULT_MOD }
      return { ...prev, [key]: { ...existing, ...patch } }
    })
  }, [])

  const shifterRef = useRef(null)
  const nodesRef = useRef(null)
  const rafRef = useRef(null)
  const scrubRef = useRef({ active: false, target: 0, current: 0, lastGrain: 0, raf: null, revBuf: null, revFor: null })
  const pitchRef = useRef(0)
  useEffect(() => { pitchRef.current = pitch }, [pitch])
  const reversedRef = useRef(false)
  useEffect(() => { reversedRef.current = reversed }, [reversed])

  // Live state mirror that the modulation rAF reads each frame.
  const stateRef = useRef({})
  stateRef.current = {
    tempo, pitch, voiceGain,
    filterHz, filterQ,
    ringFreq, ringAmount,
    flangerRate, flangerDepth, flangerFb, flangerMix,
    tremRate, tremDepth,
    wowRate, wowDepth,
    delayTime, delayFb, wet, reverbWet,
    granPos, granDensity, granPitch,
    dopplerSpeed, dopplerRange, dopplerMinDist, dopplerMix,
    freezePos, freezeMix,
    modulators,
  }

  // Granulator params mirror — the scheduler reads from here so slider changes
  // don't force it to restart and re-schedule grains.
  const granRef = useRef({})
  granRef.current = {
    active: granActive, size: granSize, density: granDensity, pos: granPos, drift: granDrift,
    spray: granSpray, pitch: granPitch, pitchSpread: granPitchSpread, gain: granGain,
    constQ: granConstQ, cqBands: granCQBands, cqResonance: granCQResonance,
  }

  // Doppler params mirror
  const dopplerRef = useRef({})
  dopplerRef.current = {
    active: dopplerActive, speed: dopplerSpeed, range: dopplerRange,
    minDist: dopplerMinDist, mix: dopplerMix,
  }

  // Freeze params mirror — reads from voice's own buffer
  const freezeRef = useRef({})
  freezeRef.current = {
    active: freezeActive, pos: freezePos, grain: freezeGrain,
    mix: freezeMix, gainVal: freezeGainVal, pitch: freezePitch, voices: freezeVoices, phase: freezePhase,
  }

  // Single rAF loop that drives all active LFOs + HRTF panner directly to audio nodes.
  const modRafRef = useRef(null)
  useEffect(() => {
    const tick = () => {
      applyModulation(stateRef.current, nodesRef.current, shifterRef.current)
      // virtual targets — non-AudioParam params that the scheduler reads from refs
      const mods = stateRef.current.modulators || {}
      for (const key of VIRTUAL_MOD_KEYS) {
        const m = mods[key]
        if (!m || !m.enabled) continue
        const base = stateRef.current[key]
        if (typeof base !== 'number') continue
        const val = modulatedValue(key, base, m)
        if (key === 'granPos') granRef.current.pos = val
        else if (key === 'granDensity') granRef.current.density = val
        else if (key === 'granPitch') granRef.current.pitch = val
        else if (key === 'dopplerSpeed') dopplerRef.current.speed = val
        else if (key === 'freezePos') freezeRef.current.pos = val
      }
      modRafRef.current = requestAnimationFrame(tick)
    }
    modRafRef.current = requestAnimationFrame(tick)
    return () => { if (modRafRef.current) cancelAnimationFrame(modRafRef.current) }
  }, [])

  // Granulator scheduler — self-rescheduling setTimeout that reads params from ref.
  const granPosCursorRef = useRef(granPos)
  useEffect(() => { granPosCursorRef.current = granPos }, [granPos])
  const granTimerRef = useRef(null)
  const bufferRef = useRef(buffer)
  bufferRef.current = buffer
  const spawnGrainRef = useRef(() => {})
  spawnGrainRef.current = () => {
    const buf = bufferRef.current
    const nodes = nodesRef.current
    const p = granRef.current
    if (!buf || !nodes || !p.active) return
    const ctx = getAudioCtx()

    // advance cursor by drift
    if (p.drift !== 0) {
      granPosCursorRef.current = ((granPosCursorRef.current + p.drift * 0.01) % 1 + 1) % 1
    } else {
      granPosCursorRef.current = p.pos
    }

    const sprayed = granPosCursorRef.current + (Math.random() - 0.5) * 2 * p.spray
    const normPos = ((sprayed % 1) + 1) % 1
    const startSec = normPos * buf.duration
    const pitchSemi = p.pitch + (Math.random() - 0.5) * 2 * p.pitchSpread
    const rate = Math.pow(2, pitchSemi / 12)
    const grainLen = Math.max(0.005, Math.min(buf.duration - startSec - 0.001, p.size))
    if (grainLen <= 0.005) return

    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate

    const gain = ctx.createGain()
    const when = ctx.currentTime + 0.01
    const actualDur = grainLen / rate
    gain.gain.setValueAtTime(0, when)
    gain.gain.linearRampToValueAtTime(1, when + actualDur / 2)
    gain.gain.linearRampToValueAtTime(0, when + actualDur)

    src.connect(gain)
    if (p.constQ) gain.connect(nodes.cqIn)
    else gain.connect(nodes.granBus)
    try { src.start(when, startSec, grainLen) } catch {}
    src.onended = () => {
      try { src.disconnect() } catch {}
      try { gain.disconnect() } catch {}
    }
  }

  useEffect(() => {
    let running = true
    const schedule = (delay) => {
      granTimerRef.current = setTimeout(() => {
        if (!running) return
        spawnGrainRef.current()
        const p = granRef.current
        const interval = 1000 / Math.max(1, p.density || 20)
        schedule(interval)
      }, delay)
    }
    schedule(50)
    return () => { running = false; if (granTimerRef.current) clearTimeout(granTimerRef.current) }
  }, [])

  // Doppler rAF — animates the delay line to simulate a moving source passing by.
  const dopplerRafRef = useRef(null)
  const dopplerTRef = useRef(0)
  useEffect(() => {
    let last = performance.now()
    const tick = () => {
      const now = performance.now()
      const dt = (now - last) / 1000
      last = now
      const d = dopplerRef.current
      const nodes = nodesRef.current
      if (nodes) {
        if (d.active && d.mix > 0) {
          dopplerTRef.current += dt * d.speed
          // source position x(t) = range * sin(2π t) → smooth pass-by cycle
          const x = d.range * Math.sin(dopplerTRef.current * Math.PI * 2)
          const dist = Math.sqrt(x * x + d.minDist * d.minDist)
          const delay = Math.min(0.49, dist / 343)
          const amp = d.minDist / dist // 1/r falloff
          // interpolate between bypass and full effect via mix
          const tDelay = delay * d.mix
          const tGain = 1 + (amp - 1) * d.mix
          try {
            nodes.dopplerDelay.delayTime.setTargetAtTime(tDelay, getAudioCtx().currentTime, 0.02)
            nodes.dopplerGain.gain.setTargetAtTime(tGain, getAudioCtx().currentTime, 0.02)
          } catch {}
        } else {
          try {
            nodes.dopplerDelay.delayTime.setTargetAtTime(0, getAudioCtx().currentTime, 0.05)
            nodes.dopplerGain.gain.setTargetAtTime(1, getAudioCtx().currentTime, 0.05)
          } catch {}
        }
      }
      dopplerRafRef.current = requestAnimationFrame(tick)
    }
    dopplerRafRef.current = requestAnimationFrame(tick)
    return () => { if (dopplerRafRef.current) cancelAnimationFrame(dopplerRafRef.current) }
  }, [getAudioCtx])

  // ---- Spectral Freeze: multi-voice grains from voice buffer, pitch + phase spread ----
  const freezeTimerRef = useRef(null)
  const freezeVoiceIdx = useRef(0)
  const spawnFreezeGrainRef = useRef(() => {})
  spawnFreezeGrainRef.current = () => {
    const f = freezeRef.current
    const buf = bufferRef.current
    const nodes = nodesRef.current
    if (!nodes || !buf || !f.active || f.mix <= 0) return
    const ctx = getAudioCtx()
    nodes.freezeMixGain.gain.value = f.mix
    const nv = Math.max(1, Math.round(f.voices))
    const vi = freezeVoiceIdx.current % nv
    freezeVoiceIdx.current = (freezeVoiceIdx.current + 1) % nv
    const phaseOffset = f.phase * (vi / nv) * f.grain
    const startSec = Math.max(0, Math.min(buf.duration - 0.005, f.pos * buf.duration + phaseOffset))
    const grainDur = Math.min(f.grain, Math.max(0.005, buf.duration - startSec))
    if (grainDur <= 0.005) return
    const amplitude = f.gainVal / Math.sqrt(nv)
    const rate = Math.pow(2, f.pitch / 12)
    const actualDur = grainDur / rate
    const fadeFrac = 0.25
    const fadeTime = Math.min(actualDur * fadeFrac, actualDur / 2 - 0.001)
    if (fadeTime <= 0) return
    const when = ctx.currentTime + 0.005
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    const env = ctx.createGain()
    env.gain.setValueAtTime(0, when)
    env.gain.linearRampToValueAtTime(amplitude, when + fadeTime)
    env.gain.setValueAtTime(amplitude, when + actualDur - fadeTime)
    env.gain.linearRampToValueAtTime(0, when + actualDur)
    src.connect(env).connect(nodes.freezeMixGain)
    try { src.start(when, startSec, grainDur) } catch {}
    src.onended = () => { try { src.disconnect() } catch {}; try { env.disconnect() } catch {} }
  }
  useEffect(() => {
    let running = true
    const schedule = (delay) => {
      freezeTimerRef.current = setTimeout(() => {
        if (!running) return
        spawnFreezeGrainRef.current()
        const f = freezeRef.current
        const nv = Math.max(1, Math.round(f.voices))
        const interval = Math.max(5, (f.grain * 1000) / 2 / nv)
        schedule(interval)
      }, delay)
    }
    schedule(50)
    return () => { running = false; if (freezeTimerRef.current) clearTimeout(freezeTimerRef.current) }
  }, [])

  const stop = useCallback(() => {
    if (shifterRef.current) {
      try { shifterRef.current.disconnect() } catch {}
      shifterRef.current = null
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    setPlaying(false)
  }, [])

  const loadFromPool = useCallback((poolId) => {
    const buf = getBuffer(poolId)
    const item = pool.find(p => p.id === poolId)
    if (!buf) return
    stop()
    setBuffer(buf)
    setSourceName(item?.name || '')
    setLoadedPoolId(poolId)
    setReversed(false)
    setLoopStart(0)
    setLoopEnd(1)
    setPosition(0)
  }, [getBuffer, pool, stop])

  const mountedRef = useRef(false)
  useEffect(() => {
    if (mountedRef.current) return
    mountedRef.current = true
    if (initial.loadedPoolId) {
      const buf = getBuffer(initial.loadedPoolId)
      const item = pool.find(p => p.id === initial.loadedPoolId)
      if (buf) {
        setBuffer(buf)
        setSourceName(item?.name || '')
      }
    }
  }, [])

  const ensureEffects = useCallback(() => {
    if (nodesRef.current) return nodesRef.current
    if (!outputNode) return null
    const ctx = getAudioCtx()
    const oscs = []
    const mkOsc = (freq, type = 'sine') => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; o.start(); oscs.push(o); return o
    }
    const G = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g }

    // ---- Source buses + granulator CQ bank (always first) ----
    const scrubBus = G(1), shifterBus = G(1)
    const cqIn = G(1), cqOut = G(1), cqFilters = []
    for (let i = 0; i < 24; i++) {
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'
      f.frequency.value = 60 * Math.pow(10000 / 60, i / 23); f.Q.value = 8
      const bg = G(((0.5 + Math.exp(-Math.pow(Math.log(f.frequency.value / 2500), 2) / 2) * 1.2) / 24) * 6)
      cqIn.connect(f).connect(bg).connect(cqOut); cqFilters.push({ filter: f, gain: bg })
    }
    const master = G(voiceGain)

    // ---- Build each effect as a self-contained module {input, output, ...nodes} ----
    const modules = {}

    // Saturation
    { const input = G(), output = G(), sat = ctx.createWaveShaper()
      sat.curve = makeSaturationCurve(saturation); sat.oversample = '2x'
      input.connect(sat).connect(output)
      modules.saturation = { input, output, sat } }

    // Wow/Flutter
    { const input = G(), output = G()
      const wowDelay = ctx.createDelay(0.05); wowDelay.delayTime.value = 0.008
      const wowLfo = mkOsc(wowRate || 0.01, 'sine')
      const wowDepthGain = G(wowDepth * 0.005)
      wowLfo.connect(wowDepthGain).connect(wowDelay.delayTime)
      input.connect(wowDelay).connect(output)
      modules.wow = { input, output, wowDelay, wowLfo, wowDepthGain } }

    // Filter
    { const input = G(), output = G()
      const filter = ctx.createBiquadFilter()
      filter.type = filterActive ? filterType : 'allpass'; filter.frequency.value = filterHz; filter.Q.value = filterQ
      input.connect(filter).connect(output)
      modules.filter = { input, output, filter } }

    // Ring Modulator
    { const input = G(), output = G()
      const ringDry = G(1 - ringAmount), ringWet = G(0), ringMix = G(ringAmount)
      const ringOsc = mkOsc(ringFreq, 'sine'), ringDepth = G(1)
      ringOsc.connect(ringDepth).connect(ringWet.gain)
      input.connect(ringDry).connect(output)
      input.connect(ringWet).connect(ringMix).connect(output)
      modules.ringmod = { input, output, ringDry, ringWet, ringMix, ringOsc, ringDepth } }

    // Tremolo
    { const input = G(), output = G()
      const tremoloGain = G(1 - tremDepth / 2)
      const tremoloLfo = mkOsc(Math.max(0.01, tremRate), 'sine')
      const tremoloDepthGain = G(tremDepth / 2)
      tremoloLfo.connect(tremoloDepthGain).connect(tremoloGain.gain)
      input.connect(tremoloGain).connect(output)
      modules.tremolo = { input, output, tremoloGain, tremoloLfo, tremoloDepthGain } }

    // Flanger (internal wet/dry)
    { const input = G(), output = G(), flangerDry = G(1)
      const flangerDelay = ctx.createDelay(0.05); flangerDelay.delayTime.value = 0.002
      const flangerLfo = mkOsc(flangerRate, 'sine'), flangerDepthGain = G(flangerDepth * 0.002)
      flangerLfo.connect(flangerDepthGain).connect(flangerDelay.delayTime)
      const flangerFbGain = G(flangerFb), flangerMixGain = G(flangerMix)
      input.connect(flangerDry).connect(output)
      input.connect(flangerDelay); flangerDelay.connect(flangerFbGain).connect(flangerDelay)
      flangerDelay.connect(flangerMixGain).connect(output)
      modules.flanger = { input, output, flangerDry, flangerDelay, flangerLfo, flangerDepthGain, flangerFbGain, flangerMixGain } }

    // Tape Delay (internal wet/dry)
    { const input = G(), output = G(), delayDry = G(1)
      const tapeDelay = ctx.createDelay(2); tapeDelay.delayTime.value = delayTime
      const tapeFbGain = G(delayFb), tapeWetGain = G(wet)
      input.connect(delayDry).connect(output)
      input.connect(tapeDelay); tapeDelay.connect(tapeFbGain).connect(tapeDelay)
      tapeDelay.connect(tapeWetGain).connect(output)
      modules.delay = { input, output, delayDry, tapeDelay, tapeFbGain, tapeWetGain } }

    // Reverb (internal wet/dry)
    { const input = G(), output = G(), reverbDry = G(1)
      const reverb = ctx.createConvolver(); reverb.buffer = makeReverbIR(ctx, reverbSize)
      const reverbWetGain = G(reverbWet)
      input.connect(reverbDry).connect(output)
      input.connect(reverb).connect(reverbWetGain).connect(output)
      modules.reverb = { input, output, reverbDry, reverb, reverbWetGain } }

    // Granulator (injects grains; when active, can duck input)
    { const input = G(), output = G()
      const granDry = G(1)
      const granMix = G(granGain)
      input.connect(granDry).connect(output)
      granMix.connect(output)
      // CQ filterbank feeds into granMix
      const cqRoute = G(1)
      cqOut.connect(cqRoute).connect(granMix)
      modules.granulator = { input, output, granDry, granMix, granBus: granMix, cqRoute } }

    // Freeze (ducks input via mix, adds own grains)
    { const input = G(), output = G()
      const freezeDry = G(freezeActive ? (1 - freezeMix) : 1)
      const freezeMixGain = G(freezeActive ? freezeMix : 0)
      input.connect(freezeDry).connect(output)
      freezeMixGain.connect(output)
      modules.freeze = { input, output, freezeDry, freezeMixGain } }

    // Doppler
    { const input = G(), output = G()
      const dopplerDelay = ctx.createDelay(0.5); dopplerDelay.delayTime.value = 0
      const dopplerGain = G(1)
      input.connect(dopplerDelay).connect(dopplerGain).connect(output)
      modules.doppler = { input, output, dopplerDelay, dopplerGain } }

    // Auto Pan
    { const input = G(), output = G()
      const validWave = ['sine', 'triangle', 'square', 'sawtooth'].includes(panWave) ? panWave : 'sine'
      const autoPan = ctx.createStereoPanner(); autoPan.pan.value = panCenter
      const panLfo = mkOsc(Math.max(0.01, panRate), validWave)
      const panDepthGain = G(panActive ? panDepth : 0)
      panLfo.connect(panDepthGain).connect(autoPan.pan)
      input.connect(autoPan).connect(output)
      modules.autopan = { input, output, autoPan, panLfo, panDepthGain } }

    // ---- Wire the chain in effectOrder ----
    const order = effectOrderRef.current
    const wireChain = () => {
      // disconnect all module outputs + source buses
      for (const m of Object.values(modules)) try { m.output.disconnect() } catch {}
      try { scrubBus.disconnect() } catch {}
      try { shifterBus.disconnect() } catch {}
      try { master.disconnect() } catch {}
      // sources → first module
      const first = modules[order[0]]
      scrubBus.connect(first.input); shifterBus.connect(first.input)
      // chain
      for (let i = 0; i < order.length - 1; i++) modules[order[i]].output.connect(modules[order[i + 1]].input)
      // last → master → output
      modules[order[order.length - 1]].output.connect(master)
      master.connect(outputNode)
    }
    wireChain()

    // flatten module nodes for backward-compatible access by live update effects
    const flat = {}
    for (const mod of Object.values(modules)) {
      for (const [k, v] of Object.entries(mod)) {
        if (k !== 'input' && k !== 'output') flat[k] = v
      }
    }
    nodesRef.current = {
      ...flat,
      scrubBus, shifterBus,
      granBus: modules.granulator.granMix,
      cqIn, cqOut, cqFilters,
      master, oscs, modules, wireChain,
    }
    return nodesRef.current
  }, [getAudioCtx, outputNode])

  const teardownEffects = useCallback(() => {
    if (!nodesRef.current) return
    const { oscs, cqFilters, ...rest } = nodesRef.current
    if (oscs) oscs.forEach(o => { try { o.stop() } catch {} })
    if (cqFilters) cqFilters.forEach(({ filter, gain }) => {
      try { filter.disconnect() } catch {}
      try { gain.disconnect() } catch {}
    })
    Object.values(rest).forEach(n => { try { n.disconnect() } catch {} })
    nodesRef.current = null
  }, [])

  useEffect(() => {
    stop()
    teardownEffects()
    if (buffer) ensureEffects()
    return () => { stop(); teardownEffects() }
  }, [buffer, ensureEffects, stop, teardownEffects])

  // rewire chain when effect order changes
  useEffect(() => {
    if (nodesRef.current?.wireChain) nodesRef.current.wireChain()
  }, [effectOrder])

  const play = useCallback(() => {
    if (!buffer) return
    if (shifterRef.current) { try { shifterRef.current.disconnect() } catch {}; shifterRef.current = null }
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    const ctx = getAudioCtx()
    const nodes = ensureEffects()
    if (!nodes) return
    const src = reversedRef.current ? reverseBuffer(buffer, ctx) : buffer
    const shifter = new PitchShifter(ctx, src, 4096)
    shifter.tempo = tempo
    shifter.pitchSemitones = pitch
    shifter.connect(nodes.shifterBus)
    shifterRef.current = shifter
    shifter.percentagePlayed = loopStart * 100
    setPlaying(true)
    const tick = () => {
      const sh = shifterRef.current
      if (!sh) return
      const p = sh.percentagePlayed / 100
      setPosition(p)
      if (p >= loopEnd || p >= 0.999) sh.percentagePlayed = loopStart * 100
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [buffer, tempo, pitch, loopStart, loopEnd, ensureEffects, getAudioCtx])

  // Snapshot
  useEffect(() => {
    if (!onSnapshot) return
    onSnapshot({
      loadedPoolId, tempo, pitch, voiceGain, reversed, loopStart, loopEnd, view,
      satActive, saturation,
      wowActive, wowRate, wowDepth,
      filterActive, filterType, filterHz, filterQ,
      ringActive, ringFreq, ringAmount,
      flangerActive, flangerRate, flangerDepth, flangerFb, flangerMix,
      tremActive, tremRate, tremDepth,
      panActive, panRate, panDepth, panCenter, panWave,
      delayActive, delayTime, delayFb, wet,
      reverbActive, reverbSize, reverbWet, reverbIRPoolId,
      granActive, granSize, granDensity, granPos, granDrift, granSpray,
      granPitch, granPitchSpread, granGain, granConstQ, granCQBands, granCQResonance,
      dopplerActive, dopplerSpeed, dopplerRange, dopplerMinDist, dopplerMix,
      freezeActive, freezePos, freezeGrain, freezeMix, freezeGainVal, freezePitch, freezeVoices, freezePhase,
      effectOrder,
      modulators,
    })
  }, [onSnapshot,
    loadedPoolId, tempo, pitch, voiceGain, reversed, loopStart, loopEnd, view,
    satActive, saturation,
    wowActive, wowRate, wowDepth,
    filterActive, filterType, filterHz, filterQ,
    ringActive, ringFreq, ringAmount,
    flangerActive, flangerRate, flangerDepth, flangerFb, flangerMix,
    tremActive, tremRate, tremDepth,
    panActive, panRate, panDepth, panCenter, panWave,
    delayActive, delayTime, delayFb, wet,
    reverbActive, reverbSize, reverbWet, reverbIRPoolId,
    granActive, granSize, granDensity, granPos, granDrift, granSpray,
    granPitch, granPitchSpread, granGain, granConstQ, granCQBands, granCQResonance,
    dopplerActive, dopplerSpeed, dopplerRange, dopplerMinDist, dopplerMix,
    freezeActive, freezePos, freezeGrain, freezeMix, freezeGainVal, freezePitch, freezeVoices, freezePhase,
    effectOrder,
    modulators,
  ])

  // Live updates
  useEffect(() => { if (shifterRef.current) shifterRef.current.tempo = tempo }, [tempo])
  useEffect(() => { if (shifterRef.current) shifterRef.current.pitchSemitones = pitch }, [pitch])
  useEffect(() => { if (nodesRef.current) nodesRef.current.master.gain.value = voiceGain }, [voiceGain])
  // saturation: when off, force identity curve (pass-through)
  useEffect(() => {
    if (!nodesRef.current) return
    nodesRef.current.sat.curve = makeSaturationCurve(satActive ? saturation : 0)
  }, [saturation, satActive])
  // wow: when off, depth gain = 0 (LFO does not modulate the delay)
  useEffect(() => { if (nodesRef.current) nodesRef.current.wowLfo.frequency.value = Math.max(0.01, wowRate) }, [wowRate])
  useEffect(() => {
    if (!nodesRef.current) return
    nodesRef.current.wowDepthGain.gain.value = wowActive ? wowDepth * 0.005 : 0
  }, [wowDepth, wowActive])
  // filter: when off, switch to allpass which is magnitude-flat
  useEffect(() => {
    if (!nodesRef.current) return
    nodesRef.current.filter.type = filterActive ? filterType : 'allpass'
  }, [filterType, filterActive])
  useEffect(() => { if (nodesRef.current) nodesRef.current.filter.frequency.value = filterHz }, [filterHz])
  useEffect(() => { if (nodesRef.current) nodesRef.current.filter.Q.value = filterQ }, [filterQ])
  useEffect(() => { if (nodesRef.current) nodesRef.current.ringOsc.frequency.value = ringFreq }, [ringFreq])
  // ring mod: when off, dry=1, wet=0
  useEffect(() => {
    if (!nodesRef.current) return
    const amt = ringActive ? ringAmount : 0
    nodesRef.current.ringDry.gain.value = 1 - amt
    nodesRef.current.ringMix.gain.value = amt
  }, [ringAmount, ringActive])
  useEffect(() => { if (nodesRef.current) nodesRef.current.flangerLfo.frequency.value = Math.max(0.01, flangerRate) }, [flangerRate])
  useEffect(() => { if (nodesRef.current) nodesRef.current.flangerDepthGain.gain.value = flangerDepth * 0.002 }, [flangerDepth])
  useEffect(() => { if (nodesRef.current) nodesRef.current.flangerFbGain.gain.value = flangerFb }, [flangerFb])
  // flanger: when off, mix = 0
  useEffect(() => {
    if (!nodesRef.current) return
    nodesRef.current.flangerMixGain.gain.value = flangerActive ? flangerMix : 0
  }, [flangerMix, flangerActive])
  useEffect(() => { if (nodesRef.current) nodesRef.current.tremoloLfo.frequency.value = Math.max(0.01, tremRate) }, [tremRate])
  // tremolo: when off, gain stays at 1 with no modulation
  useEffect(() => {
    if (!nodesRef.current) return
    const d = tremActive ? tremDepth : 0
    nodesRef.current.tremoloGain.gain.value = 1 - d / 2
    nodesRef.current.tremoloDepthGain.gain.value = d / 2
  }, [tremDepth, tremActive])
  // auto-pan
  useEffect(() => { if (nodesRef.current) nodesRef.current.panLfo.frequency.value = Math.max(0.01, panRate) }, [panRate])
  useEffect(() => {
    if (!nodesRef.current) return
    nodesRef.current.panDepthGain.gain.value = panActive ? panDepth : 0
  }, [panDepth, panActive])
  useEffect(() => { if (nodesRef.current) nodesRef.current.autoPan.pan.value = panCenter }, [panCenter])
  useEffect(() => {
    if (!nodesRef.current) return
    const w = ['sine', 'triangle', 'square', 'sawtooth'].includes(panWave) ? panWave : 'sine'
    try { nodesRef.current.panLfo.type = w } catch {}
  }, [panWave])
  useEffect(() => { if (nodesRef.current) nodesRef.current.tapeDelay.delayTime.value = delayTime }, [delayTime])
  useEffect(() => { if (nodesRef.current) nodesRef.current.tapeFbGain.gain.value = delayFb }, [delayFb])
  // tape delay: when off, wet = 0
  useEffect(() => {
    if (!nodesRef.current) return
    nodesRef.current.tapeWetGain.gain.value = delayActive ? wet : 0
  }, [wet, delayActive])
  // Use a user-loaded IR if assigned; otherwise fall back to the synthesized IR.
  useEffect(() => {
    if (!nodesRef.current) return
    if (reverbIRPoolId) {
      const buf = getBuffer(reverbIRPoolId)
      if (buf) {
        nodesRef.current.reverb.buffer = buf
        return
      }
    }
    nodesRef.current.reverb.buffer = makeReverbIR(getAudioCtx(), reverbSize)
  }, [reverbSize, reverbIRPoolId, getAudioCtx, getBuffer])
  // reverb: when off, wet = 0
  useEffect(() => {
    if (!nodesRef.current) return
    nodesRef.current.reverbWetGain.gain.value = reverbActive ? reverbWet : 0
  }, [reverbWet, reverbActive])
  useEffect(() => { if (nodesRef.current) nodesRef.current.granBus.gain.value = granGain }, [granGain])
  // freeze: wet/dry crossfade inside the freeze module
  useEffect(() => {
    if (!nodesRef.current) return
    nodesRef.current.freezeMixGain.gain.value = freezeActive ? freezeMix : 0
    if (nodesRef.current.freezeDry) nodesRef.current.freezeDry.gain.value = freezeActive ? (1 - freezeMix) : 1
  }, [freezeMix, freezeActive])
  useEffect(() => {
    if (!nodesRef.current) return
    nodesRef.current.cqFilters.forEach(({ filter }) => { filter.Q.value = granCQResonance })
  }, [granCQResonance])

  const onScrub = useCallback((p, delta, phase) => {
    if (!buffer) return
    const ctx = getAudioCtx()
    const s = scrubRef.current
    ensureEffects()
    if (phase === 'start') {
      s.active = true
      s.target = p
      s.current = p
      s.lastGrain = 0
      if (s.revFor !== buffer) { s.revBuf = null; s.revFor = buffer }
      if (nodesRef.current) nodesRef.current.shifterBus.gain.value = 0
      const GRAIN_INTERVAL = 0.05
      const GRAIN_LEN = 0.09
      const FADE = 0.008
      const loop = () => {
        if (!s.active) return
        const now = ctx.currentTime
        if (now - s.lastGrain >= GRAIN_INTERVAL) {
          let d = s.target - s.current
          if (d > 0.5) d -= 1
          if (d < -0.5) d += 1
          if (Math.abs(d) > 1e-5 && nodesRef.current) {
            const dir = d >= 0 ? 1 : -1
            let srcBuf, startSec
            if (dir > 0) {
              srcBuf = buffer
              startSec = s.current * buffer.duration
            } else {
              if (!s.revBuf) s.revBuf = reverseBuffer(buffer, ctx)
              srcBuf = s.revBuf
              startSec = (1 - s.current) * buffer.duration
            }
            const sourceSeconds = Math.abs(d) * buffer.duration
            const velRate = sourceSeconds / GRAIN_INTERVAL
            const pitchRate = Math.pow(2, pitchRef.current / 12)
            let rate = velRate * pitchRate
            rate = Math.max(0.05, Math.min(8, rate))
            const playLen = Math.min(GRAIN_LEN, (srcBuf.duration - startSec) / rate - 0.001)
            if (playLen > FADE * 2) {
              startSec = Math.max(0, Math.min(srcBuf.duration - playLen * rate - 0.001, startSec))
              const when = now + 0.005
              const src = ctx.createBufferSource()
              src.buffer = srcBuf
              src.playbackRate.value = rate
              const g = ctx.createGain()
              g.gain.setValueAtTime(0, when)
              g.gain.linearRampToValueAtTime(1, when + FADE)
              g.gain.setValueAtTime(1, when + playLen - FADE)
              g.gain.linearRampToValueAtTime(0, when + playLen)
              src.connect(g).connect(nodesRef.current.scrubBus)
              try { src.start(when, startSec, playLen) } catch {}
            }
            s.current = s.target
            setPosition(s.target)
          }
          s.lastGrain = now
        }
        s.raf = requestAnimationFrame(loop)
      }
      loop()
    }
    if (phase === 'move') s.target = p
    if (phase === 'end') {
      s.active = false
      if (s.raf) cancelAnimationFrame(s.raf)
      setPosition(p)
      if (nodesRef.current) nodesRef.current.shifterBus.gain.value = 1
      if (shifterRef.current) shifterRef.current.percentagePlayed = p * 100
    }
  }, [buffer, getAudioCtx, ensureEffects])

  const toggleReverse = useCallback(() => {
    const newRev = !reversedRef.current
    reversedRef.current = newRev
    setReversed(newRev)
    if (playing) {
      // capture current shifter position so we resume in the same spot
      const sh = shifterRef.current
      const pct = sh ? sh.percentagePlayed / 100 : 0
      stop()
      // restart with the new direction; if we were past the start, mirror the
      // position so reversed playback continues from the same audible point
      setTimeout(() => {
        play()
        if (shifterRef.current) {
          shifterRef.current.percentagePlayed = (newRev ? (1 - pct) : pct) * 100
        }
      }, 10)
    }
  }, [playing, stop, play])

  return {
    voiceNumber,
    buffer, sourceName, loadedPoolId,
    playing, position,
    // tape
    tempo, setTempo,
    pitch, setPitch,
    voiceGain, setVoiceGain,
    satActive, setSatActive,
    saturation, setSaturation,
    wowActive, setWowActive,
    wowRate, setWowRate,
    wowDepth, setWowDepth,
    // filter
    filterActive, setFilterActive,
    filterType, setFilterType,
    filterHz, setFilterHz,
    filterQ, setFilterQ,
    // mod
    ringActive, setRingActive,
    ringFreq, setRingFreq,
    ringAmount, setRingAmount,
    flangerActive, setFlangerActive,
    flangerRate, setFlangerRate,
    flangerDepth, setFlangerDepth,
    flangerFb, setFlangerFb,
    flangerMix, setFlangerMix,
    tremActive, setTremActive,
    tremRate, setTremRate,
    tremDepth, setTremDepth,
    panActive, setPanActive,
    panRate, setPanRate,
    panDepth, setPanDepth,
    panCenter, setPanCenter,
    panWave, setPanWave,
    // space
    delayActive, setDelayActive,
    delayTime, setDelayTime,
    delayFb, setDelayFb,
    wet, setWet,
    reverbActive, setReverbActive,
    reverbSize, setReverbSize,
    reverbWet, setReverbWet,
    reverbIRPoolId, setReverbIRPoolId,
    // loop
    reversed, loopStart, setLoopStart, loopEnd, setLoopEnd,
    view, setView,
    // granulator
    granActive, setGranActive,
    granSize, setGranSize,
    granDensity, setGranDensity,
    granPos, setGranPos,
    granDrift, setGranDrift,
    granSpray, setGranSpray,
    granPitch, setGranPitch,
    granPitchSpread, setGranPitchSpread,
    granGain, setGranGain,
    granConstQ, setGranConstQ,
    granCQBands, setGranCQBands,
    granCQResonance, setGranCQResonance,
    // doppler
    dopplerActive, setDopplerActive,
    dopplerSpeed, setDopplerSpeed,
    dopplerRange, setDopplerRange,
    dopplerMinDist, setDopplerMinDist,
    dopplerMix, setDopplerMix,
    // freeze
    freezeActive, setFreezeActive,
    freezePos, setFreezePos,
    freezeGrain, setFreezeGrain,
    freezeMix, setFreezeMix,
    freezeGainVal, setFreezeGainVal,
    freezePitch, setFreezePitch,
    freezeVoices, setFreezeVoices,
    freezePhase, setFreezePhase,
    // chain order
    effectOrder, setEffectOrder,
    // modulation
    modulators, setModulator,
    play, stop, onScrub, toggleReverse, loadFromPool,
  }
}
