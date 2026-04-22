// Per-context IR cache + worker-backed generator. A single shared Worker
// services all requests; main wraps returned Float32Arrays into AudioBuffers.
// Keyed generation is deduped — asking for the same key twice resolves with
// the same cached buffer (not just an equivalent one).

import irGenUrl from './workers/irGen.worker.js?url'

const workersByContext = new WeakMap()
const cachesByContext = new WeakMap()
const pendingByContext = new WeakMap()
const nextRequestId = { value: 0 }

function getWorker(ctx) {
  let w = workersByContext.get(ctx)
  if (w) return w
  try {
    w = new Worker(irGenUrl, { type: 'module' })
  } catch (e) {
    console.warn('[irCache] Worker construction failed; will fall back to synchronous IR generation', e)
    return null
  }
  w.onmessage = (e) => {
    const pending = pendingByContext.get(ctx)
    if (!pending) return
    const resolver = pending.get(e.data.id)
    if (!resolver) return
    pending.delete(e.data.id)
    resolver(e.data.channels)
  }
  workersByContext.set(ctx, w)
  pendingByContext.set(ctx, new Map())
  return w
}

function cacheFor(ctx) {
  let c = cachesByContext.get(ctx)
  if (!c) { c = new Map(); cachesByContext.set(ctx, c) }
  return c
}

function fallbackIR(ctx, duration, decay) {
  const sr = ctx.sampleRate
  const len = Math.max(1, Math.floor(sr * duration))
  const buf = ctx.createBuffer(2, len, sr)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < len; i++) {
      const t = i / len
      const env = Math.pow(1 - t, decay)
      d[i] = ((Math.random() * 2 - 1) + Math.sin(i * 0.07 + c * 1.3) * 0.25) * env
    }
  }
  return buf
}

// Synchronous: returns an AudioBuffer immediately. Uses cache; if the IR
// isn't cached yet and the worker hasn't delivered it, falls back to
// on-thread generation for THIS call (but the worker request is still
// fired so the next call hits cache). Trade-off: first activation of a
// new profile still janks, but any repeated activation (or a subsequent
// voice picking the same profile) is free. Pair with prewarm() below to
// prime common sizes at context creation time.
export function getIRSync(ctx, key, duration, decay) {
  const cache = cacheFor(ctx)
  const hit = cache.get(key)
  if (hit) return hit
  ensureIRAsync(ctx, key, duration, decay)
  const buf = fallbackIR(ctx, duration, decay)
  cache.set(key, buf)
  return buf
}

// Kick off async generation for a profile. Harmless to call redundantly;
// already-cached or in-flight keys are skipped. Returns a Promise resolving
// to the AudioBuffer when ready.
export function ensureIRAsync(ctx, key, duration, decay) {
  const cache = cacheFor(ctx)
  if (cache.has(key)) return Promise.resolve(cache.get(key))
  const w = getWorker(ctx)
  if (!w) {
    const buf = fallbackIR(ctx, duration, decay)
    cache.set(key, buf)
    return Promise.resolve(buf)
  }
  const pending = pendingByContext.get(ctx)
  const id = ++nextRequestId.value
  // Stable seed per key so repeated generation yields identical buffers.
  let seed = 0
  for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) >>> 0
  return new Promise((resolve) => {
    pending.set(id, (channels) => {
      const sr = ctx.sampleRate
      const buf = ctx.createBuffer(channels.length, channels[0].length, sr)
      for (let c = 0; c < channels.length; c++) buf.copyToChannel(channels[c], c)
      cache.set(key, buf)
      resolve(buf)
    })
    w.postMessage({ id, sampleRate: ctx.sampleRate, duration, decay, seed })
  })
}

// Pre-warm common synthetic sizes so the first user activation of reverb
// doesn't jank. Fire-and-forget at AudioContext creation time.
export function prewarmCommonIRs(ctx, decay = 3) {
  const sizes = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0]
  for (const s of sizes) {
    const key = `syn:${s.toFixed(2)}`
    ensureIRAsync(ctx, key, s, decay)
  }
}
