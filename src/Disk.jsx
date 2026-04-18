import { useRef, useEffect } from 'react'
import { useStore } from './state'
import { themeColor } from './audio'

export function Disk({ buffer, position, playing, onScrub, size = 280,
                        loopStart = 0, loopEnd = 1, setLoopStart, setLoopEnd }) {
  const { highlight, theme } = useStore()
  const canvasRef = useRef(null)
  // 'scrub' | 'loopStart' | 'loopEnd' | null
  const dragModeRef = useRef(null)
  const lastAngleRef = useRef(0)
  const posRef = useRef(position)
  const spinRef = useRef(0)
  const loopRef = useRef({ start: loopStart, end: loopEnd })
  loopRef.current = { start: loopStart, end: loopEnd }
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
      if (playing && !dragModeRef.current) spinRef.current += dt * 0.4
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
      // loop arc + markers on outer ring (always visible so they can be grabbed)
      const ls = loopRef.current.start
      const le = loopRef.current.end
      const aStart = ls * Math.PI * 2 - Math.PI / 2 + spinRef.current
      const aEnd = le * Math.PI * 2 - Math.PI / 2 + spinRef.current
      if (ls > 0 || le < 1) {
        ctx.strokeStyle = highlight
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.arc(cx, cy, rOuter, aStart, aEnd)
        ctx.stroke()
      }
      ctx.fillStyle = highlight
      for (const a of [aStart, aEnd]) {
        ctx.beginPath()
        ctx.arc(cx + Math.cos(a) * rOuter, cy + Math.sin(a) * rOuter, 5, 0, Math.PI * 2)
        ctx.fill()
      }
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

  const getPointer = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const dx = e.clientX - rect.left - rect.width / 2
    const dy = e.clientY - rect.top - rect.height / 2
    return { angle: Math.atan2(dy, dx), r: Math.hypot(dx, dy), rect }
  }

  // Convert a pointer angle back to a normalized (0..1) audio-timeline position,
  // undoing the disk's current spin. This matches how markers are drawn.
  const angleToT = (a) => {
    const TAU = Math.PI * 2
    let t = (a + Math.PI / 2 - spinRef.current) / TAU
    t = ((t % 1) + 1) % 1
    return t
  }

  const angleDist = (a, b) => {
    let d = Math.abs(a - b) % (Math.PI * 2)
    if (d > Math.PI) d = Math.PI * 2 - d
    return d
  }

  const onDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    const { angle, rect } = getPointer(e)
    const rOuter = Math.min(rect.width, rect.height) / 2 - 10
    // marker hit-test: near the outer ring AND close to one of the loop angles
    const pRadius = Math.hypot(e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2)
    const nearRing = pRadius > rOuter - 14 && pRadius < rOuter + 10
    if (nearRing && setLoopStart && setLoopEnd) {
      const aStart = loopRef.current.start * Math.PI * 2 - Math.PI / 2 + spinRef.current
      const aEnd = loopRef.current.end * Math.PI * 2 - Math.PI / 2 + spinRef.current
      const dStart = angleDist(angle, aStart)
      const dEnd = angleDist(angle, aEnd)
      const threshold = 0.25 // ~14°
      if (dStart < threshold || dEnd < threshold) {
        dragModeRef.current = dStart <= dEnd ? 'loopStart' : 'loopEnd'
        return
      }
    }
    dragModeRef.current = 'scrub'
    lastAngleRef.current = angle
    onScrub && onScrub(posRef.current, 0, 'start')
  }
  const onMove = (e) => {
    if (!dragModeRef.current) return
    const { angle } = getPointer(e)
    if (dragModeRef.current === 'loopStart' || dragModeRef.current === 'loopEnd') {
      const t = angleToT(angle)
      // Minimum loop width: 150 ms in buffer time — matches the Waveform
      // constraint (soundtouchjs's process buffer is ~93 ms).
      const dur = buffer ? buffer.duration : 1
      const minFrac = Math.min(0.5, 0.15 / dur)
      if (dragModeRef.current === 'loopStart') {
        setLoopStart(Math.min(t, loopRef.current.end - minFrac))
      } else {
        setLoopEnd(Math.max(t, loopRef.current.start + minFrac))
      }
      return
    }
    // scrub: treat as rotation
    let d = angle - lastAngleRef.current
    if (d > Math.PI) d -= 2 * Math.PI
    if (d < -Math.PI) d += 2 * Math.PI
    lastAngleRef.current = angle
    spinRef.current -= d
    let np = posRef.current + d / (Math.PI * 2)
    np = ((np % 1) + 1) % 1
    onScrub && onScrub(np, d, 'move')
  }
  const onUp = (e) => {
    if (!dragModeRef.current) return
    const wasScrub = dragModeRef.current === 'scrub'
    dragModeRef.current = null
    if (wasScrub) onScrub && onScrub(posRef.current, 0, 'end')
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
