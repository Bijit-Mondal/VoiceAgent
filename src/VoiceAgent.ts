import { WebSocket } from "ws";
import { EventEmitter } from "events";
import {
  streamText,
  LanguageModel,
  stepCountIs,
  type Tool,
  type ModelMessage,
  experimental_transcribe as transcribe,
  experimental_generateSpeech as generateSpeech,
  type TranscriptionModel,
  type SpeechModel,
} from "ai";

/**
 * Represents a chunk of text to be converted to speech
 */
interface SpeechChunk {
  id: number;
  text: string;
  audioPromise?: Promise<Uint8Array | null>;
}

/**
 * Configuration for streaming speech behavior
 */
interface StreamingSpeechConfig {
  /** Minimum characters before generating speech for a chunk */
  minChunkSize: number;
  /** Maximum characters per chunk (will split at sentence boundary before this) */
  maxChunkSize: number;
  /** Whether to enable parallel TTS generation */
  parallelGeneration: boolean;
  /** Maximum number of parallel TTS requests */
  maxParallelRequests: number;
}

/**
 * Configuration for conversation history memory management
 */
interface HistoryConfig {
  /** Maximum number of messages to keep in history. When exceeded, oldest messages are trimmed. Set to 0 for unlimited. */
  maxMessages: number;
  /** Maximum total character count across all messages. When exceeded, oldest messages are trimmed. Set to 0 for unlimited. */
  maxTotalChars: number;
}

/** Default maximum audio input size (10 MB) */
const DEFAULT_MAX_AUDIO_SIZE = 10 * 1024 * 1024;

export interface VoiceAgentOptions {
  model: LanguageModel; // AI SDK Model for chat (e.g., openai('gpt-4o'))
  transcriptionModel?: TranscriptionModel; // AI SDK Transcription Model (e.g., openai.transcription('whisper-1'))
  speechModel?: SpeechModel; // AI SDK Speech Model (e.g., openai.speech('gpt-4o-mini-tts'))
  instructions?: string;
  stopWhen?: NonNullable<Parameters<typeof streamText>[0]["stopWhen"]>;
  tools?: Record<string, Tool>;
  endpoint?: string;
  voice?: string; // Voice for TTS (e.g., 'alloy', 'echo', 'shimmer')
  speechInstructions?: string; // Instructions for TTS voice style
  outputFormat?: string; // Audio output format (e.g., 'mp3', 'opus', 'wav')
  /** Configuration for streaming speech generation */
  streamingSpeech?: Partial<StreamingSpeechConfig>;
  /** Configuration for conversation history memory limits */
  history?: Partial<HistoryConfig>;
  /** Maximum audio input size in bytes (default: 10 MB) */
  maxAudioInputSize?: number;
}

export class VoiceAgent extends EventEmitter {
  private socket?: WebSocket;
  private tools: Record<string, Tool> = {};
  private model: LanguageModel;
  private transcriptionModel?: TranscriptionModel;
  private speechModel?: SpeechModel;
  private instructions: string;
  private stopWhen: NonNullable<Parameters<typeof streamText>[0]["stopWhen"]>;
  private endpoint?: string;
  private isConnected = false;
  private conversationHistory: ModelMessage[] = [];
  private voice: string;
  private speechInstructions?: string;
  private outputFormat: string;
  private isProcessing = false;
  private isDestroyed = false;

  // Concurrency: queue incoming requests so they run serially
  private inputQueue: Array<{ text: string; resolve: (v: string) => void; reject: (e: unknown) => void }> = [];
  private processingQueue = false;

  // Abort controller for the current LLM stream so we can cancel it on interrupt/disconnect
  private currentStreamAbortController?: AbortController;

  // Memory management
  private historyConfig: HistoryConfig;
  private maxAudioInputSize: number;

  // Streaming speech state
  private streamingSpeechConfig: StreamingSpeechConfig;
  private currentSpeechAbortController?: AbortController;
  private speechChunkQueue: SpeechChunk[] = [];
  private nextChunkId = 0;
  private isSpeaking = false;
  private pendingTextBuffer = "";

  // Promise-based signal for speech queue completion (replaces busy-wait polling)
  private speechQueueDonePromise?: Promise<void>;
  private speechQueueDoneResolve?: () => void;

  constructor(options: VoiceAgentOptions) {
    super();
    this.model = options.model;
    this.transcriptionModel = options.transcriptionModel;
    this.speechModel = options.speechModel;
    this.instructions =
      options.instructions || "You are a helpful voice assistant.";
    this.stopWhen = options.stopWhen || stepCountIs(5);
    this.endpoint = options.endpoint;
    this.voice = options.voice || "alloy";
    this.speechInstructions = options.speechInstructions;
    this.outputFormat = options.outputFormat || "mp3";
    this.maxAudioInputSize = options.maxAudioInputSize ?? DEFAULT_MAX_AUDIO_SIZE;
    if (options.tools) {
      this.tools = { ...options.tools };
    }

    // Initialize streaming speech config with defaults
    this.streamingSpeechConfig = {
      minChunkSize: 50,
      maxChunkSize: 200,
      parallelGeneration: true,
      maxParallelRequests: 3,
      ...options.streamingSpeech,
    };

    // Initialize history config with defaults
    this.historyConfig = {
      maxMessages: 100,
      maxTotalChars: 0, // unlimited by default
      ...options.history,
    };
  }

  /**
   * Ensure the agent has not been destroyed. Throws if it has.
   */
  private ensureNotDestroyed(): void {
    if (this.isDestroyed) {
      throw new Error("VoiceAgent has been destroyed and cannot be used");
    }
  }

  private setupListeners() {
    if (!this.socket) return;

    this.socket.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());
        console.log(`Received WebSocket message of type: ${message.type}`);

        // Handle transcribed text from the client/STT
        if (message.type === "transcript") {
          if (typeof message.text !== "string" || !message.text.trim()) {
            this.emit("warning", "Received empty or invalid transcript message");
            return;
          }
          // Interrupt ongoing speech when user starts speaking (barge-in)
          this.interruptCurrentResponse("user_speaking");
          console.log(`Processing transcript: "${message.text}"`);
          await this.enqueueInput(message.text);
        }
        // Handle raw audio data that needs transcription
        else if (message.type === "audio") {
          if (typeof message.data !== "string" || !message.data) {
            this.emit("warning", "Received empty or invalid audio message");
            return;
          }
          // Interrupt ongoing speech when user starts speaking (barge-in)
          this.interruptCurrentResponse("user_speaking");
          console.log(`Received audio data (${message.data.length / 1000}KB) for processing, format: ${message.format || 'unknown'}`);
          await this.processAudioInput(message.data, message.format);
        }
        // Handle explicit interrupt request from client
        else if (message.type === "interrupt") {
          console.log(`Received interrupt request: ${message.reason || "client_request"}`);
          this.interruptCurrentResponse(message.reason || "client_request");
        }
      } catch (err) {
        console.error("Failed to process message:", err);
        this.emit("error", err);
      }
    });

    this.socket.on("close", () => {
      console.log("Disconnected");
      this.isConnected = false;
      // Clean up all in-flight work when the socket closes
      this.cleanupOnDisconnect();
      this.emit("disconnected");
    });

    this.socket.on("error", (error) => {
      console.error("WebSocket error:", error);
      this.emit("error", error);
    });
  }

  /**
   * Clean up all in-flight state when the connection drops.
   */
  private cleanupOnDisconnect(): void {
    // Abort ongoing LLM stream
    if (this.currentStreamAbortController) {
      this.currentStreamAbortController.abort();
      this.currentStreamAbortController = undefined;
    }
    // Abort ongoing speech generation
    if (this.currentSpeechAbortController) {
      this.currentSpeechAbortController.abort();
      this.currentSpeechAbortController = undefined;
    }
    // Clear speech state
    this.speechChunkQueue = [];
    this.pendingTextBuffer = "";
    this.isSpeaking = false;
    this.isProcessing = false;
    // Resolve any pending speech-done waiters
    if (this.speechQueueDoneResolve) {
      this.speechQueueDoneResolve();
      this.speechQueueDoneResolve = undefined;
      this.speechQueueDonePromise = undefined;
    }
    // Reject any queued inputs
    for (const item of this.inputQueue) {
      item.reject(new Error("Connection closed"));
    }
    this.inputQueue = [];
    this.processingQueue = false;
  }

  public registerTools(tools: Record<string, Tool>) {
    this.tools = { ...this.tools, ...tools };
  }

  /**
   * Transcribe audio data to text using the configured transcription model
   */
  public async transcribeAudio(audioData: Buffer | Uint8Array): Promise<string> {
    if (!this.transcriptionModel) {
      throw new Error("Transcription model not configured");
    }

    console.log(`Sending ${audioData.byteLength} bytes to Whisper for transcription`);

    try {
      // Note: The AI SDK transcribe function only accepts these parameters
      // We can't directly pass language or temperature to it
      const result = await transcribe({
        model: this.transcriptionModel,
        audio: audioData,
        // If we need to pass additional options to OpenAI Whisper,
        // we would need to do it via providerOptions if supported
      });

      console.log(`Whisper transcription result: "${result.text}", language: ${result.language || 'unknown'}`);

      this.emit("transcription", {
        text: result.text,
        language: result.language,
      });

      // Also send transcription to client for immediate feedback
      this.sendWebSocketMessage({
        type: "transcription_result",
        text: result.text,
        language: result.language,
      });

      return result.text;
    } catch (error) {
      console.error("Whisper transcription failed:", error);
      // Re-throw to be handled by the caller
      throw error;
    }
  }

  /**
   * Generate speech from text using the configured speech model
   * @param abortSignal Optional signal to cancel the speech generation
   */
  public async generateSpeechFromText(
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
   * Interrupt ongoing speech generation and playback (barge-in support).
   * This only interrupts TTS — the LLM stream is left running.
   */
  public interruptSpeech(reason: string = "interrupted"): void {
    if (!this.isSpeaking && this.speechChunkQueue.length === 0) {
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
    this.isSpeaking = false;

    // Resolve any pending speech-done waiters so processUserInput can finish
    if (this.speechQueueDoneResolve) {
      this.speechQueueDoneResolve();
      this.speechQueueDoneResolve = undefined;
      this.speechQueueDonePromise = undefined;
    }

    // Notify clients to stop audio playback
    this.sendWebSocketMessage({
      type: "speech_interrupted",
      reason,
    });

    this.emit("speech_interrupted", { reason });
  }

  /**
   * Interrupt both the current LLM stream and ongoing speech.
   * Use this for barge-in scenarios where the entire response should be cancelled.
   */
  public interruptCurrentResponse(reason: string = "interrupted"): void {
    // Abort the LLM stream first
    if (this.currentStreamAbortController) {
      this.currentStreamAbortController.abort();
      this.currentStreamAbortController = undefined;
    }
    // Then interrupt speech
    this.interruptSpeech(reason);
  }

  /**
   * Extract complete sentences from text buffer
   * Returns [extractedSentences, remainingBuffer]
   */
  private extractSentences(text: string): [string[], string] {
    const sentences: string[] = [];
    let remaining = text;

    // Match sentences ending with . ! ? followed by space or end of string
    // Also handles common abbreviations and edge cases
    const sentenceEndPattern = /[.!?]+(?:\s+|$)/g;
    let lastIndex = 0;
    let match;

    while ((match = sentenceEndPattern.exec(text)) !== null) {
      const sentence = text.slice(lastIndex, match.index + match[0].length).trim();
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
   * Trim conversation history to stay within configured limits.
   * Removes oldest messages (always in pairs to preserve user/assistant turns).
   */
  private trimHistory(): void {
    const { maxMessages, maxTotalChars } = this.historyConfig;

    // Trim by message count
    if (maxMessages > 0 && this.conversationHistory.length > maxMessages) {
      const excess = this.conversationHistory.length - maxMessages;
      // Remove from the front, ensuring we remove at least `excess` messages
      // Round up to even number to preserve turn pairs
      const toRemove = excess % 2 === 0 ? excess : excess + 1;
      this.conversationHistory.splice(0, toRemove);
      this.emit("history_trimmed", { removedCount: toRemove, reason: "max_messages" });
    }

    // Trim by total character count
    if (maxTotalChars > 0) {
      let totalChars = this.conversationHistory.reduce((sum, msg) => {
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        return sum + content.length;
      }, 0);

      let removedCount = 0;
      while (totalChars > maxTotalChars && this.conversationHistory.length > 2) {
        const removed = this.conversationHistory.shift();
        if (removed) {
          const content = typeof removed.content === "string" ? removed.content : JSON.stringify(removed.content);
          totalChars -= content.length;
          removedCount++;
        }
      }
      if (removedCount > 0) {
        this.emit("history_trimmed", { removedCount, reason: "max_total_chars" });
      }
    }
  }

  /**
   * Queue a text chunk for speech generation
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
      const activeRequests = this.speechChunkQueue.filter(c => c.audioPromise).length;

      if (activeRequests < this.streamingSpeechConfig.maxParallelRequests) {
        chunk.audioPromise = this.generateChunkAudio(chunk);
      }
    }

    this.speechChunkQueue.push(chunk);
    this.emit("speech_chunk_queued", { id: chunk.id, text: chunk.text });

    // Start processing queue if not already
    if (!this.isSpeaking) {
      this.processSpeechQueue();
    }
  }

  /**
   * Generate audio for a single chunk
   */
  private async generateChunkAudio(chunk: SpeechChunk): Promise<Uint8Array | null> {
    if (!this.currentSpeechAbortController) {
      this.currentSpeechAbortController = new AbortController();
    }

    try {
      console.log(`Generating audio for chunk ${chunk.id}: "${chunk.text.substring(0, 50)}${chunk.text.length > 50 ? '...' : ''}"`);
      const audioData = await this.generateSpeechFromText(
        chunk.text,
        this.currentSpeechAbortController.signal
      );
      console.log(`Generated audio for chunk ${chunk.id}: ${audioData.length} bytes`);
      return audioData;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        console.log(`Audio generation aborted for chunk ${chunk.id}`);
        return null; // Cancelled, don't report as error
      }
      console.error(`Failed to generate audio for chunk ${chunk.id}:`, error);
      this.emit("error", error);
      return null;
    }
  }

  /**
   * Process the speech queue and send audio chunks in order
   */
  private async processSpeechQueue(): Promise<void> {
    if (this.isSpeaking) return;
    this.isSpeaking = true;

    console.log(`Starting speech queue processing with ${this.speechChunkQueue.length} chunks`);
    this.emit("speech_start", { streaming: true });
    this.sendWebSocketMessage({ type: "speech_stream_start" });

    try {
      while (this.speechChunkQueue.length > 0) {
        const chunk = this.speechChunkQueue[0];

        console.log(`Processing speech chunk #${chunk.id} (${this.speechChunkQueue.length - 1} remaining)`);

        // Ensure audio generation has started
        if (!chunk.audioPromise) {
          chunk.audioPromise = this.generateChunkAudio(chunk);
        }

        // Wait for this chunk's audio
        const audioData = await chunk.audioPromise;

        // Check if we were interrupted while waiting
        if (!this.isSpeaking) {
          console.log(`Speech interrupted during chunk #${chunk.id}`);
          break;
        }

        // Remove from queue after processing
        this.speechChunkQueue.shift();

        if (audioData) {
          const base64Audio = Buffer.from(audioData).toString("base64");
          console.log(`Sending audio chunk #${chunk.id} (${audioData.length} bytes, ${this.outputFormat})`);

          // Send audio chunk via WebSocket
          this.sendWebSocketMessage({
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
          const activeRequests = this.speechChunkQueue.filter(c => c.audioPromise).length;
          const toStart = Math.min(
            this.streamingSpeechConfig.maxParallelRequests - activeRequests,
            this.speechChunkQueue.length
          );

          if (toStart > 0) {
            console.log(`Starting parallel generation for ${toStart} more chunks`);
            for (let i = 0; i < toStart; i++) {
              const nextChunk = this.speechChunkQueue.find(c => !c.audioPromise);
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
      this.isSpeaking = false;
      this.currentSpeechAbortController = undefined;

      // Signal that the speech queue is fully drained
      if (this.speechQueueDoneResolve) {
        this.speechQueueDoneResolve();
        this.speechQueueDoneResolve = undefined;
        this.speechQueueDonePromise = undefined;
      }

      console.log(`Speech queue processing complete`);
      this.sendWebSocketMessage({ type: "speech_stream_end" });
      this.emit("speech_complete", { streaming: true });
    }
  }

  /**
   * Process text delta for streaming speech.
   * Call this as text chunks arrive from LLM.
   */
  private processTextForStreamingSpeech(textDelta: string): void {
    if (!this.speechModel) return;

    this.pendingTextBuffer += textDelta;

    const [sentences, remaining] = this.extractSentences(this.pendingTextBuffer);
    this.pendingTextBuffer = remaining;

    for (const sentence of sentences) {
      this.queueSpeechChunk(sentence);
    }
  }

  /**
   * Flush any remaining text in the buffer to speech
   * Call this when stream ends
   */
  private flushStreamingSpeech(): void {
    if (!this.speechModel || !this.pendingTextBuffer.trim()) return;

    this.queueSpeechChunk(this.pendingTextBuffer);
    this.pendingTextBuffer = "";
  }

  /**
   * Process incoming audio data: transcribe and generate response
   */
  private async processAudioInput(base64Audio: string, format?: string): Promise<void> {
    if (!this.transcriptionModel) {
      this.emit("error", new Error("Transcription model not configured for audio input"));
      return;
    }

    try {
      const audioBuffer = Buffer.from(base64Audio, "base64");

      // Validate audio size to prevent memory issues
      if (audioBuffer.length > this.maxAudioInputSize) {
        const sizeMB = (audioBuffer.length / (1024 * 1024)).toFixed(1);
        const maxMB = (this.maxAudioInputSize / (1024 * 1024)).toFixed(1);
        this.emit("error", new Error(
          `Audio input too large (${sizeMB} MB). Maximum allowed: ${maxMB} MB`
        ));
        return;
      }

      if (audioBuffer.length === 0) {
        this.emit("warning", "Received empty audio data");
        return;
      }

      this.emit("audio_received", { size: audioBuffer.length, format });
      console.log(`Processing audio input: ${audioBuffer.length} bytes, format: ${format || 'unknown'}`);

      const transcribedText = await this.transcribeAudio(audioBuffer);
      console.log(`Transcribed text: "${transcribedText}"`);

      if (transcribedText.trim()) {
        await this.enqueueInput(transcribedText);
      } else {
        this.emit("warning", "Transcription returned empty text");
        this.sendWebSocketMessage({
          type: "transcription_error",
          error: "Whisper returned empty text"
        });
      }
    } catch (error) {
      console.error("Failed to process audio input:", error);
      this.emit("error", error);
      this.sendWebSocketMessage({
        type: "transcription_error",
        error: `Transcription failed: ${(error as Error).message || String(error)}`
      });
    }
  }

  public async connect(url?: string): Promise<void> {
    this.ensureNotDestroyed();

    // Clean up any existing connection first
    if (this.socket) {
      this.disconnectSocket();
    }

    return new Promise((resolve, reject) => {
      try {
        // Use provided URL, configured endpoint, or default URL
        const wsUrl = url || this.endpoint || "ws://localhost:8080";
        this.socket = new WebSocket(wsUrl);
        this.setupListeners();

        this.socket.once("open", () => {
          this.isConnected = true;
          this.emit("connected");
          resolve();
        });

        this.socket.once("error", (error) => {
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Attach an existing WebSocket (server-side usage).
   * Use this when a WS server accepts a connection and you want the
   * agent to handle messages on that socket.
   */
  public handleSocket(socket: WebSocket): void {
    this.ensureNotDestroyed();

    // Clean up any existing connection first
    if (this.socket) {
      this.disconnectSocket();
    }

    this.socket = socket;
    this.isConnected = true;
    this.setupListeners();
    this.emit("connected");
  }

  /**
   * Send text input for processing (bypasses transcription).
   * Requests are queued and processed serially to prevent race conditions.
   */
  public async sendText(text: string): Promise<string> {
    this.ensureNotDestroyed();
    if (!text || !text.trim()) {
      throw new Error("Text input cannot be empty");
    }
    return this.enqueueInput(text);
  }

  /**
   * Send audio data to be transcribed and processed
   * @param audioData Base64 encoded audio data
   */
  public async sendAudio(audioData: string): Promise<void> {
    this.ensureNotDestroyed();
    await this.processAudioInput(audioData);
  }

  /**
   * Send raw audio buffer to be transcribed and processed
   */
  public async sendAudioBuffer(audioBuffer: Buffer | Uint8Array): Promise<void> {
    this.ensureNotDestroyed();
    const base64Audio = Buffer.from(audioBuffer).toString("base64");
    await this.processAudioInput(base64Audio);
  }

  /**
   * Enqueue a text input for serial processing.
   * This ensures only one processUserInput runs at a time, preventing
   * race conditions on conversationHistory, fullText accumulation, etc.
   */
  private enqueueInput(text: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.inputQueue.push({ text, resolve, reject });
      this.drainInputQueue();
    });
  }

  /**
   * Drain the input queue, processing one request at a time.
   */
  private async drainInputQueue(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;

    try {
      while (this.inputQueue.length > 0) {
        const item = this.inputQueue.shift()!;
        try {
          const result = await this.processUserInput(item.text);
          item.resolve(result);
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.processingQueue = false;
    }
  }

  /**
   * Process user input with streaming text generation.
   * Handles the full pipeline: text -> LLM (streaming) -> TTS -> WebSocket.
   *
   * This method is designed to be called serially via drainInputQueue().
   */
  private async processUserInput(text: string): Promise<string> {
    this.isProcessing = true;

    // Create an abort controller for this LLM stream so it can be cancelled
    this.currentStreamAbortController = new AbortController();
    const streamAbortSignal = this.currentStreamAbortController.signal;

    try {
      // Emit text event for incoming user input
      this.emit("text", { role: "user", text });

      // Add user message to conversation history and trim if needed
      this.conversationHistory.push({ role: "user", content: text });
      this.trimHistory();

      // Use streamText for streaming responses with tool support
      const result = streamText({
        model: this.model,
        system: this.instructions,
        messages: this.conversationHistory,
        tools: this.tools,
        stopWhen: this.stopWhen,
        abortSignal: streamAbortSignal,
        onChunk: ({ chunk }) => {
          // Emit streaming chunks for real-time updates
          // Note: onChunk only receives a subset of stream events
          switch (chunk.type) {
            case "text-delta":
              this.emit("chunk:text_delta", { id: chunk.id, text: chunk.text });
              break;

            case "reasoning-delta":
              this.emit("chunk:reasoning_delta", { id: chunk.id, text: chunk.text });
              break;

            case "tool-call":
              this.emit("chunk:tool_call", {
                toolName: chunk.toolName,
                toolCallId: chunk.toolCallId,
                input: chunk.input,
              });
              break;

            case "tool-result":
              this.emit("chunk:tool_result", {
                toolName: chunk.toolName,
                toolCallId: chunk.toolCallId,
                result: chunk.output,
              });
              break;

            case "tool-input-start":
              this.emit("chunk:tool_input_start", {
                id: chunk.id,
                toolName: chunk.toolName,
              });
              break;

            case "tool-input-delta":
              this.emit("chunk:tool_input_delta", {
                id: chunk.id,
                delta: chunk.delta,
              });
              break;

            case "source":
              this.emit("chunk:source", chunk);
              break;
          }
        },
        onFinish: async (event) => {
          // Process steps for tool results
          for (const step of event.steps) {
            for (const toolResult of step.toolResults) {
              this.emit("tool_result", {
                name: toolResult.toolName,
                toolCallId: toolResult.toolCallId,
                result: toolResult.output,
              });
            }
          }
        },
        onError: ({ error }) => {
          console.error("Stream error:", error);
          this.emit("error", error);
        },
      });

      // Collect the full response text and reasoning
      let fullText = "";
      let fullReasoning = "";
      const allToolCalls: Array<{
        toolName: string;
        toolCallId: string;
        input: unknown;
      }> = [];
      const allToolResults: Array<{
        toolName: string;
        toolCallId: string;
        output: unknown;
      }> = [];
      const allSources: Array<unknown> = [];
      const allFiles: Array<unknown> = [];

      // Process the full stream
      for await (const part of result.fullStream) {
        switch (part.type) {
          // Stream lifecycle
          case "start":
            this.sendWebSocketMessage({ type: "stream_start" });
            break;

          case "finish":
            this.emit("text", { role: "assistant", text: fullText });
            this.sendWebSocketMessage({
              type: "stream_finish",
              finishReason: part.finishReason,
              usage: part.totalUsage,
            });
            break;

          case "error":
            this.emit("error", part.error);
            this.sendWebSocketMessage({
              type: "stream_error",
              error: String(part.error),
            });
            break;

          case "abort":
            this.emit("abort", { reason: part.reason });
            this.sendWebSocketMessage({
              type: "stream_abort",
              reason: part.reason,
            });
            break;

          // Step lifecycle
          case "start-step":
            this.sendWebSocketMessage({
              type: "step_start",
              warnings: part.warnings,
            });
            break;

          case "finish-step":
            this.sendWebSocketMessage({
              type: "step_finish",
              finishReason: part.finishReason,
              usage: part.usage,
            });
            break;

          // Text streaming
          case "text-start":
            this.sendWebSocketMessage({ type: "text_start", id: part.id });
            break;

          case "text-delta":
            fullText += part.text;
            // Process text for streaming speech as it arrives
            this.processTextForStreamingSpeech(part.text);
            this.sendWebSocketMessage({
              type: "text_delta",
              id: part.id,
              text: part.text,
            });
            break;

          case "text-end":
            // Flush any remaining text to speech when text stream ends
            this.flushStreamingSpeech();
            this.sendWebSocketMessage({ type: "text_end", id: part.id });
            break;

          // Reasoning streaming (for models that support it)
          case "reasoning-start":
            this.sendWebSocketMessage({ type: "reasoning_start", id: part.id });
            break;

          case "reasoning-delta":
            fullReasoning += part.text;
            this.sendWebSocketMessage({
              type: "reasoning_delta",
              id: part.id,
              text: part.text,
            });
            break;

          case "reasoning-end":
            this.sendWebSocketMessage({ type: "reasoning_end", id: part.id });
            break;

          // Tool input streaming
          case "tool-input-start":
            this.sendWebSocketMessage({
              type: "tool_input_start",
              id: part.id,
              toolName: part.toolName,
            });
            break;

          case "tool-input-delta":
            this.sendWebSocketMessage({
              type: "tool_input_delta",
              id: part.id,
              delta: part.delta,
            });
            break;

          case "tool-input-end":
            this.sendWebSocketMessage({ type: "tool_input_end", id: part.id });
            break;

          // Tool execution
          case "tool-call":
            allToolCalls.push({
              toolName: part.toolName,
              toolCallId: part.toolCallId,
              input: part.input,
            });
            this.sendWebSocketMessage({
              type: "tool_call",
              toolName: part.toolName,
              toolCallId: part.toolCallId,
              input: part.input,
            });
            break;

          case "tool-result":
            allToolResults.push({
              toolName: part.toolName,
              toolCallId: part.toolCallId,
              output: part.output,
            });
            this.sendWebSocketMessage({
              type: "tool_result",
              toolName: part.toolName,
              toolCallId: part.toolCallId,
              result: part.output,
            });
            break;

          case "tool-error":
            this.sendWebSocketMessage({
              type: "tool_error",
              toolName: part.toolName,
              toolCallId: part.toolCallId,
              error: String(part.error),
            });
            break;

          // Sources and files
          case "source":
            allSources.push(part);
            this.sendWebSocketMessage({
              type: "source",
              source: part,
            });
            break;

          case "file":
            allFiles.push(part.file);
            this.sendWebSocketMessage({
              type: "file",
              file: part.file,
            });
            break;
        }
      }

      // Add assistant response to conversation history and trim
      if (fullText) {
        this.conversationHistory.push({ role: "assistant", content: fullText });
        this.trimHistory();
      }

      // Ensure any remaining speech is flushed (in case text-end wasn't triggered)
      this.flushStreamingSpeech();

      // Wait for all speech chunks to complete using promise-based signaling
      // (replaces the previous busy-wait polling loop)
      if (this.speechQueueDonePromise) {
        await this.speechQueueDonePromise;
      }

      // Send the complete response
      this.sendWebSocketMessage({
        type: "response_complete",
        text: fullText,
        reasoning: fullReasoning || undefined,
        toolCalls: allToolCalls,
        toolResults: allToolResults,
        sources: allSources.length > 0 ? allSources : undefined,
        files: allFiles.length > 0 ? allFiles : undefined,
      });

      return fullText;
    } catch (error) {
      // Clean up speech state on error so the agent isn't stuck in a broken state
      this.pendingTextBuffer = "";
      if (this.speechChunkQueue.length > 0 || this.isSpeaking) {
        this.interruptSpeech("stream_error");
      }
      throw error;
    } finally {
      this.isProcessing = false;
      this.currentStreamAbortController = undefined;
    }
  }

  /**
   * Generate speech for full text at once (non-streaming fallback)
   * Useful when you want to bypass streaming speech for short responses
   */
  public async generateAndSendSpeechFull(text: string): Promise<void> {
    if (!this.speechModel) return;

    try {
      this.emit("speech_start", { text, streaming: false });

      const audioData = await this.generateSpeechFromText(text);
      const base64Audio = Buffer.from(audioData).toString("base64");

      // Send audio via WebSocket
      this.sendWebSocketMessage({
        type: "audio",
        data: base64Audio,
        format: this.outputFormat,
      });

      // Also emit for local handling
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
   * Send a message via WebSocket if connected.
   * Gracefully handles send failures (e.g., socket closing mid-send).
   */
  private sendWebSocketMessage(message: Record<string, unknown>): void {
    if (!this.socket || !this.isConnected) return;

    try {
      if (this.socket.readyState === WebSocket.OPEN) {
        // Skip logging huge audio data for better readability
        if (message.type === "audio_chunk" || message.type === "audio") {
          const { data, ...rest } = message as any;
          console.log(`Sending WebSocket message: ${message.type}`,
            data ? `(${(data.length / 1000).toFixed(1)}KB audio data)` : "",
            rest
          );
        } else {
          console.log(`Sending WebSocket message: ${message.type}`);
        }

        this.socket.send(JSON.stringify(message));
      } else {
        console.warn(`Cannot send message, socket state: ${this.socket.readyState}`);
      }
    } catch (error) {
      // Socket may have closed between the readyState check and send()
      console.error("Failed to send WebSocket message:", error);
      this.emit("error", error);
    }
  }

  /**
   * Start listening for voice input
   */
  startListening() {
    console.log("Starting voice agent...");
    this.emit("listening");
  }

  /**
   * Stop listening for voice input
   */
  stopListening() {
    console.log("Stopping voice agent...");
    this.emit("stopped");
  }

  /**
   * Clear conversation history
   */
  clearHistory() {
    this.conversationHistory = [];
    this.emit("history_cleared");
  }

  /**
   * Get current conversation history
   */
  getHistory(): ModelMessage[] {
    return [...this.conversationHistory];
  }

  /**
   * Set conversation history (useful for restoring sessions)
   */
  setHistory(history: ModelMessage[]) {
    this.conversationHistory = [...history];
  }

  /**
   * Internal helper to close and clean up the current socket.
   */
  private disconnectSocket(): void {
    if (!this.socket) return;

    // Stop all in-flight work tied to this connection
    this.cleanupOnDisconnect();

    try {
      this.socket.removeAllListeners();
      if (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING) {
        this.socket.close();
      }
    } catch {
      // Ignore close errors — socket may already be dead
    }
    this.socket = undefined;
    this.isConnected = false;
  }

  /**
   * Disconnect from WebSocket and stop all in-flight work.
   */
  disconnect() {
    this.disconnectSocket();
  }

  /**
   * Permanently destroy the agent, releasing all resources.
   * After calling this, the agent cannot be reused.
   */
  destroy() {
    this.isDestroyed = true;
    this.disconnectSocket();
    this.conversationHistory = [];
    this.tools = {};
    this.removeAllListeners();
  }

  /**
   * Check if agent is connected to WebSocket
   */
  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Check if agent is currently processing a request
   */
  get processing(): boolean {
    return this.isProcessing;
  }

  /**
   * Check if agent is currently speaking (generating/playing audio)
   */
  get speaking(): boolean {
    return this.isSpeaking;
  }

  /**
   * Get the number of pending speech chunks in the queue
   */
  get pendingSpeechChunks(): number {
    return this.speechChunkQueue.length;
  }

  /**
   * Check if agent has been permanently destroyed
   */
  get destroyed(): boolean {
    return this.isDestroyed;
  }
}
