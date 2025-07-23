/// <reference types="vite/client" />
/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  Session,
} from "@google/genai";
import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  createBlob,
  decode,
  decodeAudioData,
  calculateCostInDollar,
  estimateAudioTokens,
  type CostBreakdown,
} from "./utils";
import "./visual-3d";
import audioProcessorUrl from "./audio-processor.ts?url";

interface AppMetadata {
  requestFramePermissions?: string[];
  systemInstruction?: string;
}

@customElement("gdm-live-audio")
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = "";
  @state() error = "";
  @state() costInfo: CostBreakdown | null = null;
  @state() sessionCostTotal = 0;
  @state() estimatedInputTokens = 0;
  @state() textResponses: string[] = [];
  @state() lastResponseType = "";
  @state() recordingStartTime: number | null = null;
  @state() recordingDuration: number = 0;
  @state() selectedModel = "gemini-live-2.5-flash-preview";
  @state() lastChunkTime: number | null = null;
  @state() interruptedUIFlag: boolean = false;
  private receivedAudioBuffers: AudioBuffer[] = [];
  private chunkTimeoutId: number | null = null;

  private client!: GoogleGenAI;
  private session!: Session;
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({ sampleRate: 16000 });
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({ sampleRate: 24000 });
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream?: MediaStream;
  private sourceNode?: MediaStreamAudioSourceNode;
  private audioWorkletNode?: AudioWorkletNode;
  private sources = new Set<AudioBufferSourceNode>();
  private systemInstruction: string | undefined;
  private modelOptions = [
    {
      value: "gemini-live-2.5-flash-preview",
      label: "Gemini Live 2.5 Flash Preview",
    },
    {
      value: "gemini-2.5-flash-preview-native-audio-dialog",
      label: "Gemini 2.5 Flash Preview Native Audio",
    },
  ];

  /**
   * Checks the WebSocket connection status.
   */
  private isWebSocketOpen(): boolean {
    try {
      return (
        this.session &&
        this.session.conn &&
        (this.session.conn as any).ws &&
        (this.session.conn as any).ws.readyState === WebSocket.OPEN
      );
    } catch (error) {
      console.warn("Error checking WebSocket state:", error);
      return false;
    }
  }

  /**
   * Attempts to reconnect the WebSocket.
   */
  private async reconnectWebSocket(): Promise<void> {
    console.log("Attempting to reconnect WebSocket...");
    this.updateStatus("Reconnecting...");

    try {
      if (this.session) {
        this.session.close();
      }
      await this.initSession();
      this.updateStatus("Connection restored.");
    } catch (error) {
      console.error("Reconnection failed:", error);
      this.updateError("Failed to reconnect. Please press the reset button.");
    }
  }

  static styles = css`
    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
    }

    #cost-info {
      position: absolute;
      top: 2vh;
      right: 2vh;
      z-index: 10;
      background: rgba(0, 0, 0, 0.7);
      color: white;
      padding: 10px;
      border-radius: 8px;
      font-size: 12px;
      min-width: 200px;
    }

    .cost-row {
      display: flex;
      justify-content: space-between;
      margin: 2px 0;
    }

    .cost-total {
      border-top: 1px solid rgba(255, 255, 255, 0.3);
      padding-top: 5px;
      margin-top: 5px;
      font-weight: bold;
    }

    #text-responses {
      position: absolute;
      top: 2vh;
      left: 2vh;
      z-index: 10;
      background: rgba(0, 0, 0, 0.7);
      color: white;
      padding: 15px;
      border-radius: 8px;
      font-size: 14px;
      max-width: 400px;
      max-height: 40vh;
      overflow-y: auto;
    }

    .response-item {
      margin-bottom: 10px;
      padding: 8px;
      border-left: 3px solid #4caf50;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 4px;
    }

    .response-type {
      font-size: 12px;
      color: #ffd700;
      margin-bottom: 5px;
      font-weight: bold;
    }

    #model-selector {
      position: absolute;
      top: 2vh;
      left: 50%;
      transform: translateX(-50%);
      z-index: 10;
      background: rgba(0, 0, 0, 0.7);
      color: white;
      padding: 10px;
      border-radius: 8px;
      font-size: 14px;
    }

    #model-selector select {
      background: rgba(255, 255, 255, 0.1);
      color: white;
      border: 1px solid rgba(255, 255, 255, 0.3);
      border-radius: 4px;
      padding: 5px 10px;
      margin-left: 10px;
      font-size: 14px;
    }

    #model-selector select option {
      background: #333;
      color: white;
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;

      button {
        outline: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.1);
        width: 64px;
        height: 64px;
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        margin: 0;

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      }

      button[disabled] {
        display: none;
      }
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();

    try {
      const response = await fetch("metadata.json");
      if (response.ok) {
        const metadata: any = await response.json();
        if (metadata.systemInstructionFile) {
          // If systemInstructionFile exists, fetch and use that file
          const promptRes = await fetch(metadata.systemInstructionFile);
          if (promptRes.ok) {
            this.systemInstruction = await promptRes.text();
          } else {
            console.warn("Could not load the prompt file.");
          }
        } else if (metadata.systemInstruction) {
          this.systemInstruction = metadata.systemInstruction;
        }
      } else {
        console.warn(
          "Could not load metadata.json. Proceeding without system instruction."
        );
      }
    } catch (e) {
      console.warn("Error fetching metadata.json:", e);
    }

    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY, // Updated API key variable
    });

    this.outputNode.connect(this.outputAudioContext.destination);

    await this.initSession();
  }

  private async initSession() {
    const sessionConfig: any = {
      responseModalities: [Modality.AUDIO], // Set to audio only
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: "leda" } },
      },
      outputAudioTranscription: {},
      // VAD 민감도 최저로 설정
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity:
            (window as any).StartSensitivity?.START_SENSITIVITY_LOW || 0,
          endOfSpeechSensitivity:
            (window as any).EndSensitivity?.END_SENSITIVITY_LOW || 0,
          prefixPaddingMs: 20,
          silenceDurationMs: 100,
        },
      },
    };

    if (this.systemInstruction) {
      sessionConfig.systemInstruction = this.systemInstruction;
    }

    console.log("🚀 Initializing session, model:", this.selectedModel);
    console.log("📋 Config:", sessionConfig);

    try {
      this.session = await this.client.live.connect({
        model: this.selectedModel,
        callbacks: {
          onopen: () => {
            console.log("✅ WebSocket connection successful");
            this.updateStatus("Connected");
          },
          onmessage: async (message: LiveServerMessage) => {
            // Print usage metadata and calculate cost
            if (message.usageMetadata) {
              console.log("💰 Usage metadata:", message.usageMetadata);

              const promptTokensDetails = (
                message.usageMetadata.promptTokensDetails || []
              ).map((d: any) => ({
                modality: d.modality,
                token_count: d.tokenCount,
              }));
              const responseTokensDetails = (
                message.usageMetadata.responseTokensDetails || []
              ).map((d: any) => ({
                modality: d.modality,
                token_count: d.tokenCount,
              }));
              const tokenUsage = {
                prompt_tokens_details: promptTokensDetails,
                response_tokens_details: responseTokensDetails,
              };

              // Calculate cost
              const costBreakdown = calculateCostInDollar(
                this.selectedModel,
                tokenUsage
              );
              this.costInfo = costBreakdown;
              this.sessionCostTotal += costBreakdown.total_cost;
            }

            // Process audio response
            const parts = message.serverContent?.modelTurn?.parts || [];
            let hasAudio = false;

            for (const part of parts) {
              // Process audio response
              if (part.inlineData && part.inlineData.data) {
                hasAudio = true;

                // // 디버깅: 오디오 청크 정보 출력
                // console.log("[디버그] 오디오 청크 도착:", {
                //   dataLength: part.inlineData.data.length,
                //   nextStartTime: this.nextStartTime,
                //   currentTime: this.outputAudioContext.currentTime,
                // });

                // 청크 도착 시각 기록
                this.lastChunkTime = Date.now();

                // // 청크 타임아웃 리셋
                // if (this.chunkTimeoutId) {
                //   clearTimeout(this.chunkTimeoutId);
                // }
                // this.chunkTimeoutId = window.setTimeout(() => {
                //   this.saveReceivedAudio();
                // }, 5000); // 5초 동안 청크가 안 오면 저장

                this.nextStartTime = Math.max(
                  this.nextStartTime,
                  this.outputAudioContext.currentTime
                );

                const audioBuffer = await decodeAudioData(
                  decode(part.inlineData.data),
                  this.outputAudioContext,
                  24000,
                  1
                );
                this.receivedAudioBuffers.push(audioBuffer);
                const source = this.outputAudioContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(this.outputNode);
                source.addEventListener("ended", () => {
                  this.sources.delete(source);
                });

                source.start(this.nextStartTime);
                this.nextStartTime = this.nextStartTime + audioBuffer.duration;
                this.sources.add(source);
              }
            }

            // // 오디오 청크가 하나도 없을 때도 로그
            // if (!hasAudio) {
            //   console.log("[디버그] 이번 메시지에 오디오 청크 없음", message);
            // }

            // Process audio transcription
            if (message.serverContent?.outputTranscription?.text) {
              this.textResponses = [
                ...this.textResponses,
                message.serverContent.outputTranscription.text,
              ];
              this.updateStatus(
                `Transcription: ${message.serverContent.outputTranscription.text}`
              );
            }

            // Log and save response type
            if (hasAudio) {
              this.lastResponseType = message.serverContent?.outputTranscription
                ?.text
                ? "Audio + Transcription"
                : "Audio Only";
            }

            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              this.interruptedUIFlag = true;
              setTimeout(() => {
                this.interruptedUIFlag = false;
              }, 2000);
              for (const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
              // Gemini에서 end/interrupted 이벤트가 오면 저장
              console.log("🔴 interrupted");
              // this.saveReceivedAudio();
            }
          },
          onerror: (e: ErrorEvent) => {
            console.error("❌ WebSocket error:", e);
            this.updateError(e.message);
          },
          onclose: (e: CloseEvent) => {
            console.log("🔌 WebSocket connection closed:", e.code, e.reason);
            this.updateStatus("Connection closed: " + e.reason);
          },
        },
        config: sessionConfig,
      });

      console.log("✅ Live session created successfully");
    } catch (e: any) {
      console.error("❌ Session initialization failed:", e);
      this.updateError(`Session initialization failed: ${e.message}`);
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
    this.error = ""; // Clear error when status updates
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async startRecording() {
    this.error = "";
    if (!this.isWebSocketOpen()) {
      this.updateStatus("WebSocket is closed. Reconnecting...");
      await this.reconnectWebSocket();
    }
    this.updateStatus("Starting recording...");
    try {
      if (this.inputAudioContext.state === "suspended") {
        await this.inputAudioContext.resume();
      }
      if (this.outputAudioContext.state === "suspended") {
        await this.outputAudioContext.resume();
      }

      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          sampleSize: 16,
          echoCancellation: true,
        },
      });
      this.isRecording = true;
      this.recordingStartTime = Date.now();
      this.updateStatus("Waiting for microphone input...");

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream
      );

      try {
        await this.inputAudioContext.audioWorklet.addModule(audioProcessorUrl);
      } catch (e) {
        this.updateError(`Failed to load audio processor: ${e}`);
        this.stopRecording();
        return;
      }

      this.audioWorkletNode = new AudioWorkletNode(
        this.inputAudioContext,
        "audio-processor"
      );

      this.audioWorkletNode.port.onmessage = (e) => {
        if (!this.isRecording) {
          return;
        }

        const audioData = e.data;
        const audioBlob = createBlob(audioData);
        if (audioBlob && audioBlob.data) {
          this.estimatedInputTokens += estimateAudioTokens(
            audioBlob.data.length
          );
        }

        try {
          (this.session as any).sendRealtimeInput({ media: audioBlob });
        } catch (error) {
          console.warn("WebSocket send failed:", error);
          this.stopRecording();
          this.reconnectWebSocket(); // Attempt to reconnect on error
        }

        const now = Date.now();
        this.recordingDuration =
          (now - (this.recordingStartTime ?? now)) / 1000;
      };

      this.sourceNode.connect(this.audioWorkletNode);
      this.sourceNode.connect(this.inputNode);
    } catch (e) {
      this.updateError(`Microphone start error: ${e}`);
    }
  }

  private stopRecording() {
    this.updateStatus("Recording stopped.");
    this.isRecording = false;
    this.recordingStartTime = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = undefined;
    }
    if (this.audioWorkletNode) {
      this.audioWorkletNode.port.onmessage = null;
      this.audioWorkletNode.disconnect();
      this.audioWorkletNode = undefined;
    }
  }

  private async reset() {
    this.updateStatus("Resetting...");
    this.stopRecording(); // Ensure recording is stopped before resetting
    if (this.session) {
      this.session.close();
    }
    // Reset cost info and response history
    this.costInfo = null;
    this.sessionCostTotal = 0;
    this.estimatedInputTokens = 0;
    this.textResponses = [];
    this.lastResponseType = "";
    this.recordingDuration = 0;
    this.lastChunkTime = null; // Reset chunk time

    // Re-fetch system instruction if needed, or rely on stored one.
    // For simplicity, we re-initialize the session which will use the already fetched instruction.
    await this.initSession();
    this.updateStatus("Session has been reset.");
  }

  private async changeModel(event: Event) {
    const target = event.target as HTMLSelectElement;
    const newModel = target.value;

    if (newModel !== this.selectedModel) {
      this.selectedModel = newModel;
      this.updateStatus(`Switching to ${newModel}...`);

      // Stop recording if active
      if (this.isRecording) {
        this.stopRecording();
      }

      // Close current session and reinitialize with new model
      if (this.session) {
        this.session.close();
      }

      // Reset session-specific data
      this.costInfo = null;
      this.sessionCostTotal = 0;
      this.estimatedInputTokens = 0;
      this.textResponses = [];
      this.lastResponseType = "";
      this.recordingDuration = 0;
      this.lastChunkTime = null; // Reset chunk time

      await this.initSession();
      this.updateStatus(`Switched to ${newModel}`);
    }
  }

  // 오디오 버퍼들을 wav로 합쳐서 저장하는 함수
  private async saveReceivedAudio() {
    if (!this.receivedAudioBuffers.length) return;
    // 1. 버퍼 합치기
    const totalLength = this.receivedAudioBuffers.reduce(
      (sum, buf) => sum + buf.length,
      0
    );
    const sampleRate = 24000;
    const merged = this.outputAudioContext.createBuffer(
      1,
      totalLength,
      sampleRate
    );
    let offset = 0;
    for (const buf of this.receivedAudioBuffers) {
      merged.getChannelData(0).set(buf.getChannelData(0), offset);
      offset += buf.length;
    }
    // 2. wav로 변환
    const wavBlob = this.audioBufferToWavBlob(merged);
    // 3. 다운로드
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gemini_audio_${Date.now()}.wav`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    // 4. 버퍼 초기화
    this.receivedAudioBuffers = [];
  }

  // AudioBuffer를 wav Blob으로 변환
  private audioBufferToWavBlob(buffer: AudioBuffer): Blob {
    const numOfChan = buffer.numberOfChannels;
    const length = buffer.length * numOfChan * 2 + 44;
    const bufferArray = new ArrayBuffer(length);
    const view = new DataView(bufferArray);
    // RIFF chunk descriptor
    this.writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + buffer.length * numOfChan * 2, true);
    this.writeString(view, 8, "WAVE");
    // FMT sub-chunk
    this.writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numOfChan, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * numOfChan * 2, true);
    view.setUint16(32, numOfChan * 2, true);
    view.setUint16(34, 16, true);
    // data sub-chunk
    this.writeString(view, 36, "data");
    view.setUint32(40, buffer.length * numOfChan * 2, true);
    // PCM samples
    let offset = 44;
    for (let i = 0; i < buffer.length; i++) {
      for (let ch = 0; ch < numOfChan; ch++) {
        let sample = buffer.getChannelData(ch)[i];
        sample = Math.max(-1, Math.min(1, sample));
        view.setInt16(
          offset,
          sample < 0 ? sample * 0x8000 : sample * 0x7fff,
          true
        );
        offset += 2;
      }
    }
    return new Blob([bufferArray], { type: "audio/wav" });
  }

  private writeString(view: DataView, offset: number, str: string) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  render() {
    return html`
      <div>
        <!-- Model selector -->
        <div id="model-selector">
          <label for="model-select">🤖 Model:</label>
          <select
            id="model-select"
            .value=${this.selectedModel}
            @change=${this.changeModel}
            ?disabled=${this.isRecording}
          >
            ${this.modelOptions.map(
              (option) => html`
                <option
                  value=${option.value}
                  ?selected=${option.value === this.selectedModel}
                >
                  ${option.label}
                </option>
              `
            )}
          </select>
        </div>

        <!-- Display text responses -->
        ${this.textResponses.length > 0
          ? html`
              <div id="text-responses">
                <div style="font-weight: bold; margin-bottom: 10px;">
                  📝 Audio Transcription History (Audio + Text received!)
                </div>
                <div
                  style="font-size: 12px; color: #90EE90; margin-bottom: 10px;"
                ></div>
                ${this.textResponses.map(
                  (response, index) => html`
                    <div class="response-item">
                      <div class="response-type">
                        Transcription #${index + 1} (${this.lastResponseType})
                      </div>
                      <div>${response}</div>
                    </div>
                  `
                )}
              </div>
            `
          : html``}

        <!-- Display cost info -->
        <div id="cost-info">
          <div style="font-weight: bold; margin-bottom: 8px;">💰 Cost Info</div>
          <div class="cost-row">
            <span>Recording Time:</span>
            <span>${this.recordingDuration.toFixed(2)}s</span>
          </div>
          <!-- 청크 수신 상태 표시 -->
          <div class="cost-row">
            <span>오디오 청크 상태:</span>
            <span>
              ${this.lastChunkTime && Date.now() - this.lastChunkTime < 2000
                ? "🟢 청크 수신 중"
                : "⚪️ 청크 없음"}
            </span>
          </div>
          ${this.costInfo
            ? html`
                <div class="cost-row">
                  <span>Input Cost:</span>
                  <span>$${this.costInfo.input_cost.toFixed(6)}</span>
                </div>
                <div class="cost-row">
                  <span>Output Cost:</span>
                  <span>$${this.costInfo.output_cost.toFixed(6)}</span>
                </div>
                <div class="cost-row">
                  <span>Last Request:</span>
                  <span>$${this.costInfo.total_cost.toFixed(6)}</span>
                </div>
                <div class="cost-row cost-total">
                  <span>Total Session Cost:</span>
                  <span>$${this.sessionCostTotal.toFixed(6)}</span>
                </div>
                <div class="cost-row">
                  <span>Est. Input Tokens:</span>
                  <span>${this.estimatedInputTokens}</span>
                </div>
                ${this.interruptedUIFlag
                  ? html`<div
                      class="cost-row"
                      style="color:#ff4444;font-weight:bold;"
                    >
                      🔴 자동 감지로 오디오 중단됨 (VAD interrupted)
                    </div>`
                  : ""}
              `
            : html`
                <div class="cost-row">
                  <span>Total Session Cost:</span>
                  <span>$${this.sessionCostTotal.toFixed(6)}</span>
                </div>
                <div class="cost-row">
                  <span>Est. Input Tokens:</span>
                  <span>${this.estimatedInputTokens}</span>
                </div>
                ${this.interruptedUIFlag
                  ? html`<div
                      class="cost-row"
                      style="color:#ff4444;font-weight:bold;"
                    >
                      🔴 자동 감지로 오디오 중단됨 (VAD interrupted)
                    </div>`
                  : ""}
              `}
        </div>

        <div class="controls">
          <button
            id="resetButton"
            @click=${this.reset}
            ?disabled=${this.isRecording}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="40px"
              viewBox="0 -960 960 960"
              width="40px"
              fill="#ffffff"
            >
              <path
                d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z"
              />
            </svg>
          </button>
          <button
            id="startButton"
            @click=${this.startRecording}
            ?disabled=${this.isRecording}
          >
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#c80000"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle cx="50" cy="50" r="50" />
            </svg>
          </button>
          <button
            id="stopButton"
            @click=${this.stopRecording}
            ?disabled=${!this.isRecording}
          >
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#000000"
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect x="0" y="0" width="100" height="100" rx="15" />
            </svg>
          </button>
        </div>

        <div id="status">${this.error || this.status}</div>
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}
        ></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}
