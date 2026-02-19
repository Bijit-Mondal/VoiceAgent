import type { streamText } from "ai";

/**
 * Represents a chunk of text to be converted to speech
 */
export interface SpeechChunk {
    id: number;
    text: string;
    audioPromise?: Promise<Uint8Array | null>;
}

/**
 * Configuration for streaming speech behavior
 */
export interface StreamingSpeechConfig {
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
export interface HistoryConfig {
    /** Maximum number of messages to keep in history. When exceeded, oldest messages are trimmed. Set to 0 for unlimited. */
    maxMessages: number;
    /** Maximum total character count across all messages. When exceeded, oldest messages are trimmed. Set to 0 for unlimited. */
    maxTotalChars: number;
}

/**
 * Default streaming speech configuration
 */
export const DEFAULT_STREAMING_SPEECH_CONFIG: StreamingSpeechConfig = {
    minChunkSize: 50,
    maxChunkSize: 200,
    parallelGeneration: true,
    maxParallelRequests: 3,
};

/**
 * Default history configuration
 */
export const DEFAULT_HISTORY_CONFIG: HistoryConfig = {
    maxMessages: 100,
    maxTotalChars: 0, // unlimited by default
};

/** Default maximum audio input size (10 MB) */
export const DEFAULT_MAX_AUDIO_SIZE = 10 * 1024 * 1024;

/**
 * Default stop condition type from streamText
 */
export type StopWhenCondition = NonNullable<Parameters<typeof streamText>[0]["stopWhen"]>;
