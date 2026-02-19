import { WebSocket } from "ws";
import { EventEmitter } from "events";
import { streamText, LanguageModel, type Tool, type ModelMessage, type TranscriptionModel, type SpeechModel } from "ai";
import { type StreamingSpeechConfig, type HistoryConfig } from "./types";
/**
 * Trigger reasons for frame capture
 */
type FrameTriggerReason = "scene_change" | "user_request" | "timer" | "initial";
/**
 * Video frame data structure sent to/from the client
 */
interface VideoFrame {
    type: "video_frame";
    sessionId: string;
    sequence: number;
    timestamp: number;
    triggerReason: FrameTriggerReason;
    previousFrameRef?: string;
    image: {
        data: string;
        format: string;
        width: number;
        height: number;
    };
}
/**
 * Audio data structure
 */
interface AudioData {
    type: "audio";
    sessionId: string;
    data: string;
    format: string;
    sampleRate?: number;
    duration?: number;
    timestamp: number;
}
/**
 * Backend configuration for video processing
 */
interface VideoAgentConfig {
    /** Maximum frames to keep in context buffer for conversation history */
    maxContextFrames: number;
}
/**
 * Frame context for maintaining visual conversation history
 */
interface FrameContext {
    sequence: number;
    timestamp: number;
    triggerReason: FrameTriggerReason;
    frameHash: string;
    description?: string;
}
export interface VideoAgentOptions {
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
    /** Maximum frame input size in bytes (default: 5 MB) */
    maxFrameInputSize?: number;
    /** Maximum frames to keep in context buffer (default: 10) */
    maxContextFrames?: number;
    /** Session ID for this video agent instance */
    sessionId?: string;
}
export declare class VideoAgent extends EventEmitter {
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
    private sessionId;
    private frameSequence;
    private lastFrameTimestamp;
    private lastFrameHash?;
    private frameContextBuffer;
    private currentFrameData?;
    private videoConfig;
    private inputQueue;
    private processingQueue;
    private currentStreamAbortController?;
    private historyConfig;
    private maxAudioInputSize;
    private maxFrameInputSize;
    private streamingSpeechConfig;
    private currentSpeechAbortController?;
    private speechChunkQueue;
    private nextChunkId;
    private isSpeaking;
    private pendingTextBuffer;
    private speechQueueDonePromise?;
    private speechQueueDoneResolve?;
    constructor(options: VideoAgentOptions);
    /**
     * Generate a unique session ID
     */
    private generateSessionId;
    /**
     * Simple hash function for frame comparison
     */
    private hashFrame;
    /**
     * Ensure the agent has not been destroyed. Throws if it has.
     */
    private ensureNotDestroyed;
    /**
     * Get current video agent configuration
     */
    getConfig(): VideoAgentConfig;
    /**
     * Update video agent configuration
     */
    updateConfig(config: Partial<VideoAgentConfig>): void;
    private setupListeners;
    /**
     * Handle client ready signal
     */
    private handleClientReady;
    /**
     * Handle incoming video frame
     */
    private handleVideoFrame;
    /**
     * Add frame to context buffer
     */
    private addFrameToContext;
    /**
     * Request client to capture and send a frame
     */
    requestFrameCapture(reason: FrameTriggerReason): void;
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
     */
    generateSpeechFromText(text: string, abortSignal?: AbortSignal): Promise<Uint8Array>;
    /**
     * Interrupt ongoing speech generation and playback
     */
    interruptSpeech(reason?: string): void;
    /**
     * Interrupt both the current LLM stream and ongoing speech
     */
    interruptCurrentResponse(reason?: string): void;
    /**
     * Extract complete sentences from text buffer
     */
    private extractSentences;
    /**
     * Trim conversation history to stay within configured limits
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
     * Process text delta for streaming speech
     */
    private processTextForStreamingSpeech;
    /**
     * Flush any remaining text in the buffer to speech
     */
    private flushStreamingSpeech;
    /**
     * Process incoming audio data: transcribe and generate response
     */
    private processAudioInput;
    connect(url?: string): Promise<void>;
    /**
     * Attach an existing WebSocket (server-side usage)
     */
    handleSocket(socket: WebSocket): void;
    /**
     * Send text input for processing (bypasses transcription)
     */
    sendText(text: string): Promise<string>;
    /**
     * Send audio data to be transcribed and processed
     */
    sendAudio(audioData: string): Promise<void>;
    /**
     * Send raw audio buffer to be transcribed and processed
     */
    sendAudioBuffer(audioBuffer: Buffer | Uint8Array): Promise<void>;
    /**
     * Send a video frame with optional text query for vision analysis
     */
    sendFrame(frameData: string, query?: string, options?: {
        width?: number;
        height?: number;
        format?: string;
    }): Promise<string>;
    /**
     * Enqueue a text input for serial processing
     */
    private enqueueTextInput;
    /**
     * Enqueue a multimodal input (text + frame) for serial processing
     */
    private enqueueMultimodalInput;
    /**
     * Drain the input queue, processing one request at a time
     */
    private drainInputQueue;
    /**
     * Build the message content array for multimodal input
     */
    private buildMultimodalContent;
    /**
     * Process multimodal input (text + video frame)
     */
    private processMultimodalInput;
    /**
     * Process user input with streaming text generation
     */
    private processUserInput;
    /**
     * Handle individual stream chunks
     */
    private handleStreamChunk;
    /**
     * Process the full stream result and return the response text
     */
    private processStreamResult;
    /**
     * Send a message via WebSocket if connected
     */
    private sendWebSocketMessage;
    /**
     * Start listening for voice/video input
     */
    startListening(): void;
    /**
     * Stop listening for voice/video input
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
     * Set conversation history
     */
    setHistory(history: ModelMessage[]): void;
    /**
     * Get frame context buffer
     */
    getFrameContext(): FrameContext[];
    /**
     * Get session ID
     */
    getSessionId(): string;
    /**
     * Internal helper to close and clean up the current socket
     */
    private disconnectSocket;
    /**
     * Disconnect from WebSocket and stop all in-flight work
     */
    disconnect(): void;
    /**
     * Permanently destroy the agent, releasing all resources
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
     * Check if agent is currently speaking
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
    /**
     * Get current frame sequence number
     */
    get currentFrameSequence(): number;
    /**
     * Check if there is visual context available
     */
    get hasVisualContext(): boolean;
}
export type { VideoFrame, AudioData, VideoAgentConfig, FrameContext, FrameTriggerReason, };
export type { StreamingSpeechConfig, HistoryConfig } from "./types";
//# sourceMappingURL=VideoAgent.d.ts.map