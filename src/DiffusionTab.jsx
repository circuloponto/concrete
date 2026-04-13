import { useRef, useEffect, useState, useCallback } from 'react'
import { useStore, MAX_VOICES } from './state'
import { themeColor } from './audio'

const SIZE = 520
const CENTER = SIZE / 2

// Path helpers
function pathLength(pts) {
  let len = 0
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x, dz = pts[i].z - pts[i - 1].z
    len += Math.sqrt(dx * dx + dz * dz)
  }
  return len
}
function samplePath(pts, t01) {
  if (!pts || pts.length < 2) return pts?.[0] || { x: 0, z: 0 }
  const total = pathLength(pts)
  if (total < 0.001) return pts[0]
  let target = (((t01 % 1) + 1) % 1) * total
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x, dz = pts[i].z - pts[i - 1].z
    const seg = Math.sqrt(dx * dx + dz * dz)
    if (target <= seg || i === pts.length - 1) {
      const f = seg > 0 ? target / seg : 0
      return { x: pts[i - 1].x + dx * f, z: pts[i - 1].z + dz * f }
    }
    target -= seg
  }
  return pts[pts.length - 1]
}

export function DiffusionTab() {
  const { diffusion, setDiffusion, getAudioCtx, getBuffer, addPoolItem, pool, highlight, theme } = useStore()
  const canvasRef = useRef(null)
  const draggingRef = useRef(null)
  const radius = diffusion.radius || 12
  const trajectories = diffusion.trajectories || []
  const [playing, setPlayingState] = useState(() => Array(MAX_VOICES).fill(false))
  const [recording, setRecording] = useState(false)
  const [drawMode, setDrawMode] = useState(false)
  const [drawingPts, setDrawingPts] = useState(null)
  const [captureName, setCaptureName] = useState('binaural')

  // ---- audio engine ----
  const audioRef = useRef(null)
  const ensureAudio = useCallback(() => {
    if (audioRef.current) return audioRef.current
    const ctx = getAudioCtx()
    const mixer = ctx.createGain(); mixer.gain.value = 1
    const msDest = ctx.createMediaStreamDestination()
    mixer.connect(ctx.destination); mixer.connect(msDest)
    const voices = Array.from({ length: MAX_VOICES }, () => {
      const panner = ctx.createPanner()
      panner.panningModel = 'HRTF'
      panner.distanceModel = 'linear'
      panner.refDistance = 1; panner.maxDistance = 50; panner.rolloffFactor = 0.4
      panner.coneInnerAngle = 360; panner.coneOuterAngle = 360; panner.coneOuterGain = 1
      panner.setPosition(0, 0, -1)
      panner.connect(mixer)
      return { panner, source: null }
    })
    audioRef.current = { ctx, mixer, msDest, voices }
    return audioRef.current
  }, [getAudioCtx])

  useEffect(() => () => {
    if (!audioRef.current) return
    audioRef.current.voices.forEach(v => { if (v.source) try { v.source.stop() } catch {} })
    try { audioRef.current.mixer.disconnect() } catch {}
    audioRef.current = null
  }, [])

  const playVoice = (i, overridePoolId) => {
    const a = ensureAudio()
    const poolId = overridePoolId || diffRef.current.voices[i]?.poolId
    if (!poolId) return
    const buf = getBuffer(poolId)
    if (!buf) return
    stopVoice(i)
    const src = a.ctx.createBufferSource()
    src.buffer = buf; src.loop = true
    src.connect(a.voices[i].panner); src.start()
    a.voices[i].source = src
    src.onended = () => { a.voices[i].source = null; setPlayingState(p => { const n = [...p]; n[i] = false; return n }) }
    setPlayingState(p => { const n = [...p]; n[i] = true; return n })
  }
  const stopVoice = (i) => {
    if (!audioRef.current) return
    const v = audioRef.current.voices[i]
    if (v.source) { try { v.source.stop() } catch {}; try { v.source.disconnect() } catch {}; v.source = null }
    setPlayingState(p => { const n = [...p]; n[i] = false; return n })
  }
  const playAll = () => diffRef.current.voices.forEach((v, i) => { if (v.poolId) playVoice(i) })
  const stopAll = () => { for (let i = 0; i < MAX_VOICES; i++) stopVoice(i) }

  const recRef = useRef(null)
  const startRecord = () => {
    const a = ensureAudio()
    const rec = new MediaRecorder(a.msDest.stream)
    const chunks = []
    rec.ondataavailable = e => chunks.push(e.data)
    rec.onstop = async () => {
      const blob = new Blob(chunks)
      const buf = await getAudioCtx().decodeAudioData(await blob.arrayBuffer())
      addPoolItem(captureName || `binaural_${Date.now().toString(36)}`, buf, 'diffusion')
    }
    rec.start(); recRef.current = rec; setRecording(true)
  }
  const stopRecord = () => { if (recRef.current) { recRef.current.stop(); recRef.current = null }; setRecording(false) }

  // ---- rAF: positions + trajectories + orbits ----
  const diffRef = useRef(diffusion); diffRef.current = diffusion
  const trajTRef = useRef(Array(MAX_VOICES).fill(0)) // per-voice trajectory progress

  useEffect(() => {
    let raf, last = performance.now()
    const tick = () => {
      const now = performance.now(); const dt = (now - last) / 1000; last = now
      const d = diffRef.current
      if (!d) { raf = requestAnimationFrame(tick); return }
      let changed = false
      const newVoices = d.voices.map((v, i) => {
        let nx = v.x, nz = v.z
        const trajs = d.trajectories || []
        const traj = v.trajectoryId >= 0 ? trajs[v.trajectoryId] : null
        if (traj && traj.points.length >= 2) {
          trajTRef.current[i] += dt * (v.trajectorySpeed || 0.5) / Math.max(0.01, pathLength(traj.points))
          const pos = samplePath(traj.points, trajTRef.current[i])
          nx = pos.x; nz = pos.z
          changed = true
        } else if (v.orbit > 0) {
          const dist = Math.sqrt(v.x * v.x + v.z * v.z) || 4
          const angle = Math.atan2(v.x, v.z) + dt * v.orbit * Math.PI * 2
          nx = Math.sin(angle) * dist; nz = Math.cos(angle) * dist
          changed = true
        }
        // update panner if audio engine is running
        const a = audioRef.current
        if (a?.voices[i]?.panner) a.voices[i].panner.setPosition(nx, v.y || 0, -nz)
        if (nx !== v.x || nz !== v.z) return { ...v, x: nx, z: nz }
        return v
      })
      if (changed) setDiffusion(prev => ({ ...prev, voices: newVoices }))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [setDiffusion])

  // ---- coordinate conversion ----
  const w2c = (wx, wz) => ({ cx: CENTER + (wx / radius) * (CENTER - 30), cy: CENTER - (wz / radius) * (CENTER - 30) })
  const c2w = (cx, cy) => ({ x: ((cx - CENTER) / (CENTER - 30)) * radius, z: -((cy - CENTER) / (CENTER - 30)) * radius })
  const canvasXY = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    return { mx: (e.clientX - r.left) * (SIZE / r.width), my: (e.clientY - r.top) * (SIZE / r.height) }
  }

  // ---- canvas rendering ----
  useEffect(() => {
    const c = canvasRef.current; if (!c) return
    const ctx = c.getContext('2d')
    const hl = highlight || '#00ff9c'
    const bg = themeColor('panel-bg', '#050505'), dim = themeColor('dim', '#555')
    let raf
    const draw = () => {
      ctx.clearRect(0, 0, SIZE, SIZE); ctx.fillStyle = bg; ctx.fillRect(0, 0, SIZE, SIZE)
      // grid
      for (let i = 1; i <= 5; i++) { const r = (i / 5) * (CENTER - 30); ctx.strokeStyle = dim + '33'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(CENTER, CENTER, r, 0, Math.PI * 2); ctx.stroke() }
      ctx.strokeStyle = dim + '22'; ctx.beginPath(); ctx.moveTo(CENTER, 20); ctx.lineTo(CENTER, SIZE - 20); ctx.moveTo(20, CENTER); ctx.lineTo(SIZE - 20, CENTER); ctx.stroke()
      ctx.font = '9px monospace'; ctx.fillStyle = dim; ctx.textAlign = 'center'; ctx.fillText('front', CENTER, 16); ctx.fillText('back', CENTER, SIZE - 6)
      ctx.textAlign = 'left'; ctx.fillText('L', 6, CENTER + 3); ctx.textAlign = 'right'; ctx.fillText('R', SIZE - 6, CENTER + 3)
      // listener
      ctx.fillStyle = hl; ctx.beginPath(); ctx.arc(CENTER, CENTER, 8, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(CENTER, CENTER, 5, 0, Math.PI * 2); ctx.fill()
      // trajectories
      const trajs = diffusion.trajectories || []
      trajs.forEach((traj, ti) => {
        if (!traj.points || traj.points.length < 2) return
        ctx.strokeStyle = hl + '55'; ctx.lineWidth = 2; ctx.setLineDash([6, 4])
        ctx.beginPath()
        traj.points.forEach((p, j) => { const { cx, cy } = w2c(p.x, p.z); j === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy) })
        ctx.closePath(); ctx.stroke(); ctx.setLineDash([])
        // label
        const { cx, cy } = w2c(traj.points[0].x, traj.points[0].z)
        ctx.fillStyle = hl + '88'; ctx.font = '8px monospace'; ctx.textAlign = 'left'
        ctx.fillText(`P${ti + 1}`, cx + 4, cy - 4)
      })
      // drawing path preview
      if (drawingPts && drawingPts.length > 1) {
        ctx.strokeStyle = hl; ctx.lineWidth = 2.5
        ctx.beginPath()
        drawingPts.forEach((p, j) => { const { cx, cy } = w2c(p.x, p.z); j === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy) })
        ctx.stroke()
      }
      // voice dots
      const colors = [hl, '#ff6b6b', '#4ecdc4', '#ffe66d', '#a29bfe', '#fd79a8']
      diffusion.voices.forEach((v, i) => {
        if (!v?.poolId) return
        const { cx, cy } = w2c(v.x, v.z); const col = colors[i % colors.length]
        if (v.orbit > 0 || v.trajectoryId >= 0) {
          const dist = Math.sqrt(v.x * v.x + v.z * v.z)
          const pr = (dist / radius) * (CENTER - 30)
          if (v.orbit > 0 && v.trajectoryId < 0) { ctx.strokeStyle = col + '33'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.arc(CENTER, CENTER, pr, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]) }
        }
        ctx.strokeStyle = col + '44'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(CENTER, CENTER); ctx.lineTo(cx, cy); ctx.stroke()
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(cx, cy, 12, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = bg; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center'; ctx.fillText(`${i + 1}`, cx, cy + 3)
        if (playing[i]) { ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, 15, 0, Math.PI * 2); ctx.stroke() }
      })
      if (!diffusion.enabled) { ctx.fillStyle = dim; ctx.font = '10px monospace'; ctx.textAlign = 'center'; ctx.fillText('BINAURAL OFF', CENTER, SIZE - 24) }
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [diffusion, highlight, radius, theme, playing, drawingPts])

  // ---- pointer events: drag dots OR draw trajectories ----
  const onDown = (e) => {
    const { mx, my } = canvasXY(e)
    e.currentTarget.setPointerCapture(e.pointerId)
    if (drawMode) {
      const { x, z } = c2w(mx, my)
      setDrawingPts([{ x, z }])
      return
    }
    const voices = diffusion.voices || []
    for (let i = MAX_VOICES - 1; i >= 0; i--) {
      const v = voices[i]; if (!v?.poolId) continue
      const { cx, cy } = w2c(v.x, v.z)
      if (Math.sqrt((mx - cx) ** 2 + (my - cy) ** 2) < 18) { draggingRef.current = i; return }
    }
  }
  const onMove = (e) => {
    const { mx, my } = canvasXY(e)
    if (drawMode && drawingPts) {
      const { x, z } = c2w(mx, my)
      const last = drawingPts[drawingPts.length - 1]
      const dist = Math.sqrt((x - last.x) ** 2 + (z - last.z) ** 2)
      if (dist > radius * 0.02) setDrawingPts(prev => [...prev, { x, z }])
      return
    }
    if (draggingRef.current === null) return
    const { x, z } = c2w(mx, my)
    setDiffusion(prev => { const nv = prev.voices.slice(); nv[draggingRef.current] = { ...nv[draggingRef.current], x, z }; return { ...prev, voices: nv } })
  }
  const onUp = () => {
    if (drawMode && drawingPts && drawingPts.length >= 2) {
      setDiffusion(prev => ({
        ...prev,
        trajectories: [...(prev.trajectories || []), { points: drawingPts, name: `path ${(prev.trajectories?.length || 0) + 1}` }],
      }))
      setDrawingPts(null); setDrawMode(false)
    } else { setDrawingPts(null) }
    draggingRef.current = null
  }

  const deleteTrajectory = (ti) => {
    setDiffusion(prev => {
      const newTrajs = prev.trajectories.filter((_, i) => i !== ti)
      const newVoices = prev.voices.map(v => ({
        ...v,
        trajectoryId: v.trajectoryId === ti ? -1 : v.trajectoryId > ti ? v.trajectoryId - 1 : v.trajectoryId,
      }))
      return { ...prev, trajectories: newTrajs, voices: newVoices }
    })
  }

  const setVoiceProp = (i, prop, val) => {
    setDiffusion(prev => { const nv = prev.voices.slice(); nv[i] = { ...nv[i], [prop]: val }; return { ...prev, voices: nv } })
  }

  return (
    <div className="diffusion-tab">
      <div className="toolbar">
        <button className={diffusion.enabled ? 'active' : ''} onClick={() => setDiffusion(prev => ({ ...prev, enabled: !prev.enabled }))}>
          {diffusion.enabled ? '◉ Binaural ON' : '○ Binaural OFF'}
        </button>
        <button onClick={playing.some(Boolean) ? stopAll : playAll}>{playing.some(Boolean) ? '■ Stop all' : '▶ Play all'}</button>
        <input type="text" value={captureName} onChange={e => setCaptureName(e.target.value)} placeholder="capture name" style={{ width: 120 }} />
        {!recording ? <button onClick={startRecord}>● Rec → pool</button> : <button className="recording" onClick={stopRecord}>Stop rec</button>}
        <button className={drawMode ? 'active' : ''} onClick={() => { setDrawMode(!drawMode); setDrawingPts(null) }}>
          {drawMode ? '✎ Drawing...' : '✎ Draw path'}
        </button>
        <label style={{ fontSize: 10, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1, marginLeft: 8 }}>Radius</label>
        <input type="range" min="2" max="50" step="0.5" value={radius} onChange={e => setDiffusion(prev => ({ ...prev, radius: +e.target.value }))} style={{ width: 80 }} />
        <span style={{ color: 'var(--hl)', fontSize: 10 }}>{radius}m</span>
        <span style={{ color: 'var(--dim)', fontSize: 10, marginLeft: 'auto' }}>headphones required</span>
      </div>
      <div className="diffusion-layout">
        <canvas ref={canvasRef} width={SIZE} height={SIZE}
          className={'diffusion-canvas' + (drawMode ? ' drawing' : '')}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        />
        <div className="diffusion-voices">
          {Array.from({ length: MAX_VOICES }).map((_, i) => {
            const v = diffusion.voices[i] || {}
            const dist = Math.sqrt((v.x || 0) ** 2 + (v.z || 0) ** 2).toFixed(1)
            const angle = ((Math.atan2(v.x || 0, v.z || 0) * 180 / Math.PI + 360) % 360).toFixed(0)
            return (
              <div key={i} className="panel diffusion-voice-panel">
                <h4>Voice {i + 1}
                  <button className={'tiny-toggle' + (playing[i] ? ' active' : '')} onClick={() => playing[i] ? stopVoice(i) : playVoice(i)}>{playing[i] ? '■' : '▶'}</button>
                </h4>
                <div className="row">
                  <label>Source</label>
                  <select className="select-inline" value={v.poolId || ''}
                    onChange={e => { const pid = e.target.value; setVoiceProp(i, 'poolId', pid); stopVoice(i); if (pid) playVoice(i, pid) }}>
                    <option value="">— none —</option>
                    {pool.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className="row"><label>Dist / Az</label><span className="value">{dist}m · {angle}°</span></div>
                <div className="row">
                  <label>Elevation</label>
                  <input className="slider" type="range" min="-10" max="10" step="0.1" value={v.y || 0} onChange={e => setVoiceProp(i, 'y', +e.target.value)} />
                  <span className="value">{(v.y || 0).toFixed(1)}m</span>
                </div>
                <div className="row">
                  <label>Path</label>
                  <select className="select-inline" value={v.trajectoryId ?? -1}
                    onChange={e => { setVoiceProp(i, 'trajectoryId', +e.target.value); trajTRef.current[i] = 0 }}>
                    <option value={-1}>— none —</option>
                    {trajectories.map((t, ti) => <option key={ti} value={ti}>{t.name || `path ${ti + 1}`}</option>)}
                  </select>
                </div>
                {v.trajectoryId >= 0 && (
                  <div className="row">
                    <label>Speed</label>
                    <input className="slider" type="range" min="0.1" max="10" step="0.1" value={v.trajectorySpeed || 0.5} onChange={e => setVoiceProp(i, 'trajectorySpeed', +e.target.value)} />
                    <span className="value">{(v.trajectorySpeed || 0.5).toFixed(1)} m/s</span>
                  </div>
                )}
                {v.trajectoryId < 0 && (
                  <div className="row">
                    <label>Orbit</label>
                    <input className="slider" type="range" min="0" max="2" step="0.01" value={v.orbit || 0} onChange={e => setVoiceProp(i, 'orbit', +e.target.value)} />
                    <span className="value">{(v.orbit || 0).toFixed(2)} Hz</span>
                  </div>
                )}
              </div>
            )
          })}
          {trajectories.length > 0 && (
            <div className="panel diffusion-voice-panel">
              <h4>Paths</h4>
              {trajectories.map((t, ti) => (
                <div key={ti} className="row">
                  <label>{t.name || `path ${ti + 1}`}</label>
                  <span className="value">{t.points.length} pts</span>
                  <button className="pool-btn pool-btn-del" onClick={() => deleteTrajectory(ti)} title="delete">×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
