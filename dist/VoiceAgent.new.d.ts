import { WebSocket } from "ws";
import { EventEmitter } from "events";
import { streamText, type LanguageModel, type Tool, type ModelMessage, type TranscriptionModel, type SpeechModel } from "ai";
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
export declare class VoiceAgent extends EventEmitter {
    private model;
    private instructions;
    private stopWhen;
    private endpoint?;
    private tools;
    private isDestroyed;
    private _isProcessing;
    private currentStreamAbortController?;
    private ws;
    private speech;
    private conversation;
    private transcription;
    private inputQueue;
    constructor(options: VoiceAgentOptions);
    registerTools(tools: Record<string, Tool>): void;
    /**
     * Transcribe audio data to text using the configured transcription model.
     */
    transcribeAudio(audioData: Buffer | Uint8Array): Promise<string>;
    /**
     * Generate speech from text using the configured speech model.
     */
    generateSpeechFromText(text: string, abortSignal?: AbortSignal): Promise<Uint8Array>;
    /**
     * Interrupt ongoing speech generation and playback (barge-in support).
     */
    interruptSpeech(reason?: string): void;
    /**
     * Interrupt both the current LLM stream and ongoing speech.
     */
    interruptCurrentResponse(reason?: string): void;
    /**
     * Connect to a WebSocket server by URL.
     */
    connect(url?: string): Promise<void>;
    /**
     * Attach an existing WebSocket (server-side usage).
     */
    handleSocket(socket: WebSocket): void;
    /**
     * Send text input for processing (bypasses transcription).
     */
    sendText(text: string): Promise<string>;
    /**
     * Send base64 audio data to be transcribed and processed.
     */
    sendAudio(audioData: string): Promise<void>;
    /**
     * Send raw audio buffer to be transcribed and processed.
     */
    sendAudioBuffer(audioBuffer: Buffer | Uint8Array): Promise<void>;
    /**
     * Generate speech for full text at once (non-streaming fallback).
     */
    generateAndSendSpeechFull(text: string): Promise<void>;
    /** Start listening for voice input */
    startListening(): void;
    /** Stop listening for voice input */
    stopListening(): void;
    /** Clear conversation history */
    clearHistory(): void;
    /** Get current conversation history */
    getHistory(): ModelMessage[];
    /** Set conversation history (useful for restoring sessions) */
    setHistory(history: ModelMessage[]): void;
    /** Disconnect from WebSocket and stop all in-flight work */
    disconnect(): void;
    /**
     * Permanently destroy the agent, releasing all resources.
     */
    destroy(): void;
    get connected(): boolean;
    get processing(): boolean;
    get speaking(): boolean;
    get pendingSpeechChunks(): number;
    get destroyed(): boolean;
    private handleMessage;
    private handleAudioInput;
    private enqueueInput;
    /**
     * Process user input with streaming text generation.
     * Called serially by the input queue.
     */
    private processUserInput;
    private ensureNotDestroyed;
    /**
     * Clean up all in-flight state when the connection drops.
     */
    private cleanupOnDisconnect;
    /**
     * Forward select events from a child emitter to this agent.
     */
    private bubbleEvents;
}
//# sourceMappingURL=VoiceAgent.new.d.ts.map