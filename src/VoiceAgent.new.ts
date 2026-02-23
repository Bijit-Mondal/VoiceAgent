import { WebSocket } from "ws";
import { EventEmitter } from "events";
import {
  streamText,
  type LanguageModel,
  stepCountIs,
  type Tool,
  type ModelMessage,
  type TranscriptionModel,
  type SpeechModel,
} from "ai";
import {
  type StreamingSpeechConfig,
  type HistoryConfig,
} from "./types";
import {
  WebSocketManager,
  SpeechManager,
  ConversationManager,
  TranscriptionManager,
  InputQueue,
  type QueueItem,
  processFullStream,
  handleStreamChunk,
} from "./core";

export interface VoiceAgentOptions {
  model: LanguageModel;
  transcriptionModel?: TranscriptionModel;
  speechModel?: SpeechModel;
  instructions?: string;
  stopWhen?: NonNullable<Parameters<typeof streamText>[0]["stopWhen"]>;
  tools?: Record<string, Tool>;
  endpoint?: string;
  voice?: string;
  speechInstructions?: string;
  outputFormat?: string;
  /** Configuration for streaming speech generation */
  streamingSpeech?: Partial<StreamingSpeechConfig>;
  /** Configuration for conversation history memory limits */
  history?: Partial<HistoryConfig>;
  /** Maximum audio input size in bytes (default: 10 MB) */
  maxAudioInputSize?: number;
}

/** Shape of items in the voice agent's input queue */
interface VoiceInputItem extends QueueItem<string> {
  text: string;
}

/**
 * A single-session voice agent that manages one WebSocket connection at a time.
 *
 * **Important:** Each `VoiceAgent` instance holds its own conversation history,
 * input queue, speech state, and WebSocket. It is designed for **one user per
 * instance**. To support multiple concurrent users, create a separate
 * `VoiceAgent` for each connection:
 *
 * ```ts
 * wss.on("connection", (socket) => {
 *   const agent = new VoiceAgent({ model, ... });
 *   agent.handleSocket(socket);
 *   agent.on("disconnected", () => agent.destroy());
 * });
 * ```
 *
 * Sharing a single instance across multiple users will cause conversation
 * history cross-contamination, interleaved audio, and unpredictable behavior.
 */
export class VoiceAgent extends EventEmitter {
  private model: LanguageModel;
  private instructions: string;
  private stopWhen: NonNullable<Parameters<typeof streamText>[0]["stopWhen"]>;
  private endpoint?: string;
  private tools: Record<string, Tool> = {};
  private isDestroyed = false;
  private _isProcessing = false;

  // Abort controller for the current LLM stream
  private currentStreamAbortController?: AbortController;

  // ── Managers ──────────────────────────────────────────
  private ws: WebSocketManager;
  private speech: SpeechManager;
  private conversation: ConversationManager;
  private transcription: TranscriptionManager;
  private inputQueue: InputQueue<VoiceInputItem>;

  constructor(options: VoiceAgentOptions) {
    super();
    this.model = options.model;
    this.instructions =
      options.instructions || "You are a helpful voice assistant.";
    this.stopWhen = options.stopWhen || stepCountIs(5);
    this.endpoint = options.endpoint;
    if (options.tools) {
      this.tools = { ...options.tools };
    }

    // ── Initialize managers ──────────────────────────────
    this.ws = new WebSocketManager();
    this.speech = new SpeechManager({
      speechModel: options.speechModel,
      voice: options.voice,
      speechInstructions: options.speechInstructions,
      outputFormat: options.outputFormat,
      streamingSpeech: options.streamingSpeech,
    });
    this.conversation = new ConversationManager({
      history: options.history,
    });
    this.transcription = new TranscriptionManager({
      transcriptionModel: options.transcriptionModel,
      maxAudioInputSize: options.maxAudioInputSize,
    });
    this.inputQueue = new InputQueue<VoiceInputItem>();

    // ── Wire managers to the WebSocket send function ─────
    const sendMsg = (msg: Record<string, unknown>) => this.ws.send(msg);
    this.speech.sendMessage = sendMsg;
    this.transcription.sendMessage = sendMsg;

    // ── Wire the input queue processor ───────────────────
    this.inputQueue.processor = (item) => this.processUserInput(item.text);

    // ── Bubble events from managers ──────────────────────
    this.bubbleEvents(this.ws, [
      "connected",
      "error",
    ]);
    this.bubbleEvents(this.speech, [
      "speech_start",
      "speech_complete",
      "speech_interrupted",
      "speech_chunk_queued",
      "audio_chunk",
      "audio",
      "error",
    ]);
    this.bubbleEvents(this.conversation, [
      "history_cleared",
      "history_trimmed",
    ]);
    this.bubbleEvents(this.transcription, [
      "transcription",
      "audio_received",
      "error",
      "warning",
    ]);

    // ── Handle WebSocket lifecycle events ────────────────
    this.ws.on("disconnected", () => {
      this.cleanupOnDisconnect();
      this.emit("disconnected");
    });

    this.ws.on("message", (message: any) => this.handleMessage(message));
  }

  // ── Public API ────────────────────────────────────────

  public registerTools(tools: Record<string, Tool>) {
    this.tools = { ...this.tools, ...tools };
  }

  /**
   * Transcribe audio data to text using the configured transcription model.
   */
  public async transcribeAudio(audioData: Buffer | Uint8Array): Promise<string> {
    return this.transcription.transcribeAudio(audioData);
  }

  /**
   * Generate speech from text using the configured speech model.
   */
  public async generateSpeechFromText(
    text: string,
    abortSignal?: AbortSignal
  ): Promise<Uint8Array> {
    return this.speech.generateSpeechFromText(text, abortSignal);
  }

  /**
   * Interrupt ongoing speech generation and playback (barge-in support).
   */
  public interruptSpeech(reason: string = "interrupted"): void {
    this.speech.interruptSpeech(reason);
  }

  /**
   * Interrupt both the current LLM stream and ongoing speech.
   */
  public interruptCurrentResponse(reason: string = "interrupted"): void {
    if (this.currentStreamAbortController) {
      this.currentStreamAbortController.abort();
      this.currentStreamAbortController = undefined;
    }
    this.speech.interruptSpeech(reason);
  }

  /**
   * Connect to a WebSocket server by URL.
   */
  public async connect(url?: string): Promise<void> {
    this.ensureNotDestroyed();
    const wsUrl = url || this.endpoint || "ws://localhost:8080";
    await this.ws.connect(wsUrl);
  }

  /**
   * Attach an existing WebSocket (server-side usage).
   */
  public handleSocket(socket: WebSocket): void {
    this.ensureNotDestroyed();
    this.ws.handleSocket(socket);
  }

  /**
   * Send text input for processing (bypasses transcription).
   */
  public async sendText(text: string): Promise<string> {
    this.ensureNotDestroyed();
    if (!text || !text.trim()) {
      throw new Error("Text input cannot be empty");
    }
    return this.enqueueInput(text);
  }

  /**
   * Send base64 audio data to be transcribed and processed.
   */
  public async sendAudio(audioData: string): Promise<void> {
    this.ensureNotDestroyed();
    await this.handleAudioInput(audioData);
  }

  /**
   * Send raw audio buffer to be transcribed and processed.
   */
  public async sendAudioBuffer(audioBuffer: Buffer | Uint8Array): Promise<void> {
    this.ensureNotDestroyed();
    const base64Audio = Buffer.from(audioBuffer).toString("base64");
    await this.handleAudioInput(base64Audio);
  }

  /**
   * Generate speech for full text at once (non-streaming fallback).
   */
  public async generateAndSendSpeechFull(text: string): Promise<void> {
    return this.speech.generateAndSendSpeechFull(text);
  }

  /** Start listening for voice input */
  startListening() {
    console.log("Starting voice agent...");
    this.emit("listening");
  }

  /** Stop listening for voice input */
  stopListening() {
    console.log("Stopping voice agent...");
    this.emit("stopped");
  }

  /** Clear conversation history */
  clearHistory() {
    this.conversation.clearHistory();
  }

  /** Get current conversation history */
  getHistory(): ModelMessage[] {
    return this.conversation.getHistory();
  }

  /** Set conversation history (useful for restoring sessions) */
  setHistory(history: ModelMessage[]) {
    this.conversation.setHistory(history);
  }

  /** Disconnect from WebSocket and stop all in-flight work */
  disconnect() {
    this.ws.disconnect();
  }

  /**
   * Permanently destroy the agent, releasing all resources.
   */
  destroy() {
    this.isDestroyed = true;
    this.cleanupOnDisconnect();
    this.ws.disconnect();
    this.conversation.clearHistory();
    this.tools = {};
    this.removeAllListeners();
  }

  // ── Getters ───────────────────────────────────────────

  get connected(): boolean {
    return this.ws.isConnected;
  }

  get processing(): boolean {
    return this._isProcessing;
  }

  get speaking(): boolean {
    return this.speech.isSpeaking;
  }

  get pendingSpeechChunks(): number {
    return this.speech.pendingChunkCount;
  }

  get destroyed(): boolean {
    return this.isDestroyed;
  }

  // ── Private: message handling ─────────────────────────

  private async handleMessage(message: any): Promise<void> {
    try {
      console.log(`Received WebSocket message of type: ${message.type}`);

      if (message.type === "transcript") {
        if (typeof message.text !== "string" || !message.text.trim()) {
          this.emit("warning", "Received empty or invalid transcript message");
          return;
        }
        this.interruptCurrentResponse("user_speaking");
        console.log(`Processing transcript: "${message.text}"`);
        await this.enqueueInput(message.text);
      } else if (message.type === "audio") {
        if (typeof message.data !== "string" || !message.data) {
          this.emit("warning", "Received empty or invalid audio message");
          return;
        }
        this.interruptCurrentResponse("user_speaking");
        console.log(
          `Received audio data (${message.data.length / 1000}KB) for processing, format: ${message.format || "unknown"}`
        );
        await this.handleAudioInput(message.data, message.format);
      } else if (message.type === "interrupt") {
        console.log(
          `Received interrupt request: ${message.reason || "client_request"}`
        );
        this.interruptCurrentResponse(message.reason || "client_request");
      }
    } catch (err) {
      console.error("Failed to process message:", err);
      this.emit("error", err);
    }
  }

  // ── Private: audio ────────────────────────────────────

  private async handleAudioInput(
    base64Audio: string,
    format?: string
  ): Promise<void> {
    const text = await this.transcription.processAudioInput(
      base64Audio,
      format
    );
    if (text) {
      await this.enqueueInput(text);
    }
  }

  // ── Private: input queue ──────────────────────────────

  private enqueueInput(text: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.inputQueue.enqueue({ text, resolve, reject });
    });
  }

  // ── Private: LLM processing ───────────────────────────

  /**
   * Process user input with streaming text generation.
   * Called serially by the input queue.
   */
  private async processUserInput(text: string): Promise<string> {
    this._isProcessing = true;
    this.currentStreamAbortController = new AbortController();
    const streamAbortSignal = this.currentStreamAbortController.signal;

    try {
      this.emit("text", { role: "user", text });

      this.conversation.addMessage({ role: "user", content: text });

      const result = streamText({
        model: this.model,
        system: this.instructions,
        messages: this.conversation.getHistoryRef(),
        tools: this.tools,
        stopWhen: this.stopWhen,
        abortSignal: streamAbortSignal,
        onChunk: ({ chunk }) => {
          handleStreamChunk(chunk, (event, data) => this.emit(event, data));
        },
        onFinish: async (event) => {
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

      const streamResult = await processFullStream(result, {
        onTextDelta: (delta) => this.speech.processTextDelta(delta),
        onTextEnd: () => this.speech.flushPendingText(),
        sendMessage: (msg) => this.ws.send(msg),
        emitEvent: (event, data) => this.emit(event, data),
      });

      // Add assistant response to history
      if (streamResult.fullText) {
        this.conversation.addMessage({
          role: "assistant",
          content: streamResult.fullText,
        });
      }

      // Flush any remaining speech
      this.speech.flushPendingText();

      // Wait for all speech chunks to complete
      if (this.speech.queueDonePromise) {
        await this.speech.queueDonePromise;
      }

      return streamResult.fullText;
    } catch (error) {
      // Clean up speech state on error
      this.speech.reset();
      throw error;
    } finally {
      this._isProcessing = false;
      this.currentStreamAbortController = undefined;
    }
  }

  // ── Private: helpers ──────────────────────────────────

  private ensureNotDestroyed(): void {
    if (this.isDestroyed) {
      throw new Error("VoiceAgent has been destroyed and cannot be used");
    }
  }

  /**
   * Clean up all in-flight state when the connection drops.
   */
  private cleanupOnDisconnect(): void {
    if (this.currentStreamAbortController) {
      this.currentStreamAbortController.abort();
      this.currentStreamAbortController = undefined;
    }
    this.speech.reset();
    this._isProcessing = false;
    this.inputQueue.rejectAll(new Error("Connection closed"));
  }

  /**
   * Forward select events from a child emitter to this agent.
   */
  private bubbleEvents(source: EventEmitter, events: string[]): void {
    for (const event of events) {
      source.on(event, (...args: any[]) => this.emit(event, ...args));
    }
  }
}
