import { useRef, useState, useMemo } from 'react'
import { useStore } from './state'
import { decodeFile } from './audio'

const KINDS = [
  { id: 'imported', label: 'Imported' },
  { id: 'capture', label: 'Sound' },
  { id: 'object', label: 'Object' },
  { id: 'timeline', label: 'Timeline' },
]

export function Pool({ selectedId, onSelect }) {
  const { pool, addPoolItem, removePoolItem, getAudioCtx, saveSession, loadSession } = useStore()
  const fileRef = useRef(null)
  const sessionRef = useRef(null)
  const [activeKind, setActiveKind] = useState('imported')

  const counts = useMemo(() => {
    const c = { imported: 0, capture: 0, object: 0, timeline: 0 }
    for (const item of pool) {
      if (c[item.kind] !== undefined) c[item.kind]++
      else c.imported++ // fall back for legacy 'sound' kind
    }
    return c
  }, [pool])

  const visible = useMemo(
    () => pool.filter(it => (it.kind === activeKind) || (activeKind === 'imported' && (it.kind === 'sound' || !KINDS.find(k => k.id === it.kind)))),
    [pool, activeKind]
  )

  const onFiles = async (e) => {
    const files = Array.from(e.target.files || [])
    const ctx = getAudioCtx()
    for (const f of files) {
      try {
        const buf = await decodeFile(f, ctx)
        addPoolItem(f.name.replace(/\.[^.]+$/, ''), buf, 'imported')
      } catch (err) { console.error('decode fail', f.name, err) }
    }
    e.target.value = ''
  }

  const onMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const ctx = getAudioCtx()
      const rec = new MediaRecorder(stream)
      const chunks = []
      rec.ondataavailable = (e) => chunks.push(e.data)
      rec.onstop = async () => {
        const blob = new Blob(chunks)
        const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
        addPoolItem(`mic_${pool.length + 1}`, buf, 'imported')
        stream.getTracks().forEach(t => t.stop())
      }
      rec.start()
      const btn = document.createElement('button')
      const stop = () => { rec.stop(); document.body.removeChild(overlay) }
      const overlay = document.createElement('div')
      overlay.style.cssText = 'position:fixed;inset:0;background:#000a;display:flex;align-items:center;justify-content:center;z-index:9999;flex-direction:column;gap:12px;color:#fff;font-family:monospace'
      overlay.innerHTML = '<div style="color:#f33;font-size:24px">● RECORDING</div>'
      btn.textContent = 'STOP'
      btn.style.cssText = 'padding:10px 20px;background:transparent;color:#00ff9c;border:1px solid #00ff9c;cursor:pointer;font-family:monospace'
      btn.onclick = stop
      overlay.appendChild(btn)
      document.body.appendChild(overlay)
    } catch (err) { alert('mic error: ' + err.message) }
  }

  const onLoadSession = async (e) => {
    const f = e.target.files?.[0]
    if (f) await loadSession(f)
    e.target.value = ''
  }

  const onDragStart = (e, item) => {
    e.dataTransfer.setData('poolId', item.id)
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div className="pool">
      <h3>Pool</h3>
      <div className="pool-tabs">
        {KINDS.map(k => (
          <button
            key={k.id}
            className={activeKind === k.id ? 'active' : ''}
            onClick={() => setActiveKind(k.id)}
          >
            {k.label}
            <span className="badge">{counts[k.id]}</span>
          </button>
        ))}
      </div>
      <div className="list">
        {visible.length === 0 && (
          <div className="empty">
            {activeKind === 'imported' && <>empty<br />load audio below</>}
            {activeKind === 'capture' && <>no captures<br />record from sound tab</>}
            {activeKind === 'object' && <>no objects<br />render from object tab</>}
            {activeKind === 'timeline' && <>no mixes<br />render from timeline tab</>}
          </div>
        )}
        {visible.map(item => (
          <div
            key={item.id}
            className={'pool-item' + (selectedId === item.id ? ' selected' : '')}
            draggable
            onDragStart={(e) => onDragStart(e, item)}
            onClick={() => onSelect && onSelect(item.id)}
            onDoubleClick={() => removePoolItem(item.id)}
            title="click to select • double-click to delete • drag to tracks"
          >
            <div className="name">{item.name}</div>
            <div className="meta">
              <span className={'kind-' + item.kind}>{item.kind}</span>
              <span>{item.duration.toFixed(2)}s</span>
            </div>
          </div>
        ))}
      </div>
      <div className="pool-actions">
        <button onClick={() => fileRef.current.click()}>Load audio</button>
        <button onClick={onMic}>Record mic</button>
        <input ref={fileRef} type="file" accept="audio/*" multiple onChange={onFiles} />
        <div style={{ borderTop: '1px solid var(--border)', margin: '6px 0' }} />
        <button onClick={saveSession}>Save session</button>
        <button onClick={() => sessionRef.current.click()}>Load session</button>
        <input ref={sessionRef} type="file" accept="application/json,.json" onChange={onLoadSession} />
      </div>
    </div>
  )
}
