import { useState, useRef, useEffect } from 'react'
import { useStore, makeTrack } from './state'
import { Multitrack } from './Multitrack'
import { SourcePicker } from './SourcePicker'
import { ClipInspector } from './ClipInspector'
import { renderArrangement, computeArrangementDuration, clipPlayLen } from './audio'

export function ObjectTab() {
  const { addPoolItem, getBuffer, getAudioCtx } = useStore()
  const [length, setLength] = useState(32)
  const [tracks, setTracks] = useState(() => Array.from({ length: 8 }, makeTrack))
  const [selected, setSelected] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [name, setName] = useState('object')
  const [pxPerSec, setPxPerSec] = useState(50)
  const [trackHeight, setTrackHeight] = useState(64)
  const playRef = useRef(null)
  const rafRef = useRef(null)
  const startTimeRef = useRef(0)

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
        const clipGain = clip.gain ?? 1
        const fi = Math.min(clip.fadeIn || 0, len / 2)
        const fo = Math.min(clip.fadeOut || 0, len / 2)
        const t0 = now + clip.offset
        // simple linear fades for preview (offline render uses curves)
        g.gain.setValueAtTime(fi > 0 ? 0 : clipGain, t0)
        if (fi > 0) g.gain.linearRampToValueAtTime(clipGain, t0 + fi)
        if (fo > 0) {
          g.gain.setValueAtTime(clipGain, t0 + len - fo)
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

  const renderToPool = async () => {
    if (duration < 0.01) return
    const buf = await renderArrangement(tracks, getBuffer, Math.max(duration, 0.1))
    addPoolItem(name || 'object', buf, 'object')
  }

  const clear = () => {
    stop()
    setTracks(Array.from({ length: 8 }, makeTrack))
    setSelected(null)
  }

  const onSend = ({ poolId, sourceStart, sourceEnd, targetTrack, name: srcName }) => {
    const track = tracks[targetTrack]
    if (!track) return
    // append after the last clip on the target track
    const lastEnd = track.clips.reduce(
      (max, c) => Math.max(max, c.offset + (c.sourceEnd - c.sourceStart)),
      0
    )
    const clip = {
      id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      poolId,
      offset: lastEnd,
      sourceStart,
      sourceEnd,
      fadeIn: 0,
      fadeOut: 0,
      fadeInCurve: 'linear',
      fadeOutCurve: 'linear',
      gain: 1,
    }
    setTracks(prev => prev.map((t, i) =>
      i === targetTrack ? { ...t, clips: [...t.clips, clip] } : t
    ))
    setSelected(clip.id)
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
    <div className="object-tab">
      <div className="toolbar">
        {!playing ? <button onClick={play}>▶ Play</button> : <button className="active" onClick={stop}>■ Stop</button>}
        <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="name" />
        <button onClick={renderToPool} data-tutorial="render-object">▸ Render → pool</button>
        <button onClick={clear}>Clear</button>
        <div style={{ flex: 1 }} />
        <label style={{ fontSize: 10, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1 }}>Len</label>
        <input
          type="number"
          min="4"
          max="600"
          step="1"
          value={length}
          onChange={e => setLength(Math.max(4, +e.target.value))}
          style={{ width: 56 }}
        />
        <span style={{ color: 'var(--dim)', fontSize: 10 }}>s</span>
        <label style={{ fontSize: 10, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1, marginLeft: 8 }}>Zoom</label>
        <input
          type="range"
          min="10"
          max="300"
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

      <SourcePicker onSend={onSend} tracks={tracks} />

      <div style={{ position: 'relative', overflow: 'auto', marginTop: 12 }}>
        <Multitrack
          tracks={tracks}
          setTracks={setTracks}
          pxPerSec={pxPerSec}
          length={length}
          trackHeight={trackHeight}
          selected={selected}
          setSelected={setSelected}
          trackLabels={Array.from({ length: 8 }, (_, i) => `T${i + 1}`)}
        />
        {playing && <div className="playhead" style={{ left: playheadX + 1, top: 18, height: 8 * trackHeight }} />}
      </div>

      <ClipInspector clip={selectedClip} onChange={updateSelectedClip} />
    </div>
  )
}
