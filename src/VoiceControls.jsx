import React, { useRef, useState, useEffect, useLayoutEffect, useCallback } from 'react'
import { DEFAULT_MOD, MOD_SPEC } from './modulation'
import { useStore } from './state'
import { themeColor } from './audio'
import { WavesetPanel } from './WavesetPanel'

// XY pad: waveform background, crosshair at (pos, grain), draggable
function FreezeXY({ voice }) {
  const { highlight, theme } = useStore()
  const canvasRef = useRef(null)
  const dragging = useRef(false)
  const W = 280, H = 120
  useEffect(() => {
    const c = canvasRef.current; if (!c) return
    const ctx = c.getContext('2d')
    const bg = themeColor('panel-bg', '#050505')
    const hl = highlight || '#00ff9c'
    const dim = themeColor('dim', '#555')
    let raf
    const draw = () => {
      ctx.clearRect(0, 0, W, H); ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H)
      // waveform
      if (voice.buffer) {
        const data = voice.buffer.getChannelData(0)
        const step = Math.max(1, Math.floor(data.length / W))
        ctx.strokeStyle = dim + '66'; ctx.lineWidth = 1
        for (let x = 0; x < W; x++) {
          let mn = 1, mx = -1; const s = x * step; const e = Math.min(data.length, s + step)
          for (let i = s; i < e; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v }
          ctx.beginPath(); ctx.moveTo(x + 0.5, (1 - (mx + 1) / 2) * H); ctx.lineTo(x + 0.5, (1 - (mn + 1) / 2) * H); ctx.stroke()
        }
      }
      // freeze region highlight — width represents grain duration relative to buffer
      const posX = voice.freezePos * W
      const dur = voice.buffer ? voice.buffer.duration : 1
      const grainPx = Math.max(2, (voice.freezeGrain / dur) * W)
      // Y maps 0.005 s (bottom) → full buffer duration (top)
      const maxG = dur
      const grainY = (1 - Math.max(0, Math.min(1, (voice.freezeGrain - 0.005) / Math.max(0.001, maxG - 0.005)))) * H
      // selection rectangle
      ctx.fillStyle = hl + '33'
      ctx.fillRect(posX, 0, grainPx, H)
      // borders
      ctx.strokeStyle = hl; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(posX, 0); ctx.lineTo(posX, H); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(posX + grainPx, 0); ctx.lineTo(posX + grainPx, H); ctx.stroke()
      // horizontal line for grain size
      ctx.strokeStyle = hl + '88'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(0, grainY); ctx.lineTo(W, grainY); ctx.stroke()
      // dot
      ctx.fillStyle = hl; ctx.beginPath(); ctx.arc(posX + grainPx / 2, grainY, 5, 0, Math.PI * 2); ctx.fill()
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [voice.buffer, voice.freezePos, voice.freezeGrain, highlight, theme])
  const update = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    // Y: top of pad = full buffer duration (select all), bottom = 5 ms
    const normY = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))
    const maxGrain = voice.buffer ? voice.buffer.duration : 0.5
    const grain = 0.005 + normY * (maxGrain - 0.005)
    voice.setFreezePos(x)
    voice.setFreezeGrain(grain)
  }
  return (
    <canvas ref={canvasRef} width={W} height={H}
      className="freeze-xy"
      onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); update(e) }}
      onPointerMove={(e) => { if (dragging.current) update(e) }}
      onPointerUp={() => { dragging.current = false }}
      onPointerCancel={() => { dragging.current = false }}
    />
  )
}

// 10-band graphic EQ — fixed ISO centers, draggable per-band gain dots,
// curve interpolated between the points. The actual filtering happens
// in useVoice; this is just sculpting input.
const GEQ_FREQS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
function GeqCanvas({ active, gains, onGainChange, onReset }) {
  const canvasRef = useRef(null)
  const draggingRef = useRef(null)
  const W = 320, H = 110
  const minDb = -18, maxDb = 18
  const padX = 14, padY = 8
  const xForBand = (i) => padX + i * (W - 2 * padX) / (GEQ_FREQS.length - 1)
  const yForGain = (g) => padY + (1 - (g - minDb) / (maxDb - minDb)) * (H - 2 * padY)
  const gainForY = (y) => maxDb - ((y - padY) / (H - 2 * padY)) * (maxDb - minDb)
  const draw = useCallback(() => {
    const c = canvasRef.current; if (!c) return
    const ctx = c.getContext('2d')
    const hl = getComputedStyle(c).getPropertyValue('--hl').trim() || '#00ff9c'
    const dim = 'rgba(255,255,255,0.08)'
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(0, 0, W, H)
    ctx.strokeStyle = dim; ctx.lineWidth = 1
    for (let db = minDb; db <= maxDb; db += 6) {
      const y = yForGain(db)
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.beginPath(); ctx.moveTo(0, yForGain(0)); ctx.lineTo(W, yForGain(0)); ctx.stroke()
    // smooth curve through points
    ctx.strokeStyle = active ? hl : 'rgba(255,255,255,0.3)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i < GEQ_FREQS.length; i++) {
      const x = xForBand(i)
      const y = yForGain(active ? (gains[i] ?? 0) : 0)
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    ctx.stroke()
    // dots
    for (let i = 0; i < GEQ_FREQS.length; i++) {
      const x = xForBand(i)
      const y = yForGain(active ? (gains[i] ?? 0) : 0)
      ctx.fillStyle = active ? hl : 'rgba(255,255,255,0.3)'
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill()
    }
    // freq labels
    ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.font = '8px monospace'; ctx.textAlign = 'center'
    GEQ_FREQS.forEach((f, i) => {
      const label = f >= 1000 ? `${(f / 1000) | 0}k` : `${f | 0}`
      ctx.fillText(label, xForBand(i), H - 1)
    })
  }, [active, gains])
  useEffect(() => { draw() }, [draw])
  const nearestBand = (px) => {
    let best = 0, mind = Infinity
    for (let i = 0; i < GEQ_FREQS.length; i++) {
      const d = Math.abs(xForBand(i) - px)
      if (d < mind) { mind = d; best = i }
    }
    return best
  }
  const onPointerDown = (e) => {
    if (!active) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const r = canvasRef.current.getBoundingClientRect()
    const px = (e.clientX - r.left) * W / r.width
    const py = (e.clientY - r.top) * H / r.height
    const i = nearestBand(px)
    draggingRef.current = i
    onGainChange(i, Math.max(minDb, Math.min(maxDb, gainForY(py))))
  }
  const onPointerMove = (e) => {
    if (draggingRef.current == null) return
    const r = canvasRef.current.getBoundingClientRect()
    const py = (e.clientY - r.top) * H / r.height
    onGainChange(draggingRef.current, Math.max(minDb, Math.min(maxDb, gainForY(py))))
  }
  const onPointerUp = () => { draggingRef.current = null }
  const onDoubleClick = (e) => {
    if (!active) return
    const r = canvasRef.current.getBoundingClientRect()
    const px = (e.clientX - r.left) * W / r.width
    onGainChange(nearestBand(px), 0)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        style={{ width: '100%', height: H, cursor: active ? 'ns-resize' : 'default', borderRadius: 2, opacity: active ? 1 : 0.55 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        title="drag bands · double-click to reset a band"
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--dim)' }}>
        <span>±18 dB · double-click resets band</span>
        <button className="tiny-toggle" onClick={onReset} disabled={!active} title="reset all bands">flatten</button>
      </div>
    </div>
  )
}

// 64-sample drawable LFO waveform editor. The samples array is in [-1, 1].
function WaveCanvas({ samples, onChange, onReset }) {
  const canvasRef = useRef(null)
  const draggingRef = useRef(false)
  const lastIdxRef = useRef(-1)
  const W = 320, H = 80
  const N = samples?.length || 64
  const xForIdx = (i) => (i / (N - 1)) * (W - 2) + 1
  const idxForX = (x) => Math.max(0, Math.min(N - 1, Math.round(((x - 1) / (W - 2)) * (N - 1))))
  const yForVal = (v) => H / 2 - v * (H / 2 - 4)
  const valForY = (y) => Math.max(-1, Math.min(1, (H / 2 - y) / (H / 2 - 4)))
  const draw = useCallback(() => {
    const c = canvasRef.current; if (!c) return
    const ctx = c.getContext('2d')
    const hl = getComputedStyle(c).getPropertyValue('--hl').trim() || '#00ff9c'
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(0, 0, W, H)
    // 0 line
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke()
    // wave
    ctx.strokeStyle = hl; ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i < N; i++) {
      const x = xForIdx(i), y = yForVal(samples[i] ?? 0)
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }, [samples])
  useEffect(() => { draw() }, [draw])
  const writeRange = (fromIdx, toIdx, fromVal, toVal) => {
    const lo = Math.min(fromIdx, toIdx), hi = Math.max(fromIdx, toIdx)
    const next = samples.slice()
    for (let i = lo; i <= hi; i++) {
      const t = lo === hi ? 1 : (i - fromIdx) / (toIdx - fromIdx || 1)
      next[i] = Math.max(-1, Math.min(1, fromVal + (toVal - fromVal) * t))
    }
    onChange(next)
  }
  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    draggingRef.current = true
    const r = canvasRef.current.getBoundingClientRect()
    const px = (e.clientX - r.left) * W / r.width
    const py = (e.clientY - r.top) * H / r.height
    const i = idxForX(px), v = valForY(py)
    const next = samples.slice(); next[i] = v; onChange(next)
    lastIdxRef.current = i
  }
  const onPointerMove = (e) => {
    if (!draggingRef.current) return
    const r = canvasRef.current.getBoundingClientRect()
    const px = (e.clientX - r.left) * W / r.width
    const py = (e.clientY - r.top) * H / r.height
    const i = idxForX(px), v = valForY(py)
    if (lastIdxRef.current >= 0 && lastIdxRef.current !== i) {
      // interpolate across skipped samples for smooth strokes
      writeRange(lastIdxRef.current, i, samples[lastIdxRef.current], v)
    } else {
      const next = samples.slice(); next[i] = v; onChange(next)
    }
    lastIdxRef.current = i
  }
  const onPointerUp = () => { draggingRef.current = false; lastIdxRef.current = -1 }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        style={{ width: '100%', height: H, cursor: 'crosshair', borderRadius: 2 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        title="drag to draw the LFO cycle"
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--dim)' }}>
        <span>drag to sculpt one cycle · ±1</span>
        <button className="tiny-toggle" onClick={onReset} title="reset to sine">sine</button>
      </div>
    </div>
  )
}

const EFFECT_LABELS = {
  saturation: 'Saturation', wow: 'Wow/Flutter', filter: 'Filter', geq: 'Graphic EQ', phase: 'Phase',
  ringmod: 'Ring Mod', tremolo: 'Tremolo',
  flanger: 'Flanger', delay: 'Tape Delay', reverb: 'Reverb', granulator: 'Granulator', freeze: 'Freeze',
  doppler: 'Doppler', banddoppler: 'Band Doppler', bandreverb: 'Band Reverb', stutter: 'Stutter',
  autopan: 'Auto Pan',
}

const EFFECT_ACTIVE_KEYS = {
  saturation: ['satActive', 'setSatActive'],
  wow: ['wowActive', 'setWowActive'],
  filter: ['filterActive', 'setFilterActive'],
  geq: ['geqActive', 'setGeqActive'],
  phase: ['phaseActive', 'setPhaseActive'],
  ringmod: ['ringActive', 'setRingActive'],
  tremolo: ['tremActive', 'setTremActive'],
  flanger: ['flangerActive', 'setFlangerActive'],
  delay: ['delayActive', 'setDelayActive'],
  reverb: ['reverbActive', 'setReverbActive'],
  freeze: ['freezeActive', 'setFreezeActive'],
  doppler: ['dopplerActive', 'setDopplerActive'],
  banddoppler: ['bandDopplerActive', 'setBandDopplerActive'],
  bandreverb: ['bandReverbActive', 'setBandReverbActive'],
  stutter: ['stutterActive', 'setStutterActive'],
  autopan: ['panActive', 'setPanActive'],
  granulator: ['granActive', 'setGranActive'],
}

// Default mix/depth/wet to apply when an effect is toggled on from the
// chain modal so the user immediately hears it without diving into its panel.
const EFFECT_MIX_SETTER = {
  saturation: 'setSaturation',
  wow: 'setWowDepth',
  ringmod: 'setRingAmount',
  tremolo: 'setTremDepth',
  flanger: 'setFlangerMix',
  autopan: 'setPanDepth',
  delay: 'setWet',
  reverb: 'setReverbWet',
  granulator: 'setGranGain',
  freeze: 'setFreezeMix',
  doppler: 'setDopplerMix',
  banddoppler: 'setBandDopplerMix',
  bandreverb: 'setBandReverbMix',
  stutter: 'setStutterMix',
  phase: 'setPhaseMix',
}

// Maps each chain-order effect to the sub-tab that contains its controls.
const EFFECT_SUBTAB = {
  saturation: 'tape', wow: 'tape',
  filter: 'filter', geq: 'filter',
  ringmod: 'mod', flanger: 'mod', tremolo: 'mod', autopan: 'mod', phase: 'mod',
  delay: 'space', reverb: 'space',
  granulator: 'grain',
  freeze: 'freeze',
  doppler: 'motion', banddoppler: 'motion', bandreverb: 'motion',
  stutter: 'freeze',
}

function ChainModal({ voice, onClose, onPickEffect }) {
  const order = voice.effectOrder || []
  const [dragName, setDragName] = useState(null)
  const [mounted, setMounted] = useState(false)
  const [closing, setClosing] = useState(false)
  const itemsRef = useRef({})
  const prevRectsRef = useRef({})
  const closeTimer = useRef(null)
  // After a drag, the browser still fires a click on the same element.
  // We suppress that one click so a drop doesn't navigate + close the modal.
  const suppressClickRef = useRef(false)

  useEffect(() => {
    const r = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(r)
  }, [])

  const close = () => {
    if (closing) return
    setClosing(true)
    closeTimer.current = setTimeout(onClose, 180)
  }
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useLayoutEffect(() => {
    const prev = prevRectsRef.current
    const now = {}
    order.forEach(name => {
      const el = itemsRef.current[name]
      if (el) now[name] = el.getBoundingClientRect()
    })
    order.forEach(name => {
      const p = prev[name], n = now[name]
      if (!p || !n) return
      const dy = p.top - n.top
      if (Math.abs(dy) > 0.5) {
        const el = itemsRef.current[name]
        el.style.transition = 'none'
        el.style.transform = `translateY(${dy}px)`
        requestAnimationFrame(() => {
          el.style.transition = 'transform 600ms cubic-bezier(.2,.8,.2,1)'
          el.style.transform = 'translateY(0)'
        })
      }
    })
    prevRectsRef.current = now
  }, [order.join('|')])

  const startDrag = (e, idx) => {
    if (e.button !== 0) return
    const initialOrder = voice.effectOrder
    const name = initialOrder[idx]
    // Snapshot slot rects once — they represent visual positions 0..n-1,
    // which don't change as the order array mutates (items FLIP between slots).
    const slots = initialOrder.map(n => {
      const el = itemsRef.current[n]
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom }
    })
    // Track current order locally so move handlers don't read a stale
    // voice prop closure-captured at drag-start.
    let currentOrder = [...initialOrder]
    let currentIdx = idx
    let started = false
    const onMove = (ev) => {
      if (!started) { started = true; setDragName(name); suppressClickRef.current = true }
      const y = ev.clientY
      let target = currentIdx
      if (y < slots[0].top) target = 0
      else if (y > slots[slots.length - 1].bottom) target = slots.length - 1
      else {
        for (let i = 0; i < slots.length; i++) {
          if (y >= slots[i].top && y <= slots[i].bottom) { target = i; break }
        }
      }
      if (target !== currentIdx) {
        const newOrder = [...currentOrder]
        const [it] = newOrder.splice(currentIdx, 1)
        newOrder.splice(target, 0, it)
        voice.setEffectOrder(newOrder)
        currentOrder = newOrder
        currentIdx = target
      }
    }
    const onUp = () => {
      setDragName(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const shuffleOrder = () => {
    const cur = voice.effectOrder
    if (!cur || cur.length < 2) return
    const next = [...cur]
    for (let i = next.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[next[i], next[j]] = [next[j], next[i]]
    }
    voice.setEffectOrder(next)
  }

  const cls = 'chain-modal-backdrop' + (mounted && !closing ? ' open' : '')
  return (
    <div className={cls} onClick={close}>
      <div className="chain-modal" onClick={e => e.stopPropagation()}>
        <div className="chain-modal-header">
          <h3>signal chain</h3>
          <button
            className="chain-modal-shuffle"
            onClick={shuffleOrder}
            title="shuffle effect order"
          >⤨ shuffle</button>
          <button className="chain-modal-close" onClick={close} title="close (Esc)">×</button>
        </div>
        <div className="chain-modal-hint">drag to reorder · shift-click to bypass · shuffle for a random permutation</div>
        <div className="chain-modal-list">
          {order.map((name, i) => {
            const keys = EFFECT_ACTIVE_KEYS[name]
            const active = keys ? !!voice[keys[0]] : true
            const toggleActive = () => {
              if (!keys) return
              const wasActive = !!voice[keys[0]]
              voice[keys[1]](!wasActive)
              if (!wasActive) {
                const mixSetter = EFFECT_MIX_SETTER[name]
                if (mixSetter && typeof voice[mixSetter] === 'function') {
                  voice[mixSetter](0.5)
                }
              }
            }
            const onClick = (e) => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false
                return
              }
              if (e.shiftKey && keys) {
                e.preventDefault()
                toggleActive()
                return
              }
              const subKey = EFFECT_SUBTAB[name]
              if (subKey && onPickEffect) onPickEffect(subKey)
              close()
            }
            const onPillClick = (e) => {
              e.stopPropagation()
              toggleActive()
            }
            const dragging = dragName === name
            return (
              <div
                key={name}
                ref={el => { if (el) itemsRef.current[name] = el; else delete itemsRef.current[name] }}
                className={'chain-modal-item' + (active ? '' : ' inactive') + (dragging ? ' dragging' : '')}
                onPointerDown={(e) => startDrag(e, i)}
                onClick={onClick}
                title="drag anywhere on the row to reorder · click to open · shift-click to toggle"
              >
                <span className="chain-modal-num">{i + 1}</span>
                <span
                  className="chain-modal-handle"
                  aria-hidden="true"
                  title="drag to reorder"
                >⋮⋮</span>
                <span className="chain-modal-name">{EFFECT_LABELS[name] || name}</span>
                <button
                  type="button"
                  className={'chain-modal-state' + (active ? ' on' : '')}
                  onClick={onPillClick}
                  onPointerDown={(e) => e.stopPropagation()}
                  title={active ? 'tap to bypass' : 'tap to enable'}
                >{active ? 'on' : 'off'}</button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function ChainButton({ voice, onPickEffect }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        className="chain-btn"
        onClick={() => setOpen(true)}
        title="signal chain order"
      >▤ Chain</button>
      {open && (
        <ChainModal
          voice={voice}
          onClose={() => setOpen(false)}
          onPickEffect={onPickEffect}
        />
      )}
    </>
  )
}

// Generative auto-modulation modal. Lists every parameter from MOD_SPEC,
// with per-row enabled/depth/rate/wave. Global controls at the top set
// the master on/off and the three randomization knobs (phase scramble,
// rate jitter, start-delay max). "Scramble" re-rolls the per-mod random
// values without touching depth/rate/wave.
function AutoModal({ voice, onClose }) {
  const [mounted, setMounted] = useState(false)
  const [closing, setClosing] = useState(false)
  const closeTimer = useRef(null)
  useEffect(() => {
    const r = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(r)
  }, [])
  const close = () => {
    if (closing) return
    setClosing(true)
    closeTimer.current = setTimeout(onClose, 180)
  }
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const cls = 'chain-modal-backdrop' + (mounted && !closing ? ' open' : '')
  const keys = Object.keys(MOD_SPEC)
  const enableAll = () => keys.forEach(k => voice.setAutoMod(k, { enabled: true }))
  const disableAll = () => keys.forEach(k => voice.setAutoMod(k, { enabled: false }))
  return (
    <div className={cls} onClick={close}>
      <div className="chain-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="chain-modal-header">
          <h3>auto-modulation</h3>
          <button
            className={'chain-modal-shuffle' + (voice.autoActive ? ' active' : '')}
            onClick={() => voice.setAutoActive(!voice.autoActive)}
            title="master on/off"
          >{voice.autoActive ? '◉ ON' : '○ OFF'}</button>
          <button className="chain-modal-shuffle" onClick={voice.scrambleAuto} title="re-roll random offsets">⤨ scramble</button>
          <button className="chain-modal-close" onClick={close} title="close (Esc)">×</button>
        </div>
        <div className="chain-modal-hint">
          generative LFOs per parameter · each starts at random phase, drifts on rate jitter, fires after random delay · manual M-toggles override
        </div>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          <div className="row">
            <label>Phase ±</label>
            <Slider min={0} max={1} step={0.01} value={voice.autoPhaseScramble} onChange={voice.setAutoPhaseScramble} />
            <span className="value">{Math.round(voice.autoPhaseScramble * 100)}%</span>
          </div>
          <div className="row">
            <label>Rate jit</label>
            <Slider min={0} max={1} step={0.01} value={voice.autoRateJitter} onChange={voice.setAutoRateJitter} />
            <span className="value">{Math.round(voice.autoRateJitter * 100)}%</span>
          </div>
          <div className="row">
            <label>Start ≤</label>
            <Slider min={0} max={30} step={0.5} value={voice.autoStartDelay} onChange={voice.setAutoStartDelay} />
            <span className="value">{voice.autoStartDelay.toFixed(1)}s</span>
          </div>
        </div>
        <div style={{ padding: '6px 12px', display: 'flex', gap: 8 }}>
          <button className="tiny-toggle" onClick={enableAll}>enable all</button>
          <button className="tiny-toggle" onClick={disableAll}>disable all</button>
        </div>
        <div className="chain-modal-list" style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          {keys.map(key => {
            const spec = MOD_SPEC[key]
            const m = voice.autoMods?.[key] || { enabled: false, wave: 'sine', rate: 0.4, depth: 0.5 }
            return (
              <div key={key} className="chain-modal-item" style={{ display: 'grid', gridTemplateColumns: '20px 1fr 70px 80px 80px 70px', alignItems: 'center', gap: 6 }}>
                <button
                  className={'tiny-toggle' + (m.enabled ? ' active' : '')}
                  onClick={() => voice.setAutoMod(key, { enabled: !m.enabled })}
                >{m.enabled ? '●' : '○'}</button>
                <span className="chain-modal-name">{spec.label}</span>
                <select
                  className="select-inline"
                  value={m.wave || 'sine'}
                  onChange={e => voice.setAutoMod(key, { wave: e.target.value })}
                  disabled={!m.enabled}
                >
                  <option value="sine">sine</option>
                  <option value="triangle">tri</option>
                  <option value="square">sq</option>
                  <option value="saw">saw</option>
                  <option value="ramp">ramp</option>
                  <option value="random">S&amp;H</option>
                </select>
                <span className="row" style={{ gap: 4 }}>
                  <Slider min={0.01} max={5} step={0.01} value={m.rate || 0.4} onChange={v => voice.setAutoMod(key, { rate: v })} />
                </span>
                <span className="row" style={{ gap: 4 }}>
                  <Slider min={0} max={1} step={0.01} value={m.depth || 0.5} onChange={v => voice.setAutoMod(key, { depth: v })} />
                </span>
                <span className="value" style={{ fontSize: 9 }}>
                  {(m.rate || 0.4).toFixed(2)}Hz · {Math.round((m.depth || 0) * 100)}%
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function AutoButton({ voice }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        className={'chain-btn' + (voice.autoActive ? ' active' : '')}
        onClick={() => setOpen(true)}
        title="auto-modulation (generative LFOs)"
      >⌁ Auto</button>
      {open && <AutoModal voice={voice} onClose={() => setOpen(false)} />}
    </>
  )
}

function PanelTitle({ children, active, onToggle }) {
  return (
    <h4>
      {children}
      {onToggle && (
        <button
          className={'tiny-toggle' + (active ? ' active' : '')}
          onClick={onToggle}
        >{active ? 'ON' : 'OFF'}</button>
      )}
    </h4>
  )
}

const WAVES = [
  ['sine', '∿'],
  ['triangle', '△'],
  ['square', '◻'],
  ['saw', '◺'],
  ['ramp', '◹'],
  ['random', '⁓'],
]

function Slider({ min, max, step, value, onChange }) {
  return (
    <input
      className="slider"
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={e => onChange(+e.target.value)}
    />
  )
}

function Row({ label, value, unit, children }) {
  return (
    <div className="row">
      <label>{label}</label>
      {children}
      <span className="value">{value}{unit ? ` ${unit}` : ''}</span>
    </div>
  )
}

// Per-effect output-gain slider. Scale goes up to 8× (+18 dB) so the user
// can recover signal after destructive parts of the chain. Uses a linear
// slider — a log taper would feel more natural near unity but linear keeps
// the full top end easy to reach.
function EffectGainRow({ voice, name }) {
  const value = voice.effectGains?.[name] ?? 1
  const label = value >= 1 ? `${value.toFixed(2)}×` : `${Math.round(value * 100)}%`
  return (
    <div className="row">
      <label>Output</label>
      <input
        className="slider"
        type="range"
        min={0}
        max={8}
        step={0.01}
        value={value}
        onChange={e => voice.setEffectGain(name, +e.target.value)}
      />
      <span className="value">{label}</span>
    </div>
  )
}

// Slider row with a modulation toggle — expands an inline LFO strip when active.
function ModRow({ voice, pKey, label, min, max, step, value, onChange, format, unit }) {
  const mod = voice.modulators?.[pKey]
  const active = !!mod?.enabled
  const toggle = () => {
    if (active) voice.setModulator(pKey, null)
    else voice.setModulator(pKey, { ...DEFAULT_MOD })
  }
  return (
    <>
      <div className={'row' + (active ? ' modded' : '')}>
        <label>{label}</label>
        <input className="slider" type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)} />
        <button
          className={'mod-btn' + (active ? ' active' : '')}
          onClick={toggle}
          title={active ? 'remove LFO' : 'add LFO'}
        >M</button>
        <span className="value">{format(value)}{unit ? ` ${unit}` : ''}</span>
      </div>
      {active && (
        <div className="mod-strip">
          <div className="mod-waves">
            {WAVES.map(([w, icon]) => (
              <button
                key={w}
                className={mod.wave === w ? 'active' : ''}
                onClick={() => voice.setModulator(pKey, { wave: w })}
                title={w}
              >{icon}</button>
            ))}
          </div>
          <div className="mod-knob">
            <span>rate</span>
            <input type="range" min="0.05" max="10" step="0.05" value={mod.rate} onChange={e => voice.setModulator(pKey, { rate: +e.target.value })} />
            <span className="mod-val">{mod.rate.toFixed(2)}</span>
          </div>
          <div className="mod-knob">
            <span>depth</span>
            <input type="range" min="0" max="1" step="0.01" value={mod.depth} onChange={e => voice.setModulator(pKey, { depth: +e.target.value })} />
            <span className="mod-val">{Math.round(mod.depth * 100)}%</span>
          </div>
        </div>
      )}
    </>
  )
}


export function VoiceControls({ voice }) {
  const { pool } = useStore()
  const [sub, setSub] = useState('tape')
  const rowRef = useRef(null)
  const dragRef = useRef({ active: false, startX: 0, startScroll: 0, moved: false, capturedOn: null, pointerId: null })

  const onRowPointerDown = (e) => {
    const el = rowRef.current
    if (!el) return
    if (e.target.closest('button, select, input, canvas')) return
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startScroll: el.scrollLeft,
      moved: false,
      capturedOn: e.currentTarget,
      pointerId: e.pointerId,
    }
  }
  const onRowPointerMove = (e) => {
    const d = dragRef.current
    if (!d.active) return
    const dx = e.clientX - d.startX
    if (!d.moved && Math.abs(dx) > 4) {
      d.moved = true
      try { d.capturedOn.setPointerCapture(d.pointerId) } catch {}
    }
    if (d.moved) {
      rowRef.current.scrollLeft = d.startScroll - dx
      e.preventDefault()
    }
  }
  const onRowPointerUp = () => {
    const d = dragRef.current
    if (d.moved) { try { d.capturedOn?.releasePointerCapture(d.pointerId) } catch {} }
    dragRef.current = { active: false, startX: 0, startScroll: 0, moved: false, capturedOn: null, pointerId: null }
  }
  const onRowWheel = (e) => {
    if (!rowRef.current) return
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      rowRef.current.scrollLeft += e.deltaY
      e.preventDefault()
    }
  }

  // reset scroll on sub-tab change
  const switchSub = (s) => {
    setSub(s)
    if (rowRef.current) rowRef.current.scrollLeft = 0
  }

  if (!voice) return null
  const v = voice
  const fmtPct = (x) => `${Math.round(x * 100)}%`
  const fmtHz = (hz) => hz >= 1000 ? `${(hz / 1000).toFixed(2)}k` : `${Math.round(hz)}`
  const fmtNum2 = (x) => x.toFixed(2)
  const fmtNum1 = (x) => x.toFixed(1)
  const fmtPitch = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`
  const fmtMs = (x) => `${Math.round(x * 1000)}`

  return (
    <div className="voice-controls">
      <div className="voice-controls-header">
        <span>editing <b>Voice {v.voiceNumber}</b></span>
        <ChainButton voice={v} onPickEffect={switchSub} />
        <AutoButton voice={v} />
        <button
          onClick={v.randomize}
          title="randomize all effect parameters"
          style={{ padding: '4px 8px', fontSize: 10 }}
        >🎲 Randomize</button>
        <button
          onClick={v.reset}
          title="reset all effects to defaults"
          style={{ padding: '4px 8px', fontSize: 10 }}
        >↺ Reset</button>
        <div className="sub-tabs" data-tutorial="sub-tabs">
          <button className={sub === 'tape' ? 'active' : ''} onClick={() => switchSub('tape')}>Tape</button>
          <button className={sub === 'filter' ? 'active' : ''} onClick={() => switchSub('filter')}>Filter</button>
          <button className={sub === 'mod' ? 'active' : ''} onClick={() => switchSub('mod')}>Mod</button>
          <button className={sub === 'grain' ? 'active' : ''} onClick={() => switchSub('grain')}>Grain</button>
          <button className={sub === 'freeze' ? 'active' : ''} onClick={() => switchSub('freeze')}>Freeze</button>
          <button className={sub === 'motion' ? 'active' : ''} onClick={() => switchSub('motion')}>Motion</button>
          <button className={sub === 'space' ? 'active' : ''} onClick={() => switchSub('space')}>Space</button>
          <button className={sub === 'offline' ? 'active' : ''} onClick={() => switchSub('offline')}>Offline</button>
          <button className={sub === 'loop' ? 'active' : ''} onClick={() => switchSub('loop')}>Loop</button>
        </div>
      </div>

      <div
        className="controls-grid"
        ref={rowRef}
        onPointerDown={onRowPointerDown}
        onPointerMove={onRowPointerMove}
        onPointerUp={onRowPointerUp}
        onPointerCancel={onRowPointerUp}
        onWheel={onRowWheel}
      >
        {sub === 'tape' && <>
          <div className="panel">
            <h4>Transport</h4>
            <ModRow voice={v} pKey="tempo" label="Speed" min={0.25} max={4} step={0.01} value={v.tempo} onChange={v.setTempo} format={fmtNum2} unit="×" />
            <ModRow voice={v} pKey="pitch" label="Pitch" min={-24} max={24} step={0.01} value={v.pitch} onChange={v.setPitch} format={fmtPitch} unit="st" />
            <ModRow voice={v} pKey="voiceGain" label="Gain" min={0} max={1.5} step={0.01} value={v.voiceGain} onChange={v.setVoiceGain} format={fmtPct} />
          </div>
          <div className="panel">
            <h4>Sample delay
              <button
                className={'tiny-toggle' + (v.sampleDelayActive ? ' active' : '')}
                onClick={() => v.setSampleDelayActive(!v.sampleDelayActive)}
                title="enable per-channel sample delay (Logic-style)"
              >{v.sampleDelayActive ? 'on' : 'off'}</button>
            </h4>
            <Row label="L" value={v.sampleDelayL} unit="smp">
              <Slider min={0} max={4000} step={1} value={v.sampleDelayL} onChange={v.setSampleDelayL} />
            </Row>
            <Row label="R" value={v.sampleDelayR} unit="smp">
              <Slider min={0} max={4000} step={1} value={v.sampleDelayR} onChange={v.setSampleDelayR} />
            </Row>
          </div>
          <div className="panel">
            <h4>Print</h4>
            <Row label="Length" value={v.printDurationSec} unit="s">
              <Slider min={10} max={120} step={1} value={v.printDurationSec} onChange={v.setPrintDurationSec} />
            </Row>
            {v.printedSwap ? (
              <Row label="Swapped" value={v.printedSwap.poolId.slice(-6)}>
                <button
                  className="tiny-toggle active"
                  onClick={() => v.unprint()}
                  style={{ width: '100%', padding: '4px 0' }}
                >■ UNPRINT · restore effects</button>
              </Row>
            ) : v.printing ? (
              <Row label="Recording" value={`${Math.round(v.printProgress * 100)}%`}>
                <div style={{ flex: 1, height: 8, background: 'var(--track-bg)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${v.printProgress * 100}%`, height: '100%', background: 'var(--hl)' }} />
                </div>
              </Row>
            ) : (
              <Row label="Bounce" value="">
                <button
                  onClick={() => v.printVoice(v.printDurationSec)}
                  disabled={!v.buffer}
                  style={{ width: '100%', padding: '6px 0', fontWeight: 600 }}
                >▸ PRINT {v.printDurationSec}s → pool</button>
              </Row>
            )}
            {v.lastPrintId && !v.printedSwap && !v.printing && (
              <Row label="Last print" value={v.lastPrintId.slice(-6)}>
                <button
                  className="tiny-toggle"
                  onClick={() => v.swapToPrint(v.lastPrintId)}
                  style={{ width: '100%', padding: '4px 0' }}
                >→ SWAP · play printed buffer (effects off)</button>
              </Row>
            )}
            <div className="hint">
              realtime capture · bounces voice output to a pool item · swap to replace live chain with cheap playback
            </div>
          </div>
          <div className="panel">
            <PanelTitle active={v.satActive} onToggle={() => v.setSatActive(!v.satActive)}>Saturation</PanelTitle>
            <Row label="Drive" value={fmtPct(v.saturation)}><Slider min={0} max={1} step={0.01} value={v.saturation} onChange={v.setSaturation} /></Row>
            <EffectGainRow voice={v} name="saturation" />
          </div>
          <div className="panel">
            <PanelTitle active={v.wowActive} onToggle={() => v.setWowActive(!v.wowActive)}>Wow / Flutter</PanelTitle>
            <ModRow voice={v} pKey="wowRate" label="Rate" min={0} max={10} step={0.05} value={v.wowRate} onChange={v.setWowRate} format={fmtNum2} unit="Hz" />
            <ModRow voice={v} pKey="wowDepth" label="Depth" min={0} max={1} step={0.01} value={v.wowDepth} onChange={v.setWowDepth} format={fmtPct} />
            <EffectGainRow voice={v} name="wow" />
          </div>
        </>}

        {sub === 'filter' && <>
          <div className="panel">
            <PanelTitle active={v.filterActive} onToggle={() => v.setFilterActive(!v.filterActive)}>Multimode filter</PanelTitle>
            <div className="row">
              <label>Mode</label>
              <select value={v.filterType} onChange={e => v.setFilterType(e.target.value)} className="select-inline">
                <option value="lowpass">Lowpass</option>
                <option value="highpass">Highpass</option>
                <option value="bandpass">Bandpass</option>
                <option value="notch">Notch</option>
              </select>
              <span className="value" />
            </div>
            <ModRow voice={v} pKey="filterHz" label="Cutoff" min={40} max={18000} step={10} value={v.filterHz} onChange={v.setFilterHz} format={fmtHz} />
            <ModRow voice={v} pKey="filterQ" label="Resonance" min={0.1} max={20} step={0.1} value={v.filterQ} onChange={v.setFilterQ} format={fmtNum1} />
            <EffectGainRow voice={v} name="filter" />
          </div>
          <div className="panel">
            <PanelTitle active={v.geqActive} onToggle={() => v.setGeqActive(!v.geqActive)}>10-band graphic EQ</PanelTitle>
            <GeqCanvas
              active={v.geqActive}
              gains={v.geqGains}
              onGainChange={v.setGeqGain}
              onReset={() => v.setGeqGains([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])}
            />
            <EffectGainRow voice={v} name="geq" />
          </div>
        </>}

        {sub === 'mod' && <>
          <div className="panel">
            <PanelTitle active={v.phaseActive} onToggle={() => v.setPhaseActive(!v.phaseActive)}>Phase rotator</PanelTitle>
            <ModRow voice={v} pKey="phaseAngle" label="Angle" min={0} max={180} step={1} value={v.phaseAngle} onChange={v.setPhaseAngle} format={(x) => x.toFixed(0)} unit="°" />
            <ModRow voice={v} pKey="phaseMix" label="Mix" min={0} max={1} step={0.01} value={v.phaseMix} onChange={v.setPhaseMix} format={fmtPct} />
            <div className="row">
              <label>Detail</label>
              <button
                className={'tiny-toggle' + (v.phaseDetail ? ' active' : '')}
                onClick={() => v.setPhaseDetail(!v.phaseDetail)}
                title="3-band rotation (independent LF/MF/HF angles)"
              >{v.phaseDetail ? '3-band' : 'global'}</button>
              <span className="value" />
            </div>
            {v.phaseDetail && <>
              <ModRow voice={v} pKey="phaseLowAngle" label="LF" min={0} max={180} step={1} value={v.phaseLowAngle} onChange={v.setPhaseLowAngle} format={(x) => x.toFixed(0)} unit="°" />
              <ModRow voice={v} pKey="phaseMidAngle" label="MF" min={0} max={180} step={1} value={v.phaseMidAngle} onChange={v.setPhaseMidAngle} format={(x) => x.toFixed(0)} unit="°" />
              <ModRow voice={v} pKey="phaseHighAngle" label="HF" min={0} max={180} step={1} value={v.phaseHighAngle} onChange={v.setPhaseHighAngle} format={(x) => x.toFixed(0)} unit="°" />
            </>}
            <div className="row">
              <label>Follower</label>
              <button
                className={'tiny-toggle' + (v.phaseFollowerActive ? ' active' : '')}
                onClick={() => v.setPhaseFollowerActive(!v.phaseFollowerActive)}
                title="envelope-follower scales rotation by transient peaks"
              >{v.phaseFollowerActive ? 'on' : 'off'}</button>
              <span className="value" />
            </div>
            {v.phaseFollowerActive && (
              <ModRow voice={v} pKey="phaseFollowerAmount" label="Amount" min={0} max={1} step={0.01} value={v.phaseFollowerAmount} onChange={v.setPhaseFollowerAmount} format={fmtPct} />
            )}
            <EffectGainRow voice={v} name="phase" />
          </div>
          <div className="panel">
            <PanelTitle active={v.ringActive} onToggle={() => v.setRingActive(!v.ringActive)}>Ring modulator</PanelTitle>
            <ModRow voice={v} pKey="ringFreq" label="Freq" min={1} max={2000} step={1} value={v.ringFreq} onChange={v.setRingFreq} format={fmtHz} />
            <ModRow voice={v} pKey="ringAmount" label="Amount" min={0} max={1} step={0.01} value={v.ringAmount} onChange={v.setRingAmount} format={fmtPct} />
            <EffectGainRow voice={v} name="ringmod" />
          </div>
          <div className="panel">
            <PanelTitle active={v.flangerActive} onToggle={() => v.setFlangerActive(!v.flangerActive)}>Flanger</PanelTitle>
            <ModRow voice={v} pKey="flangerRate" label="Rate" min={0.01} max={5} step={0.01} value={v.flangerRate} onChange={v.setFlangerRate} format={fmtNum2} unit="Hz" />
            <ModRow voice={v} pKey="flangerDepth" label="Depth" min={0} max={1} step={0.01} value={v.flangerDepth} onChange={v.setFlangerDepth} format={fmtPct} />
            <ModRow voice={v} pKey="flangerFb" label="Feedback" min={0} max={0.95} step={0.01} value={v.flangerFb} onChange={v.setFlangerFb} format={fmtPct} />
            <ModRow voice={v} pKey="flangerMix" label="Mix" min={0} max={1} step={0.01} value={v.flangerMix} onChange={v.setFlangerMix} format={fmtPct} />
            <EffectGainRow voice={v} name="flanger" />
          </div>
          <div className="panel">
            <PanelTitle active={v.tremActive} onToggle={() => v.setTremActive(!v.tremActive)}>Tremolo</PanelTitle>
            <div className="row">
              <label>Wave</label>
              <select className="select-inline" value={v.tremWave} onChange={e => v.setTremWave(e.target.value)}>
                <option value="sine">Sine</option>
                <option value="triangle">Triangle</option>
                <option value="square">Square</option>
                <option value="sawtooth">Saw</option>
                <option value="custom">Custom (drawn)</option>
              </select>
              <span className="value" />
            </div>
            <ModRow voice={v} pKey="tremRate" label="Rate" min={0.1} max={20} step={0.1} value={v.tremRate} onChange={v.setTremRate} format={fmtNum1} unit="Hz" />
            <ModRow voice={v} pKey="tremDepth" label="Depth" min={0} max={1} step={0.01} value={v.tremDepth} onChange={v.setTremDepth} format={fmtPct} />
            {v.tremWave === 'custom' && (
              <WaveCanvas
                samples={v.tremCustomWave}
                onChange={v.setTremCustomWave}
                onReset={() => v.setTremCustomWave(Array.from({ length: 64 }, (_, i) => Math.sin((i / 64) * Math.PI * 2)))}
              />
            )}
            <EffectGainRow voice={v} name="tremolo" />
          </div>
          <div className="panel">
            <PanelTitle active={v.panActive} onToggle={() => v.setPanActive(!v.panActive)}>Auto pan</PanelTitle>
            <div className="row">
              <label>Wave</label>
              <select className="select-inline" value={v.panWave} onChange={e => v.setPanWave(e.target.value)}>
                <option value="sine">Sine</option>
                <option value="triangle">Triangle</option>
                <option value="square">Square</option>
                <option value="sawtooth">Saw</option>
              </select>
              <span className="value" />
            </div>
            <ModRow voice={v} pKey="panRate" label="Rate" min={0.05} max={20} step={0.05} value={v.panRate} onChange={v.setPanRate} format={fmtNum2} unit="Hz" />
            <ModRow voice={v} pKey="panDepth" label="Depth" min={0} max={1} step={0.01} value={v.panDepth} onChange={v.setPanDepth} format={fmtPct} />
            <ModRow voice={v} pKey="panCenter" label="Center" min={-1} max={1} step={0.01} value={v.panCenter} onChange={v.setPanCenter} format={(x) => x.toFixed(2)} />
            <EffectGainRow voice={v} name="autopan" />
          </div>
        </>}

        {sub === 'space' && <>
          <div className="panel">
            <PanelTitle active={v.delayActive} onToggle={() => v.setDelayActive(!v.delayActive)}>Tape delay</PanelTitle>
            <ModRow voice={v} pKey="delayTime" label="Time" min={0} max={1.5} step={0.01} value={v.delayTime} onChange={v.setDelayTime} format={fmtMs} unit="ms" />
            <ModRow voice={v} pKey="delayFb" label="Feedback" min={0} max={0.95} step={0.01} value={v.delayFb} onChange={v.setDelayFb} format={fmtPct} />
            <ModRow voice={v} pKey="wet" label="Wet" min={0} max={1} step={0.01} value={v.wet} onChange={v.setWet} format={fmtPct} />
            <EffectGainRow voice={v} name="delay" />
          </div>
          <div
            className="panel"
            onDragOver={(e) => { if (e.dataTransfer.types.includes('poolId') || e.dataTransfer.types.includes('Files')) e.preventDefault() }}
            onDrop={(e) => {
              const pid = e.dataTransfer.getData('poolId')
              if (pid) { e.preventDefault(); v.setReverbIRPoolId(pid) }
            }}
          >
            <PanelTitle active={v.reverbActive} onToggle={() => v.setReverbActive(!v.reverbActive)}>Convolution reverb</PanelTitle>
            <div className="row">
              <label>IR</label>
              <select
                className="select-inline"
                value={v.reverbIRPoolId || ''}
                onChange={e => v.setReverbIRPoolId(e.target.value)}
              >
                <option value="">— synth spring —</option>
                {pool.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {v.reverbIRPoolId
                ? <button className="tiny-toggle" onClick={() => v.setReverbIRPoolId('')} title="clear IR">×</button>
                : <span className="value" />}
            </div>
            {!v.reverbIRPoolId && (
              <Row label="Size" value={fmtNum1(v.reverbSize)} unit="s"><Slider min={0.2} max={4} step={0.1} value={v.reverbSize} onChange={v.setReverbSize} /></Row>
            )}
            <ModRow voice={v} pKey="reverbWet" label="Wet" min={0} max={1} step={0.01} value={v.reverbWet} onChange={v.setReverbWet} format={fmtPct} />
            <EffectGainRow voice={v} name="reverb" />
            <div className="hint">
              {v.reverbIRPoolId
                ? `using ${pool.find(p => p.id === v.reverbIRPoolId)?.name || 'IR'} · drag a pool item here to swap`
                : 'drag a pool item here to use as impulse response'}
            </div>
          </div>
        </>}

        {sub === 'grain' && <>
          <div className="panel">
            <h4>Granulator
              <button
                className={'tiny-toggle' + (v.granActive ? ' active' : '')}
                onClick={() => v.setGranActive(!v.granActive)}
              >{v.granActive ? 'ON' : 'OFF'}</button>
            </h4>
            <Row label="Source" value={v.granMode === 'live' ? 'live chain' : 'loaded buffer'}>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  className={'tiny-toggle' + (v.granMode === 'source' ? ' active' : '')}
                  onClick={() => v.setGranMode('source')}
                >SOURCE</button>
                <button
                  className={'tiny-toggle' + (v.granMode === 'live' ? ' active' : '')}
                  onClick={() => v.setGranMode('live')}
                >LIVE</button>
              </div>
            </Row>
            <ModRow voice={v} pKey="granPos" label="Position" min={0} max={1} step={0.001} value={v.granPos} onChange={v.setGranPos} format={fmtPct} />
            <Row label="Drift" value={v.granDrift.toFixed(2)}><Slider min={-1} max={1} step={0.01} value={v.granDrift} onChange={v.setGranDrift} /></Row>
            <Row label="Spray" value={fmtPct(v.granSpray)}><Slider min={0} max={0.5} step={0.001} value={v.granSpray} onChange={v.setGranSpray} /></Row>
            <Row label="Size" value={`${Math.round(v.granSize * 1000)}`} unit="ms"><Slider min={0.005} max={0.5} step={0.001} value={v.granSize} onChange={v.setGranSize} /></Row>
            <ModRow voice={v} pKey="granDensity" label="Density" min={1} max={100} step={1} value={v.granDensity} onChange={v.setGranDensity} format={(x) => `${Math.round(x)}`} unit="/s" />
            <EffectGainRow voice={v} name="granulator" />
          </div>
          <div className="panel">
            <h4>Grain Pitch</h4>
            <ModRow voice={v} pKey="granPitch" label="Pitch" min={-24} max={24} step={0.01} value={v.granPitch} onChange={v.setGranPitch} format={fmtPitch} unit="st" />
            <Row label="Spread" value={v.granPitchSpread.toFixed(1)} unit="st"><Slider min={0} max={12} step={0.1} value={v.granPitchSpread} onChange={v.setGranPitchSpread} /></Row>
            <Row label="Gain" value={fmtPct(v.granGain)}><Slider min={0} max={1.5} step={0.01} value={v.granGain} onChange={v.setGranGain} /></Row>
          </div>
          <div className="panel">
            <h4>Cochlea (Const-Q)
              <button
                className={'tiny-toggle' + (v.granConstQ ? ' active' : '')}
                onClick={() => v.setGranConstQ(!v.granConstQ)}
              >{v.granConstQ ? 'ON' : 'OFF'}</button>
            </h4>
            <Row label="Resonance" value={v.granCQResonance.toFixed(1)}><Slider min={0.5} max={20} step={0.1} value={v.granCQResonance} onChange={v.setGranCQResonance} /></Row>
            <div className="hint">24 log-spaced bandpasses · equal-loudness weighting</div>
          </div>
        </>}

        {sub === 'freeze' && <>
          <div className="panel">
            <button
              className={'freeze-power' + (v.freezeActive ? ' on' : '')}
              onClick={() => v.setFreezeActive(!v.freezeActive)}
            >{v.freezeActive ? '■ FREEZE ON' : '▶ FREEZE OFF'}</button>
            <FreezeXY voice={v} />
            <div className="hint">drag: X = position · Y↑ = longer · Y↓ = shorter</div>
          </div>
          <div className="panel">
            <h4>Parameters</h4>
            <Row label="Source" value={v.freezeMode === 'live' ? 'live chain' : 'loaded buffer'}>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  className={'tiny-toggle' + (v.freezeMode === 'source' ? ' active' : '')}
                  onClick={() => v.setFreezeMode('source')}
                >SOURCE</button>
                <button
                  className={'tiny-toggle' + (v.freezeMode === 'live' ? ' active' : '')}
                  onClick={() => v.setFreezeMode('live')}
                >LIVE</button>
              </div>
            </Row>
            <ModRow voice={v} pKey="freezePos" label="Position" min={0} max={1} step={0.001} value={v.freezePos} onChange={v.setFreezePos}
              format={(x) => v.buffer ? `${(x * v.buffer.duration).toFixed(2)}s` : fmtPct(x)} />
            <Row
              label="Grain"
              value={v.freezeGrain >= 1 ? v.freezeGrain.toFixed(2) : Math.round(v.freezeGrain * 1000)}
              unit={v.freezeGrain >= 1 ? 's' : 'ms'}
            >
              <Slider
                min={0.005}
                max={v.buffer ? v.buffer.duration : 0.5}
                step={0.001}
                value={Math.min(v.freezeGrain, v.buffer ? v.buffer.duration : 0.5)}
                onChange={v.setFreezeGrain}
              />
            </Row>
            <ModRow voice={v} pKey="freezeMix" label="Mix" min={0} max={1} step={0.01} value={v.freezeMix} onChange={v.setFreezeMix} format={fmtPct} />
            <Row label="Gain" value={fmtPct(v.freezeGainVal)}>
              <Slider min={0} max={3} step={0.01} value={v.freezeGainVal} onChange={v.setFreezeGainVal} />
            </Row>
            <Row label="Pitch" value={fmtPitch(v.freezePitch)} unit="st">
              <Slider min={-24} max={24} step={0.01} value={v.freezePitch} onChange={v.setFreezePitch} />
            </Row>
            <Row label="Voices" value={v.freezeVoices}>
              <Slider min={1} max={16} step={1} value={v.freezeVoices} onChange={v.setFreezeVoices} />
            </Row>
            <Row label="Phase" value={fmtPct(v.freezePhase)}>
              <Slider min={0} max={1} step={0.01} value={v.freezePhase} onChange={v.setFreezePhase} />
            </Row>
            <EffectGainRow voice={v} name="freeze" />
          </div>
          <div className="panel">
            <h4>Stutter
              <button
                className={'tiny-toggle' + (v.stutterActive ? ' active' : '')}
                onClick={() => v.setStutterActive(!v.stutterActive)}
              >{v.stutterActive ? 'ON' : 'OFF'}</button>
            </h4>
            <Row label="Mode" value={v.stutterMode === 'auto' ? 'auto' : 'manual'}>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  className={'tiny-toggle' + (v.stutterMode === 'auto' ? ' active' : '')}
                  onClick={() => v.setStutterMode('auto')}
                >AUTO</button>
                <button
                  className={'tiny-toggle' + (v.stutterMode === 'manual' ? ' active' : '')}
                  onClick={() => v.setStutterMode('manual')}
                >MANUAL</button>
              </div>
            </Row>
            {v.stutterMode === 'manual' && (
              <Row label="Trigger" value="">
                <button
                  className="stutter-trigger"
                  onClick={() => v.triggerStutter()}
                  disabled={!v.stutterActive}
                  style={{ width: '100%', padding: '6px 0', fontWeight: 600 }}
                >▶ FIRE BURST</button>
              </Row>
            )}
            {v.stutterMode === 'auto' && (
              <Row label="Rate" value={v.stutterAutoRate.toFixed(2)} unit="/s">
                <Slider min={0.2} max={10} step={0.1} value={v.stutterAutoRate} onChange={v.setStutterAutoRate} />
              </Row>
            )}
            <Row label="Start cycle" value={Math.round(v.stutterStartCycle * 1000)} unit="ms">
              <Slider min={0.02} max={0.5} step={0.005} value={v.stutterStartCycle} onChange={v.setStutterStartCycle} />
            </Row>
            <Row label="End cycle" value={Math.round(v.stutterEndCycle * 1000)} unit="ms">
              <Slider min={0.02} max={0.5} step={0.005} value={v.stutterEndCycle} onChange={v.setStutterEndCycle} />
            </Row>
            <Row label="Repeats" value={v.stutterRepeats}>
              <Slider min={2} max={32} step={1} value={v.stutterRepeats} onChange={v.setStutterRepeats} />
            </Row>
            <Row label="Curve" value={v.stutterCurveShape}>
              <div style={{ display: 'flex', gap: 4 }}>
                {['linear', 'geometric', 'exponential', 'scurve'].map(s => (
                  <button
                    key={s}
                    className={'tiny-toggle' + (v.stutterCurveShape === s ? ' active' : '')}
                    onClick={() => v.setStutterCurveShape(s)}
                    style={{ textTransform: 'uppercase', fontSize: 10, padding: '2px 6px' }}
                  >{s === 'scurve' ? 'S-CURVE' : s.slice(0, 3).toUpperCase()}</button>
                ))}
              </div>
            </Row>
            <Row label="Pitch sweep" value={v.stutterPitchActive ? 'on' : 'off'}>
              <button
                className={'tiny-toggle' + (v.stutterPitchActive ? ' active' : '')}
                onClick={() => v.setStutterPitchActive(!v.stutterPitchActive)}
              >{v.stutterPitchActive ? 'ON' : 'OFF'}</button>
            </Row>
            {v.stutterPitchActive && <>
              <Row label="Start pitch" value={fmtPitch(v.stutterStartPitch)} unit="st">
                <Slider min={-24} max={24} step={0.01} value={v.stutterStartPitch} onChange={v.setStutterStartPitch} />
              </Row>
              <Row label="End pitch" value={fmtPitch(v.stutterEndPitch)} unit="st">
                <Slider min={-24} max={24} step={0.01} value={v.stutterEndPitch} onChange={v.setStutterEndPitch} />
              </Row>
            </>}
            <Row
              label="Amp shape"
              value={v.stutterAmpShape === 0 ? 'flat' : (v.stutterAmpShape > 0 ? `decay ${v.stutterAmpShape.toFixed(2)}` : `swell ${Math.abs(v.stutterAmpShape).toFixed(2)}`)}
            >
              <Slider min={-1} max={1} step={0.01} value={v.stutterAmpShape} onChange={v.setStutterAmpShape} />
            </Row>
            <Row label="Jitter" value={fmtPct(v.stutterJitter)}>
              <Slider min={0} max={1} step={0.01} value={v.stutterJitter} onChange={v.setStutterJitter} />
            </Row>
            <Row label="Shape random" value={v.stutterShapeRandom ? 'on' : 'off'}>
              <button
                className={'tiny-toggle' + (v.stutterShapeRandom ? ' active' : '')}
                onClick={() => v.setStutterShapeRandom(!v.stutterShapeRandom)}
              >{v.stutterShapeRandom ? 'ON' : 'OFF'}</button>
            </Row>
            <Row label="Mix" value={fmtPct(v.stutterMix)}>
              <Slider min={0} max={1} step={0.01} value={v.stutterMix} onChange={v.setStutterMix} />
            </Row>
            <EffectGainRow voice={v} name="stutter" />
            <div className="hint">
              {v.stutterShapeRandom
                ? 'shape-random overrides the cycle + repeats sliders per burst'
                : v.stutterStartCycle > v.stutterEndCycle + 0.003
                  ? 'accelerating — intervals shrink start → end'
                  : v.stutterStartCycle < v.stutterEndCycle - 0.003
                    ? 'decelerating — intervals grow start → end'
                    : 'flat — constant interval across the burst'}
            </div>
          </div>
        </>}

        {sub === 'motion' && <>
          <div className="panel">
            <h4>Doppler
              <button
                className={'tiny-toggle' + (v.dopplerActive ? ' active' : '')}
                onClick={() => v.setDopplerActive(!v.dopplerActive)}
              >{v.dopplerActive ? 'ON' : 'OFF'}</button>
            </h4>
            <ModRow voice={v} pKey="dopplerSpeed" label="Speed" min={0.05} max={5} step={0.01} value={v.dopplerSpeed} onChange={v.setDopplerSpeed} format={fmtNum2} unit="Hz" />
            <Row label="Range" value={v.dopplerRange.toFixed(1)} unit="m"><Slider min={1} max={50} step={0.5} value={v.dopplerRange} onChange={v.setDopplerRange} /></Row>
            <Row label="Min dist" value={v.dopplerMinDist.toFixed(1)} unit="m"><Slider min={0.2} max={10} step={0.1} value={v.dopplerMinDist} onChange={v.setDopplerMinDist} /></Row>
            <Row label="Mix" value={fmtPct(v.dopplerMix)}><Slider min={0} max={1} step={0.01} value={v.dopplerMix} onChange={v.setDopplerMix} /></Row>
            <EffectGainRow voice={v} name="doppler" />
            <div className="hint">source passes by the listener · 343 m/s air speed</div>
          </div>

          <div className="panel">
            <h4>Band Doppler
              <button
                className={'tiny-toggle' + (v.bandDopplerActive ? ' active' : '')}
                onClick={() => v.setBandDopplerActive(!v.bandDopplerActive)}
              >{v.bandDopplerActive ? 'ON' : 'OFF'}</button>
            </h4>
            <Row label="Bands" value={v.bandDopplerBands}>
              <Slider min={2} max={12} step={1} value={v.bandDopplerBands} onChange={v.setBandDopplerBands} />
            </Row>
            <Row label="Speed" value={v.bandDopplerSpeed.toFixed(2)} unit="Hz">
              <Slider min={0.05} max={3} step={0.01} value={v.bandDopplerSpeed} onChange={v.setBandDopplerSpeed} />
            </Row>
            <Row label="Spread" value={fmtPct(v.bandDopplerSpread)}>
              <Slider min={0} max={1} step={0.01} value={v.bandDopplerSpread} onChange={v.setBandDopplerSpread} />
            </Row>
            <Row label="Pan width" value={fmtPct(v.bandDopplerPanWidth)}>
              <Slider min={0} max={1} step={0.01} value={v.bandDopplerPanWidth} onChange={v.setBandDopplerPanWidth} />
            </Row>
            <Row label="Distance" value={v.bandDopplerDistance.toFixed(2)}>
              <Slider min={0.2} max={3} step={0.01} value={v.bandDopplerDistance} onChange={v.setBandDopplerDistance} />
            </Row>
            <Row label="Gain" value={v.bandDopplerGain.toFixed(2)} unit="×">
              <Slider min={0} max={4} step={0.01} value={v.bandDopplerGain} onChange={v.setBandDopplerGain} />
            </Row>
            <Row label="Mix" value={fmtPct(v.bandDopplerMix)}>
              <Slider min={0} max={1} step={0.01} value={v.bandDopplerMix} onChange={v.setBandDopplerMix} />
            </Row>
            <EffectGainRow voice={v} name="banddoppler" />
            <div className="hint">splits signal into N log-spaced bands · each does its own pass-by</div>
          </div>

          <div className="panel">
            <h4>Band Reverb
              <button
                className={'tiny-toggle' + (v.bandReverbActive ? ' active' : '')}
                onClick={() => v.setBandReverbActive(!v.bandReverbActive)}
              >{v.bandReverbActive ? 'ON' : 'OFF'}</button>
            </h4>
            <Row label="Bands" value={v.bandReverbBands}>
              <Slider min={2} max={12} step={1} value={v.bandReverbBands} onChange={v.setBandReverbBands} />
            </Row>
            <Row label="Size" value={v.bandReverbSize.toFixed(2)} unit="s">
              <Slider min={0.2} max={6} step={0.05} value={v.bandReverbSize} onChange={v.setBandReverbSize} />
            </Row>
            <Row label="Spread" value={fmtPct(v.bandReverbSpread)}>
              <Slider min={0} max={1} step={0.01} value={v.bandReverbSpread} onChange={v.setBandReverbSpread} />
            </Row>
            <Row label="Decay" value={v.bandReverbDecay.toFixed(2)}>
              <Slider min={1} max={6} step={0.05} value={v.bandReverbDecay} onChange={v.setBandReverbDecay} />
            </Row>
            <Row label="Gain" value={v.bandReverbGain.toFixed(2)} unit="×">
              <Slider min={0} max={4} step={0.01} value={v.bandReverbGain} onChange={v.setBandReverbGain} />
            </Row>
            <Row label="Mix" value={fmtPct(v.bandReverbMix)}>
              <Slider min={0} max={1} step={0.01} value={v.bandReverbMix} onChange={v.setBandReverbMix} />
            </Row>
            <EffectGainRow voice={v} name="bandreverb" />
            <div className="hint">splits signal into N bands · each band has its own reverb tail</div>
          </div>
        </>}

        {sub === 'offline' && <>
          <WavesetPanel />
        </>}

        {sub === 'loop' && <>
          <div className="panel">
            <h4>Loop region</h4>
            <Row label="Start" value={v.buffer ? (v.loopStart * v.buffer.duration).toFixed(2) : '0.00'} unit="s">
              <Slider min={0} max={1} step={0.001} value={v.loopStart} onChange={val => v.setLoopStart(Math.min(val, v.loopEnd - 0.01))} />
            </Row>
            <Row label="End" value={v.buffer ? (v.loopEnd * v.buffer.duration).toFixed(2) : '0.00'} unit="s">
              <Slider min={0} max={1} step={0.001} value={v.loopEnd} onChange={val => v.setLoopEnd(Math.max(val, v.loopStart + 0.01))} />
            </Row>
          </div>
        </>}
      </div>
    </div>
  )
}
