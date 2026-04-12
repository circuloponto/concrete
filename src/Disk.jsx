import { useRef, useEffect } from 'react'
import { useStore } from './state'
import { themeColor } from './audio'

export function Disk({ buffer, position, playing, onScrub, size = 280 }) {
  const { highlight, theme } = useStore()
  const canvasRef = useRef(null)
  const draggingRef = useRef(false)
  const lastAngleRef = useRef(0)
  const posRef = useRef(position)
  const spinRef = useRef(0)
  posRef.current = position

  useEffect(() => {
    const c = canvasRef.current
    const ctx = c.getContext('2d')
    let raf
    let lastT = performance.now()
    const draw = () => {
      const now = performance.now()
      const dt = (now - lastT) / 1000
      lastT = now
      if (playing && !draggingRef.current) spinRef.current += dt * 0.4
      const w = c.width, h = c.height
      ctx.clearRect(0, 0, w, h)
      const cx = w / 2, cy = h / 2
      const rOuter = Math.min(w, h) / 2 - 10
      const rInner = rOuter * 0.35
      // background disk
      ctx.fillStyle = themeColor('panel-bg', '#050505')
      ctx.beginPath(); ctx.arc(cx, cy, rOuter, 0, Math.PI * 2); ctx.fill()
      // waveform ring around circumference
      if (buffer) {
        const data = buffer.getChannelData(0)
        const N = 360
        ctx.strokeStyle = highlight
        ctx.lineWidth = 1.2
        const rMid = (rOuter + rInner) / 2
        const amp = (rOuter - rInner) / 2 - 4
        for (let i = 0; i < N; i++) {
          const t = i / N
          const idx = Math.floor(t * data.length)
          const s = Math.abs(data[idx] || 0)
          const ang = t * Math.PI * 2 - Math.PI / 2 + spinRef.current
          const r1 = rMid - s * amp
          const r2 = rMid + s * amp
          ctx.beginPath()
          ctx.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1)
          ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2)
          ctx.stroke()
        }
      }
      // rings
      ctx.strokeStyle = highlight + '44'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.arc(cx, cy, rOuter, 0, Math.PI * 2); ctx.stroke()
      ctx.beginPath(); ctx.arc(cx, cy, rInner, 0, Math.PI * 2); ctx.stroke()
      // playhead marker (fixed at top, disk rotates beneath)
      ctx.strokeStyle = highlight
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(cx, cy - rOuter - 4)
      ctx.lineTo(cx, cy - rOuter + 8)
      ctx.stroke()
      // position dot on disk
      const pa = posRef.current * Math.PI * 2 - Math.PI / 2 + spinRef.current
      ctx.fillStyle = highlight
      ctx.beginPath()
      ctx.arc(cx + Math.cos(pa) * (rOuter - 4), cy + Math.sin(pa) * (rOuter - 4), 4, 0, Math.PI * 2)
      ctx.fill()
      // center hub
      ctx.fillStyle = themeColor('bg', '#000')
      ctx.beginPath(); ctx.arc(cx, cy, rInner - 2, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = highlight
      ctx.beginPath(); ctx.arc(cx, cy, rInner - 2, 0, Math.PI * 2); ctx.stroke()
      ctx.fillStyle = highlight
      ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill()
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [buffer, highlight, playing, theme])

  const getAngle = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left - rect.width / 2
    const y = e.clientY - rect.top - rect.height / 2
    return Math.atan2(y, x)
  }

  const onDown = (e) => {
    draggingRef.current = true
    lastAngleRef.current = getAngle(e)
    e.currentTarget.setPointerCapture(e.pointerId)
    onScrub && onScrub(posRef.current, 0, 'start')
  }
  const onMove = (e) => {
    if (!draggingRef.current) return
    const a = getAngle(e)
    let d = a - lastAngleRef.current
    if (d > Math.PI) d -= 2 * Math.PI
    if (d < -Math.PI) d += 2 * Math.PI
    lastAngleRef.current = a
    spinRef.current -= d
    let np = posRef.current + d / (Math.PI * 2)
    np = ((np % 1) + 1) % 1
    onScrub && onScrub(np, d, 'move')
  }
  const onUp = (e) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    onScrub && onScrub(posRef.current, 0, 'end')
  }

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      style={{ touchAction: 'none', cursor: 'grab', display: 'block' }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    />
  )
}
