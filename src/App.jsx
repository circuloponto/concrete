import { useEffect, useRef, useState } from 'react'
import { StateProvider, useStore } from './state'
import { Pool } from './Pool'
import { SoundTab } from './SoundTab'
import { ObjectTab } from './ObjectTab'
import { TimelineTab } from './TimelineTab'
import { Tutorial } from './Tutorial'
import { decodeFile } from './audio'

const TUTORIAL_KEY = 'concrete_tutorial_seen_v1'
const AUDIO_RX = /\.(wav|mp3|aiff?|ogg|flac|m4a|webm)$/i

function Shell() {
  const {
    highlight, setHighlight, ui, setUi, sessionVersion,
    addPoolItem, getAudioCtx,
  } = useStore()
  const tab = ui.tab
  const setTab = (t) => setUi(prev => ({ ...prev, tab: t }))
  const selectedPoolId = ui.selectedPoolId
  const setSelectedPoolId = (id) => setUi(prev => ({ ...prev, selectedPoolId: id }))
  const [tutorialOpen, setTutorialOpen] = useState(false)
  const [dropping, setDropping] = useState(false)
  const dragCounter = useRef(0)

  useEffect(() => {
    document.documentElement.style.setProperty('--hl', highlight)
  }, [highlight])

  // first-visit auto-launch
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!window.localStorage.getItem(TUTORIAL_KEY)) {
      setTutorialOpen(true)
    }
  }, [])

  const closeTutorial = () => {
    setTutorialOpen(false)
    try { window.localStorage.setItem(TUTORIAL_KEY, '1') } catch {}
  }

  // ---- file drop ----
  const onDragEnter = (e) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragCounter.current += 1
    setDropping(true)
  }
  const onDragLeave = (e) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragCounter.current -= 1
    if (dragCounter.current <= 0) {
      dragCounter.current = 0
      setDropping(false)
    }
  }
  const onDragOver = (e) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }
  const onDrop = async (e) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragCounter.current = 0
    setDropping(false)
    const files = Array.from(e.dataTransfer.files || [])
    const audioFiles = files.filter(f => AUDIO_RX.test(f.name) || (f.type && f.type.startsWith('audio/')))
    if (audioFiles.length === 0) return
    const ctx = getAudioCtx()
    for (const f of audioFiles) {
      try {
        const buf = await decodeFile(f, ctx)
        addPoolItem(f.name.replace(/\.[^.]+$/, ''), buf, 'imported')
      } catch (err) {
        console.error('decode fail', f.name, err)
      }
    }
  }

  return (
    <div
      className="app"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="topbar">
        <div className="brand">contrète</div>
        <div className="tabs" data-tutorial="tabs">
          <button className={tab === 'sound' ? 'active' : ''} onClick={() => setTab('sound')}>Sound</button>
          <button className={tab === 'object' ? 'active' : ''} onClick={() => setTab('object')}>Object</button>
          <button className={tab === 'timeline' ? 'active' : ''} onClick={() => setTab('timeline')}>Timeline</button>
        </div>
        <div className="spacer" />
        <button
          className="help-btn"
          data-tutorial="help"
          onClick={() => setTutorialOpen(true)}
          title="open tutorial"
        >?</button>
        <label style={{ fontSize: 10, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1 }}>
          highlight
          <input
            type="color"
            value={highlight}
            onChange={e => setHighlight(e.target.value)}
            style={{ marginLeft: 8, verticalAlign: 'middle' }}
          />
        </label>
      </div>
      <div className="main">
        <Pool selectedId={selectedPoolId} onSelect={setSelectedPoolId} />
        <div className="content">
          {tab === 'sound' && <SoundTab key={sessionVersion} selectedPoolId={selectedPoolId} />}
          {tab === 'object' && <ObjectTab key={sessionVersion} />}
          {tab === 'timeline' && <TimelineTab key={sessionVersion} />}
        </div>
      </div>
      <Tutorial
        open={tutorialOpen}
        onClose={closeTutorial}
        currentTab={tab}
        onSwitchTab={setTab}
      />
      {dropping && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">
            <div className="drop-icon">+</div>
            <div className="drop-text">drop audio files to import</div>
            <div className="drop-sub">wav · mp3 · aiff · ogg · flac · m4a</div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function App() {
  return (
    <StateProvider>
      <Shell />
    </StateProvider>
  )
}
