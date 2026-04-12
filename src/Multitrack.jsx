import { useRef, useEffect, useCallback } from 'react'
import { useStore } from './state'
import { themeColor } from './audio'

const HEADER_WIDTH = 140

export function Multitrack({
  tracks,
  setTracks,
  pxPerSec = 40,
  length = 24,
  trackHeight = 48,
  showRuler = true,
  trackLabels,
  selected,
  setSelected,
}) {
  const { pool } = useStore()
  const clipsWidth = length * pxPerSec
  const width = HEADER_WIDTH + clipsWidth

  const updateTracks = (fn) => setTracks(prev => fn(prev))

  const setTrackProp = (ti, prop, value) => {
    updateTracks(prev => prev.map((t, i) => i === ti ? { ...t, [prop]: value } : t))
  }

  const onDrop = (e, ti) => {
    e.preventDefault()
    const poolId = e.dataTransfer.getData('poolId')
    if (!poolId) return
    const item = pool.find(p => p.id === poolId)
    if (!item) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const offset = Math.max(0, x / pxPerSec)
    const clip = {
      id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      poolId,
      offset,
      sourceStart: 0,
      sourceEnd: item.duration,
      fadeIn: 0,
      fadeOut: 0,
      fadeInCurve: 'linear',
      fadeOutCurve: 'linear',
      gain: 1,
    }
    updateTracks(prev => prev.map((tr, i) => i === ti ? { ...tr, clips: [...tr.clips, clip] } : tr))
    setSelected && setSelected(clip.id)
  }

  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }

  const deleteSelected = useCallback(() => {
    if (!selected) return
    updateTracks(prev => prev.map(tr => ({ ...tr, clips: tr.clips.filter(c => c.id !== selected) })))
    setSelected && setSelected(null)
  }, [selected])

  useEffect(() => {
    const onKey = (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        const tag = document.activeElement?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        deleteSelected()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, deleteSelected])

  return (
    <div className="multitrack" style={{ width }}>
      {showRuler && (
        <div className="ruler" style={{ paddingLeft: HEADER_WIDTH }}>
          {Array.from({ length: Math.floor(length) + 1 }).map((_, i) => (
            <div key={i} className="tick" style={{ left: HEADER_WIDTH + i * pxPerSec }}>{i}s</div>
          ))}
        </div>
      )}
      {tracks.map((track, ti) => (
        <Track
          key={ti}
          index={ti}
          track={track}
          label={trackLabels ? trackLabels[ti] : `T${ti + 1}`}
          pxPerSec={pxPerSec}
          clipsWidth={clipsWidth}
          trackHeight={trackHeight}
          selected={selected}
          setSelected={setSelected}
          onDrop={onDrop}
          onDragOver={onDragOver}
          updateTracks={updateTracks}
          setTrackProp={setTrackProp}
        />
      ))}
    </div>
  )
}

function Track({ index, track, label, pxPerSec, clipsWidth, trackHeight, selected, setSelected, onDrop, onDragOver, updateTracks, setTrackProp }) {
  const { mute, solo, gain, pan, clips } = track
  return (
    <div className="track-row" style={{ height: trackHeight }}>
      <div className="track-header">
        <div className="track-header-top">
          <span className="tlabel-inline">{label}</span>
          <button
            className={'mini ' + (solo ? 'active-solo' : '')}
            onClick={() => setTrackProp(index, 'solo', !solo)}
            title="solo"
          >S</button>
          <button
            className={'mini ' + (mute ? 'active-mute' : '')}
            onClick={() => setTrackProp(index, 'mute', !mute)}
            title="mute"
          >M</button>
        </div>
        <div className="track-header-row">
          <span className="mini-label">G</span>
          <input
            type="range"
            min="0"
            max="1.5"
            step="0.01"
            value={gain}
            onChange={e => setTrackProp(index, 'gain', +e.target.value)}
          />
        </div>
        <div className="track-header-row">
          <span className="mini-label">P</span>
          <input
            type="range"
            min="-1"
            max="1"
            step="0.01"
            value={pan}
            onChange={e => setTrackProp(index, 'pan', +e.target.value)}
          />
        </div>
      </div>
      <div
        className="track-clips"
        style={{ width: clipsWidth }}
        onDrop={(e) => onDrop(e, index)}
        onDragOver={onDragOver}
      >
        {clips.map(clip => (
          <Clip
            key={clip.id}
            clip={clip}
            pxPerSec={pxPerSec}
            trackHeight={trackHeight}
            trackIndex={index}
            selected={selected === clip.id}
            onSelect={() => setSelected && setSelected(clip.id)}
            updateTracks={updateTracks}
          />
        ))}
      </div>
    </div>
  )
}

function Clip({ clip, pxPerSec, trackHeight, trackIndex, selected, onSelect, updateTracks }) {
  const { getBuffer, pool, theme } = useStore()
  const buf = getBuffer(clip.poolId)
  const wanted = Math.max(0.01, clip.sourceEnd - clip.sourceStart)
  const available = buf ? Math.max(0.01, buf.duration - clip.sourceStart) : wanted
  const len = Math.min(wanted, available)
  const left = clip.offset * pxPerSec
  const width = len * pxPerSec
  const innerHeight = Math.max(8, trackHeight - 8)
  const item = pool.find(p => p.id === clip.poolId)
  const canvasRef = useRef(null)

  // draw waveform of the clipped portion at full clip height
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const b = getBuffer(clip.poolId)
    if (!b) return
    const ctx = c.getContext('2d')
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(innerHeight))
    c.width = w; c.height = h
    ctx.clearRect(0, 0, w, h)
    ctx.strokeStyle = themeColor('clip-wave', '#00ff9c')
    ctx.lineWidth = 1
    const data = b.getChannelData(0)
    const startI = Math.floor(clip.sourceStart * b.sampleRate)
    const endI = Math.floor(Math.min(b.length, (clip.sourceStart + len) * b.sampleRate))
    const span = Math.max(1, endI - startI)
    const step = Math.max(1, Math.floor(span / w))
    for (let x = 0; x < w; x++) {
      let mn = 1, mx = -1
      const s = startI + Math.floor(x / w * span)
      const e = Math.min(endI, s + step)
      for (let i = s; i < e; i++) {
        const v = data[i] || 0
        if (v < mn) mn = v
        if (v > mx) mx = v
      }
      const y1 = (1 - (mx + 1) / 2) * h
      const y2 = (1 - (mn + 1) / 2) * h
      ctx.beginPath()
      ctx.moveTo(x + 0.5, y1)
      ctx.lineTo(x + 0.5, y2)
      ctx.stroke()
    }
  }, [clip.poolId, clip.sourceStart, clip.sourceEnd, width, innerHeight, getBuffer, len, theme])

  const startDrag = (e, mode) => {
    e.stopPropagation()
    onSelect()
    const startX = e.clientX
    const startY = e.clientY
    const orig = { ...clip }
    // capture track row positions for move-to-other-track drops
    const multitrackEl = e.currentTarget.closest('.multitrack')
    const trackRowEls = multitrackEl
      ? Array.from(multitrackEl.querySelectorAll('.track-row'))
      : []
    const move = (ev) => {
      const dx = (ev.clientX - startX) / pxPerSec
      const dy = ev.clientY - startY
      // for move mode: figure out which track the pointer is over
      if (mode === 'move' && trackRowEls.length > 0) {
        let targetTrack = trackIndex
        const first = trackRowEls[0].getBoundingClientRect()
        const last = trackRowEls[trackRowEls.length - 1].getBoundingClientRect()
        if (ev.clientY < first.top) {
          targetTrack = 0
        } else if (ev.clientY > last.bottom) {
          targetTrack = trackRowEls.length - 1
        } else {
          for (let i = 0; i < trackRowEls.length; i++) {
            const r = trackRowEls[i].getBoundingClientRect()
            if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
              targetTrack = i
              break
            }
          }
        }
        const newOffset = Math.max(0, orig.offset + dx)
        const updatedClip = { ...orig, offset: newOffset }
        updateTracks(prev => {
          const stripped = prev.map(t => ({ ...t, clips: t.clips.filter(c => c.id !== clip.id) }))
          return stripped.map((t, i) =>
            i === targetTrack ? { ...t, clips: [...t.clips, updatedClip] } : t
          )
        })
        return
      }
      updateTracks(prev => prev.map((tr, i) => {
        if (i !== trackIndex) return tr
        return {
          ...tr,
          clips: tr.clips.map(c => {
            if (c.id !== clip.id) return c
            if (mode === 'move') return { ...c, offset: Math.max(0, orig.offset + dx) }
            if (mode === 'left') {
              const ns = Math.max(0, Math.min(orig.sourceEnd - 0.02, orig.sourceStart + dx))
              const delta = ns - orig.sourceStart
              return { ...c, sourceStart: ns, offset: Math.max(0, orig.offset + delta) }
            }
            if (mode === 'right') {
              const b = getBuffer(c.poolId)
              const max = b ? b.duration : orig.sourceEnd + 10
              const ne = Math.max(orig.sourceStart + 0.02, Math.min(max, orig.sourceEnd + dx))
              return { ...c, sourceEnd: ne }
            }
            if (mode === 'fadeIn') {
              const maxFade = Math.max(0.001, len / 2)
              const newFade = Math.max(0, Math.min(maxFade, (orig.fadeIn || 0) + dx))
              // vertical drag → curvature (down = exp / fast end, up = log / slow start)
              const basePower = typeof orig.fadeInCurve === 'number' ? orig.fadeInCurve : 1
              const factor = Math.pow(2, dy / 60)
              const power = Math.max(0.2, Math.min(5, basePower * factor))
              return { ...c, fadeIn: newFade, fadeInCurve: power }
            }
            if (mode === 'fadeOut') {
              const maxFade = Math.max(0.001, len / 2)
              // dragging left increases fade-out length
              const newFade = Math.max(0, Math.min(maxFade, (orig.fadeOut || 0) - dx))
              const basePower = typeof orig.fadeOutCurve === 'number' ? orig.fadeOutCurve : 1
              const factor = Math.pow(2, dy / 60)
              const power = Math.max(0.2, Math.min(5, basePower * factor))
              return { ...c, fadeOut: newFade, fadeOutCurve: power }
            }
            return c
          }),
        }
      }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // SVG envelope generation
  const fiSec = Math.min(clip.fadeIn || 0, len)
  const foSec = Math.min(clip.fadeOut || 0, len)
  const fiPx = fiSec * pxPerSec
  const foPx = foSec * pxPerSec
  const h = innerHeight
  const samples = 24
  const fiPower = typeof clip.fadeInCurve === 'number' ? clip.fadeInCurve : 1
  const foPower = typeof clip.fadeOutCurve === 'number' ? clip.fadeOutCurve : 1
  let fadeInPath = ''
  if (fiPx > 0.5) {
    fadeInPath = `M 0 ${h}`
    for (let i = 1; i <= samples; i++) {
      const t = i / samples
      const x = t * fiPx
      const y = (1 - Math.pow(t, fiPower)) * h
      fadeInPath += ` L ${x.toFixed(2)} ${y.toFixed(2)}`
    }
  }
  let fadeOutPath = ''
  if (foPx > 0.5) {
    fadeOutPath = `M ${(width - foPx).toFixed(2)} 0`
    for (let i = 1; i <= samples; i++) {
      const t = i / samples
      const x = (width - foPx) + t * foPx
      const y = (1 - Math.pow(1 - t, foPower)) * h
      fadeOutPath += ` L ${x.toFixed(2)} ${y.toFixed(2)}`
    }
  }

  return (
    <div
      className={'clip' + (selected ? ' selected' : '')}
      style={{ left, width }}
      onPointerDown={(e) => startDrag(e, 'move')}
    >
      <canvas ref={canvasRef} />
      <svg className="fade-svg" width={width} height={h} viewBox={`0 0 ${width} ${h}`}>
        {fadeInPath && <path d={fadeInPath} stroke="var(--hl)" strokeWidth="1.5" fill="none" />}
        {fadeOutPath && <path d={fadeOutPath} stroke="var(--hl)" strokeWidth="1.5" fill="none" />}
      </svg>
      {/* fade handles — drag horizontally for length, vertically for curve */}
      <div
        className="fade-handle"
        style={{ left: fiPx - 8, top: -8 }}
        onPointerDown={(e) => startDrag(e, 'fadeIn')}
        title="drag: ↔ length · ↕ curve"
      />
      <div
        className="fade-handle"
        style={{ left: width - foPx - 8, top: -8 }}
        onPointerDown={(e) => startDrag(e, 'fadeOut')}
        title="drag: ↔ length · ↕ curve"
      />
      <div className="handle l" onPointerDown={(e) => startDrag(e, 'left')} />
      <div className="handle r" onPointerDown={(e) => startDrag(e, 'right')} />
    </div>
  )
}
