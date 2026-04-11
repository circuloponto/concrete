import { createContext, useContext, useRef, useState, useCallback } from 'react'
import { bufferToBase64, base64ToBuffer } from './audio'

const Ctx = createContext(null)

let _id = 0
const genId = () => `id_${Date.now().toString(36)}_${(_id++).toString(36)}`

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
  filterType: 'lowpass',
  filterHz: 18000,
  filterQ: 0.7,
  // saturation
  saturation: 0,
  // wow/flutter
  wowRate: 0,
  wowDepth: 0,
  // ring mod
  ringFreq: 100,
  ringAmount: 0,
  // flanger
  flangerRate: 0.3,
  flangerDepth: 0.4,
  flangerFb: 0.3,
  flangerMix: 0,
  // tremolo
  tremRate: 4,
  tremDepth: 0,
  // tape delay
  delayTime: 0.25,
  delayFb: 0.35,
  wet: 0,
  // reverb
  reverbSize: 1.5,
  reverbWet: 0,
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
  const [timeline, setTimeline] = useState({ tracks: [[], [], [], []] })
  const [highlight, setHighlight] = useState('#00ff9c')
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
  }, [pool, objects, timeline, highlight, soundState, ui])

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
    setTimeline(data.timeline || { tracks: [[], [], [], []] })
    setHighlight(data.highlight || '#00ff9c')
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
    soundState, setSoundState,
    ui, setUi,
    sessionVersion,
    saveSession, loadSession,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useStore = () => useContext(Ctx)
