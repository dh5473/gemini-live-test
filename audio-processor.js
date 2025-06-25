class AudioProcessor extends AudioWorkletProcessor {
  buffer = new Float32Array(4096);
  bufferIndex = 0;

  process(inputs) {
    const input = inputs[0];
    if (!input) {
      return true;
    }
    const inputChannel = input[0];

    if (inputChannel) {
      // Append new data to the buffer
      const remainingSpace = this.buffer.length - this.bufferIndex;
      if (inputChannel.length > remainingSpace) {
        // Handle oversized input which shouldn't really happen with standard sizes
        const dataToCopy = inputChannel.subarray(0, remainingSpace);
        this.buffer.set(dataToCopy, this.bufferIndex);
        this.bufferIndex += dataToCopy.length;
      } else {
        this.buffer.set(inputChannel, this.bufferIndex);
        this.bufferIndex += inputChannel.length;
      }

      // If buffer is full, send it and reset
      if (this.bufferIndex >= this.buffer.length) {
        // Send a copy of the buffer
        this.port.postMessage(this.buffer.slice(0));
        this.bufferIndex = 0;
      }
    }

    return true; // Keep the processor alive
  }
}

registerProcessor("audio-processor", AudioProcessor);
