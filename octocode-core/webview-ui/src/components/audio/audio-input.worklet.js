/* global AudioWorkletProcessor, registerProcessor */

class OctoCodeAudioInput extends AudioWorkletProcessor {
	process(inputs) {
		const samples = inputs[0]?.[0]
		if (samples?.length) {
			const copy = samples.slice()
			this.port.postMessage(copy.buffer, [copy.buffer])
		}
		return true
	}
}

registerProcessor("octocode-audio-input", OctoCodeAudioInput)
