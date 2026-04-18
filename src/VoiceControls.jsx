import React, { useRef, useState, useEffect } from 'react'
import { DEFAULT_MOD } from './modulation'
import { useStore } from './state'
import { themeColor } from './audio'

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

const EFFECT_LABELS = {
  saturation: 'Saturation', wow: 'Wow/Flutter', filter: 'Filter', ringmod: 'Ring Mod', tremolo: 'Tremolo',
  flanger: 'Flanger', delay: 'Tape Delay', reverb: 'Reverb', granulator: 'Granulator', freeze: 'Freeze',
  doppler: 'Doppler', banddoppler: 'Band Doppler', bandreverb: 'Band Reverb',
  autopan: 'Auto Pan',
}

function ChainOrder({ voice }) {
  const dragIdx = useRef(null)
  const order = voice.effectOrder || []
  const onDragStart = (e, i) => { dragIdx.current = i; e.dataTransfer.effectAllowed = 'move' }
  const onDragOver = (e) => e.preventDefault()
  const onDrop = (e, i) => {
    e.preventDefault()
    const from = dragIdx.current
    if (from === null || from === i) return
    const newOrder = [...order]
    const [item] = newOrder.splice(from, 1)
    newOrder.splice(i, 0, item)
    voice.setEffectOrder(newOrder)
    dragIdx.current = null
  }
  return (
    <div className="chain-order">
      <span className="chain-label">chain</span>
      {order.map((name, i) => (
        <React.Fragment key={name}>
          {i > 0 && <span className="chain-arrow">→</span>}
          <div
            className="chain-item"
            draggable
            onDragStart={(e) => onDragStart(e, i)}
            onDragOver={onDragOver}
            onDrop={(e) => onDrop(e, i)}
            title={`${name} — drag to reorder`}
          >{EFFECT_LABELS[name] || name}</div>
        </React.Fragment>
      ))}
    </div>
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
  const fmtPitch = (x) => `${x > 0 ? '+' : ''}${x}`
  const fmtMs = (x) => `${Math.round(x * 1000)}`

  return (
    <div className="voice-controls">
      <ChainOrder voice={v} />
      <div className="voice-controls-header">
        <span>editing <b>Voice {v.voiceNumber}</b></span>
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
            <ModRow voice={v} pKey="pitch" label="Pitch" min={-24} max={24} step={1} value={v.pitch} onChange={v.setPitch} format={fmtPitch} unit="st" />
            <ModRow voice={v} pKey="voiceGain" label="Gain" min={0} max={1.5} step={0.01} value={v.voiceGain} onChange={v.setVoiceGain} format={fmtPct} />
          </div>
          <div className="panel">
            <PanelTitle active={v.satActive} onToggle={() => v.setSatActive(!v.satActive)}>Saturation</PanelTitle>
            <Row label="Drive" value={fmtPct(v.saturation)}><Slider min={0} max={1} step={0.01} value={v.saturation} onChange={v.setSaturation} /></Row>
          </div>
          <div className="panel">
            <PanelTitle active={v.wowActive} onToggle={() => v.setWowActive(!v.wowActive)}>Wow / Flutter</PanelTitle>
            <ModRow voice={v} pKey="wowRate" label="Rate" min={0} max={10} step={0.05} value={v.wowRate} onChange={v.setWowRate} format={fmtNum2} unit="Hz" />
            <ModRow voice={v} pKey="wowDepth" label="Depth" min={0} max={1} step={0.01} value={v.wowDepth} onChange={v.setWowDepth} format={fmtPct} />
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
          </div>
        </>}

        {sub === 'mod' && <>
          <div className="panel">
            <PanelTitle active={v.ringActive} onToggle={() => v.setRingActive(!v.ringActive)}>Ring modulator</PanelTitle>
            <ModRow voice={v} pKey="ringFreq" label="Freq" min={1} max={2000} step={1} value={v.ringFreq} onChange={v.setRingFreq} format={fmtHz} />
            <ModRow voice={v} pKey="ringAmount" label="Amount" min={0} max={1} step={0.01} value={v.ringAmount} onChange={v.setRingAmount} format={fmtPct} />
          </div>
          <div className="panel">
            <PanelTitle active={v.flangerActive} onToggle={() => v.setFlangerActive(!v.flangerActive)}>Flanger</PanelTitle>
            <ModRow voice={v} pKey="flangerRate" label="Rate" min={0.01} max={5} step={0.01} value={v.flangerRate} onChange={v.setFlangerRate} format={fmtNum2} unit="Hz" />
            <ModRow voice={v} pKey="flangerDepth" label="Depth" min={0} max={1} step={0.01} value={v.flangerDepth} onChange={v.setFlangerDepth} format={fmtPct} />
            <ModRow voice={v} pKey="flangerFb" label="Feedback" min={0} max={0.95} step={0.01} value={v.flangerFb} onChange={v.setFlangerFb} format={fmtPct} />
            <ModRow voice={v} pKey="flangerMix" label="Mix" min={0} max={1} step={0.01} value={v.flangerMix} onChange={v.setFlangerMix} format={fmtPct} />
          </div>
          <div className="panel">
            <PanelTitle active={v.tremActive} onToggle={() => v.setTremActive(!v.tremActive)}>Tremolo</PanelTitle>
            <ModRow voice={v} pKey="tremRate" label="Rate" min={0.1} max={20} step={0.1} value={v.tremRate} onChange={v.setTremRate} format={fmtNum1} unit="Hz" />
            <ModRow voice={v} pKey="tremDepth" label="Depth" min={0} max={1} step={0.01} value={v.tremDepth} onChange={v.setTremDepth} format={fmtPct} />
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
          </div>
        </>}

        {sub === 'space' && <>
          <div className="panel">
            <PanelTitle active={v.delayActive} onToggle={() => v.setDelayActive(!v.delayActive)}>Tape delay</PanelTitle>
            <ModRow voice={v} pKey="delayTime" label="Time" min={0} max={1.5} step={0.01} value={v.delayTime} onChange={v.setDelayTime} format={fmtMs} unit="ms" />
            <ModRow voice={v} pKey="delayFb" label="Feedback" min={0} max={0.95} step={0.01} value={v.delayFb} onChange={v.setDelayFb} format={fmtPct} />
            <ModRow voice={v} pKey="wet" label="Wet" min={0} max={1} step={0.01} value={v.wet} onChange={v.setWet} format={fmtPct} />
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
            <ModRow voice={v} pKey="granPos" label="Position" min={0} max={1} step={0.001} value={v.granPos} onChange={v.setGranPos} format={fmtPct} />
            <Row label="Drift" value={v.granDrift.toFixed(2)}><Slider min={-1} max={1} step={0.01} value={v.granDrift} onChange={v.setGranDrift} /></Row>
            <Row label="Spray" value={fmtPct(v.granSpray)}><Slider min={0} max={0.5} step={0.001} value={v.granSpray} onChange={v.setGranSpray} /></Row>
            <Row label="Size" value={`${Math.round(v.granSize * 1000)}`} unit="ms"><Slider min={0.005} max={0.5} step={0.001} value={v.granSize} onChange={v.setGranSize} /></Row>
            <ModRow voice={v} pKey="granDensity" label="Density" min={1} max={100} step={1} value={v.granDensity} onChange={v.setGranDensity} format={(x) => `${Math.round(x)}`} unit="/s" />
          </div>
          <div className="panel">
            <h4>Grain Pitch</h4>
            <ModRow voice={v} pKey="granPitch" label="Pitch" min={-24} max={24} step={1} value={v.granPitch} onChange={v.setGranPitch} format={fmtPitch} unit="st" />
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
            <Row label="Pitch" value={(v.freezePitch > 0 ? '+' : '') + v.freezePitch} unit="st">
              <Slider min={-24} max={24} step={1} value={v.freezePitch} onChange={v.setFreezePitch} />
            </Row>
            <Row label="Voices" value={v.freezeVoices}>
              <Slider min={1} max={16} step={1} value={v.freezeVoices} onChange={v.setFreezeVoices} />
            </Row>
            <Row label="Phase" value={fmtPct(v.freezePhase)}>
              <Slider min={0} max={1} step={0.01} value={v.freezePhase} onChange={v.setFreezePhase} />
            </Row>
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
            <div className="hint">splits signal into N bands · each band has its own reverb tail</div>
          </div>
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
