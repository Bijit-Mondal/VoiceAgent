"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processFullStream = processFullStream;
exports.handleStreamChunk = handleStreamChunk;
/**
 * Processes the fullStream from an AI SDK `streamText` call,
 * forwarding events to WebSocket clients and collecting the complete response.
 *
 * This is a standalone function (not a class) because it has no persistent state.
 */
async function processFullStream(result, callbacks, extraResponseFields) {
    const { onTextDelta, onTextEnd, sendMessage, emitEvent } = callbacks;
    let fullText = "";
    let fullReasoning = "";
    const allToolCalls = [];
    const allToolResults = [];
    const allSources = [];
    const allFiles = [];
    for await (const part of result.fullStream) {
        switch (part.type) {
            // ── Stream lifecycle ──────────────────────────────
            case "start":
                sendMessage({ type: "stream_start" });
                break;
            case "finish":
                emitEvent("text", { role: "assistant", text: fullText });
                sendMessage({
                    type: "stream_finish",
                    finishReason: part.finishReason,
                    usage: part.totalUsage,
                });
                break;
            case "error":
                emitEvent("error", part.error);
                sendMessage({
                    type: "stream_error",
                    error: String(part.error),
                });
                break;
            case "abort":
                emitEvent("abort", { reason: part.reason });
                sendMessage({
                    type: "stream_abort",
                    reason: part.reason,
                });
                break;
            // ── Step lifecycle ────────────────────────────────
            case "start-step":
                sendMessage({
                    type: "step_start",
                    warnings: part.warnings,
                });
                break;
            case "finish-step":
                sendMessage({
                    type: "step_finish",
                    finishReason: part.finishReason,
                    usage: part.usage,
                });
                break;
            // ── Text streaming ────────────────────────────────
            case "text-start":
                sendMessage({ type: "text_start", id: part.id });
                break;
            case "text-delta":
                fullText += part.text;
                onTextDelta?.(part.text);
                sendMessage({
                    type: "text_delta",
                    id: part.id,
                    text: part.text,
                });
                break;
            case "text-end":
                onTextEnd?.();
                sendMessage({ type: "text_end", id: part.id });
                break;
            // ── Reasoning streaming ───────────────────────────
            case "reasoning-start":
                sendMessage({ type: "reasoning_start", id: part.id });
                break;
            case "reasoning-delta":
                fullReasoning += part.text;
                sendMessage({
                    type: "reasoning_delta",
                    id: part.id,
                    text: part.text,
                });
                break;
            case "reasoning-end":
                sendMessage({ type: "reasoning_end", id: part.id });
                break;
            // ── Tool input streaming ──────────────────────────
            case "tool-input-start":
                sendMessage({
                    type: "tool_input_start",
                    id: part.id,
                    toolName: part.toolName,
                });
                break;
            case "tool-input-delta":
                sendMessage({
                    type: "tool_input_delta",
                    id: part.id,
                    delta: part.delta,
                });
                break;
            case "tool-input-end":
                sendMessage({ type: "tool_input_end", id: part.id });
                break;
            // ── Tool execution ────────────────────────────────
            case "tool-call":
                allToolCalls.push({
                    toolName: part.toolName,
                    toolCallId: part.toolCallId,
                    input: part.input,
                });
                sendMessage({
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
                sendMessage({
                    type: "tool_result",
                    toolName: part.toolName,
                    toolCallId: part.toolCallId,
                    result: part.output,
                });
                break;
            case "tool-error":
                sendMessage({
                    type: "tool_error",
                    toolName: part.toolName,
                    toolCallId: part.toolCallId,
                    error: String(part.error),
                });
                break;
            // ── Sources and files ─────────────────────────────
            case "source":
                allSources.push(part);
                sendMessage({
                    type: "source",
                    source: part,
                });
                break;
            case "file":
                allFiles.push(part.file);
                sendMessage({
                    type: "file",
                    file: part.file,
                });
                break;
        }
    }
    // Send the complete response
    sendMessage({
        type: "response_complete",
        text: fullText,
        reasoning: fullReasoning || undefined,
        toolCalls: allToolCalls,
        toolResults: allToolResults,
        sources: allSources.length > 0 ? allSources : undefined,
        files: allFiles.length > 0 ? allFiles : undefined,
        ...extraResponseFields,
    });
    return {
        fullText,
        fullReasoning,
        allToolCalls,
        allToolResults,
        allSources,
        allFiles,
    };
}
/**
 * Handle onChunk callback events and emit them.
 */
function handleStreamChunk(chunk, emitEvent) {
    switch (chunk.type) {
        case "text-delta":
            emitEvent("chunk:text_delta", { id: chunk.id, text: chunk.text });
            break;
        case "reasoning-delta":
            emitEvent("chunk:reasoning_delta", {
                id: chunk.id,
                text: chunk.text,
            });
            break;
        case "tool-call":
            emitEvent("chunk:tool_call", {
                toolName: chunk.toolName,
                toolCallId: chunk.toolCallId,
                input: chunk.input,
            });
            break;
        case "tool-result":
            emitEvent("chunk:tool_result", {
                toolName: chunk.toolName,
                toolCallId: chunk.toolCallId,
                result: chunk.output,
            });
            break;
        case "tool-input-start":
            emitEvent("chunk:tool_input_start", {
                id: chunk.id,
                toolName: chunk.toolName,
            });
            break;
        case "tool-input-delta":
            emitEvent("chunk:tool_input_delta", {
                id: chunk.id,
                delta: chunk.delta,
            });
            break;
        case "source":
            emitEvent("chunk:source", chunk);
            break;
    }
}
//# sourceMappingURL=StreamProcessor.js.map