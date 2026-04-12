import { useStore } from './state'

const curveToPower = (c) => {
  if (typeof c === 'number' && c > 0) return c
  if (c === 'exp') return 2.5
  if (c === 'log') return 0.4
  if (c === 'scurve') return 1.6
  return 1
}

export function ClipInspector({ clip, onChange }) {
  const { pool } = useStore()
  if (!clip) {
    return (
      <div className="clip-inspector empty-inspector">
        <span>click a clip to edit fades &amp; gain</span>
      </div>
    )
  }
  const item = pool.find(p => p.id === clip.poolId)
  const len = Math.max(0.001, clip.sourceEnd - clip.sourceStart)
  const maxFade = len / 2

  return (
    <div className="clip-inspector">
      <div className="clip-inspector-header">
        <span>clip · <b>{item?.name || '?'}</b></span>
        <span style={{ color: 'var(--dim)', fontSize: 10 }}>
          {clip.sourceStart.toFixed(2)}s → {clip.sourceEnd.toFixed(2)}s ({len.toFixed(2)}s)
        </span>
      </div>
      <div className="clip-inspector-grid">
        <div className="panel">
          <h4>Length</h4>
          <div className="row">
            <label>Source end</label>
            <input
              className="slider"
              type="range"
              min={clip.sourceStart + 0.01}
              max={(item?.duration || clip.sourceEnd + 10)}
              step="0.001"
              value={clip.sourceEnd}
              onChange={e => onChange({ sourceEnd: +e.target.value })}
            />
            <span className="value">{len.toFixed(2)}s</span>
          </div>
          <div className="row">
            <label>Source start</label>
            <input
              className="slider"
              type="range"
              min="0"
              max={Math.max(0, clip.sourceEnd - 0.01)}
              step="0.001"
              value={clip.sourceStart}
              onChange={e => onChange({ sourceStart: +e.target.value })}
            />
            <span className="value">{clip.sourceStart.toFixed(2)}s</span>
          </div>
          <div className="row">
            <label>Gain</label>
            <input
              className="slider"
              type="range"
              min="0"
              max="1.5"
              step="0.01"
              value={clip.gain ?? 1}
              onChange={e => onChange({ gain: +e.target.value })}
            />
            <span className="value">{Math.round((clip.gain ?? 1) * 100)}%</span>
          </div>
        </div>
        <div className="panel">
          <h4>Fade in</h4>
          <div className="row">
            <label>Time</label>
            <input
              className="slider"
              type="range"
              min="0"
              max={maxFade}
              step="0.001"
              value={clip.fadeIn || 0}
              onChange={e => onChange({ fadeIn: +e.target.value })}
            />
            <span className="value">{((clip.fadeIn || 0) * 1000).toFixed(0)}ms</span>
          </div>
          <div className="row">
            <label>Curve</label>
            <input
              className="slider"
              type="range"
              min="0.2"
              max="5"
              step="0.05"
              value={curveToPower(clip.fadeInCurve)}
              onChange={e => onChange({ fadeInCurve: +e.target.value })}
            />
            <span className="value">{curveToPower(clip.fadeInCurve).toFixed(2)}</span>
          </div>
        </div>
        <div className="panel">
          <h4>Fade out</h4>
          <div className="row">
            <label>Time</label>
            <input
              className="slider"
              type="range"
              min="0"
              max={maxFade}
              step="0.001"
              value={clip.fadeOut || 0}
              onChange={e => onChange({ fadeOut: +e.target.value })}
            />
            <span className="value">{((clip.fadeOut || 0) * 1000).toFixed(0)}ms</span>
          </div>
          <div className="row">
            <label>Curve</label>
            <input
              className="slider"
              type="range"
              min="0.2"
              max="5"
              step="0.05"
              value={curveToPower(clip.fadeOutCurve)}
              onChange={e => onChange({ fadeOutCurve: +e.target.value })}
            />
            <span className="value">{curveToPower(clip.fadeOutCurve).toFixed(2)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
