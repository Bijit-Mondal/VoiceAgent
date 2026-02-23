import { EventEmitter } from "events";
import {
  experimental_transcribe as transcribe,
  type TranscriptionModel,
} from "ai";
import { DEFAULT_MAX_AUDIO_SIZE } from "../types";

export interface TranscriptionManagerOptions {
  transcriptionModel?: TranscriptionModel;
  maxAudioInputSize?: number;
}

/**
 * Handles audio transcription using the AI SDK transcription model
 * and validation of incoming audio data.
 */
export class TranscriptionManager extends EventEmitter {
  private transcriptionModel?: TranscriptionModel;
  private maxAudioInputSize: number;

  /** Callback to send messages over the WebSocket */
  public sendMessage: (message: Record<string, unknown>) => void = () => {};

  constructor(options: TranscriptionManagerOptions = {}) {
    super();
    this.transcriptionModel = options.transcriptionModel;
    this.maxAudioInputSize =
      options.maxAudioInputSize ?? DEFAULT_MAX_AUDIO_SIZE;
  }

  get hasTranscriptionModel(): boolean {
    return !!this.transcriptionModel;
  }

  /**
   * Transcribe audio data to text.
   */
  async transcribeAudio(audioData: Buffer | Uint8Array): Promise<string> {
    if (!this.transcriptionModel) {
      throw new Error("Transcription model not configured");
    }

    console.log(
      `Sending ${audioData.byteLength} bytes to Whisper for transcription`
    );

    try {
      const result = await transcribe({
        model: this.transcriptionModel,
        audio: audioData,
      });

      console.log(
        `Whisper transcription result: "${result.text}", language: ${result.language || "unknown"}`
      );

      this.emit("transcription", {
        text: result.text,
        language: result.language,
      });

      // Send transcription to client for immediate feedback
      this.sendMessage({
        type: "transcription_result",
        text: result.text,
        language: result.language,
      });

      return result.text;
    } catch (error) {
      console.error("Whisper transcription failed:", error);
      throw error;
    }
  }

  /**
   * Process incoming base64-encoded audio: validate, decode, transcribe.
   * Returns the transcribed text, or null if invalid / empty.
   */
  async processAudioInput(
    base64Audio: string,
    format?: string
  ): Promise<string | null> {
    if (!this.transcriptionModel) {
      const error = new Error(
        "Transcription model not configured for audio input"
      );
      this.emit("error", error);
      this.sendMessage({ type: "error", error: error.message });
      return null;
    }

    try {
      const audioBuffer = Buffer.from(base64Audio, "base64");

      // Validate audio size
      if (audioBuffer.length > this.maxAudioInputSize) {
        const sizeMB = (audioBuffer.length / (1024 * 1024)).toFixed(1);
        const maxMB = (this.maxAudioInputSize / (1024 * 1024)).toFixed(1);
        this.emit(
          "error",
          new Error(
            `Audio input too large (${sizeMB} MB). Maximum allowed: ${maxMB} MB`
          )
        );
        return null;
      }

      if (audioBuffer.length === 0) {
        this.emit("warning", "Received empty audio data");
        return null;
      }

      this.emit("audio_received", { size: audioBuffer.length, format });
      console.log(
        `Processing audio input: ${audioBuffer.length} bytes, format: ${format || "unknown"}`
      );

      const transcribedText = await this.transcribeAudio(audioBuffer);
      console.log(`Transcribed text: "${transcribedText}"`);

      if (!transcribedText.trim()) {
        this.emit("warning", "Transcription returned empty text");
        this.sendMessage({
          type: "transcription_error",
          error: "Whisper returned empty text",
        });
        return null;
      }

      return transcribedText;
    } catch (error) {
      console.error("Failed to process audio input:", error);
      this.emit("error", error);
      this.sendMessage({
        type: "transcription_error",
        error: `Transcription failed: ${(error as Error).message || String(error)}`,
      });
      return null;
    }
  }
}
