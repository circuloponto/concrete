// Host for the waveset processor worker. Mirrors irCache.js:
// singleton Worker per AudioContext, id-keyed request/response,
// copyToChannel into a fresh AudioBuffer on resolve.

import workerUrl from './workers/wavesetProc.worker.js?url'

const workersByContext = new WeakMap()
const pendingByContext = new WeakMap()
const nextId = { value: 0 }

function getWorker(ctx) {
  let w = workersByContext.get(ctx)
  if (w) return w
  try {
    w = new Worker(workerUrl, { type: 'module' })
  } catch (e) {
    console.warn('[wavesetProc] Worker construction failed', e)
    return null
  }
  const pending = new Map()
  w.onmessage = (e) => {
    const { id, channels, error, progress } = e.data
    const entry = pending.get(id)
    if (!entry) return
    if (progress != null) {
      entry.onProgress && entry.onProgress(progress)
      return
    }
    pending.delete(id)
    if (error) entry.reject(new Error(error))
    else entry.resolve(channels)
  }
  workersByContext.set(ctx, w)
  pendingByContext.set(ctx, pending)
  return w
}

// Clone an AudioBuffer's channels into fresh transferable Float32Arrays.
function cloneBufferChannels(buffer) {
  const out = []
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const copy = new Float32Array(buffer.length)
    copy.set(buffer.getChannelData(c))
    out.push(copy)
  }
  return out
}

// Process an AudioBuffer through a pipeline. Resolves to a new AudioBuffer.
// pipeline: { lpCutoff: number|null, groupSize: number, steps: [{op, params}] }
// For morph steps, params.sourceBId must be a pool id; caller supplies
// resolveBuffer(poolId) → AudioBuffer so this module stays side-effect-free
// on the store.
export function processWavesets(ctx, buffer, pipeline, onProgress, resolveBuffer) {
  return new Promise((resolve, reject) => {
    const w = getWorker(ctx)
    if (!w) { reject(new Error('worker unavailable')); return }
    const id = ++nextId.value
    const pending = pendingByContext.get(ctx)
    const channels = cloneBufferChannels(buffer)
    // Transfer list — includes the primary source's channel buffers plus
    // any morph-step sourceB buffers.
    const transfer = channels.map(c => c.buffer)
    // Walk steps, resolve morph sourceBId → fresh Float32Arrays, add to transfer.
    const steps = (pipeline.steps || []).map(step => {
      if (step.op !== 'morph') return step
      const sourceBId = step.params?.sourceBId
      if (!sourceBId) {
        console.warn('[wavesetProc] morph step has no sourceBId — output will be source A unchanged')
        return step
      }
      if (!resolveBuffer) {
        console.warn('[wavesetProc] morph step but no resolveBuffer was supplied')
        return step
      }
      const bBuf = resolveBuffer(sourceBId)
      if (!bBuf) {
        console.warn('[wavesetProc] morph sourceBId not found in pool:', sourceBId)
        return step
      }
      const bChannels = cloneBufferChannels(bBuf)
      for (const ch of bChannels) transfer.push(ch.buffer)
      console.log('[wavesetProc] morph attaching sourceB:', sourceBId, 'channels:', bChannels.length, 'length:', bChannels[0].length)
      return { ...step, params: { ...step.params, sourceBChannels: bChannels } }
    })
    pending.set(id, {
      onProgress,
      resolve: (outChannels) => {
        try {
          const outBuf = ctx.createBuffer(outChannels.length, outChannels[0].length, ctx.sampleRate)
          for (let c = 0; c < outChannels.length; c++) outBuf.copyToChannel(outChannels[c], c)
          resolve(outBuf)
        } catch (e) { reject(e) }
      },
      reject,
    })
    w.postMessage({
      id,
      channels,
      sampleRate: ctx.sampleRate,
      lpCutoff: pipeline.lpCutoff ?? null,
      groupSize: pipeline.groupSize ?? 1,
      steps,
    }, transfer)
  })
}

// Human-readable summary of a pipeline, used for the auto-generated name
// of the resulting pool item.
export function summarizePipeline(pipeline) {
  if (!pipeline?.steps?.length) return 'waveset'
  const shortOp = (s) => {
    switch (s.op) {
      case 'reverse': return 'rev'
      case 'repeat': return `rep${s.params?.n || 2}`
      case 'omit': return `om${s.params?.keepEvery || 2}`
      case 'shuffle': return `shuf${s.params?.windowSize || 8}`
      case 'invert': return 'inv'
      case 'harmonic': return 'harm'
      case 'waveSub': return `sub.${s.params?.wave || 'saw'}`
      case 'normalize': return 'norm'
      case 'envelope': return `env.${s.params?.shape || 'lin'}`
      case 'fractional': return `frac${((s.params?.fraction ?? 0.5) * 100 | 0)}`
      case 'power': return `pow${(s.params?.k ?? 1).toFixed(1)}`
      case 'reshape': return `rsh${(s.params?.factor ?? 1).toFixed(2)}x`
      case 'average': return `avg${s.params?.n || 3}`
      case 'multiply': return 'mul'
      case 'morph': {
        const tag = (s.params?.sourceBId || '').slice(-4)
        const dir = s.params?.direction === 'reverse' ? '←' : '→'
        return `morph${dir}${tag || '?'}`
      }
      default: return s.op
    }
  }
  return pipeline.steps.map(shortOp).join('→')
}
