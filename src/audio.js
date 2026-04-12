export async function decodeFile(file, ctx) {
  const arr = await file.arrayBuffer()
  return await ctx.decodeAudioData(arr)
}

export function encodeWAV(buffer) {
  const numChannels = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate
  const length = buffer.length * numChannels * 2 + 44
  const view = new DataView(new ArrayBuffer(length))
  let offset = 0
  const writeString = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i)) }
  writeString('RIFF')
  view.setUint32(offset, length - 8, true); offset += 4
  writeString('WAVE')
  writeString('fmt ')
  view.setUint32(offset, 16, true); offset += 4
  view.setUint16(offset, 1, true); offset += 2
  view.setUint16(offset, numChannels, true); offset += 2
  view.setUint32(offset, sampleRate, true); offset += 4
  view.setUint32(offset, sampleRate * numChannels * 2, true); offset += 4
  view.setUint16(offset, numChannels * 2, true); offset += 2
  view.setUint16(offset, 16, true); offset += 2
  writeString('data')
  view.setUint32(offset, buffer.length * numChannels * 2, true); offset += 4
  const channels = []
  for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c))
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < numChannels; c++) {
      let s = Math.max(-1, Math.min(1, channels[c][i]))
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
      offset += 2
    }
  }
  return new Uint8Array(view.buffer)
}

export function bufferToBase64(buffer) {
  const wav = encodeWAV(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < wav.length; i += chunk) {
    binary += String.fromCharCode.apply(null, wav.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export async function base64ToBuffer(b64, ctx) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return await ctx.decodeAudioData(bytes.buffer)
}

export function makeReverbIR(ctx, duration = 1.8, decay = 3) {
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

export function makeSaturationCurve(amount) {
  const n = 2048
  const curve = new Float32Array(n)
  const k = Math.max(0, amount) * 80
  for (let i = 0; i < n; i++) {
    const x = (i / n) * 2 - 1
    curve[i] = k > 0 ? (1 + k) * x / (1 + k * Math.abs(x)) : x
  }
  return curve
}

export function reverseBuffer(buffer, ctx) {
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c)
    const dst = out.getChannelData(c)
    for (let i = 0; i < src.length; i++) dst[i] = src[src.length - 1 - i]
  }
  return out
}

export function downloadWav(buffer, name) {
  const wav = encodeWAV(buffer)
  const blob = new Blob([wav], { type: 'audio/wav' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name || 'render.wav'
  a.click()
  URL.revokeObjectURL(url)
}

// Numeric fade-curve helpers — `power` controls the shape (1 = linear,
// > 1 slow start fast finish, < 1 fast start slow finish). Accepts legacy
// string presets too (linear/exp/log/scurve) for backward compat.
function curveToPower(c) {
  if (typeof c === 'number' && c > 0) return c
  switch (c) {
    case 'exp': return 2.5
    case 'log': return 0.4
    case 'scurve': return 1.6
    default: return 1
  }
}

export function makeFadeInCurve(toValue, steps, curve) {
  const p = curveToPower(curve)
  const arr = new Float32Array(steps)
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1)
    arr[i] = Math.pow(t, p) * toValue
  }
  return arr
}

export function makeFadeOutCurve(fromValue, steps, curve) {
  const p = curveToPower(curve)
  const arr = new Float32Array(steps)
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1)
    arr[i] = (1 - Math.pow(t, p)) * fromValue
  }
  return arr
}

// True playable length of a clip — clamped to what the buffer actually provides.
export function clipPlayLen(clip, getBuffer) {
  const wanted = Math.max(0, (clip.sourceEnd || 0) - (clip.sourceStart || 0))
  if (!getBuffer) return wanted
  const buf = getBuffer(clip.poolId)
  if (!buf) return wanted
  const available = Math.max(0, buf.duration - (clip.sourceStart || 0))
  return Math.min(wanted, available)
}

// Tracks may be in new shape {clips, mute, solo, gain, pan} or legacy [clips].
function normalizeTracks(tracks) {
  return tracks.map(t => Array.isArray(t)
    ? { clips: t, mute: false, solo: false, gain: 1, pan: 0 }
    : { mute: false, solo: false, gain: 1, pan: 0, ...t, clips: t.clips || [] }
  )
}

export async function renderArrangement(tracks, getBuffer, duration) {
  if (!duration || duration <= 0) duration = 0.1
  const sampleRate = 44100
  const numCh = 2
  const offline = new OfflineAudioContext(numCh, Math.ceil(duration * sampleRate), sampleRate)
  const norm = normalizeTracks(tracks)
  const anySolo = norm.some(t => t.solo)
  for (const track of norm) {
    if (track.mute) continue
    if (anySolo && !track.solo) continue
    const trackGain = offline.createGain()
    trackGain.gain.value = track.gain ?? 1
    const panner = offline.createStereoPanner()
    panner.pan.value = track.pan ?? 0
    trackGain.connect(panner).connect(offline.destination)
    for (const clip of track.clips) {
      const buf = getBuffer(clip.poolId)
      if (!buf) continue
      const src = offline.createBufferSource()
      src.buffer = buf
      const gain = offline.createGain()
      const clipLen = Math.max(0.001, clipPlayLen(clip, getBuffer))
      const fi = Math.min(clip.fadeIn || 0, clipLen / 2)
      const fo = Math.min(clip.fadeOut || 0, clipLen / 2)
      const g = clip.gain ?? 1
      const start = clip.offset
      // fade in
      if (fi > 0) {
        gain.gain.setValueCurveAtTime(makeFadeInCurve(g, 32, clip.fadeInCurve), start, fi)
      } else {
        gain.gain.setValueAtTime(g, start)
      }
      // body
      if (fi + fo < clipLen) gain.gain.setValueAtTime(g, start + Math.max(fi, 0.0001))
      // fade out
      if (fo > 0) {
        gain.gain.setValueCurveAtTime(makeFadeOutCurve(g, 32, clip.fadeOutCurve), start + clipLen - fo, fo)
      }
      src.connect(gain).connect(trackGain)
      src.start(start, clip.sourceStart, clipLen)
    }
  }
  return await offline.startRendering()
}

export function computeArrangementDuration(tracks, getBuffer) {
  const norm = normalizeTracks(tracks)
  let max = 0
  for (const track of norm) {
    for (const clip of track.clips) {
      const len = getBuffer ? clipPlayLen(clip, getBuffer) : Math.max(0, clip.sourceEnd - clip.sourceStart)
      const end = (clip.offset || 0) + len
      if (end > max) max = end
    }
  }
  return max
}
