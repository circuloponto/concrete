import { useEffect } from 'react'
import { StateProvider, useStore } from './state'
import { Pool } from './Pool'
import { SoundTab } from './SoundTab'
import { ObjectTab } from './ObjectTab'
import { TimelineTab } from './TimelineTab'

function Shell() {
  const { highlight, setHighlight, ui, setUi, sessionVersion } = useStore()
  const tab = ui.tab
  const setTab = (t) => setUi(prev => ({ ...prev, tab: t }))
  const selectedPoolId = ui.selectedPoolId
  const setSelectedPoolId = (id) => setUi(prev => ({ ...prev, selectedPoolId: id }))

  useEffect(() => {
    document.documentElement.style.setProperty('--hl', highlight)
  }, [highlight])

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">concrète</div>
        <div className="tabs">
          <button className={tab === 'sound' ? 'active' : ''} onClick={() => setTab('sound')}>Sound</button>
          <button className={tab === 'object' ? 'active' : ''} onClick={() => setTab('object')}>Object</button>
          <button className={tab === 'timeline' ? 'active' : ''} onClick={() => setTab('timeline')}>Timeline</button>
        </div>
        <div className="spacer" />
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
