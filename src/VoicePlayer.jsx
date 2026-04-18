import { useStore } from './state'
import { Disk } from './Disk'
import { Waveform } from './Waveform'

export function VoicePlayer({ voice, focused, onFocus }) {
  const { pool } = useStore()
  const {
    voiceNumber, buffer, loadedPoolId, playing, position,
    view, setView, play, stop, onScrub, toggleReverse, reversed, loadFromPool,
    loopStart, setLoopStart, loopEnd, setLoopEnd,
  } = voice

  const onDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const poolId = e.dataTransfer.getData('poolId')
    if (poolId) loadFromPool(poolId)
    onFocus()
  }
  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }

  return (
    <div
      className={'voice-player' + (focused ? ' focused' : '')}
      data-tutorial="voice-player"
      onPointerDown={onFocus}
      onDrop={onDrop}
      onDragOver={onDragOver}
    >
      <div className="voice-header">
        <span className="voice-num">V{voiceNumber}</span>
        <select
          value={loadedPoolId}
          onChange={e => e.target.value && loadFromPool(e.target.value)}
          onPointerDown={e => e.stopPropagation()}
        >
          <option value="">— load —</option>
          {pool.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span style={{ color: 'var(--dim)', fontSize: 10, marginLeft: 'auto' }}>
          {buffer ? `${(position * buffer.duration).toFixed(2)}s / ${buffer.duration.toFixed(2)}s` : 'drop here'}
        </span>
      </div>
      {!buffer ? (
        <div className="empty" style={{ padding: 24, height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          drop pool item or pick above
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <div onPointerDown={e => e.stopPropagation()}>
            {view === 'disk'
              ? <Disk buffer={buffer} position={position} playing={playing} onScrub={onScrub} size={220}
                  loopStart={loopStart} loopEnd={loopEnd} setLoopStart={setLoopStart} setLoopEnd={setLoopEnd} />
              : <Waveform buffer={buffer} position={position} playing={playing} onScrub={onScrub} width={440} height={140}
                  loopStart={loopStart} loopEnd={loopEnd} setLoopStart={setLoopStart} setLoopEnd={setLoopEnd} />}
          </div>
          <div className="toolbar" onPointerDown={e => e.stopPropagation()}>
            {!playing ? <button onClick={play}>▶</button> : <button className="active" onClick={stop}>■</button>}
            <button className={reversed ? 'active' : ''} onClick={toggleReverse}>⟲</button>
            <button onClick={() => setView(v => v === 'disk' ? 'wave' : 'disk')}>{view === 'disk' ? '≡' : '◎'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
