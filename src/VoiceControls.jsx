export function VoiceControls({ voice }) {
  if (!voice) return null
  const {
    voiceNumber, buffer,
    tempo, setTempo, pitch, setPitch,
    filterHz, setFilterHz,
    delayTime, setDelayTime, delayFb, setDelayFb, wet, setWet,
    voiceGain, setVoiceGain,
    loopStart, setLoopStart, loopEnd, setLoopEnd,
  } = voice

  return (
    <div className="voice-controls">
      <div className="voice-controls-header">
        editing <b>Voice {voiceNumber}</b>
      </div>
      <div className="controls-grid">
        <div className="panel">
          <h4>Tape</h4>
          <div className="row"><label>Speed</label><input className="slider" type="range" min="0.25" max="4" step="0.01" value={tempo} onChange={e => setTempo(+e.target.value)} /><span className="value">{tempo.toFixed(2)}×</span></div>
          <div className="row"><label>Pitch</label><input className="slider" type="range" min="-24" max="24" step="1" value={pitch} onChange={e => setPitch(+e.target.value)} /><span className="value">{pitch > 0 ? '+' : ''}{pitch} st</span></div>
          <div className="row"><label>Gain</label><input className="slider" type="range" min="0" max="1.5" step="0.01" value={voiceGain} onChange={e => setVoiceGain(+e.target.value)} /><span className="value">{(voiceGain * 100).toFixed(0)}%</span></div>
        </div>
        <div className="panel">
          <h4>Filter</h4>
          <div className="row"><label>Cutoff</label><input className="slider" type="range" min="100" max="18000" step="10" value={filterHz} onChange={e => setFilterHz(+e.target.value)} /><span className="value">{(filterHz / 1000).toFixed(1)}k</span></div>
        </div>
        <div className="panel">
          <h4>Tape delay</h4>
          <div className="row"><label>Time</label><input className="slider" type="range" min="0" max="1.5" step="0.01" value={delayTime} onChange={e => setDelayTime(+e.target.value)} /><span className="value">{(delayTime * 1000).toFixed(0)}ms</span></div>
          <div className="row"><label>Feedback</label><input className="slider" type="range" min="0" max="0.95" step="0.01" value={delayFb} onChange={e => setDelayFb(+e.target.value)} /><span className="value">{(delayFb * 100).toFixed(0)}%</span></div>
          <div className="row"><label>Wet</label><input className="slider" type="range" min="0" max="1" step="0.01" value={wet} onChange={e => setWet(+e.target.value)} /><span className="value">{(wet * 100).toFixed(0)}%</span></div>
        </div>
        <div className="panel">
          <h4>Loop</h4>
          <div className="row"><label>Start</label><input className="slider" type="range" min="0" max="1" step="0.001" value={loopStart} onChange={e => setLoopStart(Math.min(+e.target.value, loopEnd - 0.01))} /><span className="value">{buffer ? (loopStart * buffer.duration).toFixed(2) : '0.00'}s</span></div>
          <div className="row"><label>End</label><input className="slider" type="range" min="0" max="1" step="0.001" value={loopEnd} onChange={e => setLoopEnd(Math.max(+e.target.value, loopStart + 0.01))} /><span className="value">{buffer ? (loopEnd * buffer.duration).toFixed(2) : '0.00'}s</span></div>
        </div>
      </div>
    </div>
  )
}
