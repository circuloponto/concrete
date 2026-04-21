class NoopProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]
    if (!input || input.length === 0) return true
    for (let c = 0; c < output.length; c++) {
      const inCh = input[c] || input[0]
      const outCh = output[c]
      if (inCh) outCh.set(inCh)
      else outCh.fill(0)
    }
    return true
  }
}

registerProcessor('noop', NoopProcessor)
