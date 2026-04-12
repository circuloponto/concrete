import { useRef, useState, useEffect, useCallback } from 'react'
import { PitchShifter } from 'soundtouchjs'
import { useStore } from './state'
import { reverseBuffer, makeReverbIR, makeSaturationCurve } from './audio'
import { applyModulation, DEFAULT_MOD, MOD_SPEC, lfoWave } from './modulation'

const VIRTUAL_MOD_KEYS = ['granPos', 'granDensity', 'granPitch', 'dopplerSpeed']

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

  // space
  const [delayActive, setDelayActive] = useState(initial.delayActive ?? true)
  const [delayTime, setDelayTime] = useState(initial.delayTime ?? 0.25)
  const [delayFb, setDelayFb] = useState(initial.delayFb ?? 0.35)
  const [wet, setWet] = useState(initial.wet ?? 0)
  const [reverbActive, setReverbActive] = useState(initial.reverbActive ?? true)
  const [reverbSize, setReverbSize] = useState(initial.reverbSize ?? 1.5)
  const [reverbWet, setReverbWet] = useState(initial.reverbWet ?? 0)

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

  // Single rAF loop that drives all active LFOs directly to audio nodes.
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
      const o = ctx.createOscillator()
      o.type = type
      o.frequency.value = freq
      o.start()
      oscs.push(o)
      return o
    }

    // inputs
    const scrubBus = ctx.createGain(); scrubBus.gain.value = 1
    const shifterBus = ctx.createGain(); shifterBus.gain.value = 1
    // granulator bus (grains enter here; when constQ on, grains route through the bank)
    const granBus = ctx.createGain(); granBus.gain.value = granGain
    // constant-Q filterbank (cochlea-style log-spaced bandpasses)
    const cqIn = ctx.createGain(); cqIn.gain.value = 1
    const cqOut = ctx.createGain(); cqOut.gain.value = 1
    const cqFilters = []
    const NBANDS = 24
    const FMIN = 60, FMAX = 10000
    for (let i = 0; i < NBANDS; i++) {
      const f = ctx.createBiquadFilter()
      f.type = 'bandpass'
      f.frequency.value = FMIN * Math.pow(FMAX / FMIN, i / (NBANDS - 1))
      f.Q.value = 8
      // equal-loudness-ish weighting (emphasize 1-5kHz where ear is most sensitive)
      const bandGain = ctx.createGain()
      const fHz = f.frequency.value
      const weight = 0.5 + Math.exp(-Math.pow(Math.log(fHz / 2500), 2) / 2) * 1.2
      bandGain.gain.value = weight / NBANDS * 6
      cqIn.connect(f).connect(bandGain).connect(cqOut)
      cqFilters.push({ filter: f, gain: bandGain })
    }
    cqOut.connect(granBus)

    // saturation
    const sat = ctx.createWaveShaper()
    sat.curve = makeSaturationCurve(saturation)
    sat.oversample = '2x'

    // wow/flutter: a short base delay modulated by an LFO
    const wowDelay = ctx.createDelay(0.05)
    wowDelay.delayTime.value = 0.008
    const wowLfo = mkOsc(wowRate || 0.01, 'sine')
    const wowDepthGain = ctx.createGain()
    wowDepthGain.gain.value = wowDepth * 0.005
    wowLfo.connect(wowDepthGain).connect(wowDelay.delayTime)

    // multimode filter
    const filter = ctx.createBiquadFilter()
    filter.type = filterType
    filter.frequency.value = filterHz
    filter.Q.value = filterQ

    // ring modulator: dry path + wet path where wet gain is driven by osc
    const ringDry = ctx.createGain(); ringDry.gain.value = 1 - ringAmount
    const ringWet = ctx.createGain(); ringWet.gain.value = 0
    const ringMix = ctx.createGain(); ringMix.gain.value = ringAmount
    const ringOsc = mkOsc(ringFreq, 'sine')
    const ringDepth = ctx.createGain(); ringDepth.gain.value = 1
    ringOsc.connect(ringDepth).connect(ringWet.gain)

    // ring mod sum
    const ringSum = ctx.createGain(); ringSum.gain.value = 1

    // tremolo (amplitude LFO)
    const tremoloGain = ctx.createGain()
    tremoloGain.gain.value = 1 - tremDepth / 2
    const tremoloLfo = mkOsc(Math.max(0.01, tremRate), 'sine')
    const tremoloDepthGain = ctx.createGain()
    tremoloDepthGain.gain.value = tremDepth / 2
    tremoloLfo.connect(tremoloDepthGain).connect(tremoloGain.gain)

    // flanger
    const flangerDelay = ctx.createDelay(0.05)
    flangerDelay.delayTime.value = 0.002
    const flangerLfo = mkOsc(flangerRate, 'sine')
    const flangerDepthGain = ctx.createGain()
    flangerDepthGain.gain.value = flangerDepth * 0.002
    flangerLfo.connect(flangerDepthGain).connect(flangerDelay.delayTime)
    const flangerFbGain = ctx.createGain(); flangerFbGain.gain.value = flangerFb
    const flangerMixGain = ctx.createGain(); flangerMixGain.gain.value = flangerMix

    // tape delay
    const tapeDelay = ctx.createDelay(2)
    tapeDelay.delayTime.value = delayTime
    const tapeFbGain = ctx.createGain(); tapeFbGain.gain.value = delayFb
    const tapeWetGain = ctx.createGain(); tapeWetGain.gain.value = wet

    // reverb
    const reverb = ctx.createConvolver()
    reverb.buffer = makeReverbIR(ctx, reverbSize)
    const reverbWetGain = ctx.createGain(); reverbWetGain.gain.value = reverbWet

    // dry path
    const dry = ctx.createGain(); dry.gain.value = 1

    // doppler — serial delay + gain between FX sum and master
    const dopplerIn = ctx.createGain(); dopplerIn.gain.value = 1
    const dopplerDelay = ctx.createDelay(0.5)
    dopplerDelay.delayTime.value = 0
    const dopplerGain = ctx.createGain(); dopplerGain.gain.value = 1
    dopplerIn.connect(dopplerDelay).connect(dopplerGain)

    const master = ctx.createGain(); master.gain.value = voiceGain

    // Wiring
    // inputs → saturation
    scrubBus.connect(sat)
    shifterBus.connect(sat)
    granBus.connect(sat)
    // serial chain
    sat.connect(wowDelay).connect(filter)
    // ring mod split
    filter.connect(ringDry).connect(ringSum)
    filter.connect(ringWet).connect(ringMix).connect(ringSum)
    // tremolo in series after ringmod
    ringSum.connect(tremoloGain)
    // parallel FX branches → dopplerIn
    tremoloGain.connect(dry).connect(dopplerIn)
    tremoloGain.connect(flangerDelay)
    flangerDelay.connect(flangerFbGain).connect(flangerDelay)
    flangerDelay.connect(flangerMixGain).connect(dopplerIn)
    tremoloGain.connect(tapeDelay)
    tapeDelay.connect(tapeFbGain).connect(tapeDelay)
    tapeDelay.connect(tapeWetGain).connect(dopplerIn)
    tremoloGain.connect(reverb)
    reverb.connect(reverbWetGain).connect(dopplerIn)
    // doppler → master (bypass when inactive, i.e. delay 0, gain 1)
    dopplerGain.connect(master)
    master.connect(outputNode)

    nodesRef.current = {
      scrubBus, shifterBus, granBus,
      cqIn, cqOut, cqFilters,
      sat,
      wowDelay, wowLfo, wowDepthGain,
      filter,
      ringDry, ringWet, ringMix, ringOsc, ringDepth,
      ringSum,
      tremoloGain, tremoloLfo, tremoloDepthGain,
      flangerDelay, flangerLfo, flangerDepthGain, flangerFbGain, flangerMixGain,
      tapeDelay, tapeFbGain, tapeWetGain,
      reverb, reverbWetGain,
      dopplerIn, dopplerDelay, dopplerGain,
      dry, master,
      oscs,
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

  const play = useCallback(() => {
    if (!buffer) return
    if (shifterRef.current) { try { shifterRef.current.disconnect() } catch {}; shifterRef.current = null }
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    const ctx = getAudioCtx()
    const nodes = ensureEffects()
    if (!nodes) return
    const src = reversed ? reverseBuffer(buffer, ctx) : buffer
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
  }, [buffer, reversed, tempo, pitch, loopStart, loopEnd, ensureEffects, getAudioCtx])

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
      delayActive, delayTime, delayFb, wet,
      reverbActive, reverbSize, reverbWet,
      granActive, granSize, granDensity, granPos, granDrift, granSpray,
      granPitch, granPitchSpread, granGain, granConstQ, granCQBands, granCQResonance,
      dopplerActive, dopplerSpeed, dopplerRange, dopplerMinDist, dopplerMix,
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
    delayActive, delayTime, delayFb, wet,
    reverbActive, reverbSize, reverbWet,
    granActive, granSize, granDensity, granPos, granDrift, granSpray,
    granPitch, granPitchSpread, granGain, granConstQ, granCQBands, granCQResonance,
    dopplerActive, dopplerSpeed, dopplerRange, dopplerMinDist, dopplerMix,
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
  useEffect(() => { if (nodesRef.current) nodesRef.current.tapeDelay.delayTime.value = delayTime }, [delayTime])
  useEffect(() => { if (nodesRef.current) nodesRef.current.tapeFbGain.gain.value = delayFb }, [delayFb])
  // tape delay: when off, wet = 0
  useEffect(() => {
    if (!nodesRef.current) return
    nodesRef.current.tapeWetGain.gain.value = delayActive ? wet : 0
  }, [wet, delayActive])
  useEffect(() => {
    if (nodesRef.current) nodesRef.current.reverb.buffer = makeReverbIR(getAudioCtx(), reverbSize)
  }, [reverbSize, getAudioCtx])
  // reverb: when off, wet = 0
  useEffect(() => {
    if (!nodesRef.current) return
    nodesRef.current.reverbWetGain.gain.value = reverbActive ? reverbWet : 0
  }, [reverbWet, reverbActive])
  useEffect(() => { if (nodesRef.current) nodesRef.current.granBus.gain.value = granGain }, [granGain])
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
    const wasPlaying = playing
    stop()
    setReversed(r => !r)
    if (wasPlaying) setTimeout(() => play(), 10)
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
    // space
    delayActive, setDelayActive,
    delayTime, setDelayTime,
    delayFb, setDelayFb,
    wet, setWet,
    reverbActive, setReverbActive,
    reverbSize, setReverbSize,
    reverbWet, setReverbWet,
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
    // modulation
    modulators, setModulator,
    play, stop, onScrub, toggleReverse, loadFromPool,
  }
}
