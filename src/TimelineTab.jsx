import { useState, useRef, useEffect } from 'react'
import { useStore, makeTrack } from './state'
import { Multitrack } from './Multitrack'
import { ClipInspector } from './ClipInspector'
import { renderArrangement, computeArrangementDuration, downloadWav, clipPlayLen } from './audio'

export function TimelineTab() {
  const { timeline, setTimeline, getBuffer, getAudioCtx, addPoolItem } = useStore()
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [selected, setSelected] = useState(null)
  const [pxPerSec, setPxPerSec] = useState(30)
  const [trackHeight, setTrackHeight] = useState(64)
  const playRef = useRef(null)
  const rafRef = useRef(null)
  const startTimeRef = useRef(0)

  const setTracks = (fn) => setTimeline(prev => ({ ...prev, tracks: typeof fn === 'function' ? fn(prev.tracks) : fn }))
  const setLength = (n) => setTimeline(prev => ({ ...prev, length: n }))
  const tracks = timeline.tracks
  const length = timeline.length || 60
  const duration = Math.max(0.1, computeArrangementDuration(tracks, getBuffer))

  const play = () => {
    stop()
    const ctx = getAudioCtx()
    const srcs = []
    const now = ctx.currentTime + 0.05
    const anySolo = tracks.some(t => t.solo)
    for (const track of tracks) {
      if (track.mute) continue
      if (anySolo && !track.solo) continue
      const trackGain = ctx.createGain(); trackGain.gain.value = track.gain
      const panner = ctx.createStereoPanner(); panner.pan.value = track.pan
      trackGain.connect(panner).connect(ctx.destination)
      srcs.push(trackGain, panner)
      for (const clip of track.clips) {
        const buf = getBuffer(clip.poolId)
        if (!buf) continue
        const s = ctx.createBufferSource()
        s.buffer = buf
        const g = ctx.createGain()
        const len = Math.max(0.001, clipPlayLen(clip, getBuffer))
        const cg = clip.gain ?? 1
        const fi = Math.min(clip.fadeIn || 0, len / 2)
        const fo = Math.min(clip.fadeOut || 0, len / 2)
        const t0 = now + clip.offset
        g.gain.setValueAtTime(fi > 0 ? 0 : cg, t0)
        if (fi > 0) g.gain.linearRampToValueAtTime(cg, t0 + fi)
        if (fo > 0) {
          g.gain.setValueAtTime(cg, t0 + len - fo)
          g.gain.linearRampToValueAtTime(0, t0 + len)
        }
        s.connect(g).connect(trackGain)
        s.start(t0, clip.sourceStart, len)
        srcs.push(s, g)
      }
    }
    playRef.current = srcs
    startTimeRef.current = now
    setPlaying(true)
    const tick = () => {
      const elapsed = ctx.currentTime - startTimeRef.current
      setPosition(elapsed)
      if (elapsed >= duration) { stop(); return }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }
  const stop = () => {
    if (playRef.current) playRef.current.forEach(s => { try { if (s.stop) s.stop(); s.disconnect() } catch {} })
    playRef.current = null
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    setPlaying(false)
    setPosition(0)
  }
  useEffect(() => () => stop(), [])

  const addTrack = () => setTracks(prev => [...prev, makeTrack()])
  const removeTrack = () => setTracks(prev => prev.length > 1 ? prev.slice(0, -1) : prev)

  const exportWav = async () => {
    const buf = await renderArrangement(tracks, getBuffer, duration)
    downloadWav(buf, `timeline_${Date.now()}.wav`)
  }
  const renderToPool = async () => {
    const buf = await renderArrangement(tracks, getBuffer, duration)
    addPoolItem('timeline_mix', buf, 'timeline')
  }

  const updateSelectedClip = (patch) => {
    if (!selected) return
    setTracks(prev => prev.map(tr => ({
      ...tr,
      clips: tr.clips.map(c => c.id === selected ? { ...c, ...patch } : c),
    })))
  }
  const selectedClip = tracks.flatMap(t => t.clips).find(c => c.id === selected) || null

  const playheadX = 140 + position * pxPerSec

  return (
    <div>
      <div className="toolbar">
        {!playing ? <button onClick={play}>▶ Play</button> : <button className="active" onClick={stop}>■ Stop</button>}
        <button onClick={addTrack}>+ Track</button>
        <button onClick={removeTrack}>− Track</button>
        <button onClick={renderToPool}>▸ Render → pool</button>
        <button onClick={exportWav} data-tutorial="export">↓ Export WAV</button>
        <div style={{ flex: 1 }} />
        <label style={{ fontSize: 10, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1 }}>Len</label>
        <input
          type="number"
          min="4"
          max="1200"
          step="1"
          value={length}
          onChange={e => setLength(Math.max(4, +e.target.value))}
          style={{ width: 56 }}
        />
        <span style={{ color: 'var(--dim)', fontSize: 10 }}>s</span>
        <label style={{ fontSize: 10, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1, marginLeft: 8 }}>Zoom</label>
        <input
          type="range"
          min="6"
          max="200"
          step="1"
          value={pxPerSec}
          onChange={e => setPxPerSec(+e.target.value)}
          style={{ width: 100 }}
        />
        <label style={{ fontSize: 10, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1, marginLeft: 8 }}>Height</label>
        <input
          type="range"
          min="40"
          max="160"
          step="1"
          value={trackHeight}
          onChange={e => setTrackHeight(+e.target.value)}
          style={{ width: 80 }}
        />
      </div>
      <div style={{ position: 'relative', overflow: 'auto' }}>
        <Multitrack
          tracks={tracks}
          setTracks={setTracks}
          pxPerSec={pxPerSec}
          length={Math.max(length, duration + 10)}
          trackHeight={trackHeight}
          trackLabels={tracks.map((_, i) => `T${i + 1}`)}
          selected={selected}
          setSelected={setSelected}
        />
        {playing && <div className="playhead" style={{ left: playheadX + 1, top: 18, height: tracks.length * trackHeight }} />}
      </div>
      <ClipInspector clip={selectedClip} onChange={updateSelectedClip} />
    </div>
  )
}
