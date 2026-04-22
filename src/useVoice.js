import { useRef, useState, useEffect, useCallback } from 'react'
import { useStore, defaultVoice } from './state'
import { reverseBuffer, makeReverbIR, makeSaturationCurve } from './audio'
import { applyModulation, DEFAULT_MOD, MOD_SPEC, lfoWave } from './modulation'
import { createStretchShim } from './audio/stretchShim'
import { isWorkletReady, ensureWorklets } from './audio/workletHost'

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
  // Mirror playing flag into a ref so schedulers (granulator, freeze) can
  // gate their spawn loops without triggering re-renders or effect re-runs.
  const playingRef = useRef(false)
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

  // band doppler: split signal into N freq bands, each band a pass-by
  const [bandDopplerActive, setBandDopplerActive] = useState(initial.bandDopplerActive ?? false)
  const [bandDopplerBands, setBandDopplerBands] = useState(initial.bandDopplerBands ?? 6)
  const [bandDopplerSpeed, setBandDopplerSpeed] = useState(initial.bandDopplerSpeed ?? 0.4)
  const [bandDopplerSpread, setBandDopplerSpread] = useState(initial.bandDopplerSpread ?? 0.6)
  const [bandDopplerPanWidth, setBandDopplerPanWidth] = useState(initial.bandDopplerPanWidth ?? 0.9)
  const [bandDopplerDistance, setBandDopplerDistance] = useState(initial.bandDopplerDistance ?? 1)
  const [bandDopplerGain, setBandDopplerGain] = useState(initial.bandDopplerGain ?? 1.5)
  const [bandDopplerMix, setBandDopplerMix] = useState(initial.bandDopplerMix ?? 0)

  // band reverb: split signal into N freq bands, each with its own reverb tail
  const [bandReverbActive, setBandReverbActive] = useState(initial.bandReverbActive ?? false)
  const [bandReverbBands, setBandReverbBands] = useState(initial.bandReverbBands ?? 6)
  const [bandReverbSize, setBandReverbSize] = useState(initial.bandReverbSize ?? 1.5)
  const [bandReverbSpread, setBandReverbSpread] = useState(initial.bandReverbSpread ?? 0.5)
  const [bandReverbDecay, setBandReverbDecay] = useState(initial.bandReverbDecay ?? 3)
  const [bandReverbGain, setBandReverbGain] = useState(initial.bandReverbGain ?? 1.5)
  const [bandReverbMix, setBandReverbMix] = useState(initial.bandReverbMix ?? 0)

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
  const [effectOrder, setEffectOrder] = useState(() => {
    const defaults = [
      'saturation', 'wow', 'filter', 'ringmod', 'tremolo', 'flanger', 'delay',
      'reverb', 'granulator', 'freeze', 'doppler', 'banddoppler', 'autopan',
    ]
    const existing = initial.effectOrder
    if (!existing) return defaults
    // migrate: add banddoppler / bandreverb / granulator next to neighbours if
    // missing (for sessions saved before those effects were in the chain).
    let arr = [...existing]
    if (!arr.includes('granulator')) {
      const idx = arr.indexOf('reverb')
      arr.splice(idx >= 0 ? idx + 1 : arr.length, 0, 'granulator')
    }
    if (!arr.includes('banddoppler')) {
      const idx = arr.indexOf('doppler')
      arr.splice(idx >= 0 ? idx + 1 : arr.length, 0, 'banddoppler')
    }
    if (!arr.includes('bandreverb')) {
      const idx = arr.indexOf('banddoppler')
      arr.splice(idx >= 0 ? idx + 1 : arr.length, 0, 'bandreverb')
    }
    // strip clatter if present from older sessions (feature removed)
    arr = arr.filter(x => x !== 'clatter')
    return arr
  })
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
  const bandDopplerRef = useRef({})
  bandDopplerRef.current = {
    active: bandDopplerActive, bands: bandDopplerBands, speed: bandDopplerSpeed,
    spread: bandDopplerSpread, panWidth: bandDopplerPanWidth,
    distance: bandDopplerDistance, gain: bandDopplerGain, mix: bandDopplerMix,
  }
  // Dirty-check scratchpads for cross-thread AudioParam writes. We only send
  // a new value to an AudioWorkletNode param when the JS-side value actually
  // changes, since each .value write is a main→audio post.
  const granLastRef = useRef({})
  const dopplerLastRef = useRef({})
  const bandDopplerLastRef = useRef({})
  const freezeLastRef = useRef({})
  const bandReverbRef = useRef({})
  bandReverbRef.current = {
    active: bandReverbActive, mix: bandReverbMix, gain: bandReverbGain,
  }

  // Freeze params mirror — reads from voice's own buffer
  const freezeRef = useRef({})
  freezeRef.current = {
    active: freezeActive, pos: freezePos, grain: freezeGrain,
    mix: freezeMix, gainVal: freezeGainVal, pitch: freezePitch, voices: freezeVoices, phase: freezePhase,
  }

  // Single control-rate loop driving modulator writes + worklet param pushes.
  // setInterval(33) beats rAF+skip here: we avoid one scheduling callback per
  // rendered frame, and the loop is inherently control-rate — not tied to
  // vsync. Backgrounded tabs throttle both anyway; audio keeps playing via
  // the worklets' own clocks without needing main-thread pokes.
  const modRafRef = useRef(null)
  useEffect(() => {
    const tick = () => {
      const mods = stateRef.current.modulators || {}
      let anyEnabled = false
      for (const k in mods) { if (mods[k]?.enabled) { anyEnabled = true; break } }
      if (anyEnabled) {
        applyModulation(stateRef.current, nodesRef.current, shifterRef.current)
        // virtual targets — non-AudioParam params that the scheduler reads from refs
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
      }
      // Push granulator state to the worklet's AudioParams only when it
      // actually changes. An AudioParam .value write crosses the main→audio
      // thread boundary; doing it unconditionally at 60 Hz × 10 params × 6
      // voices is >3k cross-thread writes per second for no reason.
      const granNode = nodesRef.current?.modules?.granulator?.granNode
      if (granNode) {
        const p = granRef.current
        const last = granLastRef.current
        const params = granNode.parameters
        const vp = pitchRef.current
        const a = p.active ? 1 : 0
        if (last.density !== p.density) { params.get('density').value = p.density; last.density = p.density }
        if (last.size !== p.size) { params.get('size').value = p.size; last.size = p.size }
        if (last.pos !== p.pos) { params.get('pos').value = p.pos; last.pos = p.pos }
        if (last.drift !== p.drift) { params.get('drift').value = p.drift; last.drift = p.drift }
        if (last.spray !== p.spray) { params.get('spray').value = p.spray; last.spray = p.spray }
        if (last.pitch !== p.pitch) { params.get('pitch').value = p.pitch; last.pitch = p.pitch }
        if (last.pitchSpread !== p.pitchSpread) { params.get('pitchSpread').value = p.pitchSpread; last.pitchSpread = p.pitchSpread }
        if (last.voicePitch !== vp) { params.get('voicePitch').value = vp; last.voicePitch = vp }
        if (last.active !== a) { params.get('active').value = a; last.active = a }
      }
      // Freeze worklet — same dirty-check pattern.
      const freezeNode = nodesRef.current?.modules?.freeze?.freezeNode
      if (freezeNode) {
        const f = freezeRef.current
        const last = freezeLastRef.current
        const params = freezeNode.parameters
        const vp = pitchRef.current
        const a = f.active && f.mix > 0 ? 1 : 0
        if (last.pos !== f.pos) { params.get('pos').value = f.pos; last.pos = f.pos }
        if (last.grain !== f.grain) { params.get('grain').value = f.grain; last.grain = f.grain }
        if (last.gainVal !== f.gainVal) { params.get('gain').value = f.gainVal; last.gainVal = f.gainVal }
        if (last.pitch !== f.pitch) { params.get('pitch').value = f.pitch; last.pitch = f.pitch }
        if (last.voicePitch !== vp) { params.get('voicePitch').value = vp; last.voicePitch = vp }
        if (last.voices !== f.voices) { params.get('voices').value = f.voices; last.voices = f.voices }
        if (last.phase !== f.phase) { params.get('phase').value = f.phase; last.phase = f.phase }
        if (last.active !== a) { params.get('active').value = a; last.active = a }
      }
    }
    modRafRef.current = setInterval(tick, 33)
    return () => { if (modRafRef.current) clearInterval(modRafRef.current) }
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
    if (!playingRef.current) return
    // Worklet path handles spawning sample-accurately inside process().
    if (nodes.modules?.granulator?.granNode) return
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
    // Compose voice pitch into grain rate so the voice-level Pitch control
    // shifts grains too (grains are spawned from the raw buffer, so this is
    // the hook point where the voice pitch is applied).
    const pitchSemi = p.pitch + pitchRef.current + (Math.random() - 0.5) * 2 * p.pitchSpread
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
        // Once the worklet takes over, stop scheduling JS-side spawns
        // permanently for the life of this voice. The useEffect cleanup
        // handles unmount; we don't need the timer waking to early-return.
        if (nodesRef.current?.modules?.granulator?.granNode) return
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
  // Only runs while dopplerActive is on; on deactivate we write the rest state
  // once synchronously and then cancel the loop so idle voices burn nothing.
  const dopplerRafRef = useRef(null)
  const dopplerTRef = useRef(0)
  useEffect(() => {
    if (!dopplerActive) {
      const mod = nodesRef.current?.modules?.doppler
      if (mod?.dopplerWorklet) {
        // Worklet handles its own rest-state ramp internally via the active param.
        try {
          mod.dopplerWorklet.parameters.get('active').value = 0
          dopplerLastRef.current.active = 0
        } catch {}
      } else if (mod) {
        try {
          const now = getAudioCtx().currentTime
          mod.dopplerDelay.delayTime.setTargetAtTime(0, now, 0.05)
          mod.dopplerGain.gain.setTargetAtTime(1, now, 0.05)
        } catch {}
      }
      return
    }
    let last = performance.now()
    const tick = () => {
      const now = performance.now()
      const dt = (now - last) / 1000
      last = now
      const d = dopplerRef.current
      const nodes = nodesRef.current
      const mod = nodes?.modules?.doppler
      if (mod?.dopplerWorklet) {
        const w = mod.dopplerWorklet.parameters
        const ll = dopplerLastRef.current
        const a = d.active ? 1 : 0
        if (ll.speed !== d.speed) { w.get('speed').value = d.speed; ll.speed = d.speed }
        if (ll.range !== d.range) { w.get('range').value = d.range; ll.range = d.range }
        if (ll.minDist !== d.minDist) { w.get('minDist').value = d.minDist; ll.minDist = d.minDist }
        if (ll.mix !== d.mix) { w.get('mix').value = d.mix; ll.mix = d.mix }
        if (ll.active !== a) { w.get('active').value = a; ll.active = a }
      } else if (nodes) {
        if (d.active && d.mix > 0) {
          dopplerTRef.current += dt * d.speed
          const x = d.range * Math.sin(dopplerTRef.current * Math.PI * 2)
          const dist = Math.sqrt(x * x + d.minDist * d.minDist)
          const delay = Math.min(0.49, dist / 343)
          const amp = d.minDist / dist
          const tDelay = delay * d.mix
          const tGain = 1 + (amp - 1) * d.mix
          try {
            nodes.dopplerDelay.delayTime.setTargetAtTime(tDelay, getAudioCtx().currentTime, 0.02)
            nodes.dopplerGain.gain.setTargetAtTime(tGain, getAudioCtx().currentTime, 0.02)
          } catch {}
        }
      }
      dopplerRafRef.current = requestAnimationFrame(tick)
    }
    dopplerRafRef.current = requestAnimationFrame(tick)
    return () => { if (dopplerRafRef.current) cancelAnimationFrame(dopplerRafRef.current) }
  }, [dopplerActive, getAudioCtx])

  // Band Doppler rAF — animates each band's delay/pan/gain independently so
  // the N bands feel like N different objects passing by the listener.
  // When the worklet is active, it drives the per-band params directly;
  // the rAF just pokes k-rate worklet params with current state.
  const bandDopplerRafRef = useRef(null)
  useEffect(() => {
    if (!bandDopplerActive) {
      const mod = nodesRef.current?.modules?.banddoppler
      if (mod?.worklet) {
        try {
          mod.worklet.parameters.get('active').value = 0
          bandDopplerLastRef.current.active = 0
        } catch {}
      } else if (mod) {
        try {
          const now = getAudioCtx().currentTime
          mod.dry.gain.setTargetAtTime(1, now, 0.05)
          mod.wet.gain.setTargetAtTime(0, now, 0.05)
        } catch {}
      }
      return
    }
    const TAU = Math.PI * 2
    const tick = () => {
      const bd = bandDopplerRef.current
      const nodes = nodesRef.current
      const mod = nodes?.modules?.banddoppler
      if (mod?.worklet) {
        const w = mod.worklet.parameters
        const ll = bandDopplerLastRef.current
        const a = bd.active ? 1 : 0
        if (ll.speed !== bd.speed) { w.get('speed').value = bd.speed; ll.speed = bd.speed }
        if (ll.spread !== bd.spread) { w.get('spread').value = bd.spread; ll.spread = bd.spread }
        if (ll.panWidth !== bd.panWidth) { w.get('panWidth').value = bd.panWidth; ll.panWidth = bd.panWidth }
        if (ll.distance !== bd.distance) { w.get('distance').value = bd.distance; ll.distance = bd.distance }
        if (ll.mix !== bd.mix) { w.get('mix').value = bd.mix; ll.mix = bd.mix }
        if (ll.active !== a) { w.get('active').value = a; ll.active = a }
      } else if (mod) {
        const ctx = getAudioCtx()
        const bands = mod.bandsRef.value
        const now = ctx.currentTime
        if (bd.active && bd.mix > 0 && bands.length > 0) {
          mod.dry.gain.setTargetAtTime(1 - bd.mix, now, 0.02)
          mod.wet.gain.setTargetAtTime(bd.gain, now, 0.02)
          const t = performance.now() / 1000
          const minDist = 0.8
          for (let i = 0; i < bands.length; i++) {
            const b = bands[i]
            const evenPhase = i / bands.length
            const phaseOffset = evenPhase * (1 - bd.spread) + b.phase * bd.spread
            const theta = t * bd.speed * TAU + phaseOffset * TAU
            const x = Math.sin(theta) * 6 * bd.distance
            const dist = Math.hypot(x, minDist)
            const tDelay = Math.min(0.09, dist / 343)
            const pan = Math.max(-1, Math.min(1, (x / 6) * bd.panWidth))
            const amp = (minDist / dist) * bd.mix / Math.sqrt(bands.length)
            try {
              b.delay.delayTime.setTargetAtTime(tDelay, now, 0.02)
              b.panner.pan.setTargetAtTime(pan, now, 0.02)
              b.gain.gain.setTargetAtTime(amp, now, 0.02)
            } catch {}
          }
        }
      }
      bandDopplerRafRef.current = requestAnimationFrame(tick)
    }
    bandDopplerRafRef.current = requestAnimationFrame(tick)
    return () => { if (bandDopplerRafRef.current) cancelAnimationFrame(bandDopplerRafRef.current) }
  }, [bandDopplerActive, getAudioCtx])

  // When the worklet drives the per-band params, dry/wet stays a state-change
  // useEffect — no need for the rAF tick to poke it every frame.
  useEffect(() => {
    const mod = nodesRef.current?.modules?.banddoppler
    if (!mod?.worklet) return
    const now = getAudioCtx().currentTime
    if (bandDopplerActive && bandDopplerMix > 0) {
      mod.dry.gain.setTargetAtTime(1 - bandDopplerMix, now, 0.02)
      mod.wet.gain.setTargetAtTime(bandDopplerGain, now, 0.02)
    } else {
      mod.dry.gain.setTargetAtTime(1, now, 0.05)
      mod.wet.gain.setTargetAtTime(0, now, 0.05)
    }
  }, [bandDopplerActive, bandDopplerMix, bandDopplerGain, getAudioCtx])

  // Rebuild the band network when count or active state changes.
  useEffect(() => {
    const mod = nodesRef.current && nodesRef.current.modules && nodesRef.current.modules.banddoppler
    if (mod && mod.rebuildBands) mod.rebuildBands(bandDopplerBands, bandDopplerActive)
  }, [bandDopplerBands, bandDopplerActive])

  // Band Reverb wet/dry crossfade — state-driven, no rAF. The convolver IRs
  // themselves do the reverb; this effect only reshapes when the user toggles
  // active/mix/gain, so a 60Hz tick was pure overhead.
  useEffect(() => {
    const mod = nodesRef.current?.modules?.bandreverb
    if (!mod) return
    const now = getAudioCtx().currentTime
    if (bandReverbActive && bandReverbMix > 0) {
      mod.dry.gain.setTargetAtTime(1 - bandReverbMix, now, 0.05)
      mod.wet.gain.setTargetAtTime(bandReverbGain, now, 0.05)
    } else {
      mod.dry.gain.setTargetAtTime(1, now, 0.05)
      mod.wet.gain.setTargetAtTime(0, now, 0.05)
    }
  }, [bandReverbActive, bandReverbMix, bandReverbGain, getAudioCtx])

  // Rebuild band reverb network on any param or active change.
  useEffect(() => {
    const mod = nodesRef.current && nodesRef.current.modules && nodesRef.current.modules.bandreverb
    if (mod && mod.rebuildBands) mod.rebuildBands(bandReverbBands, bandReverbSize, bandReverbSpread, bandReverbDecay, bandReverbActive)
  }, [bandReverbBands, bandReverbSize, bandReverbSpread, bandReverbDecay, bandReverbActive])


  // ---- Spectral Freeze: multi-voice grains from voice buffer, pitch + phase spread ----
  const freezeTimerRef = useRef(null)
  const freezeVoiceIdx = useRef(0)
  const spawnFreezeGrainRef = useRef(() => {})
  spawnFreezeGrainRef.current = () => {
    const f = freezeRef.current
    const buf = bufferRef.current
    const nodes = nodesRef.current
    if (!nodes || !buf || !f.active || f.mix <= 0) return
    if (!playingRef.current) return
    // Worklet path handles spawning sample-accurately inside process().
    if (nodes.modules?.freeze?.freezeNode) return
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
    // Freeze grains honour voice pitch too (freezes are raw-buffer grains).
    const rate = Math.pow(2, (f.pitch + pitchRef.current) / 12)
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
        // Once the worklet takes over, stop scheduling JS-side grains
        // permanently. Useful JS path survives only for browsers that
        // fail to load the worklet.
        if (nodesRef.current?.modules?.freeze?.freezeNode) return
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
    playingRef.current = false
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

    // ---- Source buses + granulator CQ bank (demand-loaded) ----
    // The 24-biquad constant-Q bank is only built while granConstQ is on.
    // Before then, cqIn/cqOut exist as gain stubs so rebuildable paths can
    // route through them unconditionally; the bank itself is empty.
    const scrubBus = G(1), shifterBus = G(1)
    const cqIn = G(1), cqOut = G(1)
    const cqFilters = []
    const buildCQBank = (Q = 8) => {
      if (cqFilters.length > 0) return
      for (let i = 0; i < 24; i++) {
        const f = ctx.createBiquadFilter(); f.type = 'bandpass'
        f.frequency.value = 60 * Math.pow(10000 / 60, i / 23); f.Q.value = Q
        const bg = G(((0.5 + Math.exp(-Math.pow(Math.log(f.frequency.value / 2500), 2) / 2) * 1.2) / 24) * 6)
        cqIn.connect(f).connect(bg).connect(cqOut); cqFilters.push({ filter: f, gain: bg })
      }
    }
    const teardownCQBank = () => {
      for (const { filter, gain } of cqFilters) {
        try { filter.disconnect() } catch {}
        try { gain.disconnect() } catch {}
      }
      cqFilters.length = 0
    }
    const master = G(voiceGain)

    // ---- Build each effect as a self-contained module {input, output, ...nodes} ----
    const modules = {}

    // Saturation
    { const input = G(), output = G(), sat = ctx.createWaveShaper()
      sat.curve = makeSaturationCurve(saturation); sat.oversample = '2x'
      input.connect(sat).connect(output)
      modules.saturation = { input, output, sat } }

    // Wow/Flutter — LFO is built on-activate (below), the delay line stays in
    // the graph but costs nothing until modulated.
    { const input = G(), output = G()
      const wowDelay = ctx.createDelay(0.05); wowDelay.delayTime.value = 0.008
      const wowDepthGain = G(wowDepth * 0.005)
      input.connect(wowDelay).connect(output)
      const mod = { input, output, wowDelay, wowDepthGain, wowLfo: null }
      mod.buildLfo = (rate) => {
        if (mod.wowLfo) return
        const osc = ctx.createOscillator(); osc.type = 'sine'
        osc.frequency.value = Math.max(0.01, rate || 0.01)
        osc.connect(mod.wowDepthGain); osc.start()
        mod.wowLfo = osc
      }
      mod.teardownLfo = () => {
        if (!mod.wowLfo) return
        try { mod.wowLfo.stop() } catch {}
        try { mod.wowLfo.disconnect() } catch {}
        mod.wowLfo = null
      }
      if (wowActive) mod.buildLfo(wowRate)
      modules.wow = mod
    }

    // Filter
    { const input = G(), output = G()
      const filter = ctx.createBiquadFilter()
      filter.type = filterActive ? filterType : 'allpass'; filter.frequency.value = filterHz; filter.Q.value = filterQ
      input.connect(filter).connect(output)
      modules.filter = { input, output, filter } }

    // Ring Modulator — dry + wet paths stay wired; the carrier osc is lazy.
    { const input = G(), output = G()
      const ringDry = G(1 - ringAmount), ringWet = G(0), ringMix = G(ringAmount)
      const ringDepth = G(1)
      input.connect(ringDry).connect(output)
      input.connect(ringWet).connect(ringMix).connect(output)
      const mod = { input, output, ringDry, ringWet, ringMix, ringDepth, ringOsc: null }
      mod.buildLfo = (freq) => {
        if (mod.ringOsc) return
        const osc = ctx.createOscillator(); osc.type = 'sine'
        osc.frequency.value = freq
        osc.connect(mod.ringDepth).connect(mod.ringWet.gain); osc.start()
        mod.ringOsc = osc
      }
      mod.teardownLfo = () => {
        if (!mod.ringOsc) return
        try { mod.ringOsc.stop() } catch {}
        try { mod.ringOsc.disconnect() } catch {}
        mod.ringOsc = null
      }
      if (ringActive) mod.buildLfo(ringFreq)
      modules.ringmod = mod
    }

    // Tremolo — lazy LFO.
    { const input = G(), output = G()
      const tremoloGain = G(1 - tremDepth / 2)
      const tremoloDepthGain = G(tremDepth / 2)
      input.connect(tremoloGain).connect(output)
      const mod = { input, output, tremoloGain, tremoloDepthGain, tremoloLfo: null }
      mod.buildLfo = (rate) => {
        if (mod.tremoloLfo) return
        const osc = ctx.createOscillator(); osc.type = 'sine'
        osc.frequency.value = Math.max(0.01, rate)
        osc.connect(mod.tremoloDepthGain).connect(mod.tremoloGain.gain); osc.start()
        mod.tremoloLfo = osc
      }
      mod.teardownLfo = () => {
        if (!mod.tremoloLfo) return
        try { mod.tremoloLfo.stop() } catch {}
        try { mod.tremoloLfo.disconnect() } catch {}
        mod.tremoloLfo = null
      }
      if (tremActive) mod.buildLfo(tremRate)
      modules.tremolo = mod
    }

    // Flanger — lazy LFO; delay line + feedback stay built.
    { const input = G(), output = G(), flangerDry = G(1)
      const flangerDelay = ctx.createDelay(0.05); flangerDelay.delayTime.value = 0.002
      const flangerDepthGain = G(flangerDepth * 0.002)
      const flangerFbGain = G(flangerFb), flangerMixGain = G(flangerMix)
      input.connect(flangerDry).connect(output)
      input.connect(flangerDelay); flangerDelay.connect(flangerFbGain).connect(flangerDelay)
      flangerDelay.connect(flangerMixGain).connect(output)
      const mod = { input, output, flangerDry, flangerDelay, flangerDepthGain, flangerFbGain, flangerMixGain, flangerLfo: null }
      mod.buildLfo = (rate) => {
        if (mod.flangerLfo) return
        const osc = ctx.createOscillator(); osc.type = 'sine'
        osc.frequency.value = rate
        osc.connect(mod.flangerDepthGain).connect(mod.flangerDelay.delayTime); osc.start()
        mod.flangerLfo = osc
      }
      mod.teardownLfo = () => {
        if (!mod.flangerLfo) return
        try { mod.flangerLfo.stop() } catch {}
        try { mod.flangerLfo.disconnect() } catch {}
        mod.flangerLfo = null
      }
      if (flangerActive) mod.buildLfo(flangerRate)
      modules.flanger = mod
    }

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
      let granNode = null
      if (isWorkletReady(ctx)) {
        try {
          granNode = new AudioWorkletNode(ctx, 'granulator', {
            numberOfInputs: 0,
            numberOfOutputs: 2,
            outputChannelCount: [2, 2],
          })
          granNode.connect(granMix, 0)
          granNode.connect(cqIn, 1)
        } catch (e) {
          console.error('[useVoice] granulator worklet construction failed', e)
          granNode = null
        }
      }
      modules.granulator = { input, output, granDry, granMix, granBus: granMix, cqRoute, granNode } }

    // Freeze (ducks input via mix, adds own grains)
    { const input = G(), output = G()
      const freezeDry = G(freezeActive ? (1 - freezeMix) : 1)
      const freezeMixGain = G(freezeActive ? freezeMix : 0)
      input.connect(freezeDry).connect(output)
      freezeMixGain.connect(output)
      let freezeNode = null
      if (isWorkletReady(ctx)) {
        try {
          freezeNode = new AudioWorkletNode(ctx, 'freeze', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
          })
          freezeNode.connect(freezeMixGain)
        } catch (e) {
          console.error('[useVoice] freeze worklet construction failed', e)
          freezeNode = null
        }
      }
      modules.freeze = { input, output, freezeDry, freezeMixGain, freezeNode } }

    // Doppler
    { const input = G(), output = G()
      const dopplerDelay = ctx.createDelay(0.5); dopplerDelay.delayTime.value = 0
      const dopplerGain = G(1)
      input.connect(dopplerDelay).connect(dopplerGain).connect(output)
      let dopplerWorklet = null
      if (isWorkletReady(ctx)) {
        try {
          dopplerWorklet = new AudioWorkletNode(ctx, 'doppler', {
            numberOfInputs: 0,
            numberOfOutputs: 2,
            outputChannelCount: [1, 1],
          })
          // Worklet emits absolute target values; base param values must be 0
          // so summation leaves the worklet's signal intact.
          dopplerDelay.delayTime.value = 0
          dopplerGain.gain.value = 0
          dopplerWorklet.connect(dopplerDelay.delayTime, 0)
          dopplerWorklet.connect(dopplerGain.gain, 1)
        } catch (e) {
          console.error('[useVoice] doppler worklet construction failed', e)
          dopplerWorklet = null
          dopplerDelay.delayTime.value = 0
          dopplerGain.gain.value = 1
        }
      }
      modules.doppler = { input, output, dopplerDelay, dopplerGain, dopplerWorklet } }

    // Band Doppler: splits the signal into N bandpass paths, each with its
    // own delay / pan / gain animated on a phase-offset pass-by curve. The
    // band count is rebuildable, so `rebuildBands()` tears down and rebuilds.
    { const input = G(), output = G()
      const dry = G(1)
      const wet = G(0)
      input.connect(dry).connect(output)
      wet.connect(output)
      const bandDopplerBandsRef = { value: [] }
      // Lazy-instantiate the 36-output worklet — it's meaningful audio-thread
      // overhead even when idling, and most voices never enable bandDoppler.
      // ensureWorklet() builds on first activation and keeps the node alive
      // for subsequent toggles (cheap) rather than tearing down each time.
      let worklet = null
      const ensureWorklet = () => {
        if (worklet) return worklet
        if (!isWorkletReady(ctx)) return null
        try {
          worklet = new AudioWorkletNode(ctx, 'bandDoppler', {
            numberOfInputs: 0,
            numberOfOutputs: 36,
            outputChannelCount: new Array(36).fill(1),
          })
          if (modules.banddoppler) modules.banddoppler.worklet = worklet
        } catch (e) {
          console.error('[useVoice] bandDoppler worklet construction failed', e)
          worklet = null
        }
        return worklet
      }
      // Bands are only wired into the audio graph while the effect is active.
      // Otherwise they're fully torn down — leaving them connected makes mobile
      // CPU choke and silences the worklet output.
      const rebuildBands = (n, active) => {
        // Drop any prior worklet→band-param connections before the params die.
        if (worklet) {
          for (let i = 0; i < bandDopplerBandsRef.value.length; i++) {
            const b = bandDopplerBandsRef.value[i]
            try { worklet.disconnect(b.delay.delayTime, i * 3) } catch {}
            try { worklet.disconnect(b.panner.pan, i * 3 + 1) } catch {}
            try { worklet.disconnect(b.gain.gain, i * 3 + 2) } catch {}
          }
        }
        for (const b of bandDopplerBandsRef.value) {
          try { input.disconnect(b.bpf) } catch {}
          try { b.bpf.disconnect() } catch {}
          try { b.delay.disconnect() } catch {}
          try { b.panner.disconnect() } catch {}
          try { b.gain.disconnect() } catch {}
        }
        bandDopplerBandsRef.value = []
        if (!active) {
          if (worklet) worklet.port.postMessage({ type: 'setNumBands', n: 0 })
          return
        }
        // First activation — build the worklet on demand.
        ensureWorklet()
        const fresh = []
        const N = Math.max(1, Math.min(12, n | 0))
        const phases = new Array(N)
        for (let i = 0; i < N; i++) {
          const bpf = ctx.createBiquadFilter()
          bpf.type = 'bandpass'
          const t = N === 1 ? 0.5 : i / (N - 1)
          bpf.frequency.value = 60 * Math.pow(10000 / 60, t)
          bpf.Q.value = 6
          const delay = ctx.createDelay(0.1)
          delay.delayTime.value = 0
          const panner = ctx.createStereoPanner()
          // Base gain is 0 when the worklet will drive it (summation leaves
          // the worklet's absolute value intact); 1 for the legacy rAF path.
          const gain = G(worklet ? 0 : 1)
          input.connect(bpf).connect(delay).connect(panner).connect(gain).connect(wet)
          const phase = (Math.sin(i * 12.9898) * 43758.5453) % 1
          const normPhase = ((phase % 1) + 1) % 1
          phases[i] = normPhase
          fresh.push({ bpf, delay, panner, gain, phase: normPhase })
          if (worklet) {
            worklet.connect(delay.delayTime, i * 3)
            worklet.connect(panner.pan, i * 3 + 1)
            worklet.connect(gain.gain, i * 3 + 2)
          }
        }
        bandDopplerBandsRef.value = fresh
        if (worklet) {
          worklet.port.postMessage({ type: 'setPhases', phases })
          worklet.port.postMessage({ type: 'setNumBands', n: N })
        }
      }
      rebuildBands(bandDopplerBands, bandDopplerActive)
      modules.banddoppler = {
        input, output, dry, wet, bandsRef: bandDopplerBandsRef, rebuildBands, worklet,
      }
    }

    // Band Reverb: splits the signal into N bandpass paths, each through its
    // own convolver reverb with an independently sized / shaped IR.
    { const input = G(), output = G()
      const dry = G(1)
      const wet = G(0)
      input.connect(dry).connect(output)
      wet.connect(output)
      const bandReverbBandsRef = { value: [] }
      // Convolvers stay torn down until the effect is active — leaving 6
      // convolution paths processing input silently is enough to overload
      // mobile audio worklets and silence playback.
      const rebuildBands = (n, sizeSec, spread, decay, active) => {
        for (const b of bandReverbBandsRef.value) {
          try { input.disconnect(b.bpf) } catch {}
          try { b.bpf.disconnect() } catch {}
          try { b.convolver.disconnect() } catch {}
          try { b.gain.disconnect() } catch {}
        }
        bandReverbBandsRef.value = []
        if (!active) return
        const fresh = []
        const N = Math.max(1, Math.min(12, n | 0))
        for (let i = 0; i < N; i++) {
          const bpf = ctx.createBiquadFilter()
          bpf.type = 'bandpass'
          const t = N === 1 ? 0.5 : i / (N - 1)
          bpf.frequency.value = 60 * Math.pow(10000 / 60, t)
          bpf.Q.value = 5
          const r = (Math.sin(i * 23.717) * 43758.5453) % 1
          const rn = ((r % 1) + 1) % 1
          const lowBias = 1 - t
          const variation = (rn - 0.5) * 2
          // Narrow high-band IR tail is inaudible past ~1s anyway — clamp
          // max duration per band (t=0 → 6s, t=1 → 0.5s). Cuts convolver
          // cost roughly linearly with IR length without altering character.
          const maxDur = 0.5 + (1 - t) * 5.5
          const rawDur = sizeSec * (0.5 + lowBias * 0.7 + variation * spread * 0.6)
          const dur = Math.max(0.1, Math.min(maxDur, rawDur))
          const convolver = ctx.createConvolver()
          convolver.buffer = makeReverbIR(ctx, dur, Math.max(0.5, decay))
          const gain = G(1)
          input.connect(bpf).connect(convolver).connect(gain).connect(wet)
          fresh.push({ bpf, convolver, gain })
        }
        bandReverbBandsRef.value = fresh
      }
      rebuildBands(bandReverbBands, bandReverbSize, bandReverbSpread, bandReverbDecay, bandReverbActive)
      modules.bandreverb = {
        input, output, dry, wet, bandsRef: bandReverbBandsRef, rebuildBands,
      }
    }

    // Auto Pan — lazy LFO; StereoPanner stays in the graph.
    { const input = G(), output = G()
      const autoPan = ctx.createStereoPanner(); autoPan.pan.value = panCenter
      const panDepthGain = G(panActive ? panDepth : 0)
      input.connect(autoPan).connect(output)
      const mod = { input, output, autoPan, panDepthGain, panLfo: null }
      mod.buildLfo = (rate, wave) => {
        if (mod.panLfo) return
        const validWave = ['sine', 'triangle', 'square', 'sawtooth'].includes(wave) ? wave : 'sine'
        const osc = ctx.createOscillator(); osc.type = validWave
        osc.frequency.value = Math.max(0.01, rate)
        osc.connect(mod.panDepthGain).connect(mod.autoPan.pan); osc.start()
        mod.panLfo = osc
      }
      mod.teardownLfo = () => {
        if (!mod.panLfo) return
        try { mod.panLfo.stop() } catch {}
        try { mod.panLfo.disconnect() } catch {}
        mod.panLfo = null
      }
      if (panActive) mod.buildLfo(panRate, panWave)
      modules.autopan = mod
    }

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
      cqIn, cqOut, cqFilters, buildCQBank, teardownCQBank,
      master, oscs, modules, wireChain,
    }
    return nodesRef.current
  }, [getAudioCtx, outputNode])

  const teardownEffects = useCallback(() => {
    if (!nodesRef.current) return
    const { oscs, cqFilters, modules, ...rest } = nodesRef.current
    if (oscs) oscs.forEach(o => { try { o.stop() } catch {} })
    if (cqFilters) cqFilters.forEach(({ filter, gain }) => {
      try { filter.disconnect() } catch {}
      try { gain.disconnect() } catch {}
    })
    // Lazy-built LFOs live outside oscs; tear them down via their modules.
    if (modules) {
      for (const m of Object.values(modules)) {
        if (typeof m.teardownLfo === 'function') { try { m.teardownLfo() } catch {} }
      }
    }
    Object.values(rest).forEach(n => { try { n.disconnect() } catch {} })
    nodesRef.current = null
  }, [])

  useEffect(() => {
    let cancelled = false
    const setup = async () => {
      stop()
      teardownEffects()
      if (!buffer) return
      // Wait for addModule to resolve so isWorkletReady(ctx) returns true
      // before the first ensureEffects() call. On mobile this can take a
      // couple hundred ms; without the await, voices silently fall back to
      // the old main-thread paths for their entire lifetime because
      // nodesRef.current gets cached on the first (pre-ready) call.
      await ensureWorklets(getAudioCtx())
      if (cancelled) return
      // Teardown again — if anything (scrub, play) built stale non-worklet
      // effects during the await, this forces a fresh worklet-backed build.
      teardownEffects()
      ensureEffects()
    }
    setup()
    return () => { cancelled = true; stop(); teardownEffects() }
  }, [buffer, ensureEffects, stop, teardownEffects, getAudioCtx])

  // rewire chain when effect order changes
  useEffect(() => {
    if (nodesRef.current?.wireChain) nodesRef.current.wireChain()
  }, [effectOrder])

  // Keep loop bounds in a ref so the play-tick closure picks up live edits
  // (e.g. dragging loop handles during playback) without having to restart.
  const loopBoundsRef = useRef({ start: loopStart, end: loopEnd })
  loopBoundsRef.current = { start: loopStart, end: loopEnd }

  const play = useCallback(async (opts) => {
    if (!buffer) return
    const oneShot = !!opts?.oneShot
    const onEnded = opts?.onEnded
    const ctx = getAudioCtx()
    // Belt-and-suspenders for the race already mostly handled by the buffer
    // effect: if a caller hits play() before ensureWorklets has resolved
    // (e.g. fast initial interaction, or a scrub built stale nodes), this
    // awaits the cached promise and then the follow-through teardownEffects +
    // ensureEffects below picks up worklet-backed modules. Essentially free
    // on repeat calls since readyByContext caches the promise.
    await ensureWorklets(ctx)
    if (shifterRef.current) { try { shifterRef.current.disconnect() } catch {}; shifterRef.current = null }
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    // Force a rebuild if whatever built the nodes didn't have worklets ready.
    if (nodesRef.current && !nodesRef.current.modules?.granulator?.granNode) {
      teardownEffects()
    }
    const nodes = ensureEffects()
    if (!nodes) return
    const src = reversedRef.current ? reverseBuffer(buffer, ctx) : buffer
    const dur = src.duration
    // Use a native AudioBufferSourceNode when we don't need pitch/tempo
    // shifting — it supports hardware loopStart/loopEnd and is free on the
    // audio thread. The worklet stretcher spins up only when needed.
    const needsShifter = tempo !== 1 || pitch !== 0
    playingRef.current = true
    setPlaying(true)
    if (!needsShifter) {
      const { start: ls0, end: le0 } = loopBoundsRef.current
      const node = ctx.createBufferSource()
      node.buffer = src
      node.loop = !oneShot
      node.loopStart = Math.max(0, Math.min(dur, ls0 * dur))
      node.loopEnd = Math.max(node.loopStart + 0.01, Math.min(dur, le0 * dur))
      node.connect(nodes.shifterBus)
      const t0 = ctx.currentTime
      const startOffset = node.loopStart
      if (oneShot) {
        const span = Math.max(0.01, node.loopEnd - node.loopStart)
        node.start(0, startOffset, span)
        node.onended = () => { if (onEnded) onEnded() }
      } else {
        node.start(0, startOffset)
      }
      // Shim matching the shifter surface the rest of useVoice expects.
      const shim = {
        _kind: 'source',
        _node: node,
        _dest: nodes.shifterBus,
        _startedAt: t0,
        _startOffset: startOffset,
        get tempo() { return 1 },
        set tempo(_v) {},
        get pitchSemitones() { return 0 },
        set pitchSemitones(_v) {},
        get percentagePlayed() {
          const ls = node.loopStart
          const le = node.loopEnd
          const range = Math.max(0.001, le - ls)
          const elapsed = ctx.currentTime - this._startedAt
          const within = ((this._startOffset - ls) + elapsed) % range
          return ((ls + within) / dur) * 100
        },
        set percentagePlayed(pct) {
          try { this._node.stop() } catch {}
          try { this._node.disconnect() } catch {}
          const off = Math.max(0, Math.min(dur - 0.001, (pct / 100) * dur))
          const ns = ctx.createBufferSource()
          ns.buffer = src
          ns.loop = true
          ns.loopStart = node.loopStart
          ns.loopEnd = node.loopEnd
          ns.connect(this._dest)
          ns.start(0, off)
          this._node = ns
          this._startedAt = ctx.currentTime
          this._startOffset = off
        },
        updateLoop(ls, le) {
          this._node.loopStart = Math.max(0, Math.min(dur, ls * dur))
          this._node.loopEnd = Math.max(this._node.loopStart + 0.01, Math.min(dur, le * dur))
        },
        connect() {},
        disconnect() {
          try { this._node.stop() } catch {}
          try { this._node.disconnect() } catch {}
        },
      }
      shifterRef.current = shim
    } else {
      const lb = loopBoundsRef.current
      const shifter = createStretchShim(ctx, src, nodes.shifterBus, {
        tempo,
        pitch,
        loopStart: lb.start,
        loopEnd: lb.end,
        oneShot,
        onEnded,
        startFromNorm: lb.start,
      })
      shifterRef.current = shifter
    }
    const tick = () => {
      const sh = shifterRef.current
      if (!sh) return
      // Keep loop points in sync with the ref so live drags of loop handles
      // apply during playback. Both the native source path and the stretch
      // worklet expose updateLoop.
      if ((sh._kind === 'source' || sh._kind === 'stretch') && sh.updateLoop) {
        const { start: ls, end: le } = loopBoundsRef.current
        sh.updateLoop(ls, le)
      }
      const p = sh.percentagePlayed / 100
      setPosition(p)
      // Stretch and native source handle looping themselves. For one-shot
      // playback via stretch we still watch for end-of-buffer to fire
      // onEnded (native source uses AudioBufferSourceNode.onended instead).
      if (sh._kind === 'stretch' && sh._oneShot && p >= 0.999) {
        const cb = sh._onEnded
        if (cb) cb()
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [buffer, tempo, pitch, ensureEffects, getAudioCtx, teardownEffects])

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
      bandDopplerActive, bandDopplerBands, bandDopplerSpeed, bandDopplerSpread,
      bandDopplerPanWidth, bandDopplerDistance, bandDopplerGain, bandDopplerMix,
      bandReverbActive, bandReverbBands, bandReverbSize, bandReverbSpread,
      bandReverbDecay, bandReverbGain, bandReverbMix,
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
    bandDopplerActive, bandDopplerBands, bandDopplerSpeed, bandDopplerSpread,
    bandDopplerPanWidth, bandDopplerDistance, bandDopplerGain, bandDopplerMix,
    bandReverbActive, bandReverbBands, bandReverbSize, bandReverbSpread,
    bandReverbDecay, bandReverbGain, bandReverbMix,
    freezeActive, freezePos, freezeGrain, freezeMix, freezeGainVal, freezePitch, freezeVoices, freezePhase,
    effectOrder,
    modulators,
  ])

  // Live updates
  // If tempo/pitch moves away from defaults while the cheap source-node path
  // is playing, rebuild as a stretch shim so the change takes effect. Going
  // back to defaults rebuilds down to the raw source node.
  const playRef = useRef(play); playRef.current = play
  const rebuildPlaybackIfNeeded = () => {
    const sh = shifterRef.current
    if (!sh) return
    const onSource = sh._kind === 'source'
    const needsShifter = tempo !== 1 || pitch !== 0
    if (onSource && needsShifter) { playRef.current() }
    else if (!onSource && !needsShifter) { playRef.current() }
    else if (!onSource) {
      try { sh.tempo = tempo } catch {}
      try { sh.pitchSemitones = pitch } catch {}
    }
  }
  useEffect(() => { rebuildPlaybackIfNeeded() }, [tempo])
  useEffect(() => { rebuildPlaybackIfNeeded() }, [pitch])
  useEffect(() => { if (nodesRef.current) nodesRef.current.master.gain.value = voiceGain }, [voiceGain])
  // saturation: when off, force identity curve (pass-through)
  useEffect(() => {
    if (!nodesRef.current) return
    nodesRef.current.sat.curve = makeSaturationCurve(satActive ? saturation : 0)
  }, [saturation, satActive])
  // wow: LFO is lazy — built on activate, stopped on deactivate. Depth gain
  // still zeroes on inactive as belt-and-suspenders during the transition.
  useEffect(() => {
    const m = nodesRef.current?.modules?.wow
    if (!m) return
    if (wowActive) m.buildLfo(wowRate)
    else m.teardownLfo()
  }, [wowActive])
  useEffect(() => {
    const lfo = nodesRef.current?.modules?.wow?.wowLfo
    if (lfo) lfo.frequency.value = Math.max(0.01, wowRate)
  }, [wowRate])
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
  useEffect(() => {
    const m = nodesRef.current?.modules?.ringmod
    if (!m) return
    if (ringActive) m.buildLfo(ringFreq)
    else m.teardownLfo()
  }, [ringActive])
  useEffect(() => {
    const osc = nodesRef.current?.modules?.ringmod?.ringOsc
    if (osc) osc.frequency.value = ringFreq
  }, [ringFreq])
  // ring mod: when off, dry=1, wet=0
  useEffect(() => {
    if (!nodesRef.current) return
    const amt = ringActive ? ringAmount : 0
    nodesRef.current.ringDry.gain.value = 1 - amt
    nodesRef.current.ringMix.gain.value = amt
  }, [ringAmount, ringActive])
  useEffect(() => {
    const m = nodesRef.current?.modules?.flanger
    if (!m) return
    if (flangerActive) m.buildLfo(flangerRate)
    else m.teardownLfo()
  }, [flangerActive])
  useEffect(() => {
    const lfo = nodesRef.current?.modules?.flanger?.flangerLfo
    if (lfo) lfo.frequency.value = Math.max(0.01, flangerRate)
  }, [flangerRate])
  useEffect(() => { if (nodesRef.current) nodesRef.current.flangerDepthGain.gain.value = flangerDepth * 0.002 }, [flangerDepth])
  useEffect(() => { if (nodesRef.current) nodesRef.current.flangerFbGain.gain.value = flangerFb }, [flangerFb])
  // flanger: when off, mix = 0
  useEffect(() => {
    if (!nodesRef.current) return
    nodesRef.current.flangerMixGain.gain.value = flangerActive ? flangerMix : 0
  }, [flangerMix, flangerActive])
  useEffect(() => {
    const m = nodesRef.current?.modules?.tremolo
    if (!m) return
    if (tremActive) m.buildLfo(tremRate)
    else m.teardownLfo()
  }, [tremActive])
  useEffect(() => {
    const lfo = nodesRef.current?.modules?.tremolo?.tremoloLfo
    if (lfo) lfo.frequency.value = Math.max(0.01, tremRate)
  }, [tremRate])
  // tremolo: when off, gain stays at 1 with no modulation
  useEffect(() => {
    if (!nodesRef.current) return
    const d = tremActive ? tremDepth : 0
    nodesRef.current.tremoloGain.gain.value = 1 - d / 2
    nodesRef.current.tremoloDepthGain.gain.value = d / 2
  }, [tremDepth, tremActive])
  // auto-pan — lazy LFO.
  useEffect(() => {
    const m = nodesRef.current?.modules?.autopan
    if (!m) return
    if (panActive) m.buildLfo(panRate, panWave)
    else m.teardownLfo()
  }, [panActive])
  useEffect(() => {
    const lfo = nodesRef.current?.modules?.autopan?.panLfo
    if (lfo) lfo.frequency.value = Math.max(0.01, panRate)
  }, [panRate])
  useEffect(() => {
    if (!nodesRef.current) return
    nodesRef.current.panDepthGain.gain.value = panActive ? panDepth : 0
  }, [panDepth, panActive])
  useEffect(() => { if (nodesRef.current) nodesRef.current.autoPan.pan.value = panCenter }, [panCenter])
  useEffect(() => {
    const lfo = nodesRef.current?.modules?.autopan?.panLfo
    if (!lfo) return
    const w = ['sine', 'triangle', 'square', 'sawtooth'].includes(panWave) ? panWave : 'sine'
    try { lfo.type = w } catch {}
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
  useEffect(() => {
    if (!nodesRef.current) return
    nodesRef.current.granBus.gain.value = granGain
    if (nodesRef.current.granDry) nodesRef.current.granDry.gain.value = granActive ? 0 : 1
  }, [granGain, granActive])
  // freeze: wet/dry crossfade inside the freeze module
  useEffect(() => {
    if (!nodesRef.current) return
    nodesRef.current.freezeMixGain.gain.value = freezeActive ? freezeMix : 0
    if (nodesRef.current.freezeDry) nodesRef.current.freezeDry.gain.value = freezeActive ? (1 - freezeMix) : 1
  }, [freezeMix, freezeActive])
  useEffect(() => {
    const n = nodesRef.current
    if (!n) return
    if (granConstQ) n.buildCQBank(granCQResonance)
    else n.teardownCQBank()
  }, [granConstQ])

  useEffect(() => {
    if (!nodesRef.current) return
    // No-op when the bank isn't built; otherwise sweeps Q live.
    nodesRef.current.cqFilters.forEach(({ filter }) => { filter.Q.value = granCQResonance })
  }, [granCQResonance])

  // Push the current buffer into the granulator worklet whenever it changes.
  // Clone channels into fresh Float32Arrays so we can transfer ownership to
  // the worklet without losing main-thread access to the original AudioBuffer.
  const granBufferIdRef = useRef(0)
  useEffect(() => {
    const granNode = nodesRef.current?.modules?.granulator?.granNode
    if (!granNode || !buffer) return
    const id = ++granBufferIdRef.current
    const chans = []
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const copy = new Float32Array(buffer.length)
      copy.set(buffer.getChannelData(c))
      chans.push(copy)
    }
    granNode.port.postMessage({ type: 'loadBuffer', id, channels: chans }, chans.map(c => c.buffer))
  }, [buffer])

  // Forward constQ routing toggle into the worklet.
  useEffect(() => {
    const granNode = nodesRef.current?.modules?.granulator?.granNode
    if (!granNode) return
    granNode.port.postMessage({ type: 'setConstQ', enabled: granConstQ })
  }, [granConstQ])

  // Push the current buffer into the freeze worklet whenever it changes.
  // Independent clone from the granulator's copy — transferable ownership
  // moves the ArrayBuffer over, so each worklet needs its own Float32Arrays.
  const freezeBufferIdRef = useRef(0)
  useEffect(() => {
    const freezeNode = nodesRef.current?.modules?.freeze?.freezeNode
    if (!freezeNode || !buffer) return
    const id = ++freezeBufferIdRef.current
    const chans = []
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const copy = new Float32Array(buffer.length)
      copy.set(buffer.getChannelData(c))
      chans.push(copy)
    }
    freezeNode.port.postMessage({ type: 'loadBuffer', id, channels: chans }, chans.map(c => c.buffer))
  }, [buffer])

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

  // Reset every effect parameter back to its defaultVoice() value. Doesn't
  // touch the loaded sample or loop region.
  const reset = useCallback(() => {
    const d = defaultVoice()
    setTempo(d.tempo); setPitch(d.pitch); setVoiceGain(d.voiceGain)
    setSatActive(d.satActive); setSaturation(d.saturation)
    setWowActive(d.wowActive); setWowRate(d.wowRate); setWowDepth(d.wowDepth)
    setFilterActive(d.filterActive); setFilterType(d.filterType)
    setFilterHz(d.filterHz); setFilterQ(d.filterQ)
    setRingActive(d.ringActive); setRingFreq(d.ringFreq); setRingAmount(d.ringAmount)
    setFlangerActive(d.flangerActive); setFlangerRate(d.flangerRate)
    setFlangerDepth(d.flangerDepth); setFlangerFb(d.flangerFb); setFlangerMix(d.flangerMix)
    setTremActive(d.tremActive); setTremRate(d.tremRate); setTremDepth(d.tremDepth)
    setPanActive(d.panActive); setPanRate(d.panRate); setPanDepth(d.panDepth)
    setPanCenter(d.panCenter); setPanWave(d.panWave)
    setDelayActive(d.delayActive); setDelayTime(d.delayTime); setDelayFb(d.delayFb); setWet(d.wet)
    setReverbActive(d.reverbActive); setReverbSize(d.reverbSize); setReverbWet(d.reverbWet)
    setGranActive(d.granActive); setGranSize(d.granSize); setGranDensity(d.granDensity)
    setGranPos(d.granPos); setGranDrift(d.granDrift); setGranSpray(d.granSpray)
    setGranPitch(d.granPitch); setGranPitchSpread(d.granPitchSpread); setGranGain(d.granGain)
    setGranConstQ(d.granConstQ); setGranCQBands(d.granCQBands); setGranCQResonance(d.granCQResonance)
    setDopplerActive(d.dopplerActive); setDopplerSpeed(d.dopplerSpeed)
    setDopplerRange(d.dopplerRange); setDopplerMinDist(d.dopplerMinDist); setDopplerMix(d.dopplerMix)
    setBandDopplerActive(d.bandDopplerActive); setBandDopplerBands(d.bandDopplerBands)
    setBandDopplerSpeed(d.bandDopplerSpeed); setBandDopplerSpread(d.bandDopplerSpread)
    setBandDopplerPanWidth(d.bandDopplerPanWidth); setBandDopplerDistance(d.bandDopplerDistance)
    setBandDopplerGain(d.bandDopplerGain); setBandDopplerMix(d.bandDopplerMix)
    setBandReverbActive(d.bandReverbActive); setBandReverbBands(d.bandReverbBands)
    setBandReverbSize(d.bandReverbSize); setBandReverbSpread(d.bandReverbSpread)
    setBandReverbDecay(d.bandReverbDecay); setBandReverbGain(d.bandReverbGain)
    setBandReverbMix(d.bandReverbMix)
    setFreezeActive(d.freezeActive); setFreezePos(d.freezePos); setFreezeGrain(d.freezeGrain)
    setFreezeMix(d.freezeMix); setFreezeGainVal(d.freezeGainVal); setFreezePitch(d.freezePitch)
    setFreezeVoices(d.freezeVoices); setFreezePhase(d.freezePhase)
    setModulators({})
  }, [])

  // Musical-range randomization: picks sensible values for each parameter and
  // toggles each effect independently with a per-effect probability so the
  // variation stays playable rather than chaotic. Skips transport and loop.
  const randomize = useCallback(() => {
    const rnd = (min, max) => min + Math.random() * (max - min)
    const rndLog = (min, max) => Math.exp(rnd(Math.log(min), Math.log(max)))
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
    const bool = (p = 0.5) => Math.random() < p

    // Tape transport — kept in musical range so it doesn't get unplayable.
    setTempo(rndLog(0.5, 2))
    setPitch(Math.round(rnd(-12, 12)))
    setVoiceGain(rnd(0.7, 1.2))
    setSatActive(bool(0.5)); setSaturation(rnd(0, 0.5))
    setWowActive(bool(0.4)); setWowRate(rnd(0, 4)); setWowDepth(rnd(0, 0.5))
    setFilterActive(bool(0.7))
    setFilterType(pick(['lowpass', 'highpass', 'bandpass', 'notch']))
    setFilterHz(rndLog(200, 12000)); setFilterQ(rnd(0.5, 6))
    setRingActive(bool(0.25)); setRingFreq(rndLog(30, 1000)); setRingAmount(rnd(0, 0.5))
    setFlangerActive(bool(0.4)); setFlangerRate(rnd(0.05, 2))
    setFlangerDepth(rnd(0, 0.6)); setFlangerFb(rnd(0, 0.5)); setFlangerMix(rnd(0, 0.6))
    setTremActive(bool(0.35)); setTremRate(rnd(0.3, 8)); setTremDepth(rnd(0, 0.5))
    setPanActive(bool(0.5)); setPanRate(rnd(0.1, 4))
    setPanDepth(rnd(0, 0.8)); setPanCenter(rnd(-0.5, 0.5))
    setPanWave(pick(['sine', 'triangle', 'square', 'sawtooth']))
    setDelayActive(bool(0.5)); setDelayTime(rnd(0.05, 0.6))
    setDelayFb(rnd(0, 0.55)); setWet(rnd(0, 0.5))
    setReverbActive(bool(0.5)); setReverbSize(rnd(0.4, 3)); setReverbWet(rnd(0, 0.5))
    setGranActive(bool(0.35)); setGranSize(rnd(0.02, 0.2))
    setGranDensity(rnd(4, 40)); setGranPos(rnd(0, 1))
    setGranSpray(rnd(0, 0.2)); setGranPitch(Math.round(rnd(-12, 12)))
    setGranPitchSpread(rnd(0, 8)); setGranGain(rnd(0.6, 1.4))
    setFreezeActive(bool(0.25)); setFreezePos(rnd(0, 1))
    setFreezeGrain(rnd(0.01, 0.5)); setFreezeMix(rnd(0, 0.7))
    setFreezePitch(Math.round(rnd(-12, 12)))
    setDopplerActive(bool(0.3)); setDopplerSpeed(rnd(0.1, 2))
    setDopplerRange(rnd(2, 20)); setDopplerMix(rnd(0, 0.6))
    setBandDopplerActive(bool(0.3)); setBandDopplerBands(Math.round(rnd(4, 10)))
    setBandDopplerSpeed(rnd(0.1, 1.5)); setBandDopplerSpread(rnd(0.3, 1))
    setBandDopplerPanWidth(rnd(0.4, 1)); setBandDopplerDistance(rnd(0.5, 2))
    setBandDopplerMix(rnd(0, 0.5))
    setBandReverbActive(bool(0.3)); setBandReverbBands(Math.round(rnd(4, 10)))
    setBandReverbSize(rnd(0.5, 3)); setBandReverbSpread(rnd(0, 1))
    setBandReverbDecay(rnd(1.5, 5)); setBandReverbMix(rnd(0, 0.4))
  }, [])

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
    // band doppler
    bandDopplerActive, setBandDopplerActive,
    bandDopplerBands, setBandDopplerBands,
    bandDopplerSpeed, setBandDopplerSpeed,
    bandDopplerSpread, setBandDopplerSpread,
    bandDopplerPanWidth, setBandDopplerPanWidth,
    bandDopplerDistance, setBandDopplerDistance,
    bandDopplerGain, setBandDopplerGain,
    bandDopplerMix, setBandDopplerMix,
    // band reverb
    bandReverbActive, setBandReverbActive,
    bandReverbBands, setBandReverbBands,
    bandReverbSize, setBandReverbSize,
    bandReverbSpread, setBandReverbSpread,
    bandReverbDecay, setBandReverbDecay,
    bandReverbGain, setBandReverbGain,
    bandReverbMix, setBandReverbMix,
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
    randomize, reset,
  }
}
