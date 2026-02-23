import { EventEmitter } from "events";
import { type TranscriptionModel } from "ai";
export interface TranscriptionManagerOptions {
    transcriptionModel?: TranscriptionModel;
    maxAudioInputSize?: number;
}
/**
 * Handles audio transcription using the AI SDK transcription model
 * and validation of incoming audio data.
 */
export declare class TranscriptionManager extends EventEmitter {
    private transcriptionModel?;
    private maxAudioInputSize;
    /** Callback to send messages over the WebSocket */
    sendMessage: (message: Record<string, unknown>) => void;
    constructor(options?: TranscriptionManagerOptions);
    get hasTranscriptionModel(): boolean;
    /**
     * Transcribe audio data to text.
     */
    transcribeAudio(audioData: Buffer | Uint8Array): Promise<string>;
    /**
     * Process incoming base64-encoded audio: validate, decode, transcribe.
     * Returns the transcribed text, or null if invalid / empty.
     */
    processAudioInput(base64Audio: string, format?: string): Promise<string | null>;
}
//# sourceMappingURL=TranscriptionManager.d.ts.map