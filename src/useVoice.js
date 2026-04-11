import { useRef, useState, useEffect, useCallback } from 'react'
import { PitchShifter } from 'soundtouchjs'
import { useStore } from './state'
import { reverseBuffer } from './audio'

export function useVoice(voiceNumber, outputNode, initial = {}, onSnapshot = null) {
  const { getAudioCtx, getBuffer, pool } = useStore()
  const [buffer, setBuffer] = useState(null)
  const [sourceName, setSourceName] = useState('')
  const [loadedPoolId, setLoadedPoolId] = useState(initial.loadedPoolId || '')
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [tempo, setTempo] = useState(initial.tempo ?? 1)
  const [pitch, setPitch] = useState(initial.pitch ?? 0)
  const [filterHz, setFilterHz] = useState(initial.filterHz ?? 6000)
  const [delayTime, setDelayTime] = useState(initial.delayTime ?? 0.25)
  const [delayFb, setDelayFb] = useState(initial.delayFb ?? 0.45)
  const [wet, setWet] = useState(initial.wet ?? 0.5)
  const [voiceGain, setVoiceGain] = useState(initial.voiceGain ?? 1)
  const [reversed, setReversed] = useState(initial.reversed ?? false)
  const [loopStart, setLoopStart] = useState(initial.loopStart ?? 0)
  const [loopEnd, setLoopEnd] = useState(initial.loopEnd ?? 1)
  const [view, setView] = useState(initial.view ?? 'disk')

  const shifterRef = useRef(null)
  const nodesRef = useRef(null)
  const rafRef = useRef(null)
  const scrubRef = useRef({ active: false, target: 0, current: 0, lastGrain: 0, raf: null, revBuf: null, revFor: null })
  const pitchRef = useRef(0)
  useEffect(() => { pitchRef.current = pitch }, [pitch])

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

  // On mount: if an initial poolId was passed (session restore), attach buffer
  // without clobbering the already-initialized loop/reverse params.
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
    const scrubBus = ctx.createGain(); scrubBus.gain.value = 1
    const shifterBus = ctx.createGain(); shifterBus.gain.value = 1
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = filterHz
    filter.Q.value = 0.7
    const dry = ctx.createGain(); dry.gain.value = 1
    const delay = ctx.createDelay(2)
    delay.delayTime.value = delayTime
    const feedback = ctx.createGain(); feedback.gain.value = delayFb
    const wetGain = ctx.createGain(); wetGain.gain.value = wet
    const master = ctx.createGain(); master.gain.value = voiceGain
    scrubBus.connect(filter)
    shifterBus.connect(filter)
    filter.connect(dry).connect(master)
    filter.connect(delay)
    delay.connect(feedback).connect(delay)
    delay.connect(wetGain).connect(master)
    master.connect(outputNode)
    nodesRef.current = { scrubBus, shifterBus, filter, dry, delay, feedback, wetGain, master }
    return nodesRef.current
  }, [getAudioCtx, outputNode])

  const teardownEffects = useCallback(() => {
    if (!nodesRef.current) return
    Object.values(nodesRef.current).forEach(n => { try { n.disconnect() } catch {} })
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

  // Push a snapshot to parent whenever any serializable field changes.
  useEffect(() => {
    if (!onSnapshot) return
    onSnapshot({
      loadedPoolId, tempo, pitch, filterHz, delayTime, delayFb, wet,
      voiceGain, reversed, loopStart, loopEnd, view,
    })
  }, [loadedPoolId, tempo, pitch, filterHz, delayTime, delayFb, wet, voiceGain, reversed, loopStart, loopEnd, view, onSnapshot])

  useEffect(() => { if (shifterRef.current) shifterRef.current.tempo = tempo }, [tempo])
  useEffect(() => { if (shifterRef.current) shifterRef.current.pitchSemitones = pitch }, [pitch])
  useEffect(() => { if (nodesRef.current) nodesRef.current.filter.frequency.value = filterHz }, [filterHz])
  useEffect(() => { if (nodesRef.current) nodesRef.current.delay.delayTime.value = delayTime }, [delayTime])
  useEffect(() => { if (nodesRef.current) nodesRef.current.feedback.gain.value = delayFb }, [delayFb])
  useEffect(() => { if (nodesRef.current) nodesRef.current.wetGain.gain.value = wet }, [wet])
  useEffect(() => { if (nodesRef.current) nodesRef.current.master.gain.value = voiceGain }, [voiceGain])

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
    tempo, setTempo,
    pitch, setPitch,
    filterHz, setFilterHz,
    delayTime, setDelayTime,
    delayFb, setDelayFb,
    wet, setWet,
    voiceGain, setVoiceGain,
    reversed, loopStart, setLoopStart, loopEnd, setLoopEnd,
    view, setView,
    play, stop, onScrub, toggleReverse, loadFromPool,
  }
}
