/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { Blob } from "@google/genai";

// Defines the Gemini model types
enum GeminiModel {
  GEMINI_2_5_FLASH_PREVIEW_NATIVE_AUDIO = "gemini-2.5-flash-preview-native-audio-dialog",
  GEMINI_LIVE_2_5_FLASH_PREVIEW = "gemini-live-2.5-flash-preview",
  GEMINI_2_0_FLASH_LIVE_001 = "gemini-2.0-flash-live-001",
}

// Live API pricing information (USD per 1M tokens)
const GEMINI_PRICE_RATIO = {
  [GeminiModel.GEMINI_2_5_FLASH_PREVIEW_NATIVE_AUDIO]: {
    input: {
      text: 0.5 / 1_000_000,
      audio: 3.0 / 1_000_000,
    },
    output: {
      text: 2.0 / 1_000_000,
      audio: 12.0 / 1_000_000,
    },
  },
  [GeminiModel.GEMINI_LIVE_2_5_FLASH_PREVIEW]: {
    input: {
      text: 0.5 / 1_000_000,
      audio: 3.0 / 1_000_000,
    },
    output: {
      text: 2.0 / 1_000_000,
      audio: 12.0 / 1_000_000,
    },
  },
  [GeminiModel.GEMINI_2_0_FLASH_LIVE_001]: {
    input: {
      text: 0.35 / 1_000_000,
      audio: 2.1 / 1_000_000,
    },
    output: {
      text: 1.5 / 1_000_000,
      audio: 8.5 / 1_000_000,
    },
  },
};

interface TokenDetail {
  modality: "TEXT" | "AUDIO";
  token_count: number;
}

interface TokenUsage {
  prompt_tokens_details?: TokenDetail[];
  response_tokens_details?: TokenDetail[];
}

interface CostBreakdown {
  input_cost: number;
  output_cost: number;
  total_cost: number;
  input_text_tokens: number;
  input_audio_tokens: number;
  output_text_tokens: number;
  output_audio_tokens: number;
}

/**
 * Extracts the number of text and audio tokens from token details.
 */
function extractTokensByModality(
  tokensDetails?: TokenDetail[]
): [number, number] {
  let textTokens = 0;
  let audioTokens = 0;
  if (tokensDetails) {
    for (const detail of tokensDetails) {
      if (detail.modality === "TEXT") {
        textTokens += detail.token_count;
      } else if (detail.modality === "AUDIO") {
        audioTokens += detail.token_count;
      }
    }
  }
  return [textTokens, audioTokens];
}

/**
 * Calculates the cost of a Gemini API response.
 */
function calculateCostInDollar(
  model: string,
  tokenUsage: TokenUsage
): CostBreakdown {
  // Convert model name to enum
  let geminiModel: GeminiModel;
  if (model === GeminiModel.GEMINI_2_5_FLASH_PREVIEW_NATIVE_AUDIO) {
    geminiModel = GeminiModel.GEMINI_2_5_FLASH_PREVIEW_NATIVE_AUDIO;
  } else if (model === GeminiModel.GEMINI_LIVE_2_5_FLASH_PREVIEW) {
    geminiModel = GeminiModel.GEMINI_LIVE_2_5_FLASH_PREVIEW;
  } else {
    geminiModel = GeminiModel.GEMINI_2_0_FLASH_LIVE_001;
  }

  // Input tokens
  const [inputTextTokens, inputAudioTokens] = extractTokensByModality(
    tokenUsage.prompt_tokens_details
  );
  // Output tokens
  const [outputTextTokens, outputAudioTokens] = extractTokensByModality(
    tokenUsage.response_tokens_details
  );

  // Pricing info
  const price = GEMINI_PRICE_RATIO[geminiModel];

  const inputCost =
    inputTextTokens * price.input.text + inputAudioTokens * price.input.audio;
  const outputCost =
    outputTextTokens * price.output.text +
    outputAudioTokens * price.output.audio;
  const totalCost = inputCost + outputCost;

  return {
    input_cost: inputCost,
    output_cost: outputCost,
    total_cost: totalCost,
    input_text_tokens: inputTextTokens,
    input_audio_tokens: inputAudioTokens,
    output_text_tokens: outputTextTokens,
    output_audio_tokens: outputAudioTokens,
  };
}

/**
 * Estimates the number of tokens based on the audio data size.
 * (The actual token count should be confirmed from the API response)
 */
function estimateAudioTokens(audioDataSize: number): number {
  // Approximate estimation: about 75 tokens per second (based on 16kHz)
  // A more precise calculation may be needed in practice
  const approximateSecondsPerByte = 1 / (16000 * 2); // 16kHz, 16bit
  const seconds = audioDataSize * approximateSecondsPerByte;
  return Math.ceil(seconds * 75);
}

function encode(bytes: Uint8Array) {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function createBlob(data: Float32Array): Blob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    // convert float32 -1 to 1 to int16 -32768 to 32767
    int16[i] = data[i] * 32768;
  }

  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: "audio/pcm;rate=16000",
  };
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number
): Promise<AudioBuffer> {
  const buffer = ctx.createBuffer(
    numChannels,
    data.length / 2 / numChannels,
    sampleRate
  );

  const dataInt16 = new Int16Array(data.buffer);
  const l = dataInt16.length;
  const dataFloat32 = new Float32Array(l);
  for (let i = 0; i < l; i++) {
    dataFloat32[i] = dataInt16[i] / 32768.0;
  }
  // Extract interleaved channels
  if (numChannels === 1) {
    buffer.copyToChannel(dataFloat32, 0);
  } else {
    for (let i = 0; i < numChannels; i++) {
      const channel = dataFloat32.filter(
        (_, index) => index % numChannels === i
      );
      buffer.copyToChannel(channel, i);
    }
  }

  return buffer;
}

export {
  createBlob,
  decode,
  decodeAudioData,
  encode,
  calculateCostInDollar,
  estimateAudioTokens,
  GeminiModel,
  type TokenUsage,
  type CostBreakdown,
};
