import SignalsmithStretch from 'signalsmith-stretch'

// Mirrors the soundtouchjs PitchShifter surface that useVoice.js expects
// (tempo/pitchSemitones/percentagePlayed/connect/disconnect, plus the
// _kind/_oneShot/_onEnded tracking fields), but is backed by the WASM
// AudioWorklet in signalsmith-stretch. Playback is sample-accurate; seeks and
// tiny loops work without the ~93ms soundtouch buffer quirk.
//
// Constructor is synchronous so play() stays sync. The underlying worklet +
// buffer load asynchronously; ops that land before the node is ready are
// queued and flushed on resolve.
export function createStretchShim(ctx, buffer, destNode, opts = {}) {
  const dur = buffer.duration
  const state = {
    tempo: opts.tempo ?? 1,
    pitch: opts.pitch ?? 0,
    loopStart: opts.loopStart ?? 0,
    loopEnd: opts.loopEnd ?? 1,
    oneShot: !!opts.oneShot,
    startFromNorm: opts.startFromNorm ?? (opts.loopStart ?? 0),
  }

  let stretch = null
  let disposed = false
  const queue = []
  const runOrQueue = (fn) => { if (stretch) fn(stretch); else queue.push(fn) }

  const scheduleAll = (node, extra = {}) => {
    const ls = state.oneShot ? 0 : state.loopStart * dur
    const le = state.oneShot ? 0 : state.loopEnd * dur
    node.schedule({
      output: ctx.currentTime,
      active: true,
      rate: state.tempo,
      semitones: state.pitch,
      loopStart: ls,
      loopEnd: le,
      ...extra,
    })
  }

  SignalsmithStretch(ctx).then(async (node) => {
    if (disposed) { try { node.disconnect() } catch {} ; return }
    const chs = []
    for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c))
    await node.addBuffers(chs)
    if (disposed) { try { node.disconnect() } catch {} ; return }
    node.connect(destNode)
    scheduleAll(node, { input: state.startFromNorm * dur })
    node.start()
    stretch = node
    for (const fn of queue) fn(node)
    queue.length = 0
  }).catch(err => {
    console.error('[stretchShim] SignalsmithStretch init failed', err)
  })

  return {
    _kind: 'stretch',
    _onEnded: opts.onEnded || null,
    get _oneShot() { return state.oneShot },
    set _oneShot(v) { state.oneShot = v; runOrQueue(n => scheduleAll(n)) },
    get tempo() { return state.tempo },
    set tempo(v) { if (state.tempo === v) return; state.tempo = v; runOrQueue(n => scheduleAll(n)) },
    get pitchSemitones() { return state.pitch },
    set pitchSemitones(v) { if (state.pitch === v) return; state.pitch = v; runOrQueue(n => scheduleAll(n)) },
    get percentagePlayed() {
      if (!stretch) return state.startFromNorm * 100
      return (stretch.inputTime / dur) * 100
    },
    set percentagePlayed(pct) {
      const input = Math.max(0, Math.min(dur, (pct / 100) * dur))
      state.startFromNorm = input / dur
      // Schedule slightly ahead so the worklet has room to crossfade rather
      // than hard-cut. Without the offset, scrub-end positioning sounds
      // glitchy because the node has to catch up from its internal buffer.
      runOrQueue(n => n.schedule({
        output: ctx.currentTime + 0.02,
        active: true,
        rate: state.tempo,
        semitones: state.pitch,
        input,
        loopStart: state.oneShot ? 0 : state.loopStart * dur,
        loopEnd: state.oneShot ? 0 : state.loopEnd * dur,
      }))
    },
    updateLoop(lsNorm, leNorm) {
      if (state.loopStart === lsNorm && state.loopEnd === leNorm) return
      state.loopStart = lsNorm
      state.loopEnd = leNorm
      runOrQueue(n => scheduleAll(n))
    },
    connect(target) { runOrQueue(n => { try { n.connect(target) } catch {} }) },
    disconnect() {
      disposed = true
      if (stretch) {
        try { stretch.stop() } catch {}
        try { stretch.disconnect() } catch {}
        stretch = null
      }
    },
  }
}
