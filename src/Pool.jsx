import React, { useRef, useState, useMemo } from 'react'
import { useStore } from './state'
import { decodeFile, downloadWav } from './audio'

const KINDS = [
  { id: 'imported', label: 'Import' },
  { id: 'capture', label: 'Sound' },
  { id: 'object', label: 'Object' },
  { id: 'timeline', label: 'Time' },
  { id: 'diffusion', label: 'Diff' },
]

const MASSES = ['tonic', 'complex', 'varied']
const DURATIONS = ['impulse', 'sustained', 'iterative']
const MASS_LABELS = { tonic: 'Tonic', complex: 'Complex', varied: 'Varied' }
const DUR_LABELS = { impulse: 'Imp', sustained: 'Sus', iterative: 'Iter' }
const TYPO_CODES = {
  'tonic-impulse': 'T/N', 'tonic-sustained': 'T/X', 'tonic-iterative': 'T/Y',
  'complex-impulse': 'N/N', 'complex-sustained': 'N/X', 'complex-iterative': 'N/Y',
  'varied-impulse': 'V/N', 'varied-sustained': 'V/X', 'varied-iterative': 'V/Y',
}

export function Pool({ selectedId, onSelect }) {
  const { pool, addPoolItem, removePoolItem, setPoolItemTypo, getBuffer, getAudioCtx, saveSession, loadSession } = useStore()
  const fileRef = useRef(null)
  const sessionRef = useRef(null)
  const [activeKind, setActiveKind] = useState('imported')
  const [typoFilter, setTypoFilter] = useState(null)
  const [typoOpen, setTypoOpen] = useState(false)
  const [auditioning, setAuditioning] = useState(null)
  const auditionSrcRef = useRef(null)

  const stopAudition = () => {
    if (auditionSrcRef.current) { try { auditionSrcRef.current.stop() } catch {}; auditionSrcRef.current = null }
    setAuditioning(null)
  }
  const audition = (item) => {
    stopAudition()
    const buf = getBuffer(item.id); if (!buf) return
    const ctx = getAudioCtx()
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination)
    src.onended = () => { auditionSrcRef.current = null; setAuditioning(null) }
    src.start(); auditionSrcRef.current = src; setAuditioning(item.id)
  }
  const exportItem = (item) => { const buf = getBuffer(item.id); if (buf) downloadWav(buf, `${item.name}.wav`) }

  const counts = useMemo(() => {
    const c = { imported: 0, capture: 0, object: 0, timeline: 0, diffusion: 0 }
    for (const item of pool) { if (c[item.kind] !== undefined) c[item.kind]++; else c.imported++ }
    return c
  }, [pool])

  const typoCounts = useMemo(() => {
    const c = {}
    for (const m of MASSES) for (const d of DURATIONS) c[`${m}-${d}`] = 0
    for (const item of pool) {
      if (item.typo) c[`${item.typo.mass}-${item.typo.duration}`] = (c[`${item.typo.mass}-${item.typo.duration}`] || 0) + 1
    }
    return c
  }, [pool])

  const visible = useMemo(() => {
    let items = pool.filter(it => (it.kind === activeKind) || (activeKind === 'imported' && !KINDS.find(k => k.id === it.kind)))
    if (typoFilter) items = items.filter(it => it.typo?.mass === typoFilter.mass && it.typo?.duration === typoFilter.duration)
    return items
  }, [pool, activeKind, typoFilter])

  const onFiles = async (e) => {
    const files = Array.from(e.target.files || [])
    const ctx = getAudioCtx()
    for (const f of files) {
      try { const buf = await decodeFile(f, ctx); addPoolItem(f.name.replace(/\.[^.]+$/, ''), buf, 'imported') }
      catch (err) { console.error('decode fail', f.name, err) }
    }
    e.target.value = ''
  }
  const recordStream = (stream, namePrefix, label) => {
    const ctx = getAudioCtx(); const rec = new MediaRecorder(stream); const chunks = []
    rec.ondataavailable = (e) => chunks.push(e.data)
    rec.onstop = async () => {
      const blob = new Blob(chunks); const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
      addPoolItem(`${namePrefix}_${pool.length + 1}`, buf, 'imported'); stream.getTracks().forEach(t => t.stop())
    }
    rec.start()
    const stop = () => { rec.stop(); document.body.removeChild(overlay) }
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:#000a;display:flex;align-items:center;justify-content:center;z-index:9999;flex-direction:column;gap:12px;color:#fff;font-family:monospace'
    overlay.innerHTML = `<div style="color:#f33;font-size:24px">● RECORDING ${label}</div>`
    const btn = document.createElement('button')
    btn.textContent = 'STOP'
    btn.style.cssText = 'padding:10px 20px;background:transparent;color:#00ff9c;border:1px solid #00ff9c;cursor:pointer;font-family:monospace'
    btn.onclick = stop; overlay.appendChild(btn); document.body.appendChild(overlay)
  }
  const onMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      recordStream(stream, 'mic', 'MIC')
    } catch (err) { alert('mic error: ' + err.message) }
  }
  const onTab = async () => {
    try {
      // getDisplayMedia requires video to be requested for tab/system audio
      // capture in Chromium browsers; we discard the video track immediately
      // and only record the audio track. Browser will prompt the user to
      // pick a tab/window and toggle "Share tab audio".
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      const audioTracks = stream.getAudioTracks()
      if (audioTracks.length === 0) {
        stream.getTracks().forEach(t => t.stop())
        alert('No audio captured. When prompted, pick a tab and tick "Share tab audio".')
        return
      }
      stream.getVideoTracks().forEach(t => t.stop())
      const audioStream = new MediaStream(audioTracks)
      recordStream(audioStream, 'tab', 'TAB AUDIO')
    } catch (err) {
      if (err.name !== 'NotAllowedError') alert('tab audio error: ' + err.message)
    }
  }
  const onLoadSession = async (e) => { const f = e.target.files?.[0]; if (f) await loadSession(f); e.target.value = '' }
  const onDragStart = (e, item) => { e.dataTransfer.setData('poolId', item.id); e.dataTransfer.effectAllowed = 'copy' }
  const onCellDrop = (e, mass, duration) => {
    e.preventDefault()
    const poolId = e.dataTransfer.getData('poolId')
    if (poolId) setPoolItemTypo(poolId, { mass, duration })
  }

  return (
    <div className="pool" data-tutorial="pool">
      <div className="pool-tabs">
        {KINDS.map(k => (
          <button key={k.id} className={activeKind === k.id ? 'active' : ''} onClick={() => setActiveKind(k.id)}>
            {k.label}<span className="badge">{counts[k.id]}</span>
          </button>
        ))}
      </div>

      <button className="tartyp-toggle" onClick={() => setTypoOpen(o => !o)}>
        <span>{typoOpen ? '▾' : '▸'} Typomorphology</span>
        {typoFilter && <span className="typo-filter-badge">{TYPO_CODES[`${typoFilter.mass}-${typoFilter.duration}`]}</span>}
      </button>
      {typoOpen && (
        <div className="tartyp-section">
          <div className="tartyp-grid">
            <div className="tartyp-corner" />
            {DURATIONS.map(d => <div key={d} className="tartyp-col-header">{DUR_LABELS[d]}</div>)}
            {MASSES.map(m => (
              <React.Fragment key={m}>
                <div className="tartyp-row-header">{MASS_LABELS[m]}</div>
                {DURATIONS.map(d => {
                  const key = `${m}-${d}`
                  const isActive = typoFilter?.mass === m && typoFilter?.duration === d
                  return (
                    <div
                      key={key}
                      className={'tartyp-cell' + (isActive ? ' active' : '')}
                      onClick={() => setTypoFilter(isActive ? null : { mass: m, duration: d })}
                      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
                      onDrop={e => onCellDrop(e, m, d)}
                      title={`${TYPO_CODES[key]} — click to filter · drop to categorize`}
                    >
                      <span className="tartyp-code">{TYPO_CODES[key]}</span>
                      {typoCounts[key] > 0 && <span className="tartyp-count">{typoCounts[key]}</span>}
                    </div>
                  )
                })}
              </React.Fragment>
            ))}
          </div>
          {typoFilter && (
            <button className="typo-clear" onClick={() => setTypoFilter(null)}>
              showing {TYPO_CODES[`${typoFilter.mass}-${typoFilter.duration}`]} · click to clear
            </button>
          )}
        </div>
      )}

      <div className="list">
        {visible.length === 0 && (
          <div className="empty">
            {activeKind === 'imported' && <>empty<br />load audio below</>}
            {activeKind === 'capture' && <>no captures</>}
            {activeKind === 'object' && <>no objects</>}
            {activeKind === 'timeline' && <>no mixes</>}
            {activeKind === 'diffusion' && <>no captures</>}
          </div>
        )}
        {visible.map(item => (
          <div
            key={item.id}
            className={'pool-item' + (selectedId === item.id ? ' selected' : '')}
            draggable
            onDragStart={(e) => onDragStart(e, item)}
            onClick={() => onSelect && onSelect(item.id)}
            title="click to select · drag to tracks or TARTYP cells"
          >
            <div className="pool-item-top">
              <span className="name">{item.name}</span>
              <button className="pool-btn" onPointerDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); e.preventDefault(); auditioning === item.id ? stopAudition() : audition(item) }}
              >{auditioning === item.id ? '■' : '▶'}</button>
              <button className="pool-btn" onPointerDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); e.preventDefault(); exportItem(item) }}>↓</button>
              <button className="pool-btn pool-btn-del" onPointerDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); e.preventDefault(); removePoolItem(item.id) }}>×</button>
            </div>
            <div className="meta">
              <span className={'kind-' + item.kind}>{item.kind}</span>
              {item.typo && <span className="typo-tag">{TYPO_CODES[`${item.typo.mass}-${item.typo.duration}`]}</span>}
              <span>{item.duration.toFixed(2)}s</span>
            </div>
          </div>
        ))}
      </div>

      <div className="pool-actions" data-tutorial="save-actions">
        <button onClick={() => fileRef.current.click()}>Load audio</button>
        <button onClick={onMic}>Record mic</button>
        <button onClick={onTab} title="capture audio playing in another browser tab (pick the tab + tick 'Share tab audio')">Record tab</button>
        <input ref={fileRef} type="file" accept="audio/*" multiple onChange={onFiles} />
        <div style={{ borderTop: '1px solid var(--border)', margin: '6px 0' }} />
        <button onClick={saveSession}>Save session</button>
        <button onClick={() => sessionRef.current.click()}>Load session</button>
        <input ref={sessionRef} type="file" accept="application/json,.json" onChange={onLoadSession} />
      </div>
    </div>
  )
}
