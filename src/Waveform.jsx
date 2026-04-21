import { useRef, useEffect } from 'react'
import { useStore } from './state'
import { themeColor } from './audio'

export function Waveform({ buffer, position, playing, onScrub, width = 640, height = 160,
                            loopStart = 0, loopEnd = 1, setLoopStart, setLoopEnd }) {
  const { highlight, theme } = useStore()
  const canvasRef = useRef(null)
  const posRef = useRef(position)
  const loopRef = useRef({ start: loopStart, end: loopEnd })
  loopRef.current = { start: loopStart, end: loopEnd }
  // 'scrub' | 'select' | null
  const modeRef = useRef(null)
  const selectAnchorRef = useRef(0)
  posRef.current = position

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    // draw waveform once per buffer/width change; playhead is overlaid per frame
    const drawStatic = () => {
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = themeColor('panel-bg', '#050505')
      ctx.fillRect(0, 0, width, height)
      ctx.strokeStyle = highlight + '33'
      ctx.beginPath()
      ctx.moveTo(0, height / 2)
      ctx.lineTo(width, height / 2)
      ctx.stroke()
      if (!buffer) return
      const data = buffer.getChannelData(0)
      const step = Math.max(1, Math.floor(data.length / width))
      ctx.strokeStyle = highlight
      ctx.lineWidth = 1
      for (let x = 0; x < width; x++) {
        let min = 1, max = -1
        const start = x * step
        const end = Math.min(data.length, start + step)
        for (let i = start; i < end; i++) {
          const v = data[i]
          if (v < min) min = v
          if (v > max) max = v
        }
        const y1 = (1 - (max + 1) / 2) * height
        const y2 = (1 - (min + 1) / 2) * height
        ctx.beginPath()
        ctx.moveTo(x + 0.5, y1)
        ctx.lineTo(x + 0.5, y2)
        ctx.stroke()
      }
    }
    drawStatic()
    const off = document.createElement('canvas')
    off.width = width; off.height = height
    off.getContext('2d').drawImage(c, 0, 0)
    let raf
    const draw = () => {
      ctx.clearRect(0, 0, width, height)
      ctx.drawImage(off, 0, 0)
      // loop-region shading
      const ls = loopRef.current.start
      const le = loopRef.current.end
      if (ls > 0 || le < 1) {
        const xs = Math.floor(ls * width)
        const xe = Math.floor(le * width)
        ctx.fillStyle = highlight + '22'
        ctx.fillRect(xs, 0, xe - xs, height)
        ctx.strokeStyle = highlight + '99'
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(xs + 0.5, 0); ctx.lineTo(xs + 0.5, height); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(xe + 0.5, 0); ctx.lineTo(xe + 0.5, height); ctx.stroke()
      }
      // playhead
      const x = Math.floor(posRef.current * width)
      ctx.strokeStyle = highlight
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x + 0.5, 0)
      ctx.lineTo(x + 0.5, height)
      ctx.stroke()
      ctx.fillStyle = highlight
      ctx.fillRect(x - 3, 0, 7, 4)
      ctx.fillRect(x - 3, height - 4, 7, 4)
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [buffer, width, height, highlight, theme])

  const getPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    return Math.max(0, Math.min(1, x / rect.width))
  }

  const onDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = getPos(e)
    if (e.shiftKey && setLoopStart && setLoopEnd) {
      // enter pre-select: don't write loop bounds yet — wait until the user
      // actually drags, otherwise a plain shift-click would collapse the loop
      // to ~1 ms and the playback becomes silent.
      modeRef.current = 'select-armed'
      selectAnchorRef.current = p
      return
    }
    modeRef.current = 'scrub'
    onScrub && onScrub(p, 0, 'start')
  }
  const onMove = (e) => {
    if (!modeRef.current) return
    const p = getPos(e)
    if (modeRef.current === 'select-armed' || modeRef.current === 'select') {
      const a = selectAnchorRef.current
      if (modeRef.current === 'select-armed' && Math.abs(p - a) < 0.005) return
      modeRef.current = 'select'
      const lo = Math.min(a, p)
      const hi = Math.max(a, p)
      // Tiny floor just to prevent zero-width loops; signalsmith-stretch
      // and AudioBufferSourceNode both handle sub-100ms loops cleanly.
      const dur = buffer ? buffer.duration : 1
      const minFrac = Math.min(0.5, 0.005 / dur)
      setLoopStart(lo)
      setLoopEnd(Math.min(1, Math.max(lo + minFrac, hi)))
      return
    }
    const delta = p - posRef.current
    onScrub && onScrub(p, delta, 'move')
  }
  const onUp = (e) => {
    if (!modeRef.current) return
    const wasScrub = modeRef.current === 'scrub'
    modeRef.current = null
    if (wasScrub) onScrub && onScrub(posRef.current, 0, 'end')
  }

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ touchAction: 'none', cursor: 'ew-resize', display: 'block', border: '1px solid var(--border)' }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    />
  )
}
