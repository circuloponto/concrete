// Per-modulator LFO worklet attachment. Replaces applyModulation's
// main-thread .value = x writes for the subset of modulator targets that
// are a single AudioParam with no scale transform. Each enabled routable
// modulator gets its own lfo worklet node connected directly to the
// target AudioParam; summation with the AudioParam's base .value yields
// the final value on the audio thread.

const WAVE_CODES = { sine: 0, triangle: 1, square: 2, saw: 3, ramp: 4, random: 5 }

// Map modulator key → (nodesRef.current) => AudioParam. Only non-lazy
// single-AudioParam targets belong here. Lazy targets (ringOsc, wowLfo,
// flangerLfo, tremoloLfo, panLfo) and multi-param targets (ringAmount,
// tremDepth) stay on the main-thread rAF.
export const LFO_TARGETS = {
  filterHz: (n) => n?.filter?.frequency,
  filterQ: (n) => n?.filter?.Q,
  reverbWet: (n) => n?.reverbWetGain?.gain,
  wet: (n) => n?.tapeWetGain?.gain,
  panCenter: (n) => n?.autoPan?.pan,
  voiceGain: (n) => n?.master?.gain,
  delayTime: (n) => n?.tapeDelay?.delayTime,
  delayFb: (n) => n?.tapeFbGain?.gain,
}

export function attachLfo(ctx, target, baseValue, modConfig, spec) {
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
  p.get('depth').value = (modConfig.depth || 0) * (range / 2)
  p.get('offset').value = 0
  try { target.cancelScheduledValues?.(ctx.currentTime) } catch {}
  target.value = baseValue
  node.connect(target)
  return {
    node,
    target,
    update(nextConfig, nextBase) {
      const np = node.parameters
      np.get('wave').value = WAVE_CODES[nextConfig.wave || 'sine'] ?? 0
      np.get('rate').value = nextConfig.rate || 1
      np.get('phase').value = nextConfig.phase || 0
      np.get('depth').value = (nextConfig.depth || 0) * (range / 2)
      if (target.value !== nextBase) target.value = nextBase
    },
    detach(finalBase) {
      try { node.disconnect() } catch {}
      try { target.value = finalBase } catch {}
    },
  }
}
