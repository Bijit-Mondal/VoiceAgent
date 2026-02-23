import { EventEmitter } from "events";
import { type SpeechModel } from "ai";
import { type StreamingSpeechConfig } from "../types";
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
export declare class SpeechManager extends EventEmitter {
    private speechModel?;
    private voice;
    private speechInstructions?;
    private outputFormat;
    private streamingSpeechConfig;
    private currentSpeechAbortController?;
    private speechChunkQueue;
    private nextChunkId;
    private _isSpeaking;
    private pendingTextBuffer;
    private speechQueueDonePromise?;
    private speechQueueDoneResolve?;
    /** Callback to send messages over the WebSocket */
    sendMessage: (message: Record<string, unknown>) => void;
    constructor(options: SpeechManagerOptions);
    get isSpeaking(): boolean;
    get pendingChunkCount(): number;
    get hasSpeechModel(): boolean;
    /**
     * Returns a promise that resolves when the speech queue is fully drained.
     * Returns undefined if there is nothing queued.
     */
    get queueDonePromise(): Promise<void> | undefined;
    /**
     * Generate speech from text using the configured speech model.
     */
    generateSpeechFromText(text: string, abortSignal?: AbortSignal): Promise<Uint8Array>;
    /**
     * Generate speech for full text at once (non-streaming fallback).
     */
    generateAndSendSpeechFull(text: string): Promise<void>;
    /**
     * Interrupt ongoing speech generation and playback (barge-in support).
     */
    interruptSpeech(reason?: string): void;
    /**
     * Process a text delta for streaming speech.
     * Call this as text chunks arrive from the LLM.
     */
    processTextDelta(textDelta: string): void;
    /**
     * Flush any remaining text in the buffer to speech.
     * Call this when the LLM stream ends.
     */
    flushPendingText(): void;
    /**
     * Reset all speech state (used on disconnect / cleanup).
     */
    reset(): void;
    /**
     * Extract complete sentences from text buffer.
     * Returns [extractedSentences, remainingBuffer].
     */
    private extractSentences;
    /**
     * Queue a text chunk for speech generation.
     */
    private queueSpeechChunk;
    /**
     * Generate audio for a single chunk.
     */
    private generateChunkAudio;
    /**
     * Process the speech queue and send audio chunks in order.
     */
    private processSpeechQueue;
}
//# sourceMappingURL=SpeechManager.d.ts.map