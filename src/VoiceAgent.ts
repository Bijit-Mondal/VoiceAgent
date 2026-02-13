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
    if (options.tools) {
      this.tools = { ...options.tools };
    }
  }

  private setupListeners() {
    if (!this.socket) return;

    this.socket.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());

        // Handle transcribed text from the client/STT
        if (message.type === "transcript") {
          await this.processUserInput(message.text);
        }
        // Handle raw audio data that needs transcription
        if (message.type === "audio") {
          await this.processAudioInput(message.data);
        }
      } catch (err) {
        console.error("Failed to process message:", err);
        this.emit("error", err);
      }
    });

    this.socket.on("close", () => {
      console.log("Disconnected");
      this.isConnected = false;
      this.emit("disconnected");
    });

    this.socket.on("error", (error) => {
      console.error("WebSocket error:", error);
      this.emit("error", error);
    });
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

    const result = await transcribe({
      model: this.transcriptionModel,
      audio: audioData,
    });

    this.emit("transcription", {
      text: result.text,
      language: result.language,
    });

    return result.text;
  }

  /**
   * Generate speech from text using the configured speech model
   */
  public async generateSpeechFromText(text: string): Promise<Uint8Array> {
    if (!this.speechModel) {
      throw new Error("Speech model not configured");
    }

    const result = await generateSpeech({
      model: this.speechModel,
      text,
      voice: this.voice,
      instructions: this.speechInstructions,
      outputFormat: this.outputFormat,
    });

    return result.audio.uint8Array;
  }

  /**
   * Process incoming audio data: transcribe and generate response
   */
  private async processAudioInput(base64Audio: string): Promise<void> {
    if (!this.transcriptionModel) {
      this.emit("error", new Error("Transcription model not configured for audio input"));
      return;
    }

    try {
      const audioBuffer = Buffer.from(base64Audio, "base64");
      this.emit("audio_received", { size: audioBuffer.length });

      const transcribedText = await this.transcribeAudio(audioBuffer);

      if (transcribedText.trim()) {
        await this.processUserInput(transcribedText);
      }
    } catch (error) {
      console.error("Failed to process audio input:", error);
      this.emit("error", error);
    }
  }

  public async connect(url?: string): Promise<void> {
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
   * Send text input for processing (bypasses transcription)
   */
  public async sendText(text: string): Promise<string> {
    return this.processUserInput(text);
  }

  /**
   * Send audio data to be transcribed and processed
   * @param audioData Base64 encoded audio data
   */
  public async sendAudio(audioData: string): Promise<void> {
    await this.processAudioInput(audioData);
  }

  /**
   * Send raw audio buffer to be transcribed and processed
   */
  public async sendAudioBuffer(audioBuffer: Buffer | Uint8Array): Promise<void> {
    const base64Audio = Buffer.from(audioBuffer).toString("base64");
    await this.processAudioInput(base64Audio);
  }

  /**
   * Process user input with streaming text generation
   * Handles the full pipeline: text -> LLM (streaming) -> TTS -> WebSocket
   */
  private async processUserInput(text: string): Promise<string> {
    if (this.isProcessing) {
      this.emit("warning", "Already processing a request, queuing...");
    }
    this.isProcessing = true;

    try {
      // Emit text event for incoming user input
      this.emit("text", { role: "user", text });

      // Add user message to conversation history
      this.conversationHistory.push({ role: "user", content: text });

      // Use streamText for streaming responses with tool support
      const result = streamText({
        model: this.model,
        system: this.instructions,
        messages: this.conversationHistory,
        tools: this.tools,
        stopWhen: this.stopWhen,
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
            this.sendWebSocketMessage({
              type: "text_delta",
              id: part.id,
              text: part.text,
            });
            break;

          case "text-end":
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

      // Add assistant response to conversation history
      if (fullText) {
        this.conversationHistory.push({ role: "assistant", content: fullText });
      }

      // Generate speech from the response if speech model is configured
      if (this.speechModel && fullText) {
        await this.generateAndSendSpeech(fullText);
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
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Generate speech and send audio via WebSocket
   */
  private async generateAndSendSpeech(text: string): Promise<void> {
    if (!this.speechModel) return;

    try {
      this.emit("speech_start", { text });

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

      this.emit("speech_complete", { text });
    } catch (error) {
      console.error("Failed to generate speech:", error);
      this.emit("error", error);
    }
  }

  /**
   * Send a message via WebSocket if connected
   */
  private sendWebSocketMessage(message: Record<string, unknown>): void {
    if (this.socket && this.isConnected) {
      this.socket.send(JSON.stringify(message));
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
   * Disconnect from WebSocket
   */
  disconnect() {
    if (this.socket) {
      this.socket.close();
      this.socket = undefined;
      this.isConnected = false;
    }
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
}
