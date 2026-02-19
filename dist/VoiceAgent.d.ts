import { WebSocket } from "ws";
import { EventEmitter } from "events";
import { streamText, LanguageModel, type Tool, type ModelMessage, type TranscriptionModel, type SpeechModel } from "ai";
import { type StreamingSpeechConfig, type HistoryConfig } from "./types";
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
export declare class VoiceAgent extends EventEmitter {
    private socket?;
    private tools;
    private model;
    private transcriptionModel?;
    private speechModel?;
    private instructions;
    private stopWhen;
    private endpoint?;
    private isConnected;
    private conversationHistory;
    private voice;
    private speechInstructions?;
    private outputFormat;
    private isProcessing;
    private isDestroyed;
    private inputQueue;
    private processingQueue;
    private currentStreamAbortController?;
    private historyConfig;
    private maxAudioInputSize;
    private streamingSpeechConfig;
    private currentSpeechAbortController?;
    private speechChunkQueue;
    private nextChunkId;
    private isSpeaking;
    private pendingTextBuffer;
    private speechQueueDonePromise?;
    private speechQueueDoneResolve?;
    constructor(options: VoiceAgentOptions);
    /**
     * Ensure the agent has not been destroyed. Throws if it has.
     */
    private ensureNotDestroyed;
    private setupListeners;
    /**
     * Clean up all in-flight state when the connection drops.
     */
    private cleanupOnDisconnect;
    registerTools(tools: Record<string, Tool>): void;
    /**
     * Transcribe audio data to text using the configured transcription model
     */
    transcribeAudio(audioData: Buffer | Uint8Array): Promise<string>;
    /**
     * Generate speech from text using the configured speech model
     * @param abortSignal Optional signal to cancel the speech generation
     */
    generateSpeechFromText(text: string, abortSignal?: AbortSignal): Promise<Uint8Array>;
    /**
     * Interrupt ongoing speech generation and playback (barge-in support).
     * This only interrupts TTS — the LLM stream is left running.
     */
    interruptSpeech(reason?: string): void;
    /**
     * Interrupt both the current LLM stream and ongoing speech.
     * Use this for barge-in scenarios where the entire response should be cancelled.
     */
    interruptCurrentResponse(reason?: string): void;
    /**
     * Extract complete sentences from text buffer
     * Returns [extractedSentences, remainingBuffer]
     */
    private extractSentences;
    /**
     * Trim conversation history to stay within configured limits.
     * Removes oldest messages (always in pairs to preserve user/assistant turns).
     */
    private trimHistory;
    /**
     * Queue a text chunk for speech generation
     */
    private queueSpeechChunk;
    /**
     * Generate audio for a single chunk
     */
    private generateChunkAudio;
    /**
     * Process the speech queue and send audio chunks in order
     */
    private processSpeechQueue;
    /**
     * Process text delta for streaming speech.
     * Call this as text chunks arrive from LLM.
     */
    private processTextForStreamingSpeech;
    /**
     * Flush any remaining text in the buffer to speech
     * Call this when stream ends
     */
    private flushStreamingSpeech;
    /**
     * Process incoming audio data: transcribe and generate response
     */
    private processAudioInput;
    connect(url?: string): Promise<void>;
    /**
     * Attach an existing WebSocket (server-side usage).
     * Use this when a WS server accepts a connection and you want the
     * agent to handle messages on that socket.
     */
    handleSocket(socket: WebSocket): void;
    /**
     * Send text input for processing (bypasses transcription).
     * Requests are queued and processed serially to prevent race conditions.
     */
    sendText(text: string): Promise<string>;
    /**
     * Send audio data to be transcribed and processed
     * @param audioData Base64 encoded audio data
     */
    sendAudio(audioData: string): Promise<void>;
    /**
     * Send raw audio buffer to be transcribed and processed
     */
    sendAudioBuffer(audioBuffer: Buffer | Uint8Array): Promise<void>;
    /**
     * Enqueue a text input for serial processing.
     * This ensures only one processUserInput runs at a time, preventing
     * race conditions on conversationHistory, fullText accumulation, etc.
     */
    private enqueueInput;
    /**
     * Drain the input queue, processing one request at a time.
     */
    private drainInputQueue;
    /**
     * Process user input with streaming text generation.
     * Handles the full pipeline: text -> LLM (streaming) -> TTS -> WebSocket.
     *
     * This method is designed to be called serially via drainInputQueue().
     */
    private processUserInput;
    /**
     * Generate speech for full text at once (non-streaming fallback)
     * Useful when you want to bypass streaming speech for short responses
     */
    generateAndSendSpeechFull(text: string): Promise<void>;
    /**
     * Send a message via WebSocket if connected.
     * Gracefully handles send failures (e.g., socket closing mid-send).
     */
    private sendWebSocketMessage;
    /**
     * Start listening for voice input
     */
    startListening(): void;
    /**
     * Stop listening for voice input
     */
    stopListening(): void;
    /**
     * Clear conversation history
     */
    clearHistory(): void;
    /**
     * Get current conversation history
     */
    getHistory(): ModelMessage[];
    /**
     * Set conversation history (useful for restoring sessions)
     */
    setHistory(history: ModelMessage[]): void;
    /**
     * Internal helper to close and clean up the current socket.
     */
    private disconnectSocket;
    /**
     * Disconnect from WebSocket and stop all in-flight work.
     */
    disconnect(): void;
    /**
     * Permanently destroy the agent, releasing all resources.
     * After calling this, the agent cannot be reused.
     */
    destroy(): void;
    /**
     * Check if agent is connected to WebSocket
     */
    get connected(): boolean;
    /**
     * Check if agent is currently processing a request
     */
    get processing(): boolean;
    /**
     * Check if agent is currently speaking (generating/playing audio)
     */
    get speaking(): boolean;
    /**
     * Get the number of pending speech chunks in the queue
     */
    get pendingSpeechChunks(): number;
    /**
     * Check if agent has been permanently destroyed
     */
    get destroyed(): boolean;
}
//# sourceMappingURL=VoiceAgent.d.ts.map