import { useRef, useState, useEffect, useCallback } from 'react'
import { useStore, MAX_VOICES } from './state'
import { useVoice } from './useVoice'
import { VoicePlayer } from './VoicePlayer'
import { VoiceControls } from './VoiceControls'

export function SoundTab({ selectedPoolId }) {
  const { getAudioCtx, addPoolItem, soundState, setSoundState } = useStore()
  const [audioNodes] = useState(() => {
    const ctx = getAudioCtx()
    const busInput = ctx.createGain(); busInput.gain.value = 1
    const master = ctx.createGain(); master.gain.value = 1
    const feedback = ctx.createGain(); feedback.gain.value = 0
    const msDest = ctx.createMediaStreamDestination()
    busInput.connect(master)
    master.connect(ctx.destination)
    master.connect(msDest)
    master.connect(feedback)
    feedback.connect(busInput)
    return { busInput, master, feedback, msDest, mixer: busInput }
  })

  // live howlround amount
  useEffect(() => {
    const amt = soundState.bus?.feedback ?? 0
    audioNodes.feedback.gain.value = amt
  }, [soundState.bus?.feedback, audioNodes])

  const setHowl = (amt) => setSoundState(prev => ({ ...prev, bus: { ...(prev.bus || {}), feedback: amt } }))

  // stable per-index snapshot callbacks that write to store
  const mkSnapCb = (i) => useCallback((snap) => {
    setSoundState(prev => {
      const vs = prev.voices.slice()
      vs[i] = snap
      return { ...prev, voices: vs }
    })
  }, [setSoundState])

  const onSnap0 = mkSnapCb(0)
  const onSnap1 = mkSnapCb(1)
  const onSnap2 = mkSnapCb(2)
  const onSnap3 = mkSnapCb(3)
  const onSnap4 = mkSnapCb(4)
  const onSnap5 = mkSnapCb(5)

  const v0 = useVoice(1, audioNodes.mixer, soundState.voices[0], onSnap0)
  const v1 = useVoice(2, audioNodes.mixer, soundState.voices[1], onSnap1)
  const v2 = useVoice(3, audioNodes.mixer, soundState.voices[2], onSnap2)
  const v3 = useVoice(4, audioNodes.mixer, soundState.voices[3], onSnap3)
  const v4 = useVoice(5, audioNodes.mixer, soundState.voices[4], onSnap4)
  const v5 = useVoice(6, audioNodes.mixer, soundState.voices[5], onSnap5)
  const voices = [v0, v1, v2, v3, v4, v5]

  const voiceCount = Math.min(MAX_VOICES, Math.max(1, soundState.voiceCount || 2))
  const setVoiceCount = (n) => setSoundState(prev => ({ ...prev, voiceCount: Math.min(MAX_VOICES, Math.max(1, n)) }))

  const [focused, setFocused] = useState(soundState.focused || 1)
  useEffect(() => {
    setSoundState(prev => prev.focused === focused ? prev : { ...prev, focused })
  }, [focused, setSoundState])

  const [recording, setRecording] = useState(false)
  const recRef = useRef(null)

  // auto-load pool selection into focused voice
  const lastSelRef = useRef(null)
  useEffect(() => {
    if (selectedPoolId && selectedPoolId !== lastSelRef.current) {
      lastSelRef.current = selectedPoolId
      const target = voices[focused - 1]
      target?.loadFromPool(selectedPoolId)
    }
  }, [selectedPoolId, focused])

  const focusedVoice = voices[focused - 1] || voices[0]

  const startRecord = () => {
    const rec = new MediaRecorder(audioNodes.msDest.stream)
    const chunks = []
    rec.ondataavailable = (e) => chunks.push(e.data)
    rec.onstop = async () => {
      const blob = new Blob(chunks)
      const buf = await getAudioCtx().decodeAudioData(await blob.arrayBuffer())
      addPoolItem(`capture_${Date.now().toString(36)}`, buf, 'capture')
    }
    rec.start()
    recRef.current = rec
    setRecording(true)
  }
  const stopRecord = () => {
    if (recRef.current) { recRef.current.stop(); recRef.current = null }
    setRecording(false)
  }

  // drag-scroll on the row
  const rowRef = useRef(null)
  const dragRef = useRef({ active: false, startX: 0, startScroll: 0, moved: false, capturedOn: null })
  const onRowPointerDown = (e) => {
    const el = rowRef.current
    if (!el) return
    // ignore drags that start on interactive controls — they should still work
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
  const onRowPointerUp = (e) => {
    const d = dragRef.current
    if (d.moved) { try { d.capturedOn?.releasePointerCapture(d.pointerId) } catch {} }
    dragRef.current = { active: false, startX: 0, startScroll: 0, moved: false, capturedOn: null }
  }
  const onRowWheel = (e) => {
    if (!rowRef.current) return
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      rowRef.current.scrollLeft += e.deltaY
      e.preventDefault()
    }
  }
  const scrollBy = (dir) => {
    if (rowRef.current) rowRef.current.scrollBy({ left: dir * 300, behavior: 'smooth' })
  }

  return (
    <div>
      <div className="toolbar">
        <span style={{ color: 'var(--dim)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>
          click a player to edit its effects · drag row to scroll
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={() => scrollBy(-1)}>◀</button>
        <button onClick={() => scrollBy(1)}>▶</button>
        <button
          onClick={() => voices.forEach(v => { try { v.stop() } catch {} })}
          title="stop all voices"
        >■ Stop all</button>
        <button onClick={() => setVoiceCount(voiceCount - 1)} disabled={voiceCount <= 1}>− Voice</button>
        <button onClick={() => setVoiceCount(voiceCount + 1)} disabled={voiceCount >= MAX_VOICES}>+ Voice</button>
        <span style={{ color: 'var(--hl)', fontSize: 11, marginLeft: 4 }}>{voiceCount}/{MAX_VOICES}</span>
        <div style={{ width: 12 }} />
        <div className="howl">
          <label>Howlround</label>
          <input
            type="range"
            min="0"
            max="0.9"
            step="0.01"
            value={soundState.bus?.feedback ?? 0}
            onChange={e => setHowl(+e.target.value)}
          />
          <span className="value">{Math.round((soundState.bus?.feedback ?? 0) * 100)}%</span>
        </div>
        <div style={{ width: 12 }} />
        <span data-tutorial="rec">
          {!recording
            ? <button onClick={startRecord}>● Rec mix → pool</button>
            : <button className="recording" onClick={stopRecord}>Stop rec</button>}
        </span>
      </div>
      <div
        className="voice-players-row scroll"
        data-tutorial="voice-players"
        ref={rowRef}
        onPointerDown={onRowPointerDown}
        onPointerMove={onRowPointerMove}
        onPointerUp={onRowPointerUp}
        onPointerCancel={onRowPointerUp}
        onWheel={onRowWheel}
      >
        {voices.slice(0, voiceCount).map((voice, i) => (
          <VoicePlayer
            key={i}
            voice={voice}
            focused={focused === i + 1}
            onFocus={() => setFocused(i + 1)}
          />
        ))}
      </div>
      <VoiceControls voice={focusedVoice} />
    </div>
  )
}
