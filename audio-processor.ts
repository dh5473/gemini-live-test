/// <reference lib="webworker" />

// Augment the global scope to include AudioWorklet-related types
declare global {
  class AudioWorkletProcessor {
    readonly port: MessagePort;
    constructor(options?: AudioWorkletNodeOptions);
  }
  function registerProcessor(
    name: string,
    processorCtor: new (
      options?: AudioWorkletNodeOptions
    ) => AudioWorkletProcessor
  ): void;
}

class AudioProcessor extends AudioWorkletProcessor {
  private buffer = new Float32Array(4096);
  private bufferIndex = 0;

  process(inputs: Float32Array[][]): boolean {
    const inputChannel = inputs[0]?.[0];

    if (!inputChannel) {
      return true;
    }

    // Append new data to the buffer.
    const remainingSpace = this.buffer.length - this.bufferIndex;
    if (inputChannel.length > remainingSpace) {
      const dataToCopy = inputChannel.subarray(0, remainingSpace);
      this.buffer.set(dataToCopy, this.bufferIndex);
      this.bufferIndex += dataToCopy.length;
    } else {
      this.buffer.set(inputChannel, this.bufferIndex);
      this.bufferIndex += inputChannel.length;
    }

    // If buffer is full, send it and reset.
    if (this.bufferIndex >= this.buffer.length) {
      // Send a copy of the buffer.
      this.port.postMessage(this.buffer.slice(0));
      this.bufferIndex = 0;
    }

    return true;
  }
}

registerProcessor("audio-processor", AudioProcessor);
