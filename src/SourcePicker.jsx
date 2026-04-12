import { useRef, useState, useEffect } from 'react'
import { useStore } from './state'
import { reverseBuffer } from './audio'

// Waveform view with draggable region selection, scrub playback, and a
// commit-on-send action that slices the source into a new pool item.
export function SourcePicker({ onSend, tracks }) {
  const { pool, getBuffer, getAudioCtx, addPoolItem, highlight } = useStore()
  const [poolId, setPoolId] = useState('')
  const [region, setRegion] = useState({ start: 0, end: 0 })
  const [targetTrack, setTargetTrack] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [scrubPos, setScrubPos] = useState(null) // 0..1 along buffer
  const canvasRef = useRef(null)
  const srcRef = useRef(null)
  const rafRef = useRef(null)
  const startTimeRef = useRef(0)
  const draggingRef = useRef(null)
  const scrubRef = useRef({ active: false, target: 0, current: 0, lastGrain: 0, raf: null, revBuf: null, revFor: null })

  const buffer = poolId ? getBuffer(poolId) : null
  const duration = buffer?.duration || 0

  useEffect(() => {
    if (buffer) {
      setRegion({ start: 0, end: buffer.duration })
      setScrubPos(null)
    }
  }, [poolId, buffer])

  // draw waveform + region + playheads
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const w = c.width
    const h = c.height
    const ctx = c.getContext('2d')
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#050505'
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = highlight + '22'
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke()
    if (buffer) {
      const data = buffer.getChannelData(0)
      const step = Math.max(1, Math.floor(data.length / w))
      ctx.strokeStyle = highlight
      ctx.lineWidth = 1
      for (let x = 0; x < w; x++) {
        let min = 1, max = -1
        const s = x * step
        const e = Math.min(data.length, s + step)
        for (let i = s; i < e; i++) {
          const v = data[i]
          if (v < min) min = v
          if (v > max) max = v
        }
        const y1 = (1 - (max + 1) / 2) * h
        const y2 = (1 - (min + 1) / 2) * h
        ctx.beginPath()
        ctx.moveTo(x + 0.5, y1)
        ctx.lineTo(x + 0.5, y2)
        ctx.stroke()
      }
    }
    if (duration > 0 && region.end > region.start) {
      const x1 = Math.floor((region.start / duration) * w)
      const x2 = Math.ceil((region.end / duration) * w)
      ctx.fillStyle = highlight + '22'
      ctx.fillRect(x1, 0, x2 - x1, h)
      ctx.strokeStyle = highlight
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(x1 + 0.5, 0); ctx.lineTo(x1 + 0.5, h); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(x2 - 0.5, 0); ctx.lineTo(x2 - 0.5, h); ctx.stroke()
    }
    // preview playhead
    if (playing && duration > 0) {
      const px = Math.floor(((region.start + progress * (region.end - region.start)) / duration) * w)
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(px + 0.5, 0); ctx.lineTo(px + 0.5, h); ctx.stroke()
    }
    // scrub playhead
    if (scrubPos !== null && duration > 0) {
      const px = Math.floor(scrubPos * w)
      ctx.strokeStyle = '#ff0'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(px + 0.5, 0); ctx.lineTo(px + 0.5, h); ctx.stroke()
    }
  }, [buffer, region, duration, highlight, playing, progress, scrubPos])

  const xToTime = (clientX) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left))
    return (x / rect.width) * duration
  }

  // ---- granular scrub (same approach as Sound tab Disk) ----
  const startScrubLoop = () => {
    const ctx = getAudioCtx()
    const s = scrubRef.current
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
        if (Math.abs(d) > 1e-5 && buffer) {
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
          let rate = Math.max(0.05, Math.min(8, velRate))
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
            src.connect(g).connect(ctx.destination)
            try { src.start(when, startSec, playLen) } catch {}
          }
          s.current = s.target
          setScrubPos(s.target)
        }
        s.lastGrain = now
      }
      s.raf = requestAnimationFrame(loop)
    }
    loop()
  }

  const startScrub = (t) => {
    if (!buffer) return
    const s = scrubRef.current
    s.active = true
    s.target = t / duration
    s.current = s.target
    s.lastGrain = 0
    if (s.revFor !== buffer) { s.revBuf = null; s.revFor = buffer }
    setScrubPos(s.target)
    startScrubLoop()
  }
  const updateScrub = (t) => {
    scrubRef.current.target = t / duration
  }
  const endScrub = () => {
    const s = scrubRef.current
    s.active = false
    if (s.raf) cancelAnimationFrame(s.raf)
  }

  // ---- pointer event routing ----
  const onDown = (e) => {
    if (!buffer) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const t = xToTime(e.clientX)
    const grabDist = duration * 0.02
    if (Math.abs(t - region.start) < grabDist) {
      draggingRef.current = 'rstart'
    } else if (Math.abs(t - region.end) < grabDist) {
      draggingRef.current = 'rend'
    } else if (e.shiftKey) {
      draggingRef.current = 'scrub'
      startScrub(t)
    } else {
      draggingRef.current = 'newregion'
      setRegion({ start: t, end: t })
    }
  }
  const onMove = (e) => {
    if (!draggingRef.current || !buffer) return
    const t = xToTime(e.clientX)
    if (draggingRef.current === 'scrub') {
      updateScrub(t)
      return
    }
    setRegion(r => {
      if (draggingRef.current === 'rstart') return { ...r, start: Math.min(t, r.end - 0.01) }
      if (draggingRef.current === 'rend') return { ...r, end: Math.max(t, r.start + 0.01) }
      if (draggingRef.current === 'newregion') {
        return { start: Math.min(r.start, t), end: Math.max(r.start, t) }
      }
      return r
    })
  }
  const onUp = () => {
    if (draggingRef.current === 'scrub') endScrub()
    draggingRef.current = null
  }

  // ---- preview playback (raw) ----
  const stop = () => {
    if (srcRef.current) { try { srcRef.current.stop() } catch {}; srcRef.current = null }
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    setPlaying(false)
    setProgress(0)
  }
  const play = () => {
    if (!buffer || region.end <= region.start) return
    stop()
    const ctx = getAudioCtx()
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    const len = region.end - region.start
    const when = ctx.currentTime + 0.02
    src.start(when, region.start, len)
    src.onended = () => setPlaying(false)
    srcRef.current = src
    startTimeRef.current = when
    setPlaying(true)
    const tick = () => {
      const p = (ctx.currentTime - startTimeRef.current) / len
      setProgress(Math.max(0, Math.min(1, p)))
      if (p >= 1) { stop(); return }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }
  useEffect(() => () => { stop(); endScrub() }, [])

  const onDrop = (e) => {
    e.preventDefault()
    const id = e.dataTransfer.getData('poolId')
    if (id) setPoolId(id)
  }
  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }

  // Commit & send: slice the source into a fresh AudioBuffer, push it to the
  // pool as a new committed item, and route the clip to the new item id.
  const send = () => {
    if (!buffer || region.end <= region.start) return
    const ctx = getAudioCtx()
    const sr = buffer.sampleRate
    const startSamp = Math.max(0, Math.floor(region.start * sr))
    const endSamp = Math.min(buffer.length, Math.floor(region.end * sr))
    const len = endSamp - startSamp
    if (len <= 0) return
    const sliced = ctx.createBuffer(buffer.numberOfChannels, len, sr)
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const ch = buffer.getChannelData(c)
      sliced.copyToChannel(ch.subarray(startSamp, endSamp), c)
    }
    const baseName = pool.find(p => p.id === poolId)?.name || 'region'
    const newId = addPoolItem(`${baseName}_${region.start.toFixed(2)}-${region.end.toFixed(2)}`, sliced, 'object')
    onSend && onSend({
      poolId: newId,
      sourceStart: 0,
      sourceEnd: sliced.duration,
      targetTrack,
    })
  }

  return (
    <div className="source-picker" data-tutorial="source-picker" onDrop={onDrop} onDragOver={onDragOver}>
      <div className="source-picker-row">
        <select value={poolId} onChange={e => setPoolId(e.target.value)} className="select-inline">
          <option value="">— pick source —</option>
          {pool.map(p => <option key={p.id} value={p.id}>{p.name} · {p.duration.toFixed(2)}s</option>)}
        </select>
        {!playing
          ? <button onClick={play} disabled={!buffer}>▶ Region</button>
          : <button className="active" onClick={stop}>■</button>}
        <span style={{ color: 'var(--dim)', fontSize: 10, marginLeft: 'auto' }}>
          {buffer
            ? `region ${region.start.toFixed(2)}s → ${region.end.toFixed(2)}s · ${(region.end - region.start).toFixed(2)}s`
            : 'drop a pool item or pick above'}
        </span>
      </div>
      <canvas
        ref={canvasRef}
        width={900}
        height={110}
        className="source-picker-canvas"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
      <div className="source-picker-row">
        <span style={{ color: 'var(--dim)', fontSize: 10 }}>
          drag to set region · shift-drag to scrub · drag region edges to resize
        </span>
        <div style={{ flex: 1 }} />
        <label style={{ fontSize: 10, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1 }}>target</label>
        <select value={targetTrack} onChange={e => setTargetTrack(+e.target.value)} className="select-inline">
          {tracks.map((_, i) => <option key={i} value={i}>Track {i + 1}</option>)}
        </select>
        <button onClick={send} disabled={!buffer || region.end <= region.start} title="slice region into a new pool item and add as clip">
          ▸ Commit & send
        </button>
      </div>
    </div>
  )
}
