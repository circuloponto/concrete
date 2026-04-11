import { useRef, useState, useEffect, useCallback } from 'react'
import { PitchShifter } from 'soundtouchjs'
import { useStore } from './state'
import { reverseBuffer, makeReverbIR, makeSaturationCurve } from './audio'

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
  const [saturation, setSaturation] = useState(initial.saturation ?? 0)
  const [wowRate, setWowRate] = useState(initial.wowRate ?? 0)
  const [wowDepth, setWowDepth] = useState(initial.wowDepth ?? 0)

  // filter
  const [filterType, setFilterType] = useState(initial.filterType ?? 'lowpass')
  const [filterHz, setFilterHz] = useState(initial.filterHz ?? 18000)
  const [filterQ, setFilterQ] = useState(initial.filterQ ?? 0.7)

  // modulation
  const [ringFreq, setRingFreq] = useState(initial.ringFreq ?? 100)
  const [ringAmount, setRingAmount] = useState(initial.ringAmount ?? 0)
  const [flangerRate, setFlangerRate] = useState(initial.flangerRate ?? 0.3)
  const [flangerDepth, setFlangerDepth] = useState(initial.flangerDepth ?? 0.4)
  const [flangerFb, setFlangerFb] = useState(initial.flangerFb ?? 0.3)
  const [flangerMix, setFlangerMix] = useState(initial.flangerMix ?? 0)
  const [tremRate, setTremRate] = useState(initial.tremRate ?? 4)
  const [tremDepth, setTremDepth] = useState(initial.tremDepth ?? 0)

  // space
  const [delayTime, setDelayTime] = useState(initial.delayTime ?? 0.25)
  const [delayFb, setDelayFb] = useState(initial.delayFb ?? 0.35)
  const [wet, setWet] = useState(initial.wet ?? 0)
  const [reverbSize, setReverbSize] = useState(initial.reverbSize ?? 1.5)
  const [reverbWet, setReverbWet] = useState(initial.reverbWet ?? 0)

  // loop
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

    const master = ctx.createGain(); master.gain.value = voiceGain

    // Wiring
    // inputs → saturation
    scrubBus.connect(sat)
    shifterBus.connect(sat)
    // serial chain
    sat.connect(wowDelay).connect(filter)
    // ring mod split
    filter.connect(ringDry).connect(ringSum)
    filter.connect(ringWet).connect(ringMix).connect(ringSum)
    // tremolo in series after ringmod
    ringSum.connect(tremoloGain)
    // parallel FX branches from tremolo output
    tremoloGain.connect(dry).connect(master)
    tremoloGain.connect(flangerDelay)
    flangerDelay.connect(flangerFbGain).connect(flangerDelay)
    flangerDelay.connect(flangerMixGain).connect(master)
    tremoloGain.connect(tapeDelay)
    tapeDelay.connect(tapeFbGain).connect(tapeDelay)
    tapeDelay.connect(tapeWetGain).connect(master)
    tremoloGain.connect(reverb)
    reverb.connect(reverbWetGain).connect(master)
    master.connect(outputNode)

    nodesRef.current = {
      scrubBus, shifterBus,
      sat,
      wowDelay, wowLfo, wowDepthGain,
      filter,
      ringDry, ringWet, ringMix, ringOsc, ringDepth,
      ringSum,
      tremoloGain, tremoloLfo, tremoloDepthGain,
      flangerDelay, flangerLfo, flangerDepthGain, flangerFbGain, flangerMixGain,
      tapeDelay, tapeFbGain, tapeWetGain,
      reverb, reverbWetGain,
      dry, master,
      oscs,
    }
    return nodesRef.current
  }, [getAudioCtx, outputNode])

  const teardownEffects = useCallback(() => {
    if (!nodesRef.current) return
    const { oscs, ...rest } = nodesRef.current
    if (oscs) oscs.forEach(o => { try { o.stop() } catch {} })
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
      filterType, filterHz, filterQ,
      saturation, wowRate, wowDepth,
      ringFreq, ringAmount,
      flangerRate, flangerDepth, flangerFb, flangerMix,
      tremRate, tremDepth,
      delayTime, delayFb, wet,
      reverbSize, reverbWet,
    })
  }, [onSnapshot,
    loadedPoolId, tempo, pitch, voiceGain, reversed, loopStart, loopEnd, view,
    filterType, filterHz, filterQ,
    saturation, wowRate, wowDepth,
    ringFreq, ringAmount,
    flangerRate, flangerDepth, flangerFb, flangerMix,
    tremRate, tremDepth,
    delayTime, delayFb, wet,
    reverbSize, reverbWet,
  ])

  // Live updates
  useEffect(() => { if (shifterRef.current) shifterRef.current.tempo = tempo }, [tempo])
  useEffect(() => { if (shifterRef.current) shifterRef.current.pitchSemitones = pitch }, [pitch])
  useEffect(() => { if (nodesRef.current) nodesRef.current.master.gain.value = voiceGain }, [voiceGain])
  useEffect(() => { if (nodesRef.current) nodesRef.current.sat.curve = makeSaturationCurve(saturation) }, [saturation])
  useEffect(() => { if (nodesRef.current) nodesRef.current.wowLfo.frequency.value = Math.max(0.01, wowRate) }, [wowRate])
  useEffect(() => { if (nodesRef.current) nodesRef.current.wowDepthGain.gain.value = wowDepth * 0.005 }, [wowDepth])
  useEffect(() => { if (nodesRef.current) nodesRef.current.filter.type = filterType }, [filterType])
  useEffect(() => { if (nodesRef.current) nodesRef.current.filter.frequency.value = filterHz }, [filterHz])
  useEffect(() => { if (nodesRef.current) nodesRef.current.filter.Q.value = filterQ }, [filterQ])
  useEffect(() => { if (nodesRef.current) nodesRef.current.ringOsc.frequency.value = ringFreq }, [ringFreq])
  useEffect(() => {
    if (nodesRef.current) {
      nodesRef.current.ringDry.gain.value = 1 - ringAmount
      nodesRef.current.ringMix.gain.value = ringAmount
    }
  }, [ringAmount])
  useEffect(() => { if (nodesRef.current) nodesRef.current.flangerLfo.frequency.value = Math.max(0.01, flangerRate) }, [flangerRate])
  useEffect(() => { if (nodesRef.current) nodesRef.current.flangerDepthGain.gain.value = flangerDepth * 0.002 }, [flangerDepth])
  useEffect(() => { if (nodesRef.current) nodesRef.current.flangerFbGain.gain.value = flangerFb }, [flangerFb])
  useEffect(() => { if (nodesRef.current) nodesRef.current.flangerMixGain.gain.value = flangerMix }, [flangerMix])
  useEffect(() => { if (nodesRef.current) nodesRef.current.tremoloLfo.frequency.value = Math.max(0.01, tremRate) }, [tremRate])
  useEffect(() => {
    if (nodesRef.current) {
      nodesRef.current.tremoloGain.gain.value = 1 - tremDepth / 2
      nodesRef.current.tremoloDepthGain.gain.value = tremDepth / 2
    }
  }, [tremDepth])
  useEffect(() => { if (nodesRef.current) nodesRef.current.tapeDelay.delayTime.value = delayTime }, [delayTime])
  useEffect(() => { if (nodesRef.current) nodesRef.current.tapeFbGain.gain.value = delayFb }, [delayFb])
  useEffect(() => { if (nodesRef.current) nodesRef.current.tapeWetGain.gain.value = wet }, [wet])
  useEffect(() => {
    if (nodesRef.current) nodesRef.current.reverb.buffer = makeReverbIR(getAudioCtx(), reverbSize)
  }, [reverbSize, getAudioCtx])
  useEffect(() => { if (nodesRef.current) nodesRef.current.reverbWetGain.gain.value = reverbWet }, [reverbWet])

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
    saturation, setSaturation,
    wowRate, setWowRate,
    wowDepth, setWowDepth,
    // filter
    filterType, setFilterType,
    filterHz, setFilterHz,
    filterQ, setFilterQ,
    // mod
    ringFreq, setRingFreq,
    ringAmount, setRingAmount,
    flangerRate, setFlangerRate,
    flangerDepth, setFlangerDepth,
    flangerFb, setFlangerFb,
    flangerMix, setFlangerMix,
    tremRate, setTremRate,
    tremDepth, setTremDepth,
    // space
    delayTime, setDelayTime,
    delayFb, setDelayFb,
    wet, setWet,
    reverbSize, setReverbSize,
    reverbWet, setReverbWet,
    // loop
    reversed, loopStart, setLoopStart, loopEnd, setLoopEnd,
    view, setView,
    play, stop, onScrub, toggleReverse, loadFromPool,
  }
}
