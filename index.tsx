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
  private modelName = "gemini-live-2.5-flash-preview";
  // private modelName = "gemini-2.5-flash-preview-native-audio-dialog";

  /**
   * WebSocket 연결 상태 체크 함수
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
      console.warn("WebSocket 상태 체크 오류:", error);
      return false;
    }
  }

  /**
   * WebSocket 재연결 시도
   */
  private async reconnectWebSocket(): Promise<void> {
    console.log("WebSocket 재연결 시도 중...");
    this.updateStatus("연결 재시도 중...");

    try {
      if (this.session) {
        this.session.close();
      }
      await this.initSession();
      this.updateStatus("연결 복구됨");
    } catch (error) {
      console.error("재연결 실패:", error);
      this.updateError("연결 재시도 실패. 리셋 버튼을 눌러주세요.");
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
          // systemInstructionFile이 있으면 해당 파일을 fetch해서 사용
          const promptRes = await fetch(metadata.systemInstructionFile);
          if (promptRes.ok) {
            this.systemInstruction = await promptRes.text();
          } else {
            console.warn("프롬프트 파일을 불러올 수 없습니다.");
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
      responseModalities: [Modality.AUDIO], // 오디오만 설정
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: "leda" } },
      },
      outputAudioTranscription: {},
    };

    if (this.systemInstruction) {
      sessionConfig.systemInstruction = this.systemInstruction;
    }

    console.log("🚀 세션 초기화 시작, 모델:", this.modelName);
    console.log("📋 설정:", sessionConfig);

    try {
      this.session = await this.client.live.connect({
        model: this.modelName,
        callbacks: {
          onopen: () => {
            console.log("✅ WebSocket 연결 성공");
            this.updateStatus("연결됨");
          },
          onmessage: async (message: LiveServerMessage) => {
            // 사용량 메타데이터 출력 및 비용 계산
            if (message.usageMetadata) {
              console.log("💰 사용량 메타데이터:", message.usageMetadata);

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

              // 비용 계산
              const costBreakdown = calculateCostInDollar(
                this.modelName,
                tokenUsage
              );
              this.costInfo = costBreakdown;
              this.sessionCostTotal += costBreakdown.total_cost;
            }

            // 오디오 응답 처리
            const parts = message.serverContent?.modelTurn?.parts || [];
            let hasAudio = false;

            for (const part of parts) {
              // 오디오 응답 처리
              if (part.inlineData && part.inlineData.data) {
                hasAudio = true;

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

            // 오디오 전사(transcription) 처리
            if (message.serverContent?.outputTranscription?.text) {
              this.textResponses = [
                ...this.textResponses,
                message.serverContent.outputTranscription.text,
              ];
              this.updateStatus(
                `오디오 전사: ${message.serverContent.outputTranscription.text}`
              );
            }

            // 응답 타입 로깅 및 저장
            if (hasAudio) {
              this.lastResponseType = message.serverContent?.outputTranscription
                ?.text
                ? "오디오 + 전사"
                : "오디오만";
            }

            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              for (const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
            }
          },
          onerror: (e: ErrorEvent) => {
            console.error("❌ WebSocket 오류:", e);
            this.updateError(e.message);
          },
          onclose: (e: CloseEvent) => {
            console.log("🔌 WebSocket 연결 종료:", e.code, e.reason);
            this.updateStatus("연결 종료:" + e.reason);
          },
        },
        config: sessionConfig,
      });

      console.log("✅ Live 세션 생성 완료");
    } catch (e: any) {
      console.error("❌ 세션 초기화 실패:", e);
      this.updateError(`세션 초기화 실패: ${e.message}`);
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
      this.updateStatus("WebSocket이 닫혀있습니다. 다시 연결합니다...");
      await this.reconnectWebSocket();
    }
    this.updateStatus("녹음 시작...");
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
      this.updateStatus("마이크 입력을 기다리는 중...");

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream
      );

      try {
        await this.inputAudioContext.audioWorklet.addModule(
          "audio-processor.js"
        );
      } catch (e) {
        this.updateError(`오디오 프로세서 로딩 실패: ${e}`);
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
          console.warn("WebSocket 전송 실패:", error);
          this.stopRecording();
          this.reconnectWebSocket(); // 오류 시 재연결 시도
        }

        const now = Date.now();
        this.recordingDuration =
          (now - (this.recordingStartTime ?? now)) / 1000;
      };

      this.sourceNode.connect(this.audioWorkletNode);
      this.sourceNode.connect(this.inputNode);
    } catch (e) {
      this.updateError(`마이크 시작 오류: ${e}`);
    }
  }

  private stopRecording() {
    this.updateStatus("녹음 중지.");
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
    this.updateStatus("리셋 중...");
    this.stopRecording(); // Ensure recording is stopped before resetting
    if (this.session) {
      this.session.close();
    }
    // 비용 정보 및 응답 기록 리셋
    this.costInfo = null;
    this.sessionCostTotal = 0;
    this.estimatedInputTokens = 0;
    this.textResponses = [];
    this.lastResponseType = "";
    this.recordingDuration = 0;

    // Re-fetch system instruction if needed, or rely on stored one.
    // For simplicity, we re-initialize the session which will use the already fetched instruction.
    await this.initSession();
    this.updateStatus("세션이 초기화되었습니다.");
  }

  render() {
    return html`
      <div>
        <!-- 텍스트 응답 표시 -->
        ${this.textResponses.length > 0
          ? html`
              <div id="text-responses">
                <div style="font-weight: bold; margin-bottom: 10px;">
                  📝 오디오 전사 기록 (텍스트 + 오디오 동시 수신!)
                </div>
                <div
                  style="font-size: 12px; color: #90EE90; margin-bottom: 10px;"
                ></div>
                ${this.textResponses.map(
                  (response, index) => html`
                    <div class="response-item">
                      <div class="response-type">
                        전사 #${index + 1} (${this.lastResponseType})
                      </div>
                      <div>${response}</div>
                    </div>
                  `
                )}
              </div>
            `
          : html``}

        <!-- 비용 정보 표시 -->
        <div id="cost-info">
          <div style="font-weight: bold; margin-bottom: 8px;">💰 비용 정보</div>
          <div class="cost-row">
            <span>녹음 시간:</span>
            <span>${this.recordingDuration.toFixed(2)}초</span>
          </div>
          ${this.costInfo
            ? html`
                <div class="cost-row">
                  <span>입력 비용:</span>
                  <span>$${this.costInfo.input_cost.toFixed(6)}</span>
                </div>
                <div class="cost-row">
                  <span>출력 비용:</span>
                  <span>$${this.costInfo.output_cost.toFixed(6)}</span>
                </div>
                <div class="cost-row">
                  <span>최근 요청:</span>
                  <span>$${this.costInfo.total_cost.toFixed(6)}</span>
                </div>
                <div class="cost-row cost-total">
                  <span>세션 총 비용:</span>
                  <span>$${this.sessionCostTotal.toFixed(6)}</span>
                </div>
                <div class="cost-row">
                  <span>추정 입력 토큰:</span>
                  <span>${this.estimatedInputTokens}</span>
                </div>
              `
            : html`
                <div class="cost-row">
                  <span>세션 총 비용:</span>
                  <span>$${this.sessionCostTotal.toFixed(6)}</span>
                </div>
                <div class="cost-row">
                  <span>추정 입력 토큰:</span>
                  <span>${this.estimatedInputTokens}</span>
                </div>
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
