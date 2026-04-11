import { useState, useRef, useEffect } from 'react'
import { useStore } from './state'
import { Multitrack } from './Multitrack'
import { renderArrangement, computeArrangementDuration, downloadWav } from './audio'

const TIMELINE_LENGTH = 60

export function TimelineTab() {
  const { timeline, setTimeline, getBuffer, getAudioCtx, addPoolItem } = useStore()
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const playRef = useRef(null)
  const rafRef = useRef(null)
  const startTimeRef = useRef(0)

  const setTracks = (fn) => setTimeline(prev => ({ ...prev, tracks: typeof fn === 'function' ? fn(prev.tracks) : fn }))
  const tracks = timeline.tracks
  const duration = Math.max(0.1, computeArrangementDuration(tracks))

  const play = () => {
    stop()
    const ctx = getAudioCtx()
    const srcs = []
    const now = ctx.currentTime + 0.05
    for (const track of tracks) {
      for (const clip of track) {
        const buf = getBuffer(clip.poolId)
        if (!buf) continue
        const s = ctx.createBufferSource()
        s.buffer = buf
        const g = ctx.createGain()
        const len = Math.max(0.001, clip.sourceEnd - clip.sourceStart)
        g.gain.value = clip.gain ?? 1
        s.connect(g).connect(ctx.destination)
        s.start(now + clip.offset, clip.sourceStart, len)
        srcs.push(s)
      }
    }
    playRef.current = srcs
    startTimeRef.current = now
    setPlaying(true)
    const tick = () => {
      const p = (ctx.currentTime - startTimeRef.current) / duration
      setPosition(p)
      if (p >= 1) { stop(); return }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }
  const stop = () => {
    if (playRef.current) playRef.current.forEach(s => { try { s.stop() } catch {} })
    playRef.current = null
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    setPlaying(false)
    setPosition(0)
  }
  useEffect(() => () => stop(), [])

  const addTrack = () => setTracks(prev => [...prev, []])
  const removeTrack = () => setTracks(prev => prev.length > 1 ? prev.slice(0, -1) : prev)

  const exportWav = async () => {
    const buf = await renderArrangement(tracks, getBuffer, duration)
    downloadWav(buf, `timeline_${Date.now()}.wav`)
  }
  const renderToPool = async () => {
    const buf = await renderArrangement(tracks, getBuffer, duration)
    addPoolItem('timeline_mix', buf, 'object')
  }

  const pxPerSec = 30
  const playheadX = position * duration * pxPerSec

  return (
    <div>
      <div className="toolbar">
        {!playing ? <button onClick={play}>▶ Play</button> : <button className="active" onClick={stop}>■ Stop</button>}
        <button onClick={addTrack}>+ Track</button>
        <button onClick={removeTrack}>− Track</button>
        <button onClick={renderToPool}>▸ Render → pool</button>
        <button onClick={exportWav}>↓ Export WAV</button>
        <span style={{ color: 'var(--dim)', fontSize: 11 }}>drag objects/sounds from pool · {duration.toFixed(1)}s total</span>
      </div>
      <div style={{ position: 'relative', overflow: 'auto' }}>
        <Multitrack
          tracks={tracks}
          setTracks={setTracks}
          pxPerSec={pxPerSec}
          length={Math.max(TIMELINE_LENGTH, duration + 10)}
          trackLabels={tracks.map((_, i) => `T${i + 1}`)}
        />
        {playing && <div className="playhead" style={{ left: playheadX + 1, top: 18, height: tracks.length * 48 }} />}
      </div>
    </div>
  )
}
