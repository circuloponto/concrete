import { useState, useRef } from 'react'
import { useStore } from './state'
import { processWavesets, summarizePipeline } from './audio/wavesetProc'

// Default params per op. Used when "Add step" appends a new pipeline entry.
const OP_DEFAULTS = {
  // Clean family — rearrange / retime
  reverse: {},
  repeat: { n: 4 },
  omit: { keepEvery: 3 },
  shuffle: { windowSize: 8 },
  // Distortion family — per-group shape alteration
  invert: {},
  harmonic: {},
  waveSub: { wave: 'saw' },
  normalize: {},
  envelope: { shape: 'linear' },
  fractional: { fraction: 0.5 },
  power: { k: 2 },
  reshape: { factor: 0.5 },
  // Distortion family — neighbor-interaction
  average: { n: 4 },
  multiply: {},
}

const OP_FAMILIES = [
  {
    label: 'Clean — rearrange / retime',
    ops: ['reverse', 'repeat', 'omit', 'shuffle'],
  },
  {
    label: 'Distortion — per-group shape',
    ops: ['invert', 'harmonic', 'waveSub', 'normalize', 'envelope', 'fractional', 'power', 'reshape'],
  },
  {
    label: 'Distortion — neighbor interaction',
    ops: ['average', 'multiply'],
  },
]

const OP_LABELS = {
  reverse: 'Reverse',
  repeat: 'Repeat',
  omit: 'Omit',
  shuffle: 'Shuffle',
  invert: 'Invert',
  harmonic: 'Harmonic (sine)',
  waveSub: 'Wave substitute',
  normalize: 'Normalize',
  envelope: 'Envelope',
  fractional: 'Fractional',
  power: 'Power / waveshape',
  reshape: 'Reshape / transpose',
  average: 'Average neighbors',
  multiply: 'Multiply w/ next',
}

function StepParams({ step, onChange }) {
  const set = (patch) => onChange({ ...step, params: { ...step.params, ...patch } })
  const p = step.params || {}
  switch (step.op) {
    case 'repeat':
      return (
        <label className="wv-param">
          n<input type="range" min="2" max="16" step="1" value={p.n ?? 2}
            onChange={e => set({ n: +e.target.value })} />
          <span>{p.n ?? 2}</span>
        </label>
      )
    case 'omit':
      return (
        <label className="wv-param">
          keep every<input type="range" min="2" max="16" step="1" value={p.keepEvery ?? 2}
            onChange={e => set({ keepEvery: +e.target.value })} />
          <span>{p.keepEvery ?? 2}</span>
        </label>
      )
    case 'shuffle':
      return (
        <label className="wv-param">
          window<input type="range" min="2" max="32" step="1" value={p.windowSize ?? 8}
            onChange={e => set({ windowSize: +e.target.value })} />
          <span>{p.windowSize ?? 8}</span>
        </label>
      )
    case 'waveSub':
      return (
        <div className="wv-param-row">
          {['saw', 'square', 'triangle'].map(w => (
            <button key={w}
              className={'tiny-toggle' + ((p.wave || 'saw') === w ? ' active' : '')}
              onClick={() => set({ wave: w })}
            >{w}</button>
          ))}
        </div>
      )
    case 'envelope':
      return (
        <div className="wv-param-row">
          {['linear', 'gauss', 'expDecay'].map(s => (
            <button key={s}
              className={'tiny-toggle' + ((p.shape || 'linear') === s ? ' active' : '')}
              onClick={() => set({ shape: s })}
            >{s}</button>
          ))}
        </div>
      )
    case 'fractional':
      return (
        <label className="wv-param">
          frac<input type="range" min="0.05" max="1" step="0.01" value={p.fraction ?? 0.5}
            onChange={e => set({ fraction: +e.target.value })} />
          <span>{Math.round((p.fraction ?? 0.5) * 100)}%</span>
        </label>
      )
    case 'power':
      return (
        <label className="wv-param">
          k<input type="range" min="0.25" max="4" step="0.05" value={p.k ?? 2}
            onChange={e => set({ k: +e.target.value })} />
          <span>{(p.k ?? 2).toFixed(2)}</span>
        </label>
      )
    case 'average':
      return (
        <label className="wv-param">
          n<input type="range" min="2" max="8" step="1" value={p.n ?? 4}
            onChange={e => set({ n: +e.target.value })} />
          <span>{p.n ?? 4}</span>
        </label>
      )
    case 'reshape':
      return (
        <label className="wv-param">
          factor<input type="range" min="0.25" max="4" step="0.01" value={p.factor ?? 0.5}
            onChange={e => set({ factor: +e.target.value })} />
          <span>{(p.factor ?? 0.5).toFixed(2)}×</span>
        </label>
      )
    default:
      return null
  }
}

export function WavesetPanel() {
  const { pool, getBuffer, addPoolItem, getAudioCtx } = useStore()
  const [sourceId, setSourceId] = useState('')
  const [lpCutoff, setLpCutoff] = useState(3000)
  const [lpOn, setLpOn] = useState(true)
  const [groupSize, setGroupSize] = useState(1)
  const [steps, setSteps] = useState([])
  const [addOp, setAddOp] = useState('reverse')
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('')
  const dragIndexRef = useRef(null)

  // Any pool item with audio is a valid source. Earlier filter excluded
  // 'capture' / 'diffusion' / 'timeline' which left the dropdown empty
  // for users whose pool came from in-app recording.
  const sources = pool

  // Auto-pick first source if none chosen.
  const resolvedSourceId = sourceId || sources[0]?.id || ''
  const sourceItem = sources.find(s => s.id === resolvedSourceId)

  const addStep = () => {
    setSteps(prev => [...prev, { op: addOp, params: { ...(OP_DEFAULTS[addOp] || {}) } }])
  }
  const removeStep = (i) => setSteps(prev => prev.filter((_, idx) => idx !== i))
  const updateStep = (i, next) => setSteps(prev => prev.map((s, idx) => idx === i ? next : s))
  const onDragStart = (i) => () => { dragIndexRef.current = i }
  const onDragOver = (e) => e.preventDefault()
  const onDrop = (i) => (e) => {
    e.preventDefault()
    const from = dragIndexRef.current
    if (from == null || from === i) return
    setSteps(prev => {
      const next = prev.slice()
      const [moved] = next.splice(from, 1)
      next.splice(i, 0, moved)
      return next
    })
    dragIndexRef.current = null
  }

  const run = async () => {
    if (!sourceItem) { setStatus('pick a source first'); return }
    const srcBuffer = getBuffer(sourceItem.id)
    if (!srcBuffer) { setStatus('source buffer missing'); return }
    if (steps.length === 0) { setStatus('pipeline is empty'); return }
    setProcessing(true)
    setProgress(0)
    setStatus('processing…')
    try {
      const ctx = getAudioCtx()
      const pipeline = {
        lpCutoff: lpOn ? lpCutoff : null,
        groupSize,
        steps,
      }
      const outBuf = await processWavesets(ctx, srcBuffer, pipeline, (p) => setProgress(p))
      const summary = summarizePipeline(pipeline)
      const name = `${sourceItem.name} · ${summary}`
      addPoolItem(name, outBuf, 'sound')
      setStatus(`processed → ${name} added`)
    } catch (e) {
      console.error('[WavesetPanel] process failed', e)
      setStatus(`error: ${e.message || e}`)
    } finally {
      setProcessing(false)
      setProgress(0)
    }
  }

  return (
    <div className="waveset-panel">
      <div className="panel">
        <h4>Waveset</h4>
        <div className="wv-row">
          <label>Source</label>
          <select value={resolvedSourceId} onChange={e => setSourceId(e.target.value)}>
            {sources.length === 0 && <option value="">(no pool items)</option>}
            {sources.map(s => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.duration.toFixed(1)}s
              </option>
            ))}
          </select>
        </div>
        <div className="wv-row">
          <label>LP prefilter</label>
          <button className={'tiny-toggle' + (lpOn ? ' active' : '')} onClick={() => setLpOn(!lpOn)}>
            {lpOn ? 'ON' : 'OFF'}
          </button>
          <input
            type="range"
            min="100"
            max="12000"
            step="50"
            value={lpCutoff}
            onChange={e => setLpCutoff(+e.target.value)}
            disabled={!lpOn}
            style={{ flex: 1 }}
          />
          <span style={{ minWidth: 52, textAlign: 'right' }}>
            {lpOn ? `${lpCutoff} Hz` : '—'}
          </span>
        </div>
        <div className="wv-row">
          <label>Group size</label>
          <input
            type="range"
            min="1"
            max="16"
            step="1"
            value={groupSize}
            onChange={e => setGroupSize(+e.target.value)}
            style={{ flex: 1 }}
          />
          <span style={{ minWidth: 52, textAlign: 'right' }}>{groupSize}</span>
        </div>

        <div className="wv-pipeline">
          {steps.length === 0 && (
            <div className="wv-empty">pipeline is empty — add a step below</div>
          )}
          {steps.map((step, i) => (
            <div
              key={i}
              className="wv-step"
              draggable
              onDragStart={onDragStart(i)}
              onDragOver={onDragOver}
              onDrop={onDrop(i)}
            >
              <span className="wv-step-idx">{i + 1}.</span>
              <span className="wv-step-op">{OP_LABELS[step.op] || step.op}</span>
              <div className="wv-step-params">
                <StepParams step={step} onChange={(next) => updateStep(i, next)} />
              </div>
              <button className="wv-step-remove" onClick={() => removeStep(i)} title="remove step">×</button>
            </div>
          ))}
        </div>

        <div className="wv-row">
          <label>Add step</label>
          <select value={addOp} onChange={e => setAddOp(e.target.value)}>
            {OP_FAMILIES.map(fam => (
              <optgroup key={fam.label} label={fam.label}>
                {fam.ops.map(op => (
                  <option key={op} value={op}>{OP_LABELS[op]}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <button onClick={addStep}>+ Add</button>
          <div style={{ flex: 1 }} />
          <button
            onClick={run}
            disabled={processing || !sourceItem || steps.length === 0}
            style={{ fontWeight: 600, padding: '6px 14px' }}
          >
            {processing ? `Processing… ${Math.round(progress * 100)}%` : '▸ Process'}
          </button>
        </div>
        {status && <div className="hint" style={{ marginTop: 4 }}>{status}</div>}
        <div className="hint">
          Wishart-style offline waveset processing. Result is added to the pool; load into a voice to play.
          Harmonic / wave-substitute assume monophonic source — inharmonic input gives artistic but unpitched results.
        </div>
      </div>
    </div>
  )
}
