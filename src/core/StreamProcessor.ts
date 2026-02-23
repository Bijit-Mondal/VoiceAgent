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
export async function processFullStream(
  result: ReturnType<typeof streamText>,
  callbacks: StreamProcessorCallbacks,
  extraResponseFields?: Record<string, unknown>
): Promise<StreamResult> {
  const { onTextDelta, onTextEnd, sendMessage, emitEvent } = callbacks;

  let fullText = "";
  let fullReasoning = "";
  const allToolCalls: StreamResult["allToolCalls"] = [];
  const allToolResults: StreamResult["allToolResults"] = [];
  const allSources: unknown[] = [];
  const allFiles: unknown[] = [];

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
export function handleStreamChunk(
  chunk: any,
  emitEvent: (event: string, data?: unknown) => void
): void {
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
