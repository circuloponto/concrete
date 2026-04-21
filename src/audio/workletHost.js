// `?url` tells Vite to emit the file as a static asset and hand us the
// fingerprinted URL. `?worker` would wrap it as a Web Worker — wrong for
// AudioWorklets, which load via ctx.audioWorklet.addModule(url).
import noopUrl from './worklets/noop.worklet.js?url'
import granulatorUrl from './worklets/granulator.worklet.js?url'
import dopplerUrl from './worklets/doppler.worklet.js?url'
import bandDopplerUrl from './worklets/bandDoppler.worklet.js?url'

const WORKLET_URLS = {
  noop: noopUrl,
  granulator: granulatorUrl,
  doppler: dopplerUrl,
  bandDoppler: bandDopplerUrl,
}

const readyByContext = new WeakMap()
const readyFlagByContext = new WeakMap()

export function isWorkletEnabled() {
  if (typeof window === 'undefined') return false
  if (window.__contreteWorklets === false) return false
  if (window.__contreteWorklets === true) return true
  return !!import.meta.env.DEV
}

export function registerWorklet(name, url) {
  WORKLET_URLS[name] = url
}

export function ensureWorklets(ctx) {
  if (!ctx || !ctx.audioWorklet) return Promise.resolve({ loaded: false, reason: 'no-audioworklet' })
  const cached = readyByContext.get(ctx)
  if (cached) return cached
  const names = Object.keys(WORKLET_URLS)
  const promise = Promise.all(
    names.map(name =>
      ctx.audioWorklet.addModule(WORKLET_URLS[name])
        .then(() => ({ name, ok: true }))
        .catch(err => ({ name, ok: false, err }))
    )
  ).then(results => {
    const failed = results.filter(r => !r.ok)
    if (failed.length) {
      console.warn('[workletHost] some worklets failed to load', failed)
    }
    readyFlagByContext.set(ctx, failed.length === 0)
    return { loaded: failed.length === 0, results }
  })
  readyByContext.set(ctx, promise)
  return promise
}

export function isWorkletReady(ctx) {
  return !!readyFlagByContext.get(ctx)
}
