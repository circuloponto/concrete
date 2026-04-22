// Per-modulator LFO worklet attachment. Replaces applyModulation's
// main-thread .value = x writes for the subset of modulator targets that
// are a single AudioParam with no scale transform. Each enabled routable
// modulator gets its own lfo worklet node connected directly to the
// target AudioParam; summation with the AudioParam's base .value yields
// the final value on the audio thread.

const WAVE_CODES = { sine: 0, triangle: 1, square: 2, saw: 3, ramp: 4, random: 5 }

// Map modulator key → { target, scale?, applyBase? }. Only non-lazy
// single-AudioParam targets. Lazy targets (ringOsc, wowLfo, flangerLfo,
// tremoloLfo, panLfo) and multi-param targets (ringAmount, tremDepth)
// stay on the main-thread rAF — their apply functions aren't a plain
// param.value write.
//
// - target(nodes): AudioParam resolver
// - scale: optional coefficient applied to BOTH the base value and the
//   LFO depth, matching modulation.js apply transforms like `val * 0.002`
//   for flangerDepth. Without this the base and the modulation would
//   live at different magnitudes.
export const LFO_TARGETS = {
  filterHz: { target: (n) => n?.filter?.frequency },
  filterQ: { target: (n) => n?.filter?.Q },
  reverbWet: { target: (n) => n?.reverbWetGain?.gain },
  wet: { target: (n) => n?.tapeWetGain?.gain },
  panCenter: { target: (n) => n?.autoPan?.pan },
  voiceGain: { target: (n) => n?.master?.gain },
  delayTime: { target: (n) => n?.tapeDelay?.delayTime },
  delayFb: { target: (n) => n?.tapeFbGain?.gain },
  flangerMix: { target: (n) => n?.flangerMixGain?.gain },
  flangerFb: { target: (n) => n?.flangerFbGain?.gain },
  freezeMix: { target: (n) => n?.freezeMixGain?.gain },
  flangerDepth: { target: (n) => n?.flangerDepthGain?.gain, scale: 0.002 },
  wowDepth: { target: (n) => n?.wowDepthGain?.gain, scale: 0.005 },
}

export function attachLfo(ctx, target, baseValue, modConfig, spec, scale = 1) {
  const node = new AudioWorkletNode(ctx, 'lfo', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  })
  const p = node.parameters
  const range = spec.max - spec.min
  p.get('wave').value = WAVE_CODES[modConfig.wave || 'sine'] ?? 0
  p.get('rate').value = modConfig.rate || 1
  p.get('phase').value = modConfig.phase || 0
  p.get('depth').value = (modConfig.depth || 0) * (range / 2) * scale
  p.get('offset').value = 0
  try { target.cancelScheduledValues?.(ctx.currentTime) } catch {}
  target.value = baseValue * scale
  node.connect(target)
  return {
    node,
    target,
    scale,
    update(nextConfig, nextBase) {
      const np = node.parameters
      np.get('wave').value = WAVE_CODES[nextConfig.wave || 'sine'] ?? 0
      np.get('rate').value = nextConfig.rate || 1
      np.get('phase').value = nextConfig.phase || 0
      np.get('depth').value = (nextConfig.depth || 0) * (range / 2) * scale
      const scaledBase = nextBase * scale
      if (target.value !== scaledBase) target.value = scaledBase
    },
    detach(finalBase) {
      try { node.disconnect() } catch {}
      try { target.value = finalBase * scale } catch {}
    },
  }
}
