import { useRef, useState, useEffect, useCallback } from 'react'
import { useStore, MAX_VOICES } from './state'
import { useVoice } from './useVoice'
import { VoicePlayer } from './VoicePlayer'
import { VoiceControls } from './VoiceControls'

export function SoundTab({ selectedPoolId }) {
  const { getAudioCtx, addPoolItem, soundState, setSoundState, lowCpuMode, setLowCpuMode, transportRef } = useStore()
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
    // Shared reverb bus — voices with matching IR config (either a synthetic
    // size bucket or a user IR buffer) share a single ConvolverNode. Each
    // voice routes input through its own send gain into the shared convolver
    // of its profile; the convolver's output returns to the mixer. Distinct
    // profiles get distinct convolvers, so per-voice character is preserved
    // when voices want it. Identical configs dedup to one convolver.
    const reverbProfiles = new Map()
    const reverbBus = {
      acquire(key, produceIR) {
        let entry = reverbProfiles.get(key)
        if (!entry) {
          const conv = ctx.createConvolver()
          conv.buffer = produceIR()
          conv.connect(busInput)
          entry = { conv, refCount: 0 }
          reverbProfiles.set(key, entry)
        }
        entry.refCount++
        return {
          conv: entry.conv,
          release: () => {
            entry.refCount--
            if (entry.refCount === 0) {
              try { entry.conv.disconnect() } catch {}
              reverbProfiles.delete(key)
            }
          },
        }
      },
    }
    // Shared band-reverb bus — same refcount pattern, but each profile owns
    // a fan of N bandpass→convolver→gain chains (the expensive bit). Voices
    // with matching bandReverb config (bands|size|spread|decay) share the
    // whole fan. Six voices all on bandReverbBands=6 size=2 spread=0.5
    // decay=3 = 6 convolvers total instead of 36.
    const bandReverbProfiles = new Map()
    const bandReverbBus = {
      acquire(key, buildFan) {
        let entry = bandReverbProfiles.get(key)
        if (!entry) {
          const input = ctx.createGain(); input.gain.value = 1
          const fan = buildFan(input, busInput)
          entry = { input, fan, refCount: 0 }
          bandReverbProfiles.set(key, entry)
        }
        entry.refCount++
        return {
          input: entry.input,
          release: () => {
            entry.refCount--
            if (entry.refCount === 0) {
              try { entry.input.disconnect() } catch {}
              for (const b of entry.fan) {
                try { b.bpf.disconnect() } catch {}
                try { b.convolver.disconnect() } catch {}
                try { b.gain.disconnect() } catch {}
              }
              bandReverbProfiles.delete(key)
            }
          },
        }
      },
    }
    return { busInput, master, feedback, msDest, mixer: busInput, reverbBus, bandReverbBus }
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

  const v0 = useVoice(1, audioNodes.mixer, soundState.voices[0], onSnap0, audioNodes)
  const v1 = useVoice(2, audioNodes.mixer, soundState.voices[1], onSnap1, audioNodes)
  const v2 = useVoice(3, audioNodes.mixer, soundState.voices[2], onSnap2, audioNodes)
  const v3 = useVoice(4, audioNodes.mixer, soundState.voices[3], onSnap3, audioNodes)
  const v4 = useVoice(5, audioNodes.mixer, soundState.voices[4], onSnap4, audioNodes)
  const v5 = useVoice(6, audioNodes.mixer, soundState.voices[5], onSnap5, audioNodes)
  const voices = [v0, v1, v2, v3, v4, v5]
  // Expose per-voice diffusion sends + a router toggle so DiffusionTab can
  // route post-effect chain audio into its Resonance spatializer AND mute
  // the Sound-tab direct output when a voice is being diffused.
  if (transportRef) {
    transportRef.current.diffusionSends = voices.map(v => v.diffusionSend)
    transportRef.current.voiceRouters = voices.map(v => v.setDiffusionRouted)
  }

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
  const startRecordOneShot = () => {
    const v = focusedVoice
    if (!v || !v.buffer) return
    const rec = new MediaRecorder(audioNodes.msDest.stream)
    const chunks = []
    rec.ondataavailable = (e) => chunks.push(e.data)
    rec.onstop = async () => {
      const blob = new Blob(chunks)
      const buf = await getAudioCtx().decodeAudioData(await blob.arrayBuffer())
      addPoolItem(`oneshot_${Date.now().toString(36)}`, buf, 'capture')
    }
    rec.start()
    recRef.current = rec
    setRecording(true)
    v.play({
      oneShot: true,
      onEnded: () => {
        setTimeout(() => {
          if (recRef.current === rec) {
            try { rec.stop() } catch {}
            recRef.current = null
            setRecording(false)
            try { v.stop() } catch {}
          }
        }, 400)
      },
    })
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
        <label
          title="Skip the pitch/time stretch worklet — pitch and tempo collapse into a single playback rate. Much lighter on mobile CPU."
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer' }}
        >
          <input
            type="checkbox"
            checked={lowCpuMode}
            onChange={e => setLowCpuMode(e.target.checked)}
          />
          Low-CPU
        </label>
        <div style={{ width: 12 }} />
        <span data-tutorial="rec">
          {!recording
            ? <>
                <button onClick={startRecord}>● Rec mix → pool</button>
                <button
                  onClick={startRecordOneShot}
                  disabled={!focusedVoice?.buffer}
                  title="play focused voice once and capture into pool"
                  style={{ marginLeft: 4 }}
                >● Rec one-shot</button>
              </>
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
