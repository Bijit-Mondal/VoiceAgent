import { EventEmitter } from "events";
import {
  experimental_generateSpeech as generateSpeech,
  type SpeechModel,
} from "ai";
import {
  type SpeechChunk,
  type StreamingSpeechConfig,
  DEFAULT_STREAMING_SPEECH_CONFIG,
} from "../types";

export interface SpeechManagerOptions {
  speechModel?: SpeechModel;
  voice?: string;
  speechInstructions?: string;
  outputFormat?: string;
  streamingSpeech?: Partial<StreamingSpeechConfig>;
}

/**
 * Manages text-to-speech generation, streaming speech chunking,
 * parallel TTS requests, and speech interruption.
 */
export class SpeechManager extends EventEmitter {
  private speechModel?: SpeechModel;
  private voice: string;
  private speechInstructions?: string;
  private outputFormat: string;
  private streamingSpeechConfig: StreamingSpeechConfig;

  private currentSpeechAbortController?: AbortController;
  private speechChunkQueue: SpeechChunk[] = [];
  private nextChunkId = 0;
  private _isSpeaking = false;
  private pendingTextBuffer = "";

  // Promise-based signal for speech queue completion
  private speechQueueDonePromise?: Promise<void>;
  private speechQueueDoneResolve?: () => void;

  /** Callback to send messages over the WebSocket */
  public sendMessage: (message: Record<string, unknown>) => void = () => { };

  constructor(options: SpeechManagerOptions) {
    super();
    this.speechModel = options.speechModel;
    this.voice = options.voice || "alloy";
    this.speechInstructions = options.speechInstructions;
    this.outputFormat = options.outputFormat || "opus";
    this.streamingSpeechConfig = {
      ...DEFAULT_STREAMING_SPEECH_CONFIG,
      ...options.streamingSpeech,
    };
  }

  get isSpeaking(): boolean {
    return this._isSpeaking;
  }

  get pendingChunkCount(): number {
    return this.speechChunkQueue.length;
  }

  get hasSpeechModel(): boolean {
    return !!this.speechModel;
  }

  /**
   * Returns a promise that resolves when the speech queue is fully drained.
   * Returns undefined if there is nothing queued.
   */
  get queueDonePromise(): Promise<void> | undefined {
    return this.speechQueueDonePromise;
  }

  /**
   * Generate speech from text using the configured speech model.
   */
  async generateSpeechFromText(
    text: string,
    abortSignal?: AbortSignal
  ): Promise<Uint8Array> {
    if (!this.speechModel) {
      throw new Error("Speech model not configured");
    }

    const result = await generateSpeech({
      model: this.speechModel,
      text,
      voice: this.voice,
      instructions: this.speechInstructions,
      outputFormat: this.outputFormat,
      abortSignal,
    });

    return result.audio.uint8Array;
  }

  /**
   * Generate speech for full text at once (non-streaming fallback).
   */
  async generateAndSendSpeechFull(text: string): Promise<void> {
    if (!this.speechModel) return;

    try {
      this.emit("speech_start", { text, streaming: false });

      const audioData = await this.generateSpeechFromText(text);
      const base64Audio = Buffer.from(audioData).toString("base64");

      this.sendMessage({
        type: "audio",
        data: base64Audio,
        format: this.outputFormat,
      });

      this.emit("audio", {
        data: base64Audio,
        format: this.outputFormat,
        uint8Array: audioData,
      });

      this.emit("speech_complete", { text, streaming: false });
    } catch (error) {
      console.error("Failed to generate speech:", error);
      this.emit("error", error);
    }
  }

  /**
   * Interrupt ongoing speech generation and playback (barge-in support).
   */
  interruptSpeech(reason: string = "interrupted"): void {
    if (!this._isSpeaking && this.speechChunkQueue.length === 0) {
      return;
    }

    // Abort any pending speech generation requests
    if (this.currentSpeechAbortController) {
      this.currentSpeechAbortController.abort();
      this.currentSpeechAbortController = undefined;
    }

    // Clear the speech queue
    this.speechChunkQueue = [];
    this.pendingTextBuffer = "";
    this._isSpeaking = false;

    // Resolve any pending speech-done waiters so callers can finish
    if (this.speechQueueDoneResolve) {
      this.speechQueueDoneResolve();
      this.speechQueueDoneResolve = undefined;
      this.speechQueueDonePromise = undefined;
    }

    // Notify clients to stop audio playback
    this.sendMessage({
      type: "speech_interrupted",
      reason,
    });

    this.emit("speech_interrupted", { reason });
  }

  /**
   * Process a text delta for streaming speech.
   * Call this as text chunks arrive from the LLM.
   */
  processTextDelta(textDelta: string): void {
    if (!this.speechModel) return;

    this.pendingTextBuffer += textDelta;

    const [sentences, remaining] = this.extractSentences(this.pendingTextBuffer);
    this.pendingTextBuffer = remaining;

    for (const sentence of sentences) {
      this.queueSpeechChunk(sentence);
    }
  }

  /**
   * Flush any remaining text in the buffer to speech.
   * Call this when the LLM stream ends.
   */
  flushPendingText(): void {
    if (!this.speechModel || !this.pendingTextBuffer.trim()) return;

    this.queueSpeechChunk(this.pendingTextBuffer);
    this.pendingTextBuffer = "";
  }

  /**
   * Reset all speech state (used on disconnect / cleanup).
   */
  reset(): void {
    if (this.currentSpeechAbortController) {
      this.currentSpeechAbortController.abort();
      this.currentSpeechAbortController = undefined;
    }
    this.speechChunkQueue = [];
    this.pendingTextBuffer = "";
    this._isSpeaking = false;

    if (this.speechQueueDoneResolve) {
      this.speechQueueDoneResolve();
      this.speechQueueDoneResolve = undefined;
      this.speechQueueDonePromise = undefined;
    }
  }

  // ── Private helpers ─────────────────────────────────────────

  /**
   * Extract complete sentences from text buffer.
   * Returns [extractedSentences, remainingBuffer].
   */
  private extractSentences(text: string): [string[], string] {
    const sentences: string[] = [];
    let remaining = text;

    // Match sentences ending with . ! ? followed by space or end of string
    const sentenceEndPattern = /[.!?]+(?:\s+|$)/g;
    let lastIndex = 0;
    let match;

    while ((match = sentenceEndPattern.exec(text)) !== null) {
      const sentence = text
        .slice(lastIndex, match.index + match[0].length)
        .trim();
      if (sentence.length >= this.streamingSpeechConfig.minChunkSize) {
        sentences.push(sentence);
        lastIndex = match.index + match[0].length;
      } else if (sentences.length > 0) {
        // Append short sentence to previous one
        sentences[sentences.length - 1] += " " + sentence;
        lastIndex = match.index + match[0].length;
      }
    }

    remaining = text.slice(lastIndex);

    // If remaining text is too long, force split at clause boundaries
    if (remaining.length > this.streamingSpeechConfig.maxChunkSize) {
      const clausePattern = /[,;:]\s+/g;
      let clauseMatch;
      let splitIndex = 0;

      while ((clauseMatch = clausePattern.exec(remaining)) !== null) {
        if (clauseMatch.index >= this.streamingSpeechConfig.minChunkSize) {
          splitIndex = clauseMatch.index + clauseMatch[0].length;
          break;
        }
      }

      if (splitIndex > 0) {
        sentences.push(remaining.slice(0, splitIndex).trim());
        remaining = remaining.slice(splitIndex);
      }
    }

    return [sentences, remaining];
  }

  /**
   * Queue a text chunk for speech generation.
   */
  private queueSpeechChunk(text: string): void {
    if (!this.speechModel || !text.trim()) return;

    // Wrap chunk ID to prevent unbounded growth in very long sessions
    if (this.nextChunkId >= Number.MAX_SAFE_INTEGER) {
      this.nextChunkId = 0;
    }

    const chunk: SpeechChunk = {
      id: this.nextChunkId++,
      text: text.trim(),
    };

    // Create the speech-done promise if not already present
    if (!this.speechQueueDonePromise) {
      this.speechQueueDonePromise = new Promise<void>((resolve) => {
        this.speechQueueDoneResolve = resolve;
      });
    }

    // Start generating audio immediately (parallel generation)
    if (this.streamingSpeechConfig.parallelGeneration) {
      const activeRequests = this.speechChunkQueue.filter(
        (c) => c.audioPromise
      ).length;

      if (activeRequests < this.streamingSpeechConfig.maxParallelRequests) {
        chunk.audioPromise = this.generateChunkAudio(chunk);
      }
    }

    this.speechChunkQueue.push(chunk);
    this.emit("speech_chunk_queued", { id: chunk.id, text: chunk.text });

    // Start processing queue if not already
    if (!this._isSpeaking) {
      this.processSpeechQueue();
    }
  }

  /**
   * Generate audio for a single chunk.
   */
  private async generateChunkAudio(
    chunk: SpeechChunk
  ): Promise<Uint8Array | null> {
    if (!this.currentSpeechAbortController) {
      this.currentSpeechAbortController = new AbortController();
    }

    try {
      console.log(
        `Generating audio for chunk ${chunk.id}: "${chunk.text.substring(0, 50)}${chunk.text.length > 50 ? "..." : ""}"`
      );
      const audioData = await this.generateSpeechFromText(
        chunk.text,
        this.currentSpeechAbortController.signal
      );
      console.log(
        `Generated audio for chunk ${chunk.id}: ${audioData.length} bytes`
      );
      return audioData;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        console.log(`Audio generation aborted for chunk ${chunk.id}`);
        return null;
      }
      console.error(
        `Failed to generate audio for chunk ${chunk.id}:`,
        error
      );
      this.emit("error", error);
      return null;
    }
  }

  /**
   * Process the speech queue and send audio chunks in order.
   */
  private async processSpeechQueue(): Promise<void> {
    if (this._isSpeaking) return;
    this._isSpeaking = true;

    console.log(
      `Starting speech queue processing with ${this.speechChunkQueue.length} chunks`
    );
    this.emit("speech_start", { streaming: true });
    this.sendMessage({ type: "speech_stream_start" });

    try {
      while (this.speechChunkQueue.length > 0) {
        const chunk = this.speechChunkQueue[0];

        console.log(
          `Processing speech chunk #${chunk.id} (${this.speechChunkQueue.length - 1} remaining)`
        );

        // Ensure audio generation has started
        if (!chunk.audioPromise) {
          chunk.audioPromise = this.generateChunkAudio(chunk);
        }

        // Wait for this chunk's audio
        const audioData = await chunk.audioPromise;

        // Check if we were interrupted while waiting
        if (!this._isSpeaking) {
          console.log(`Speech interrupted during chunk #${chunk.id}`);
          break;
        }

        // Remove from queue after processing
        this.speechChunkQueue.shift();

        if (audioData) {
          const base64Audio = Buffer.from(audioData).toString("base64");
          console.log(
            `Sending audio chunk #${chunk.id} (${audioData.length} bytes, ${this.outputFormat})`
          );

          // Send audio chunk via WebSocket
          this.sendMessage({
            type: "audio_chunk",
            chunkId: chunk.id,
            data: base64Audio,
            format: this.outputFormat,
            text: chunk.text,
          });

          // Emit for local handling
          this.emit("audio_chunk", {
            chunkId: chunk.id,
            data: base64Audio,
            format: this.outputFormat,
            text: chunk.text,
            uint8Array: audioData,
          });
        } else {
          console.log(`No audio data generated for chunk #${chunk.id}`);
        }

        // Start generating next chunks in parallel
        if (this.streamingSpeechConfig.parallelGeneration) {
          const activeRequests = this.speechChunkQueue.filter(
            (c) => c.audioPromise
          ).length;
          const toStart = Math.min(
            this.streamingSpeechConfig.maxParallelRequests - activeRequests,
            this.speechChunkQueue.length
          );

          if (toStart > 0) {
            console.log(
              `Starting parallel generation for ${toStart} more chunks`
            );
            for (let i = 0; i < toStart; i++) {
              const nextChunk = this.speechChunkQueue.find(
                (c) => !c.audioPromise
              );
              if (nextChunk) {
                nextChunk.audioPromise = this.generateChunkAudio(nextChunk);
              }
            }
          }
        }
      }
    } catch (error) {
      console.error("Error in speech queue processing:", error);
      this.emit("error", error);
    } finally {
      this._isSpeaking = false;
      this.currentSpeechAbortController = undefined;

      // Signal that the speech queue is fully drained
      if (this.speechQueueDoneResolve) {
        this.speechQueueDoneResolve();
        this.speechQueueDoneResolve = undefined;
        this.speechQueueDonePromise = undefined;
      }

      console.log(`Speech queue processing complete`);
      this.sendMessage({ type: "speech_stream_end" });
      this.emit("speech_complete", { streaming: true });
    }
  }
}
