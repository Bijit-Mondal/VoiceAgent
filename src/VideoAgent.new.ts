import { WebSocket } from "ws";
import { EventEmitter } from "events";
import {
    streamText,
    type LanguageModel,
    stepCountIs,
    type Tool,
    type ModelMessage,
    type TranscriptionModel,
    type SpeechModel,
} from "ai";
import {
    type StreamingSpeechConfig,
    type HistoryConfig,
} from "./types";
import {
    WebSocketManager,
    SpeechManager,
    ConversationManager,
    TranscriptionManager,
    InputQueue,
    type QueueItem,
    processFullStream,
    handleStreamChunk,
} from "./core";

// ── Video-specific types ────────────────────────────────

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

/** Default maximum frame input size (5 MB) */
const DEFAULT_MAX_FRAME_SIZE = 5 * 1024 * 1024;

/** Default video agent config */
const DEFAULT_VIDEO_AGENT_CONFIG: VideoAgentConfig = {
    maxContextFrames: 10,
};

// ── Options & queue item ────────────────────────────────

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

/** Shape of items in the video agent's input queue */
interface VideoInputItem extends QueueItem<string> {
    text?: string;
    frame?: VideoFrame;
}

// ── VideoAgent class ────────────────────────────────────

export class VideoAgent extends EventEmitter {
    private model: LanguageModel;
    private instructions: string;
    private stopWhen: NonNullable<Parameters<typeof streamText>[0]["stopWhen"]>;
    private endpoint?: string;
    private tools: Record<string, Tool> = {};
    private isDestroyed = false;
    private _isProcessing = false;

    // Abort controller for the current LLM stream
    private currentStreamAbortController?: AbortController;

    // ── Managers ─────────────────────────────────────────
    private ws: WebSocketManager;
    private speech: SpeechManager;
    private conversation: ConversationManager;
    private transcription: TranscriptionManager;
    private inputQueue: InputQueue<VideoInputItem>;

    // ── Video-specific state ────────────────────────────
    private sessionId: string;
    private frameSequence = 0;
    private lastFrameTimestamp = 0;
    private lastFrameHash?: string;
    private frameContextBuffer: FrameContext[] = [];
    private currentFrameData?: string;
    private videoConfig: VideoAgentConfig;
    private maxFrameInputSize: number;

    constructor(options: VideoAgentOptions) {
        super();
        this.model = options.model;
        this.instructions =
            options.instructions ||
            `You are a helpful multimodal AI assistant that can see through the user's camera and hear their voice.
When analyzing images, be concise but informative. Describe what you see when asked.
Keep responses conversational since they will be spoken aloud.
Use tools when needed to provide accurate information.`;
        this.stopWhen = options.stopWhen || stepCountIs(5);
        this.endpoint = options.endpoint;
        this.maxFrameInputSize = options.maxFrameInputSize ?? DEFAULT_MAX_FRAME_SIZE;
        this.sessionId = options.sessionId || this.generateSessionId();
        this.videoConfig = {
            ...DEFAULT_VIDEO_AGENT_CONFIG,
            maxContextFrames:
                options.maxContextFrames ?? DEFAULT_VIDEO_AGENT_CONFIG.maxContextFrames,
        };
        if (options.tools) {
            this.tools = { ...options.tools };
        }

        // ── Initialize managers ─────────────────────────
        this.ws = new WebSocketManager();
        this.speech = new SpeechManager({
            speechModel: options.speechModel,
            voice: options.voice,
            speechInstructions: options.speechInstructions,
            outputFormat: options.outputFormat,
            streamingSpeech: options.streamingSpeech,
        });
        this.conversation = new ConversationManager({
            history: options.history,
        });
        this.transcription = new TranscriptionManager({
            transcriptionModel: options.transcriptionModel,
            maxAudioInputSize: options.maxAudioInputSize,
        });
        this.inputQueue = new InputQueue<VideoInputItem>();

        // ── Wire managers to WebSocket send ─────────────
        const sendMsg = (msg: Record<string, unknown>) => this.ws.send(msg);
        this.speech.sendMessage = sendMsg;
        this.transcription.sendMessage = sendMsg;

        // ── Wire input queue processor ──────────────────
        this.inputQueue.processor = (item) => this.processQueueItem(item);

        // ── Bubble events from managers ─────────────────
        this.bubbleEvents(this.ws, ["connected", "error"]);
        this.bubbleEvents(this.speech, [
            "speech_start",
            "speech_complete",
            "speech_interrupted",
            "speech_chunk_queued",
            "audio_chunk",
            "audio",
            "error",
        ]);
        this.bubbleEvents(this.conversation, [
            "history_cleared",
            "history_trimmed",
        ]);
        this.bubbleEvents(this.transcription, [
            "transcription",
            "audio_received",
            "error",
            "warning",
        ]);

        // ── Handle WebSocket lifecycle ──────────────────
        this.ws.on("disconnected", () => {
            this.cleanupOnDisconnect();
            this.emit("disconnected");
        });

        this.ws.on("message", (message: any) => this.handleMessage(message));
    }

    // ══════════════════════════════════════════════════════
    //  Public API
    // ══════════════════════════════════════════════════════

    public registerTools(tools: Record<string, Tool>) {
        this.tools = { ...this.tools, ...tools };
    }

    public async transcribeAudio(audioData: Buffer | Uint8Array): Promise<string> {
        return this.transcription.transcribeAudio(audioData);
    }

    public async generateSpeechFromText(
        text: string,
        abortSignal?: AbortSignal
    ): Promise<Uint8Array> {
        return this.speech.generateSpeechFromText(text, abortSignal);
    }

    public interruptSpeech(reason: string = "interrupted"): void {
        this.speech.interruptSpeech(reason);
    }

    public interruptCurrentResponse(reason: string = "interrupted"): void {
        if (this.currentStreamAbortController) {
            this.currentStreamAbortController.abort();
            this.currentStreamAbortController = undefined;
        }
        this.speech.interruptSpeech(reason);
    }

    public async connect(url?: string): Promise<void> {
        this.ensureNotDestroyed();
        const wsUrl = url || this.endpoint || "ws://localhost:8080";
        await this.ws.connect(wsUrl);
    }

    public handleSocket(socket: WebSocket): void {
        this.ensureNotDestroyed();
        this.ws.handleSocket(socket);
    }

    public async sendText(text: string): Promise<string> {
        this.ensureNotDestroyed();
        if (!text || !text.trim()) {
            throw new Error("Text input cannot be empty");
        }
        return this.enqueueTextInput(text);
    }

    public async sendAudio(audioData: string): Promise<void> {
        this.ensureNotDestroyed();
        await this.handleAudioInput(audioData);
    }

    public async sendAudioBuffer(audioBuffer: Buffer | Uint8Array): Promise<void> {
        this.ensureNotDestroyed();
        const base64Audio = Buffer.from(audioBuffer).toString("base64");
        await this.handleAudioInput(base64Audio);
    }

    /**
     * Send a video frame with optional text query for vision analysis
     */
    public async sendFrame(
        frameData: string,
        query?: string,
        options?: { width?: number; height?: number; format?: string }
    ): Promise<string> {
        this.ensureNotDestroyed();

        const frame: VideoFrame = {
            type: "video_frame",
            sessionId: this.sessionId,
            sequence: this.frameSequence++,
            timestamp: Date.now(),
            triggerReason: "user_request",
            previousFrameRef: this.lastFrameHash,
            image: {
                data: frameData,
                format: options?.format || "webp",
                width: options?.width || 640,
                height: options?.height || 480,
            },
        };

        // Update local frame state
        await this.handleVideoFrame(frame);

        if (query) {
            return this.enqueueMultimodalInput(query, frame);
        }

        return "";
    }

    /**
     * Request client to capture and send a frame
     */
    public requestFrameCapture(reason: FrameTriggerReason): void {
        this.ws.send({
            type: "capture_frame",
            reason,
            timestamp: Date.now(),
        });
        this.emit("frame_requested", { reason });
    }

    public getConfig(): VideoAgentConfig {
        return { ...this.videoConfig };
    }

    public updateConfig(config: Partial<VideoAgentConfig>): void {
        this.videoConfig = { ...this.videoConfig, ...config };
        this.emit("config_changed", this.videoConfig);
    }

    startListening() {
        this.emit("listening");
    }

    stopListening() {
        this.emit("stopped");
    }

    clearHistory() {
        this.conversation.clearHistory();
        this.frameContextBuffer = [];
    }

    getHistory(): ModelMessage[] {
        return this.conversation.getHistory();
    }

    setHistory(history: ModelMessage[]) {
        this.conversation.setHistory(history);
    }

    getFrameContext(): FrameContext[] {
        return [...this.frameContextBuffer];
    }

    getSessionId(): string {
        return this.sessionId;
    }

    disconnect() {
        this.ws.disconnect();
    }

    destroy() {
        this.isDestroyed = true;
        this.cleanupOnDisconnect();
        this.ws.disconnect();
        this.conversation.clearHistory();
        this.frameContextBuffer = [];
        this.tools = {};
        this.removeAllListeners();
    }

    // ── Getters ─────────────────────────────────────────

    get connected(): boolean {
        return this.ws.isConnected;
    }

    get processing(): boolean {
        return this._isProcessing;
    }

    get speaking(): boolean {
        return this.speech.isSpeaking;
    }

    get pendingSpeechChunks(): number {
        return this.speech.pendingChunkCount;
    }

    get destroyed(): boolean {
        return this.isDestroyed;
    }

    get currentFrameSequence(): number {
        return this.frameSequence;
    }

    get hasVisualContext(): boolean {
        return !!this.currentFrameData;
    }

    // ══════════════════════════════════════════════════════
    //  Private — message handling
    // ══════════════════════════════════════════════════════

    private async handleMessage(message: any): Promise<void> {
        try {
            switch (message.type) {
                case "transcript":
                    if (typeof message.text !== "string" || !message.text.trim()) {
                        this.emit("warning", "Received empty or invalid transcript message");
                        return;
                    }
                    this.interruptCurrentResponse("user_speaking");
                    this.requestFrameCapture("user_request");
                    await this.enqueueTextInput(message.text);
                    break;

                case "audio":
                    if (typeof message.data !== "string" || !message.data) {
                        this.emit("warning", "Received empty or invalid audio message");
                        return;
                    }
                    this.interruptCurrentResponse("user_speaking");
                    this.requestFrameCapture("user_request");
                    try {
                        await this.handleAudioInput(message.data, message.format);
                    } catch (audioError) {
                        this.emit("error", audioError);
                    }
                    break;

                case "video_frame":
                    await this.handleVideoFrame(message);
                    break;

                case "interrupt":
                    this.interruptCurrentResponse(message.reason || "client_request");
                    break;

                case "client_ready":
                    this.handleClientReady(message);
                    break;
            }
        } catch (err) {
            this.emit("error", err);
        }
    }

    private handleClientReady(message: any): void {
        this.ws.send({
            type: "session_init",
            sessionId: this.sessionId,
        });
        this.emit("client_ready", message.capabilities);
    }

    // ══════════════════════════════════════════════════════
    //  Private — audio
    // ══════════════════════════════════════════════════════

    private async handleAudioInput(
        base64Audio: string,
        format?: string
    ): Promise<void> {
        const text = await this.transcription.processAudioInput(base64Audio, format);
        if (text) {
            await this.enqueueTextInput(text);
        }
    }

    // ══════════════════════════════════════════════════════
    //  Private — video frames
    // ══════════════════════════════════════════════════════

    private async handleVideoFrame(frame: VideoFrame): Promise<void> {
        try {
            if (!frame.image?.data) {
                this.emit("warning", "Received empty or invalid video frame");
                return;
            }

            const frameSize = Buffer.from(frame.image.data, "base64").length;
            if (frameSize > this.maxFrameInputSize) {
                const sizeMB = (frameSize / (1024 * 1024)).toFixed(1);
                const maxMB = (this.maxFrameInputSize / (1024 * 1024)).toFixed(1);
                this.emit(
                    "error",
                    new Error(`Frame too large (${sizeMB} MB). Maximum allowed: ${maxMB} MB`)
                );
                return;
            }

            const frameHash = this.hashFrame(frame.image.data);
            this.lastFrameTimestamp = frame.timestamp;
            this.lastFrameHash = frameHash;
            this.currentFrameData = frame.image.data;

            this.addFrameToContext({
                sequence: frame.sequence,
                timestamp: frame.timestamp,
                triggerReason: frame.triggerReason,
                frameHash,
            });

            this.emit("frame_received", {
                sequence: frame.sequence,
                timestamp: frame.timestamp,
                triggerReason: frame.triggerReason,
                size: frameSize,
                dimensions: { width: frame.image.width, height: frame.image.height },
            });

            this.ws.send({
                type: "frame_ack",
                sequence: frame.sequence,
                timestamp: Date.now(),
            });
        } catch (error) {
            this.emit("error", error);
        }
    }

    private addFrameToContext(context: FrameContext): void {
        this.frameContextBuffer.push(context);
        if (this.frameContextBuffer.length > this.videoConfig.maxContextFrames) {
            this.frameContextBuffer.shift();
        }
    }

    private hashFrame(data: string): string {
        let hash = 0;
        for (let i = 0; i < data.length; i++) {
            const char = data.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return `frame_${this.frameSequence}_${Math.abs(hash).toString(16)}`;
    }

    private generateSessionId(): string {
        const timestamp = Date.now().toString(36);
        const randomPart = Math.random().toString(36).substring(2, 10);
        return `vs_${timestamp}_${randomPart}`;
    }

    // ══════════════════════════════════════════════════════
    //  Private — input queue
    // ══════════════════════════════════════════════════════

    private enqueueTextInput(text: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            this.inputQueue.enqueue({ text, resolve, reject });
        });
    }

    private enqueueMultimodalInput(text: string, frame: VideoFrame): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            this.inputQueue.enqueue({ text, frame, resolve, reject });
        });
    }

    /**
     * Route queued items to the correct processor.
     */
    private async processQueueItem(item: VideoInputItem): Promise<string> {
        if (item.frame && item.text) {
            return this.processMultimodalInput(item.text, item.frame);
        } else if (item.text) {
            return this.processUserInput(item.text);
        }
        return "";
    }

    // ══════════════════════════════════════════════════════
    //  Private — multimodal content building
    // ══════════════════════════════════════════════════════

    private buildMultimodalContent(
        text: string,
        frameData?: string
    ): Array<{ type: "text"; text: string } | { type: "image"; image: string }> {
        const content: Array<
            { type: "text"; text: string } | { type: "image"; image: string }
        > = [];

        if (this.frameContextBuffer.length > 0) {
            const contextSummary = `[Visual context: ${this.frameContextBuffer.length} frames captured, latest at ${new Date(this.lastFrameTimestamp).toISOString()}]`;
            content.push({ type: "text", text: contextSummary });
        }

        const imageData = frameData || this.currentFrameData;
        if (imageData) {
            content.push({ type: "image", image: imageData });
        }

        content.push({ type: "text", text });
        return content;
    }

    // ══════════════════════════════════════════════════════
    //  Private — LLM processing
    // ══════════════════════════════════════════════════════

    /**
     * Shared streamText invocation used by both processUserInput and processMultimodalInput.
     */
    private async runStream(
        messages: ModelMessage[],
        abortSignal: AbortSignal
    ): Promise<string> {
        const result = streamText({
            model: this.model,
            system: this.instructions,
            messages,
            tools: this.tools,
            stopWhen: this.stopWhen,
            abortSignal,
            onChunk: ({ chunk }) => {
                handleStreamChunk(chunk, (event, data) => this.emit(event, data));
            },
            onFinish: async (event) => {
                for (const step of event.steps) {
                    for (const toolResult of step.toolResults) {
                        this.emit("tool_result", {
                            name: toolResult.toolName,
                            toolCallId: toolResult.toolCallId,
                            result: toolResult.output,
                        });
                    }
                }
            },
            onError: ({ error }) => {
                this.emit("error", error);
            },
        });

        const streamResult = await processFullStream(
            result,
            {
                onTextDelta: (delta) => this.speech.processTextDelta(delta),
                onTextEnd: () => this.speech.flushPendingText(),
                sendMessage: (msg) => this.ws.send(msg),
                emitEvent: (event, data) => this.emit(event, data),
            },
            {
                sessionId: this.sessionId,
                frameContext:
                    this.frameContextBuffer.length > 0
                        ? {
                            frameCount: this.frameContextBuffer.length,
                            lastFrameSequence:
                                this.frameContextBuffer[this.frameContextBuffer.length - 1]
                                    ?.sequence,
                        }
                        : undefined,
            }
        );

        // Add assistant response to history
        if (streamResult.fullText) {
            this.conversation.addMessage({
                role: "assistant",
                content: streamResult.fullText,
            });
        }

        // Flush remaining speech & wait for queue
        this.speech.flushPendingText();
        if (this.speech.queueDonePromise) {
            await this.speech.queueDonePromise;
        }

        return streamResult.fullText;
    }

    /**
     * Process text-only input (with optional visual context from latest frame).
     */
    private async processUserInput(text: string): Promise<string> {
        this._isProcessing = true;
        this.currentStreamAbortController = new AbortController();

        try {
            this.emit("text", { role: "user", text });

            const hasVisual = !!this.currentFrameData;
            let messages: ModelMessage[];

            if (hasVisual) {
                const content = this.buildMultimodalContent(text);
                this.conversation.addMessage({
                    role: "user",
                    content: [{ type: "text", text: `[Visual context] ${text}` }],
                });
                messages = [
                    ...this.conversation.getHistoryRef().slice(0, -1),
                    { role: "user", content },
                ];
            } else {
                this.conversation.addMessage({ role: "user", content: text });
                messages = this.conversation.getHistoryRef();
            }

            return await this.runStream(
                messages,
                this.currentStreamAbortController.signal
            );
        } catch (error) {
            this.speech.reset();
            throw error;
        } finally {
            this._isProcessing = false;
            this.currentStreamAbortController = undefined;
        }
    }

    /**
     * Process multimodal input (text + explicit video frame).
     */
    private async processMultimodalInput(
        text: string,
        frame: VideoFrame
    ): Promise<string> {
        this._isProcessing = true;
        this.currentStreamAbortController = new AbortController();

        try {
            this.emit("text", { role: "user", text, hasImage: true });

            const content = this.buildMultimodalContent(text, frame.image.data);

            this.conversation.addMessage({
                role: "user",
                content: [{ type: "text", text: `[Image attached] ${text}` }],
            });

            const messages: ModelMessage[] = [
                ...this.conversation.getHistoryRef().slice(0, -1),
                { role: "user", content },
            ];

            return await this.runStream(
                messages,
                this.currentStreamAbortController.signal
            );
        } catch (error) {
            this.speech.reset();
            throw error;
        } finally {
            this._isProcessing = false;
            this.currentStreamAbortController = undefined;
        }
    }

    // ══════════════════════════════════════════════════════
    //  Private — helpers
    // ══════════════════════════════════════════════════════

    private ensureNotDestroyed(): void {
        if (this.isDestroyed) {
            throw new Error("VideoAgent has been destroyed and cannot be used");
        }
    }

    private cleanupOnDisconnect(): void {
        if (this.currentStreamAbortController) {
            this.currentStreamAbortController.abort();
            this.currentStreamAbortController = undefined;
        }
        this.speech.reset();
        this._isProcessing = false;
        this.currentFrameData = undefined;
        this.inputQueue.rejectAll(new Error("Connection closed"));
    }

    private bubbleEvents(source: EventEmitter, events: string[]): void {
        for (const event of events) {
            source.on(event, (...args: any[]) => this.emit(event, ...args));
        }
    }
}

// Export types for external use
export type {
    VideoFrame,
    AudioData,
    VideoAgentConfig,
    FrameContext,
    FrameTriggerReason,
};

// Re-export shared types
export type { StreamingSpeechConfig, HistoryConfig } from "./types";