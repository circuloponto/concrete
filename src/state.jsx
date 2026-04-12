import { createContext, useContext, useRef, useState, useCallback } from 'react'
import { bufferToBase64, base64ToBuffer } from './audio'

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

const defaultVoice = () => ({
  loadedPoolId: '',
  tempo: 1,
  pitch: 0,
  voiceGain: 1,
  reversed: false,
  loopStart: 0,
  loopEnd: 1,
  view: 'disk',
  // filter
  filterActive: true,
  filterType: 'lowpass',
  filterHz: 18000,
  filterQ: 0.7,
  // saturation
  satActive: true,
  saturation: 0,
  // wow/flutter
  wowActive: true,
  wowRate: 0,
  wowDepth: 0,
  // ring mod
  ringActive: true,
  ringFreq: 100,
  ringAmount: 0,
  // flanger
  flangerActive: true,
  flangerRate: 0.3,
  flangerDepth: 0.4,
  flangerFb: 0.3,
  flangerMix: 0,
  // tremolo
  tremActive: true,
  tremRate: 4,
  tremDepth: 0,
  // tape delay
  delayActive: true,
  delayTime: 0.25,
  delayFb: 0.35,
  wet: 0,
  // reverb
  reverbActive: true,
  reverbSize: 1.5,
  reverbWet: 0,
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
  // doppler
  dopplerActive: false,
  dopplerSpeed: 0.5,
  dopplerRange: 10,
  dopplerMinDist: 1,
  dopplerMix: 1,
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
  const [pool, setPool] = useState([])
  const [objects, setObjects] = useState([])
  const [timeline, setTimeline] = useState({ tracks: Array.from({ length: 4 }, makeTrack), length: 60 })
  const [highlight, setHighlight] = useState('#00ff9c')
  const [theme, setTheme] = useState('dark')
  const [soundState, setSoundState] = useState(defaultSoundState)
  const [ui, setUi] = useState(defaultUi)
  const [sessionVersion, setSessionVersion] = useState(0)

  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)()
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
      ui,
    })
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `concrete_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [pool, objects, timeline, highlight, theme, soundState, ui])

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
    pool, addPoolItem, removePoolItem, getBuffer,
    objects, setObjects,
    timeline, setTimeline,
    highlight, setHighlight,
    theme, setTheme,
    soundState, setSoundState,
    ui, setUi,
    sessionVersion,
    saveSession, loadSession,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useStore = () => useContext(Ctx)
