import { useState } from 'react'

function Row({ label, value, unit, children }) {
  return (
    <div className="row">
      <label>{label}</label>
      {children}
      <span className="value">{value}{unit ? ` ${unit}` : ''}</span>
    </div>
  )
}
const Slider = ({ min, max, step, value, onChange }) => (
  <input className="slider" type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)} />
)

export function VoiceControls({ voice }) {
  const [sub, setSub] = useState('tape')
  if (!voice) return null
  const v = voice
  const fmtPct = (x) => `${Math.round(x * 100)}%`
  const fmtHz = (hz) => hz >= 1000 ? `${(hz / 1000).toFixed(2)}k` : `${Math.round(hz)}`

  return (
    <div className="voice-controls">
      <div className="voice-controls-header">
        <span>editing <b>Voice {v.voiceNumber}</b></span>
        <div className="sub-tabs">
          <button className={sub === 'tape' ? 'active' : ''} onClick={() => setSub('tape')}>Tape</button>
          <button className={sub === 'filter' ? 'active' : ''} onClick={() => setSub('filter')}>Filter</button>
          <button className={sub === 'mod' ? 'active' : ''} onClick={() => setSub('mod')}>Mod</button>
          <button className={sub === 'space' ? 'active' : ''} onClick={() => setSub('space')}>Space</button>
          <button className={sub === 'loop' ? 'active' : ''} onClick={() => setSub('loop')}>Loop</button>
        </div>
      </div>

      <div className="controls-grid">
        {sub === 'tape' && <>
          <div className="panel">
            <h4>Transport</h4>
            <Row label="Speed" value={v.tempo.toFixed(2)} unit="×"><Slider min={0.25} max={4} step={0.01} value={v.tempo} onChange={v.setTempo} /></Row>
            <Row label="Pitch" value={(v.pitch > 0 ? '+' : '') + v.pitch} unit="st"><Slider min={-24} max={24} step={1} value={v.pitch} onChange={v.setPitch} /></Row>
            <Row label="Gain" value={fmtPct(v.voiceGain)}><Slider min={0} max={1.5} step={0.01} value={v.voiceGain} onChange={v.setVoiceGain} /></Row>
          </div>
          <div className="panel">
            <h4>Saturation</h4>
            <Row label="Drive" value={fmtPct(v.saturation)}><Slider min={0} max={1} step={0.01} value={v.saturation} onChange={v.setSaturation} /></Row>
          </div>
          <div className="panel">
            <h4>Wow / Flutter</h4>
            <Row label="Rate" value={v.wowRate.toFixed(2)} unit="Hz"><Slider min={0} max={10} step={0.05} value={v.wowRate} onChange={v.setWowRate} /></Row>
            <Row label="Depth" value={fmtPct(v.wowDepth)}><Slider min={0} max={1} step={0.01} value={v.wowDepth} onChange={v.setWowDepth} /></Row>
          </div>
        </>}

        {sub === 'filter' && <>
          <div className="panel">
            <h4>Multimode filter</h4>
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
            <Row label="Cutoff" value={fmtHz(v.filterHz)}><Slider min={40} max={18000} step={10} value={v.filterHz} onChange={v.setFilterHz} /></Row>
            <Row label="Resonance" value={v.filterQ.toFixed(1)}><Slider min={0.1} max={20} step={0.1} value={v.filterQ} onChange={v.setFilterQ} /></Row>
          </div>
        </>}

        {sub === 'mod' && <>
          <div className="panel">
            <h4>Ring modulator</h4>
            <Row label="Freq" value={fmtHz(v.ringFreq)}><Slider min={1} max={2000} step={1} value={v.ringFreq} onChange={v.setRingFreq} /></Row>
            <Row label="Amount" value={fmtPct(v.ringAmount)}><Slider min={0} max={1} step={0.01} value={v.ringAmount} onChange={v.setRingAmount} /></Row>
          </div>
          <div className="panel">
            <h4>Flanger</h4>
            <Row label="Rate" value={v.flangerRate.toFixed(2)} unit="Hz"><Slider min={0.01} max={5} step={0.01} value={v.flangerRate} onChange={v.setFlangerRate} /></Row>
            <Row label="Depth" value={fmtPct(v.flangerDepth)}><Slider min={0} max={1} step={0.01} value={v.flangerDepth} onChange={v.setFlangerDepth} /></Row>
            <Row label="Feedback" value={fmtPct(v.flangerFb)}><Slider min={0} max={0.95} step={0.01} value={v.flangerFb} onChange={v.setFlangerFb} /></Row>
            <Row label="Mix" value={fmtPct(v.flangerMix)}><Slider min={0} max={1} step={0.01} value={v.flangerMix} onChange={v.setFlangerMix} /></Row>
          </div>
          <div className="panel">
            <h4>Tremolo</h4>
            <Row label="Rate" value={v.tremRate.toFixed(1)} unit="Hz"><Slider min={0.1} max={20} step={0.1} value={v.tremRate} onChange={v.setTremRate} /></Row>
            <Row label="Depth" value={fmtPct(v.tremDepth)}><Slider min={0} max={1} step={0.01} value={v.tremDepth} onChange={v.setTremDepth} /></Row>
          </div>
        </>}

        {sub === 'space' && <>
          <div className="panel">
            <h4>Tape delay</h4>
            <Row label="Time" value={`${Math.round(v.delayTime * 1000)}`} unit="ms"><Slider min={0} max={1.5} step={0.01} value={v.delayTime} onChange={v.setDelayTime} /></Row>
            <Row label="Feedback" value={fmtPct(v.delayFb)}><Slider min={0} max={0.95} step={0.01} value={v.delayFb} onChange={v.setDelayFb} /></Row>
            <Row label="Wet" value={fmtPct(v.wet)}><Slider min={0} max={1} step={0.01} value={v.wet} onChange={v.setWet} /></Row>
          </div>
          <div className="panel">
            <h4>Spring reverb</h4>
            <Row label="Size" value={v.reverbSize.toFixed(1)} unit="s"><Slider min={0.2} max={4} step={0.1} value={v.reverbSize} onChange={v.setReverbSize} /></Row>
            <Row label="Wet" value={fmtPct(v.reverbWet)}><Slider min={0} max={1} step={0.01} value={v.reverbWet} onChange={v.setReverbWet} /></Row>
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
