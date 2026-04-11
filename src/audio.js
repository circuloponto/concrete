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

// Render a multitrack arrangement to an AudioBuffer via OfflineAudioContext.
// tracks: array of arrays of clips {poolId, offset, sourceStart, sourceEnd, fadeIn, fadeOut, gain}
// getBuffer: (poolId) => AudioBuffer
export async function renderArrangement(tracks, getBuffer, duration) {
  if (!duration || duration <= 0) duration = 0.1
  const sampleRate = 44100
  const numCh = 2
  const offline = new OfflineAudioContext(numCh, Math.ceil(duration * sampleRate), sampleRate)
  for (const track of tracks) {
    for (const clip of track) {
      const buf = getBuffer(clip.poolId)
      if (!buf) continue
      const src = offline.createBufferSource()
      src.buffer = buf
      const gain = offline.createGain()
      const clipLen = Math.max(0.001, clip.sourceEnd - clip.sourceStart)
      const fi = Math.min(clip.fadeIn || 0, clipLen / 2)
      const fo = Math.min(clip.fadeOut || 0, clipLen / 2)
      const g = clip.gain ?? 1
      const start = clip.offset
      gain.gain.setValueAtTime(fi > 0 ? 0 : g, start)
      if (fi > 0) gain.gain.linearRampToValueAtTime(g, start + fi)
      if (fo > 0) {
        gain.gain.setValueAtTime(g, start + clipLen - fo)
        gain.gain.linearRampToValueAtTime(0, start + clipLen)
      }
      src.connect(gain).connect(offline.destination)
      src.start(start, clip.sourceStart, clipLen)
    }
  }
  return await offline.startRendering()
}

export function computeArrangementDuration(tracks) {
  let max = 0
  for (const track of tracks) {
    for (const clip of track) {
      const end = clip.offset + (clip.sourceEnd - clip.sourceStart)
      if (end > max) max = end
    }
  }
  return max
}
