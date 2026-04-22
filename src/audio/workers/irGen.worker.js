// Reverb IR generator — runs the same formula as makeReverbIR() in
// audio.js but on a Worker thread so the main thread stays responsive
// when reverb gets activated. On low-end Android / iOS a 3-second IR
// at 44.1 kHz was measured at 30–80 ms of jank; moving it here takes
// that to zero main-thread cost.
//
// Protocol: main posts {id, sampleRate, duration, decay, seed?}, worker
// posts back {id, channels: [Float32Array, Float32Array]} with the
// ArrayBuffers transferred.

// Deterministic PRNG so repeated same-key generation produces the same
// IR (matters for the profile-dedup cache — identical keys must yield
// identical buffers).
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

self.onmessage = (e) => {
  const { id, sampleRate, duration, decay, seed } = e.data
  const len = Math.max(1, Math.floor(sampleRate * duration))
  const rng = mulberry32(seed || 0x9E3779B9)
  const chans = []
  for (let c = 0; c < 2; c++) {
    const d = new Float32Array(len)
    for (let i = 0; i < len; i++) {
      const t = i / len
      const env = Math.pow(1 - t, decay)
      d[i] = ((rng() * 2 - 1) + Math.sin(i * 0.07 + c * 1.3) * 0.25) * env
    }
    chans.push(d)
  }
  self.postMessage({ id, channels: chans }, chans.map(c => c.buffer))
}
