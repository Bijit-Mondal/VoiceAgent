import { type streamText } from "ai";
/**
 * Result of processing a full LLM stream.
 */
export interface StreamResult {
    fullText: string;
    fullReasoning: string;
    allToolCalls: Array<{
        toolName: string;
        toolCallId: string;
        input: unknown;
    }>;
    allToolResults: Array<{
        toolName: string;
        toolCallId: string;
        output: unknown;
    }>;
    allSources: Array<unknown>;
    allFiles: Array<unknown>;
}
export interface StreamProcessorCallbacks {
    /** Called when a text delta arrives (for streaming speech, etc.) */
    onTextDelta?: (text: string) => void;
    /** Called when a text-end part arrives (flush speech, etc.) */
    onTextEnd?: () => void;
    /** Send a WebSocket message */
    sendMessage: (message: Record<string, unknown>) => void;
    /** Emit an event on the agent */
    emitEvent: (event: string, data?: unknown) => void;
}
/**
 * Processes the fullStream from an AI SDK `streamText` call,
 * forwarding events to WebSocket clients and collecting the complete response.
 *
 * This is a standalone function (not a class) because it has no persistent state.
 */
export declare function processFullStream(result: ReturnType<typeof streamText>, callbacks: StreamProcessorCallbacks, extraResponseFields?: Record<string, unknown>): Promise<StreamResult>;
/**
 * Handle onChunk callback events and emit them.
 */
export declare function handleStreamChunk(chunk: any, emitEvent: (event: string, data?: unknown) => void): void;
//# sourceMappingURL=StreamProcessor.d.ts.map