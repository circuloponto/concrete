import { useRef, useState, useEffect, useCallback } from 'react'
import { useStore } from './state'

export function Multitrack({ tracks, setTracks, pxPerSec = 40, length = 24, showRuler = true, trackLabels }) {
  const { pool, getBuffer, highlight } = useStore()
  const [selected, setSelected] = useState(null)
  const width = length * pxPerSec

  const updateTracks = (fn) => setTracks(prev => fn(prev))

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
      gain: 1,
    }
    updateTracks(prev => prev.map((tr, i) => i === ti ? [...tr, clip] : tr))
    setSelected(clip.id)
  }

  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }

  const deleteSelected = useCallback(() => {
    if (!selected) return
    updateTracks(prev => prev.map(tr => tr.filter(c => c.id !== selected)))
    setSelected(null)
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
        <div className="ruler">
          {Array.from({ length: Math.floor(length) + 1 }).map((_, i) => (
            <div key={i} className="tick" style={{ left: i * pxPerSec }}>{i}s</div>
          ))}
        </div>
      )}
      {tracks.map((trackClips, ti) => (
        <Track
          key={ti}
          index={ti}
          clips={trackClips}
          label={trackLabels ? trackLabels[ti] : `T${ti + 1}`}
          pxPerSec={pxPerSec}
          selected={selected}
          setSelected={setSelected}
          onDrop={onDrop}
          onDragOver={onDragOver}
          updateTracks={updateTracks}
        />
      ))}
    </div>
  )
}

function Track({ index, clips, label, pxPerSec, selected, setSelected, onDrop, onDragOver, updateTracks }) {
  return (
    <div
      className="track"
      onDrop={(e) => onDrop(e, index)}
      onDragOver={onDragOver}
    >
      <div className="tlabel">{label}</div>
      {clips.map(clip => (
        <Clip
          key={clip.id}
          clip={clip}
          pxPerSec={pxPerSec}
          trackIndex={index}
          selected={selected === clip.id}
          onSelect={() => setSelected(clip.id)}
          updateTracks={updateTracks}
        />
      ))}
    </div>
  )
}

function Clip({ clip, pxPerSec, trackIndex, selected, onSelect, updateTracks }) {
  const { getBuffer, pool } = useStore()
  const len = Math.max(0.01, clip.sourceEnd - clip.sourceStart)
  const left = clip.offset * pxPerSec
  const width = len * pxPerSec
  const item = pool.find(p => p.id === clip.poolId)
  const canvasRef = useRef(null)

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const buf = getBuffer(clip.poolId)
    if (!buf) return
    const ctx = c.getContext('2d')
    const w = Math.max(1, Math.floor(width))
    const h = 40
    c.width = w; c.height = h
    ctx.clearRect(0, 0, w, h)
    ctx.strokeStyle = '#00ff9c'
    ctx.beginPath()
    const data = buf.getChannelData(0)
    const startI = Math.floor(clip.sourceStart * buf.sampleRate)
    const endI = Math.floor(clip.sourceEnd * buf.sampleRate)
    const span = Math.max(1, endI - startI)
    for (let x = 0; x < w; x++) {
      const i = startI + Math.floor(x / w * span)
      const s = data[i] || 0
      const y = h / 2 + s * h / 2
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }, [clip.poolId, clip.sourceStart, clip.sourceEnd, width, getBuffer])

  const startDrag = (e, mode) => {
    e.stopPropagation()
    onSelect()
    const startX = e.clientX
    const orig = { ...clip }
    const move = (ev) => {
      const dx = (ev.clientX - startX) / pxPerSec
      updateTracks(prev => prev.map((tr, i) => {
        if (i !== trackIndex) return tr
        return tr.map(c => {
          if (c.id !== clip.id) return c
          if (mode === 'move') {
            return { ...c, offset: Math.max(0, orig.offset + dx) }
          }
          if (mode === 'left') {
            let ns = Math.max(0, Math.min(orig.sourceEnd - 0.02, orig.sourceStart + dx))
            const delta = ns - orig.sourceStart
            return { ...c, sourceStart: ns, offset: Math.max(0, orig.offset + delta) }
          }
          if (mode === 'right') {
            const buf = getBuffer(c.poolId)
            const max = buf ? buf.duration : orig.sourceEnd + 10
            let ne = Math.max(orig.sourceStart + 0.02, Math.min(max, orig.sourceEnd + dx))
            return { ...c, sourceEnd: ne }
          }
          return c
        })
      }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      className={'clip' + (selected ? ' selected' : '')}
      style={{ left, width }}
      onPointerDown={(e) => startDrag(e, 'move')}
    >
      <canvas ref={canvasRef} />
      <div className="cname">{item?.name || '?'}</div>
      <div className="handle l" onPointerDown={(e) => startDrag(e, 'left')} />
      <div className="handle r" onPointerDown={(e) => startDrag(e, 'right')} />
    </div>
  )
}
