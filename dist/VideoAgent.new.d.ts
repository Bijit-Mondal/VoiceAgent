import { WebSocket } from "ws";
import { EventEmitter } from "events";
import { streamText, type LanguageModel, type Tool, type ModelMessage, type TranscriptionModel, type SpeechModel } from "ai";
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
    /**
     * AI SDK Model for chat. Must be a vision-enabled model (e.g., openai('gpt-4o'),
     * anthropic('claude-3.5-sonnet'), google('gemini-1.5-pro')) to process video frames.
     */
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
    streamingSpeech?: Partial<StreamingSpeechConfig>;
    history?: Partial<HistoryConfig>;
    maxAudioInputSize?: number;
    /** Maximum frame input size in bytes (default: 5 MB) */
    maxFrameInputSize?: number;
    /** Maximum frames to keep in context buffer (default: 10) */
    maxContextFrames?: number;
    /** Session ID for this video agent instance */
    sessionId?: string;
}
export declare class VideoAgent extends EventEmitter {
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
    private sessionId;
    private frameSequence;
    private lastFrameTimestamp;
    private lastFrameHash?;
    private frameContextBuffer;
    private currentFrameData?;
    private videoConfig;
    private maxFrameInputSize;
    constructor(options: VideoAgentOptions);
    registerTools(tools: Record<string, Tool>): void;
    transcribeAudio(audioData: Buffer | Uint8Array): Promise<string>;
    generateSpeechFromText(text: string, abortSignal?: AbortSignal): Promise<Uint8Array>;
    interruptSpeech(reason?: string): void;
    interruptCurrentResponse(reason?: string): void;
    connect(url?: string): Promise<void>;
    handleSocket(socket: WebSocket): void;
    sendText(text: string): Promise<string>;
    sendAudio(audioData: string): Promise<void>;
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
     * Request client to capture and send a frame
     */
    requestFrameCapture(reason: FrameTriggerReason): void;
    getConfig(): VideoAgentConfig;
    updateConfig(config: Partial<VideoAgentConfig>): void;
    startListening(): void;
    stopListening(): void;
    clearHistory(): void;
    getHistory(): ModelMessage[];
    setHistory(history: ModelMessage[]): void;
    getFrameContext(): FrameContext[];
    getSessionId(): string;
    disconnect(): void;
    destroy(): void;
    get connected(): boolean;
    get processing(): boolean;
    get speaking(): boolean;
    get pendingSpeechChunks(): number;
    get destroyed(): boolean;
    get currentFrameSequence(): number;
    get hasVisualContext(): boolean;
    private handleMessage;
    private handleClientReady;
    private handleAudioInput;
    private handleVideoFrame;
    private addFrameToContext;
    private hashFrame;
    private generateSessionId;
    private enqueueTextInput;
    private enqueueMultimodalInput;
    /**
     * Route queued items to the correct processor.
     */
    private processQueueItem;
    private buildMultimodalContent;
    /**
     * Shared streamText invocation used by both processUserInput and processMultimodalInput.
     */
    private runStream;
    /**
     * Process text-only input (with optional visual context from latest frame).
     */
    private processUserInput;
    /**
     * Process multimodal input (text + explicit video frame).
     */
    private processMultimodalInput;
    private ensureNotDestroyed;
    private cleanupOnDisconnect;
    private bubbleEvents;
}
export type { VideoFrame, AudioData, VideoAgentConfig, FrameContext, FrameTriggerReason, };
export type { StreamingSpeechConfig, HistoryConfig } from "./types";
//# sourceMappingURL=VideoAgent.new.d.ts.map