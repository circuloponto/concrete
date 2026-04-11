import { useState, useRef, useEffect } from 'react'
import { useStore } from './state'
import { Multitrack } from './Multitrack'
import { renderArrangement, computeArrangementDuration, downloadWav } from './audio'

const OBJECT_LENGTH = 16

export function ObjectTab() {
  const { addPoolItem, getBuffer, getAudioCtx } = useStore()
  const [tracks, setTracks] = useState(() => Array.from({ length: 8 }, () => []))
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [name, setName] = useState('object')
  const playRef = useRef(null)
  const rafRef = useRef(null)
  const startTimeRef = useRef(0)

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

  const renderToPool = async () => {
    const buf = await renderArrangement(tracks, getBuffer, duration)
    addPoolItem(name || 'object', buf, 'object')
  }

  const clear = () => {
    stop()
    setTracks(Array.from({ length: 8 }, () => []))
  }

  const pxPerSec = 50
  const playheadX = position * OBJECT_LENGTH * pxPerSec

  return (
    <div>
      <div className="toolbar">
        {!playing ? <button onClick={play}>▶ Play</button> : <button className="active" onClick={stop}>■ Stop</button>}
        <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="name" />
        <button onClick={renderToPool}>▸ Render → pool</button>
        <button onClick={clear}>Clear</button>
        <span style={{ color: 'var(--dim)', fontSize: 11 }}>drag from pool → 8 tracks · drag edges to trim · del to remove</span>
      </div>
      <div style={{ position: 'relative', overflow: 'auto' }}>
        <Multitrack
          tracks={tracks}
          setTracks={setTracks}
          pxPerSec={pxPerSec}
          length={OBJECT_LENGTH}
          trackLabels={Array.from({ length: 8 }, (_, i) => `T${i + 1}`)}
        />
        {playing && <div className="playhead" style={{ left: playheadX + 1, top: 18, height: 8 * 48 }} />}
      </div>
    </div>
  )
}
