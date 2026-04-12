import { useState, useEffect, useLayoutEffect, useRef } from 'react'

const STEPS = [
  {
    title: 'welcome to contrète',
    body: 'A musique concrète playground. Three workspaces — Sound, Object, Timeline — let you sculpt sounds the way Pierre Schaeffer did, but in a browser.',
    selector: '.brand',
    placement: 'bottom',
  },
  {
    title: 'three workspaces',
    body: 'Sound is for sculpting raw audio with effects. Object is for cutting small sound objects from the result. Timeline is where you arrange them into a piece.',
    selector: '[data-tutorial="tabs"]',
    placement: 'bottom',
  },
  {
    title: 'the pool',
    body: 'Your sound library, sorted by stage: imported files, captures from Sound, rendered objects, timeline mixes. Drag any item onto a player or a track.',
    selector: '[data-tutorial="pool"]',
    placement: 'right',
  },
  {
    title: 'load and save sessions',
    body: 'Save the entire session — pool audio, voices, every effect setting, all tracks — to a single JSON file. Load it back any time to keep working.',
    selector: '[data-tutorial="save-actions"]',
    placement: 'right',
  },
  {
    title: 'voice players',
    body: 'Each voice plays a sound through its own effect chain. Click a player to focus it; the controls below apply to whichever voice is focused. Add more voices with + Voice.',
    selector: '[data-tutorial="voice-players"]',
    tab: 'sound',
    placement: 'bottom',
  },
  {
    title: 'scrub the disk',
    body: 'Drag the disk to scrub bidirectionally. Toggle the wave / disk view with ≡/◎. Speed and pitch are decoupled — transpose without time-stretching.',
    selector: '[data-tutorial="voice-player"]',
    tab: 'sound',
    placement: 'right',
  },
  {
    title: 'effect sub-tabs',
    body: 'Tape, Filter, Mod, Grain, Motion, Space, Loop. Inside Mod: ring modulator, flanger, tremolo. Inside Grain: a constant-Q granulator that mixes grains the way the cochlea hears.',
    selector: '[data-tutorial="sub-tabs"]',
    tab: 'sound',
    placement: 'top',
  },
  {
    title: 'animate any slider',
    body: 'Click the small M button next to any slider to attach an LFO. Pick a wave (sine, triangle, square, saw, ramp, S&H), set rate and depth, and the parameter animates over time.',
    selector: '[data-tutorial="sub-tabs"]',
    tab: 'sound',
    placement: 'top',
  },
  {
    title: 'capture the mix',
    body: 'When you like what you hear, click Rec mix → pool to record everything — multiple voices, all effects, even your scrub gestures — into a fresh pool item.',
    selector: '[data-tutorial="rec"]',
    tab: 'sound',
    placement: 'bottom',
  },
  {
    title: 'object tab — slice',
    body: 'Drag a captured sound onto the source picker. Click and drag on the waveform to mark a region. Shift-drag to scrub through the buffer.',
    selector: '[data-tutorial="source-picker"]',
    tab: 'object',
    placement: 'bottom',
  },
  {
    title: 'commit & send',
    body: 'Pick a target track and click Commit & send. The region is sliced into a fresh pool item and dropped onto the chosen track — fully independent of the source.',
    selector: '[data-tutorial="source-picker"]',
    tab: 'object',
    placement: 'top',
  },
  {
    title: 'track controls',
    body: 'Each track has Solo (S), Mute (M), Gain and Pan. The S/M buttons follow classic mixing-console behavior.',
    selector: '.track-header',
    tab: 'object',
    placement: 'right',
  },
  {
    title: 'logic-style fades',
    body: 'Drag the small green dot at either end of a clip to set the fade. Horizontal = length, vertical = curve shape. The envelope updates in real time.',
    selector: '.track-clips',
    tab: 'object',
    placement: 'top',
  },
  {
    title: 'render to pool',
    body: 'When the object is finished, click Render → pool to bake it into a single sound. It lands in the Object tab of the pool, ready to use in the timeline.',
    selector: '[data-tutorial="render-object"]',
    tab: 'object',
    placement: 'bottom',
  },
  {
    title: 'timeline — compose',
    body: 'Drag rendered objects from the pool onto tracks. Adjust zoom and track height in the toolbar. Export the final mix as a WAV when you are done.',
    selector: '[data-tutorial="export"]',
    tab: 'timeline',
    placement: 'bottom',
  },
  {
    title: 'you are ready',
    body: 'Re-open this tutorial any time with the ? in the topbar. Now go make some musique concrète.',
    selector: '[data-tutorial="help"]',
    placement: 'bottom',
  },
]

export function Tutorial({ open, onClose, currentTab, onSwitchTab }) {
  const [step, setStep] = useState(0)
  const [rect, setRect] = useState(null)
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 })
  const popoverRef = useRef(null)

  useEffect(() => { if (open) setStep(0) }, [open])

  const current = STEPS[step]

  // switch tabs if the current step needs a different one
  useEffect(() => {
    if (!open || !current) return
    if (current.tab && current.tab !== currentTab) {
      onSwitchTab(current.tab)
    }
  }, [open, step, current, currentTab, onSwitchTab])

  // measure target & position the popover
  useLayoutEffect(() => {
    if (!open || !current) return
    let raf = null
    const measure = () => {
      const el = document.querySelector(current.selector)
      if (!el) {
        setRect(null)
        setPopoverPos({
          top: window.innerHeight / 2 - 90,
          left: window.innerWidth / 2 - 180,
        })
        return
      }
      // try to bring it into view
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }) } catch {}
      const r = el.getBoundingClientRect()
      setRect(r)
      const popW = 360
      const popH = popoverRef.current?.offsetHeight || 180
      const place = current.placement || 'bottom'
      let top, left
      if (place === 'bottom') { top = r.bottom + 16; left = r.left + r.width / 2 - popW / 2 }
      else if (place === 'top') { top = r.top - popH - 16; left = r.left + r.width / 2 - popW / 2 }
      else if (place === 'right') { top = r.top + r.height / 2 - popH / 2; left = r.right + 16 }
      else if (place === 'left') { top = r.top + r.height / 2 - popH / 2; left = r.left - popW - 16 }
      top = Math.max(12, Math.min(window.innerHeight - popH - 12, top))
      left = Math.max(12, Math.min(window.innerWidth - popW - 12, left))
      setPopoverPos({ top, left })
    }
    // measure now and after a small delay to allow tab switches to render
    measure()
    const t1 = setTimeout(measure, 80)
    const t2 = setTimeout(measure, 250)
    const onResize = () => { raf = requestAnimationFrame(measure) }
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      clearTimeout(t1); clearTimeout(t2)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [open, step, current])

  // keyboard navigation
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' || e.key === 'Enter') next()
      else if (e.key === 'ArrowLeft') prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, step])

  if (!open) return null

  const next = () => {
    if (step < STEPS.length - 1) setStep(s => s + 1)
    else onClose()
  }
  const prev = () => setStep(s => Math.max(0, s - 1))

  const padding = 6
  const hl = rect && {
    top: rect.top - padding,
    left: rect.left - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  }

  return (
    <div className="tutorial-root" role="dialog" aria-modal>
      <svg className="tutorial-mask" width="100%" height="100%">
        <defs>
          <mask id="tutorial-cutout">
            <rect width="100%" height="100%" fill="white" />
            {hl && (
              <rect
                x={hl.left}
                y={hl.top}
                width={hl.width}
                height={hl.height}
                rx="4"
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="var(--scrim)" mask="url(#tutorial-cutout)" />
      </svg>
      {hl && (
        <div
          className="tutorial-highlight"
          style={{ top: hl.top, left: hl.left, width: hl.width, height: hl.height }}
        />
      )}
      <div
        ref={popoverRef}
        className="tutorial-popover"
        style={{ top: popoverPos.top, left: popoverPos.left }}
      >
        <div className="tutorial-popover-head">
          <span className="tutorial-step-num">{step + 1} / {STEPS.length}</span>
          <button className="tutorial-x" onClick={onClose} aria-label="close">×</button>
        </div>
        <h3 className="tutorial-title">{current.title}</h3>
        <p className="tutorial-body">{current.body}</p>
        <div className="tutorial-progress">
          {STEPS.map((_, i) => (
            <span key={i} className={'tutorial-dot' + (i === step ? ' active' : '') + (i < step ? ' done' : '')} />
          ))}
        </div>
        <div className="tutorial-actions">
          <button className="tutorial-ghost" onClick={onClose}>Skip</button>
          <div style={{ flex: 1 }} />
          <button className="tutorial-arrow" onClick={prev} disabled={step === 0}>← Prev</button>
          <button className="tutorial-primary" onClick={next}>
            {step === STEPS.length - 1 ? 'Done' : 'Next →'}
          </button>
        </div>
      </div>
    </div>
  )
}
