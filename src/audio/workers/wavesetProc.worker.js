// Waveset processor — runs Wishart-style operations on AudioBuffer-shaped
// Float32Array channels. Offline, Worker-threaded so main stays responsive.
//
// Protocol:
//   main → worker: {id, channels, sampleRate, lpCutoff, groupSize, steps}
//     channels: Float32Array[] (transferable)
//     lpCutoff: number | null  (Hz; null = skip prefilter)
//     groupSize: 1..16
//     steps: [{ op, params }]
//   worker → main: {id, channels, error?}
//
// Waveset = segment between every OTHER upward zero-crossing (Wishart):
// one positive + one negative excursion. Groups = groupSize wavesets.

const MAX_OUTPUT_SEC = 60  // cap to prevent repeat(16) of a long source from eating the heap
const SILENCE_EPS = 1e-6

// ────────────────────────────────────────────────────────────────────────
// Utilities

function mono(channels) {
  // Always returns a fresh buffer. Critical: the detection path runs
  // lowpassInPlace on this result, so returning channels[0] by reference
  // on mono sources would trash the original sample data.
  const n = channels[0].length
  const out = new Float32Array(n)
  if (channels.length === 1) {
    out.set(channels[0])
    return out
  }
  const gain = 1 / channels.length
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c]
    for (let i = 0; i < n; i++) out[i] += ch[i] * gain
  }
  return out
}

// One-pole lowpass (RC-style). Used only for ZC detection on a mono copy.
function lowpassInPlace(buf, cutoffHz, sampleRate) {
  const rc = 1 / (2 * Math.PI * cutoffHz)
  const dt = 1 / sampleRate
  const alpha = dt / (rc + dt)
  let prev = 0
  for (let i = 0; i < buf.length; i++) {
    prev = prev + alpha * (buf[i] - prev)
    buf[i] = prev
  }
}

function detectWavesets(monoChannel) {
  // Upward zero-crossings. Pair every two into one waveset.
  const zcs = []
  for (let i = 1; i < monoChannel.length; i++) {
    if (monoChannel[i - 1] < 0 && monoChannel[i] >= 0) zcs.push(i)
  }
  const wavesets = []
  for (let k = 0; k + 2 <= zcs.length; k += 2) {
    wavesets.push({ start: zcs[k], end: zcs[k + 2] })
  }
  if (wavesets.length === 0 && monoChannel.length > 0) {
    wavesets.push({ start: 0, end: monoChannel.length })
  }
  return wavesets
}

function buildGroups(wavesets, groupSize) {
  const groups = []
  for (let g = 0; g < wavesets.length; g += groupSize) {
    const first = wavesets[g]
    const last = wavesets[Math.min(g + groupSize - 1, wavesets.length - 1)]
    groups.push({
      start: first.start,
      end: last.end,
      wavesetCount: Math.min(groupSize, wavesets.length - g),
    })
  }
  return groups
}

function detectGroups(channels, lpCutoff, groupSize, sampleRate) {
  const m = mono(channels)
  if (lpCutoff != null && lpCutoff > 0) lowpassInPlace(m, lpCutoff, sampleRate)
  const wavesets = detectWavesets(m)
  return buildGroups(wavesets, groupSize)
}

// Allocate a fresh output of given length, zeroed, matching channel count.
function allocChannels(numCh, length) {
  const out = new Array(numCh)
  for (let c = 0; c < numCh; c++) out[c] = new Float32Array(length)
  return out
}

// Linear-interp resample: read `src[start..end]` stretched/squished to `dstLen`.
function resampleRange(src, start, end, dst, dstStart, dstLen) {
  const srcLen = end - start
  if (srcLen <= 0 || dstLen <= 0) return
  if (srcLen === dstLen) {
    for (let i = 0; i < dstLen; i++) dst[dstStart + i] = src[start + i]
    return
  }
  for (let i = 0; i < dstLen; i++) {
    const srcPos = (i / dstLen) * srcLen
    const s0 = start + Math.floor(srcPos)
    const s1 = Math.min(end - 1, s0 + 1)
    const frac = srcPos - Math.floor(srcPos)
    dst[dstStart + i] = src[s0] * (1 - frac) + src[s1] * frac
  }
}

function groupRMS(channels, start, end) {
  let sum = 0
  let count = 0
  for (let c = 0; c < channels.length; c++) {
    for (let i = start; i < end; i++) {
      const s = channels[c][i]
      sum += s * s
      count++
    }
  }
  return count > 0 ? Math.sqrt(sum / count) : 0
}

function groupPeak(channels, start, end) {
  let peak = 0
  for (let c = 0; c < channels.length; c++) {
    for (let i = start; i < end; i++) {
      const a = Math.abs(channels[c][i])
      if (a > peak) peak = a
    }
  }
  return peak
}

// Deterministic PRNG so shuffle is reproducible per pipeline run.
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

// ────────────────────────────────────────────────────────────────────────
// Length-preserving ops: mutate channels in place over each group.

function opReverse(channels, groups) {
  for (const g of groups) {
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c]
      let lo = g.start, hi = g.end - 1
      while (lo < hi) {
        const tmp = ch[lo]; ch[lo] = ch[hi]; ch[hi] = tmp
        lo++; hi--
      }
    }
  }
}

function opInvert(channels, groups) {
  for (const g of groups) {
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c]
      for (let i = g.start; i < g.end; i++) ch[i] = -ch[i]
    }
  }
}

function opNormalize(channels, groups) {
  for (const g of groups) {
    const peak = groupPeak(channels, g.start, g.end)
    if (peak < SILENCE_EPS) continue
    const inv = 1 / peak
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c]
      for (let i = g.start; i < g.end; i++) ch[i] *= inv
    }
  }
}

function opEnvelope(channels, groups, shape) {
  for (const g of groups) {
    const len = g.end - g.start
    if (len <= 0) continue
    for (let i = 0; i < len; i++) {
      const t = i / len
      let env
      if (shape === 'gauss') {
        // Bell centered at middle, σ = 0.25
        const x = (t - 0.5) / 0.25
        env = Math.exp(-0.5 * x * x)
      } else if (shape === 'expDecay') {
        env = Math.exp(-3 * t)
      } else {
        // linear (decay ramp 1 → 0)
        env = 1 - t
      }
      for (let c = 0; c < channels.length; c++) {
        channels[c][g.start + i] *= env
      }
    }
  }
}

function opPower(channels, groups, k) {
  for (const g of groups) {
    const peak = groupPeak(channels, g.start, g.end)
    if (peak < SILENCE_EPS) continue
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c]
      for (let i = g.start; i < g.end; i++) {
        const s = ch[i]
        ch[i] = s >= 0 ? Math.pow(s, k) : -Math.pow(-s, k)
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Length-changing ops: allocate new channel arrays.

function opRepeat(channels, groups, n, sampleRate) {
  const cap = Math.floor(MAX_OUTPUT_SEC * sampleRate)
  let totalLen = 0
  for (const g of groups) totalLen += (g.end - g.start) * n
  totalLen = Math.min(totalLen, cap)

  const out = allocChannels(channels.length, totalLen)
  let wp = 0
  for (const g of groups) {
    const len = g.end - g.start
    for (let r = 0; r < n; r++) {
      if (wp + len > totalLen) break
      for (let c = 0; c < channels.length; c++) {
        out[c].set(channels[c].subarray(g.start, g.end), wp)
      }
      wp += len
    }
    if (wp >= totalLen) break
  }
  return out
}

function opOmit(channels, groups, keepEvery) {
  let totalLen = 0
  for (let i = 0; i < groups.length; i += keepEvery) {
    totalLen += groups[i].end - groups[i].start
  }
  const out = allocChannels(channels.length, totalLen)
  let wp = 0
  for (let i = 0; i < groups.length; i += keepEvery) {
    const g = groups[i]
    const len = g.end - g.start
    for (let c = 0; c < channels.length; c++) {
      out[c].set(channels[c].subarray(g.start, g.end), wp)
    }
    wp += len
  }
  return out
}

function opShuffle(channels, groups, windowSize, seed = 0x9E3779B9) {
  const rng = mulberry32(seed)
  const totalLen = channels[0].length
  const out = allocChannels(channels.length, totalLen)
  const order = []
  for (let w = 0; w < groups.length; w += windowSize) {
    const windowEnd = Math.min(w + windowSize, groups.length)
    const indices = []
    for (let i = w; i < windowEnd; i++) indices.push(i)
    // Fisher-Yates with seeded rng
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const tmp = indices[i]; indices[i] = indices[j]; indices[j] = tmp
    }
    order.push(...indices)
  }
  let wp = 0
  for (const gi of order) {
    const g = groups[gi]
    const len = g.end - g.start
    for (let c = 0; c < channels.length; c++) {
      out[c].set(channels[c].subarray(g.start, g.end), wp)
    }
    wp += len
  }
  return out
}

function opFractional(channels, groups, fraction) {
  // Length-preserving in total, but each group's tail is zeroed.
  // Keeping the total length stable makes subsequent ops simpler; if the
  // user wanted true length-compression they can follow with `omit`.
  const out = allocChannels(channels.length, channels[0].length)
  for (const g of groups) {
    const len = g.end - g.start
    const keep = Math.max(0, Math.floor(len * fraction))
    for (let c = 0; c < channels.length; c++) {
      out[c].set(channels[c].subarray(g.start, g.start + keep), g.start)
      // Rest is already zero from allocChannels.
    }
  }
  return out
}

// harmonic + waveSub share the per-group-shape-substitute pattern.
function shapeFn(name, phase) {
  // phase ∈ [0, 1)
  if (name === 'sine') return Math.sin(phase * 2 * Math.PI)
  if (name === 'saw') return phase * 2 - 1
  if (name === 'square') return phase < 0.5 ? 1 : -1
  if (name === 'triangle') return phase < 0.5 ? (phase * 4 - 1) : (3 - phase * 4)
  return 0
}

function opSubstitute(channels, groups, shape) {
  const totalLen = channels[0].length
  const out = allocChannels(channels.length, totalLen)
  for (const g of groups) {
    const len = g.end - g.start
    if (len <= 0) continue
    const amp = groupRMS(channels, g.start, g.end) * Math.SQRT2  // RMS → peak for a sine
    // Period ≈ len / wavesetCount (each waveset ≈ one cycle of the fundamental)
    const cyclesInGroup = Math.max(1, g.wavesetCount)
    for (let i = 0; i < len; i++) {
      const phase = ((i / len) * cyclesInGroup) % 1
      const s = shapeFn(shape, phase) * amp
      for (let c = 0; c < channels.length; c++) {
        out[c][g.start + i] = s
      }
    }
  }
  return out
}

// Neighbor-interaction ops: length-preserving.
function opAverage(channels, groups, n) {
  const out = allocChannels(channels.length, channels[0].length)
  const halfN = Math.floor(n / 2)
  // Per-channel scratch for resampling neighbors to current group length.
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]
    const len = g.end - g.start
    if (len <= 0) continue
    const neighbors = []
    for (let d = -halfN; d <= halfN; d++) {
      const idx = gi + d
      if (idx < 0 || idx >= groups.length) continue
      neighbors.push(groups[idx])
    }
    if (neighbors.length === 0) continue
    const inv = 1 / neighbors.length
    const scratch = new Float32Array(len)
    for (let c = 0; c < channels.length; c++) {
      for (let i = 0; i < len; i++) scratch[i] = 0
      for (const nb of neighbors) {
        const buf = new Float32Array(len)
        resampleRange(channels[c], nb.start, nb.end, buf, 0, len)
        for (let i = 0; i < len; i++) scratch[i] += buf[i] * inv
      }
      for (let i = 0; i < len; i++) out[c][g.start + i] = scratch[i]
    }
  }
  return out
}

function opReshape(channels, groups, factor, sampleRate) {
  // Each group resampled to length * factor samples. Preserves group COUNT
  // (so wavesets stay wavesets) but changes the sample count per waveset —
  // this is Wishart's "transposition by reshaping": factor>1 pitches DOWN
  // and lengthens, factor<1 pitches UP and compresses. Bounded by the 60s
  // output cap.
  const cap = Math.floor(MAX_OUTPUT_SEC * sampleRate)
  const f = Math.max(0.1, Math.min(10, factor))
  let totalOut = 0
  for (const g of groups) totalOut += Math.max(1, Math.floor((g.end - g.start) * f))
  totalOut = Math.min(totalOut, cap)
  const out = allocChannels(channels.length, totalOut)
  let wp = 0
  for (const g of groups) {
    const srcLen = g.end - g.start
    if (srcLen <= 0) continue
    const dstLen = Math.max(1, Math.floor(srcLen * f))
    if (wp + dstLen > totalOut) break
    for (let c = 0; c < channels.length; c++) {
      resampleRange(channels[c], g.start, g.end, out[c], wp, dstLen)
    }
    wp += dstLen
  }
  return out
}

// Warp u ∈ [0,1] → warped u by the requested curve shape. Mirrors the
// shape taxonomy used elsewhere in the app (stutter.worklet, LFO panel)
// but inlined here so the worker stays a single standalone module.
function warpMorphU(u, shape) {
  if (shape === 'geometric') return u * u                         // log-ish: slow start, fast finish
  if (shape === 'exponential') return u * u * u                   // u^3: holds long, snaps hard at end
  if (shape === 'scurve') return 0.5 - 0.5 * Math.cos(u * Math.PI)  // cosine ease: slow at both ends
  return u                                                         // 'linear' (default)
}

// Waveset morph — probabilistic A→B interleave across the output duration.
// For each output group g, compute warped-u ∈ [0,1] at position g/(N-1);
// with probability u pick a group from sourceB (resampled to A's group
// length), else keep A's group. Length-preserving.
function opMorph(channels, groups, sourceBChannels, lpCutoff, groupSize, sampleRate, curveShape, direction) {
  if (!sourceBChannels || !sourceBChannels[0] || sourceBChannels[0].length === 0) return channels
  const bGroups = detectGroups(sourceBChannels, lpCutoff, groupSize, sampleRate)
  if (bGroups.length === 0) return channels
  const totalLen = channels[0].length
  const numCh = channels.length
  const numChB = sourceBChannels.length
  const out = allocChannels(numCh, totalLen)
  const N = groups.length
  const reverse = direction === 'reverse'
  for (let g = 0; g < N; g++) {
    const u = N > 1 ? g / (N - 1) : 0
    const warped = warpMorphU(u, curveShape)
    const t = reverse ? 1 - warped : warped
    const srcGroup = groups[g]
    const srcLen = srcGroup.end - srcGroup.start
    if (srcLen <= 0) continue
    const pickB = Math.random() < t
    if (pickB) {
      const bg = bGroups[g % bGroups.length]
      const bLen = bg.end - bg.start
      if (bLen <= 0) {
        for (let c = 0; c < numCh; c++) {
          out[c].set(channels[c].subarray(srcGroup.start, srcGroup.end), srcGroup.start)
        }
        continue
      }
      for (let c = 0; c < numCh; c++) {
        const bc = c < numChB ? sourceBChannels[c] : sourceBChannels[0]
        resampleRange(bc, bg.start, bg.end, out[c], srcGroup.start, srcLen)
      }
    } else {
      for (let c = 0; c < numCh; c++) {
        out[c].set(channels[c].subarray(srcGroup.start, srcGroup.end), srcGroup.start)
      }
    }
  }
  return out
}

function opMultiply(channels, groups) {
  const out = allocChannels(channels.length, channels[0].length)
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]
    const len = g.end - g.start
    if (len <= 0) continue
    const nbIdx = gi + 1 < groups.length ? gi + 1 : gi - 1
    if (nbIdx < 0) {
      // Only one group — passthrough.
      for (let c = 0; c < channels.length; c++) {
        out[c].set(channels[c].subarray(g.start, g.end), g.start)
      }
      continue
    }
    const nb = groups[nbIdx]
    for (let c = 0; c < channels.length; c++) {
      const nbResampled = new Float32Array(len)
      resampleRange(channels[c], nb.start, nb.end, nbResampled, 0, len)
      for (let i = 0; i < len; i++) {
        out[c][g.start + i] = channels[c][g.start + i] * nbResampled[i]
      }
    }
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────
// Pipeline

const LENGTH_PRESERVING = new Set(['reverse', 'invert', 'normalize', 'envelope', 'power', 'fractional', 'average', 'multiply', 'waveSub', 'harmonic'])
// waveSub/harmonic produce same length as input (per-group substitution), so
// they're length-preserving — but they change sample VALUES fundamentally,
// so re-detecting wavesets after is still useful (new ZCs). We flag them as
// preserving for allocation purposes but force re-detection after.
const FORCE_REDETECT_AFTER = new Set(['waveSub', 'harmonic', 'power', 'invert'])

function runPipeline(initialChannels, sampleRate, lpCutoff, groupSize, steps, progress) {
  let channels = initialChannels
  let groups = detectGroups(channels, lpCutoff, groupSize, sampleRate)

  for (let si = 0; si < steps.length; si++) {
    const step = steps[si]
    const { op, params = {} } = step
    let needsRedetect = false

    switch (op) {
      case 'reverse':
        opReverse(channels, groups)
        break
      case 'invert':
        opInvert(channels, groups)
        needsRedetect = true
        break
      case 'normalize':
        opNormalize(channels, groups)
        break
      case 'envelope':
        opEnvelope(channels, groups, params.shape || 'linear')
        break
      case 'power':
        opPower(channels, groups, Math.max(0.01, params.k ?? 1))
        needsRedetect = true
        break
      case 'fractional':
        channels = opFractional(channels, groups, Math.max(0, Math.min(1, params.fraction ?? 0.5)))
        needsRedetect = true
        break
      case 'repeat':
        channels = opRepeat(channels, groups, Math.max(1, params.n | 0 || 2), sampleRate)
        needsRedetect = true
        break
      case 'omit':
        channels = opOmit(channels, groups, Math.max(2, params.keepEvery | 0 || 2))
        needsRedetect = true
        break
      case 'shuffle':
        channels = opShuffle(channels, groups, Math.max(2, params.windowSize | 0 || 8), params.seed ?? 0x9E3779B9)
        needsRedetect = true
        break
      case 'harmonic':
        channels = opSubstitute(channels, groups, 'sine')
        needsRedetect = true
        break
      case 'waveSub':
        channels = opSubstitute(channels, groups, params.wave || 'saw')
        needsRedetect = true
        break
      case 'average':
        channels = opAverage(channels, groups, Math.max(2, params.n | 0 || 3))
        needsRedetect = true
        break
      case 'multiply':
        channels = opMultiply(channels, groups)
        needsRedetect = true
        break
      case 'reshape':
        channels = opReshape(channels, groups, params.factor ?? 1, sampleRate)
        needsRedetect = true
        break
      case 'morph': {
        const hasB = !!(params.sourceBChannels && params.sourceBChannels[0] && params.sourceBChannels[0].length > 0)
        console.log('[wavesetProc.worker] morph step — sourceBChannels present:', hasB,
          'curve:', params.curveShape, 'direction:', params.direction)
        channels = opMorph(
          channels, groups,
          params.sourceBChannels,
          lpCutoff, groupSize, sampleRate,
          params.curveShape || 'linear',
          params.direction || 'forward',
        )
        needsRedetect = true
        break
      }
      default:
        // Unknown op — skip.
        break
    }

    if (needsRedetect || FORCE_REDETECT_AFTER.has(op)) {
      groups = detectGroups(channels, lpCutoff, groupSize, sampleRate)
    }
    progress && progress((si + 1) / steps.length)
  }

  return channels
}

self.onmessage = (e) => {
  const { id, channels, sampleRate, lpCutoff, groupSize, steps } = e.data
  try {
    const out = runPipeline(
      channels,
      sampleRate,
      lpCutoff,
      Math.max(1, Math.min(16, groupSize | 0 || 1)),
      steps || [],
      (p) => self.postMessage({ id, progress: p }),
    )
    self.postMessage({ id, channels: out }, out.map(c => c.buffer))
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) })
  }
}
