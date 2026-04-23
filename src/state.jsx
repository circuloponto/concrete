import { createContext, useContext, useRef, useState, useCallback } from 'react'
import { bufferToBase64, base64ToBuffer } from './audio'
import { ensureWorklets } from './audio/workletHost'
import { prewarmCommonIRs } from './audio/irCache'

const Ctx = createContext(null)

let _id = 0
const genId = () => `id_${Date.now().toString(36)}_${(_id++).toString(36)}`

export const makeTrack = () => ({ clips: [], mute: false, solo: false, gain: 1, pan: 0 })

// Migrate old track shapes into the new {clips, mute, solo, gain, pan} object.
export function migrateTrack(t) {
  if (Array.isArray(t)) return { clips: t, mute: false, solo: false, gain: 1, pan: 0 }
  if (t && typeof t === 'object' && 'clips' in t) {
    return { mute: false, solo: false, gain: 1, pan: 0, ...t, clips: t.clips || [] }
  }
  return makeTrack()
}

export const defaultVoice = () => ({
  loadedPoolId: '',
  tempo: 1,
  pitch: 0,
  voiceGain: 1,
  reversed: false,
  loopStart: 0,
  loopEnd: 1,
  view: 'disk',
  // filter
  filterActive: false,
  filterType: 'lowpass',
  filterHz: 18000,
  filterQ: 0.7,
  // saturation
  satActive: false,
  saturation: 0,
  // wow/flutter
  wowActive: false,
  wowRate: 0,
  wowDepth: 0,
  // ring mod
  ringActive: false,
  ringFreq: 100,
  ringAmount: 0,
  // flanger
  flangerActive: false,
  flangerRate: 0.3,
  flangerDepth: 0.4,
  flangerFb: 0.3,
  flangerMix: 0,
  // tremolo
  tremActive: false,
  tremRate: 4,
  tremDepth: 0,
  // auto pan
  panActive: false,
  panRate: 0.6,
  panDepth: 0,
  panCenter: 0,
  panWave: 'sine',
  // tape delay
  delayActive: false,
  delayTime: 0.25,
  delayFb: 0.35,
  wet: 0,
  // reverb
  reverbActive: false,
  reverbSize: 1.5,
  reverbWet: 0,
  reverbIRPoolId: '',
  // granulator
  granActive: false,
  granSize: 0.08,
  granDensity: 20,
  granPos: 0.5,
  granDrift: 0,
  granSpray: 0.02,
  granPitch: 0,
  granPitchSpread: 0,
  granGain: 1,
  granConstQ: false,
  granCQBands: 16,
  granCQResonance: 8,
  granMode: 'source',      // 'source' = loaded buffer · 'live' = 5s ring of chain input
  // doppler
  dopplerActive: false,
  dopplerSpeed: 0.5,
  dopplerRange: 10,
  dopplerMinDist: 1,
  dopplerMix: 1,
  // multi-band doppler (sound split into N freq bands, each a pass-by)
  bandDopplerActive: false,
  bandDopplerBands: 6,
  bandDopplerSpeed: 0.4,
  bandDopplerSpread: 0.6,
  bandDopplerPanWidth: 0.9,
  bandDopplerDistance: 1,
  bandDopplerGain: 1.5,
  bandDopplerMix: 0,
  // multi-band reverb (sound split into N freq bands, each with own tail)
  bandReverbActive: false,
  bandReverbBands: 6,
  bandReverbSize: 1.5,
  bandReverbSpread: 0.5,
  bandReverbDecay: 3,
  bandReverbGain: 1.5,
  bandReverbMix: 0,
  // spectral freeze
  freezeActive: false,
  freezeMode: 'source',  // 'source' = loaded buffer · 'live' = 5s ring of chain input
  freezePos: 0.5,
  freezeGrain: 0.06,
  freezeMix: 1,
  freezeGainVal: 1,
  freezePitch: 0,
  freezeVoices: 4,
  freezePhase: 0.5,
  // per-voice Print — offline bounce of voice output to pool
  printDurationSec: 30,
  printedSwap: null,
  // stutter / beat-repeat with explicit start/end cycle endpoints plus
  // per-burst pitch + amp contours, jitter, and curve-shape selector.
  stutterActive: false,
  stutterMode: 'auto',      // 'auto' = random-interval bursts, 'manual' = trigger-only
  stutterStartCycle: 0.2,
  stutterEndCycle: 0.05,
  stutterRepeats: 8,
  stutterAutoRate: 1.5,
  stutterMix: 1,
  stutterPitchActive: false,
  stutterStartPitch: 0,     // semitones
  stutterEndPitch: 0,
  stutterAmpShape: 0,       // -1 swell · 0 flat · +1 decay
  stutterJitter: 0,         // 0..1 — random spread on every per-repeat value
  stutterCurveShape: 'geometric',  // 'linear' | 'geometric' | 'exponential' | 'scurve'
  stutterShapeRandom: false,       // re-roll startCycle / endCycle / repeats per burst
  // effect chain order (all modules are serial, each with internal wet/dry)
  effectOrder: ['saturation', 'wow', 'filter', 'ringmod', 'tremolo', 'flanger', 'delay', 'reverb', 'granulator', 'freeze', 'doppler', 'banddoppler', 'bandreverb', 'stutter', 'autopan'],
  // per-effect post-module output gain. Missing keys default to 1.0.
  // Range exposed in UI is 0..8 (+18 dB headroom) so users can recover
  // signal after destructive sections of the chain like deep filtering
  // or narrow band-reverb tails.
  effectGains: {},
  // modulation
  modulators: {},
})
export const MAX_VOICES = 6
const defaultSoundState = () => ({
  focused: 1,
  voiceCount: 2,
  voices: Array.from({ length: MAX_VOICES }, defaultVoice),
  bus: { feedback: 0 },
})
const defaultUi = () => ({ tab: 'sound', selectedPoolId: null })

export function StateProvider({ children }) {
  const audioCtxRef = useRef(null)
  const buffersRef = useRef(new Map())
  // Shared transport ref — SoundTab writes voice play/stop/etc, DiffusionTab reads
  const transportRef = useRef({ voices: [], startRecord: null, stopRecord: null, recording: false })
  const [pool, setPool] = useState([])
  const [objects, setObjects] = useState([])
  const [timeline, setTimeline] = useState({ tracks: Array.from({ length: 4 }, makeTrack), length: 60 })
  const [highlight, setHighlight] = useState('#00ff9c')
  const [theme, setTheme] = useState('dark')
  const [diffusion, setDiffusion] = useState(() => ({
    enabled: false,
    radius: 12,
    voices: Array.from({ length: MAX_VOICES }, (_, i) => {
      const a = (i / MAX_VOICES) * Math.PI * 2 - Math.PI / 2
      return { x: Math.sin(a) * 4, z: Math.cos(a) * 4, y: 0, orbit: 0, poolId: '', trajectoryId: -1, trajectorySpeed: 0.5 }
    }),
  }))
  const [soundState, setSoundState] = useState(defaultSoundState)
  const [ui, setUi] = useState(defaultUi)
  const [sessionVersion, setSessionVersion] = useState(0)
  // `workletsReady` drives a loading overlay while AudioWorklet.addModule()
  // resolves. On low-end Android this total load can be 500ms–1.5s for
  // the six worklets the branch ships, and the existing await-in-buffer-
  // effect race-guard makes the UI feel dead during that window.
  // `audioCtxInitialized` gates the overlay to only appear after the user
  // gesture that kicks off AudioContext creation.
  const [workletsReady, setWorkletsReady] = useState(false)
  const [audioCtxInitialized, setAudioCtxInitialized] = useState(false)
  // Mobile/low-CPU mode — disables the signalsmith-stretch worklet per-
  // voice allocation (six independent WASM stretchers can melt a thermally
  // constrained phone). When true, tempo/pitch changes fall back to the
  // native AudioBufferSourceNode path (flat tempo=1 + playbackRate for
  // pitch only). Auto-defaults to true on mobile UAs; user can override
  // from the transport UI.
  const mobileDefault = typeof navigator !== 'undefined'
    && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')
  const [lowCpuMode, setLowCpuMode] = useState(mobileDefault)

  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      const Ctor = window.AudioContext || window.webkitAudioContext
      // Pin to 44.1 kHz so grain durations in worklets (which compute
      // Math.floor(seconds * sampleRate)) stay consistent regardless of
      // Bluetooth-headset-forced 24 kHz / 16 kHz contexts on iOS. Fall
      // back silently if the browser rejects the preferred rate.
      try {
        audioCtxRef.current = new Ctor({ sampleRate: 44100 })
      } catch {
        audioCtxRef.current = new Ctor()
      }
      setAudioCtxInitialized(true)
      ensureWorklets(audioCtxRef.current).then((r) => {
        if (r?.loaded) setWorkletsReady(true)
      })
      // Fire-and-forget: pre-generate common synthetic reverb IR sizes on a
      // worker so the first activation of reverb doesn't jank on low-end
      // mobile (30–80 ms for a 3s IR at 44.1 kHz otherwise).
      prewarmCommonIRs(audioCtxRef.current)
    }
    if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume()
    return audioCtxRef.current
  }, [])

  const addPoolItem = useCallback((name, buffer, kind = 'sound') => {
    const id = genId()
    buffersRef.current.set(id, buffer)
    setPool(p => [...p, { id, name, kind, duration: buffer.duration }])
    return id
  }, [])

  const removePoolItem = useCallback((id) => {
    buffersRef.current.delete(id)
    setPool(p => p.filter(i => i.id !== id))
  }, [])

  const setPoolItemTypo = useCallback((id, typo) => {
    setPool(p => p.map(item => item.id === id ? { ...item, typo } : item))
  }, [])

  const getBuffer = useCallback((id) => buffersRef.current.get(id), [])

  const saveSession = useCallback(() => {
    const poolData = []
    for (const item of pool) {
      const buf = buffersRef.current.get(item.id)
      if (!buf) continue
      poolData.push({ ...item, audio: bufferToBase64(buf) })
    }
    const json = JSON.stringify({
      version: 2,
      highlight,
      theme,
      pool: poolData,
      objects,
      timeline,
      soundState,
      diffusion,
      ui,
    })
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `concrete_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [pool, objects, timeline, highlight, theme, soundState, diffusion, ui])

  const loadSession = useCallback(async (file) => {
    const text = await file.text()
    const data = JSON.parse(text)
    const ctx = getAudioCtx()
    const newMap = new Map()
    const newPool = []
    for (const item of data.pool || []) {
      try {
        const buf = await base64ToBuffer(item.audio, ctx)
        newMap.set(item.id, buf)
        newPool.push({ id: item.id, name: item.name, kind: item.kind, duration: item.duration })
      } catch (e) { console.error('decode fail', e) }
    }
    buffersRef.current = newMap
    setPool(newPool)
    setObjects(data.objects || [])
    const loadedTimeline = data.timeline || {}
    const timelineTracks = (loadedTimeline.tracks || Array.from({ length: 4 }, makeTrack)).map(migrateTrack)
    // heal: clamp clip sourceEnd to actual buffer duration
    const healed = timelineTracks.map(t => ({
      ...t,
      clips: t.clips.map(c => {
        const buf = newMap.get(c.poolId)
        if (!buf) return c
        const ss = Math.max(0, Math.min(buf.duration, c.sourceStart || 0))
        const se = Math.max(ss, Math.min(buf.duration, c.sourceEnd ?? buf.duration))
        return { ...c, sourceStart: ss, sourceEnd: se }
      }),
    }))
    setTimeline({
      tracks: healed,
      length: loadedTimeline.length || 60,
    })
    setHighlight(data.highlight || '#00ff9c')
    setTheme(data.theme === 'light' ? 'light' : 'dark')
    if (data.diffusion) setDiffusion(prev => ({ ...prev, ...data.diffusion }))
    // merge loaded voices with defaults so missing fields fall back
    const loadedSound = data.soundState || defaultSoundState()
    const merged = {
      focused: loadedSound.focused || 1,
      voiceCount: Math.min(MAX_VOICES, Math.max(1, loadedSound.voiceCount || 2)),
      voices: Array.from({ length: MAX_VOICES }, (_, i) => ({
        ...defaultVoice(),
        ...(loadedSound.voices?.[i] || {}),
      })),
      bus: { feedback: 0, ...(loadedSound.bus || {}) },
    }
    setSoundState(merged)
    setUi({ ...defaultUi(), ...(data.ui || {}) })
    setSessionVersion(v => v + 1)
  }, [getAudioCtx])

  const value = {
    getAudioCtx,
    pool, addPoolItem, removePoolItem, setPoolItemTypo, getBuffer,
    objects, setObjects,
    timeline, setTimeline,
    highlight, setHighlight,
    theme, setTheme,
    diffusion, setDiffusion,
    transportRef,
    soundState, setSoundState,
    ui, setUi,
    sessionVersion,
    saveSession, loadSession,
    workletsReady,
    audioCtxInitialized,
    lowCpuMode, setLowCpuMode,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useStore = () => useContext(Ctx)
