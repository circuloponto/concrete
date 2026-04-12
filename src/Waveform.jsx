import { useRef, useEffect } from 'react'
import { useStore } from './state'
import { themeColor } from './audio'

export function Waveform({ buffer, position, playing, onScrub, width = 640, height = 160 }) {
  const { highlight, theme } = useStore()
  const canvasRef = useRef(null)
  const posRef = useRef(position)
  const draggingRef = useRef(false)
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
    draggingRef.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = getPos(e)
    onScrub && onScrub(p, 0, 'start')
  }
  const onMove = (e) => {
    if (!draggingRef.current) return
    const p = getPos(e)
    const delta = p - posRef.current
    onScrub && onScrub(p, delta, 'move')
  }
  const onUp = (e) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    onScrub && onScrub(posRef.current, 0, 'end')
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
