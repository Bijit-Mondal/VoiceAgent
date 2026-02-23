"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VideoAgent = void 0;
const events_1 = require("events");
const ai_1 = require("ai");
const core_1 = require("./core");
/** Default maximum frame input size (5 MB) */
const DEFAULT_MAX_FRAME_SIZE = 5 * 1024 * 1024;
/** Default video agent config */
const DEFAULT_VIDEO_AGENT_CONFIG = {
    maxContextFrames: 10,
};
// ── VideoAgent class ────────────────────────────────────
class VideoAgent extends events_1.EventEmitter {
    model;
    instructions;
    stopWhen;
    endpoint;
    tools = {};
    isDestroyed = false;
    _isProcessing = false;
    // Abort controller for the current LLM stream
    currentStreamAbortController;
    // ── Managers ─────────────────────────────────────────
    ws;
    speech;
    conversation;
    transcription;
    inputQueue;
    // ── Video-specific state ────────────────────────────
    sessionId;
    frameSequence = 0;
    lastFrameTimestamp = 0;
    lastFrameHash;
    frameContextBuffer = [];
    currentFrameData;
    videoConfig;
    maxFrameInputSize;
    constructor(options) {
        super();
        this.model = options.model;
        this.instructions =
            options.instructions ||
                `You are a helpful multimodal AI assistant that can see through the user's camera and hear their voice.
When analyzing images, be concise but informative. Describe what you see when asked.
Keep responses conversational since they will be spoken aloud.
Use tools when needed to provide accurate information.`;
        this.stopWhen = options.stopWhen || (0, ai_1.stepCountIs)(5);
        this.endpoint = options.endpoint;
        this.maxFrameInputSize = options.maxFrameInputSize ?? DEFAULT_MAX_FRAME_SIZE;
        this.sessionId = options.sessionId || this.generateSessionId();
        this.videoConfig = {
            ...DEFAULT_VIDEO_AGENT_CONFIG,
            maxContextFrames: options.maxContextFrames ?? DEFAULT_VIDEO_AGENT_CONFIG.maxContextFrames,
        };
        if (options.tools) {
            this.tools = { ...options.tools };
        }
        // ── Initialize managers ─────────────────────────
        this.ws = new core_1.WebSocketManager();
        this.speech = new core_1.SpeechManager({
            speechModel: options.speechModel,
            voice: options.voice,
            speechInstructions: options.speechInstructions,
            outputFormat: options.outputFormat,
            streamingSpeech: options.streamingSpeech,
        });
        this.conversation = new core_1.ConversationManager({
            history: options.history,
        });
        this.transcription = new core_1.TranscriptionManager({
            transcriptionModel: options.transcriptionModel,
            maxAudioInputSize: options.maxAudioInputSize,
        });
        this.inputQueue = new core_1.InputQueue();
        // ── Wire managers to WebSocket send ─────────────
        const sendMsg = (msg) => this.ws.send(msg);
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
        this.ws.on("message", (message) => this.handleMessage(message));
    }
    // ══════════════════════════════════════════════════════
    //  Public API
    // ══════════════════════════════════════════════════════
    registerTools(tools) {
        this.tools = { ...this.tools, ...tools };
    }
    async transcribeAudio(audioData) {
        return this.transcription.transcribeAudio(audioData);
    }
    async generateSpeechFromText(text, abortSignal) {
        return this.speech.generateSpeechFromText(text, abortSignal);
    }
    interruptSpeech(reason = "interrupted") {
        this.speech.interruptSpeech(reason);
    }
    interruptCurrentResponse(reason = "interrupted") {
        if (this.currentStreamAbortController) {
            this.currentStreamAbortController.abort();
            this.currentStreamAbortController = undefined;
        }
        this.speech.interruptSpeech(reason);
    }
    async connect(url) {
        this.ensureNotDestroyed();
        const wsUrl = url || this.endpoint || "ws://localhost:8080";
        await this.ws.connect(wsUrl);
    }
    handleSocket(socket) {
        this.ensureNotDestroyed();
        this.ws.handleSocket(socket);
    }
    async sendText(text) {
        this.ensureNotDestroyed();
        if (!text || !text.trim()) {
            throw new Error("Text input cannot be empty");
        }
        return this.enqueueTextInput(text);
    }
    async sendAudio(audioData) {
        this.ensureNotDestroyed();
        await this.handleAudioInput(audioData);
    }
    async sendAudioBuffer(audioBuffer) {
        this.ensureNotDestroyed();
        const base64Audio = Buffer.from(audioBuffer).toString("base64");
        await this.handleAudioInput(base64Audio);
    }
    /**
     * Send a video frame with optional text query for vision analysis
     */
    async sendFrame(frameData, query, options) {
        this.ensureNotDestroyed();
        const frame = {
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
    requestFrameCapture(reason) {
        this.ws.send({
            type: "capture_frame",
            reason,
            timestamp: Date.now(),
        });
        this.emit("frame_requested", { reason });
    }
    getConfig() {
        return { ...this.videoConfig };
    }
    updateConfig(config) {
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
    getHistory() {
        return this.conversation.getHistory();
    }
    setHistory(history) {
        this.conversation.setHistory(history);
    }
    getFrameContext() {
        return [...this.frameContextBuffer];
    }
    getSessionId() {
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
    get connected() {
        return this.ws.isConnected;
    }
    get processing() {
        return this._isProcessing;
    }
    get speaking() {
        return this.speech.isSpeaking;
    }
    get pendingSpeechChunks() {
        return this.speech.pendingChunkCount;
    }
    get destroyed() {
        return this.isDestroyed;
    }
    get currentFrameSequence() {
        return this.frameSequence;
    }
    get hasVisualContext() {
        return !!this.currentFrameData;
    }
    // ══════════════════════════════════════════════════════
    //  Private — message handling
    // ══════════════════════════════════════════════════════
    async handleMessage(message) {
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
                    }
                    catch (audioError) {
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
        }
        catch (err) {
            this.emit("error", err);
        }
    }
    handleClientReady(message) {
        this.ws.send({
            type: "session_init",
            sessionId: this.sessionId,
        });
        this.emit("client_ready", message.capabilities);
    }
    // ══════════════════════════════════════════════════════
    //  Private — audio
    // ══════════════════════════════════════════════════════
    async handleAudioInput(base64Audio, format) {
        const text = await this.transcription.processAudioInput(base64Audio, format);
        if (text) {
            await this.enqueueTextInput(text);
        }
    }
    // ══════════════════════════════════════════════════════
    //  Private — video frames
    // ══════════════════════════════════════════════════════
    async handleVideoFrame(frame) {
        try {
            if (!frame.image?.data) {
                this.emit("warning", "Received empty or invalid video frame");
                return;
            }
            const frameSize = Buffer.from(frame.image.data, "base64").length;
            if (frameSize > this.maxFrameInputSize) {
                const sizeMB = (frameSize / (1024 * 1024)).toFixed(1);
                const maxMB = (this.maxFrameInputSize / (1024 * 1024)).toFixed(1);
                this.emit("error", new Error(`Frame too large (${sizeMB} MB). Maximum allowed: ${maxMB} MB`));
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
        }
        catch (error) {
            this.emit("error", error);
        }
    }
    addFrameToContext(context) {
        this.frameContextBuffer.push(context);
        if (this.frameContextBuffer.length > this.videoConfig.maxContextFrames) {
            this.frameContextBuffer.shift();
        }
    }
    hashFrame(data) {
        let hash = 0;
        for (let i = 0; i < data.length; i++) {
            const char = data.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return `frame_${this.frameSequence}_${Math.abs(hash).toString(16)}`;
    }
    generateSessionId() {
        const timestamp = Date.now().toString(36);
        const randomPart = Math.random().toString(36).substring(2, 10);
        return `vs_${timestamp}_${randomPart}`;
    }
    // ══════════════════════════════════════════════════════
    //  Private — input queue
    // ══════════════════════════════════════════════════════
    enqueueTextInput(text) {
        return new Promise((resolve, reject) => {
            this.inputQueue.enqueue({ text, resolve, reject });
        });
    }
    enqueueMultimodalInput(text, frame) {
        return new Promise((resolve, reject) => {
            this.inputQueue.enqueue({ text, frame, resolve, reject });
        });
    }
    /**
     * Route queued items to the correct processor.
     */
    async processQueueItem(item) {
        if (item.frame && item.text) {
            return this.processMultimodalInput(item.text, item.frame);
        }
        else if (item.text) {
            return this.processUserInput(item.text);
        }
        return "";
    }
    // ══════════════════════════════════════════════════════
    //  Private — multimodal content building
    // ══════════════════════════════════════════════════════
    buildMultimodalContent(text, frameData) {
        const content = [];
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
    async runStream(messages, abortSignal) {
        const result = (0, ai_1.streamText)({
            model: this.model,
            system: this.instructions,
            messages,
            tools: this.tools,
            stopWhen: this.stopWhen,
            abortSignal,
            onChunk: ({ chunk }) => {
                (0, core_1.handleStreamChunk)(chunk, (event, data) => this.emit(event, data));
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
        const streamResult = await (0, core_1.processFullStream)(result, {
            onTextDelta: (delta) => this.speech.processTextDelta(delta),
            onTextEnd: () => this.speech.flushPendingText(),
            sendMessage: (msg) => this.ws.send(msg),
            emitEvent: (event, data) => this.emit(event, data),
        }, {
            sessionId: this.sessionId,
            frameContext: this.frameContextBuffer.length > 0
                ? {
                    frameCount: this.frameContextBuffer.length,
                    lastFrameSequence: this.frameContextBuffer[this.frameContextBuffer.length - 1]
                        ?.sequence,
                }
                : undefined,
        });
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
    async processUserInput(text) {
        this._isProcessing = true;
        this.currentStreamAbortController = new AbortController();
        try {
            this.emit("text", { role: "user", text });
            const hasVisual = !!this.currentFrameData;
            let messages;
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
            }
            else {
                this.conversation.addMessage({ role: "user", content: text });
                messages = this.conversation.getHistoryRef();
            }
            return await this.runStream(messages, this.currentStreamAbortController.signal);
        }
        catch (error) {
            this.speech.reset();
            throw error;
        }
        finally {
            this._isProcessing = false;
            this.currentStreamAbortController = undefined;
        }
    }
    /**
     * Process multimodal input (text + explicit video frame).
     */
    async processMultimodalInput(text, frame) {
        this._isProcessing = true;
        this.currentStreamAbortController = new AbortController();
        try {
            this.emit("text", { role: "user", text, hasImage: true });
            const content = this.buildMultimodalContent(text, frame.image.data);
            this.conversation.addMessage({
                role: "user",
                content: [{ type: "text", text: `[Image attached] ${text}` }],
            });
            const messages = [
                ...this.conversation.getHistoryRef().slice(0, -1),
                { role: "user", content },
            ];
            return await this.runStream(messages, this.currentStreamAbortController.signal);
        }
        catch (error) {
            this.speech.reset();
            throw error;
        }
        finally {
            this._isProcessing = false;
            this.currentStreamAbortController = undefined;
        }
    }
    // ══════════════════════════════════════════════════════
    //  Private — helpers
    // ══════════════════════════════════════════════════════
    ensureNotDestroyed() {
        if (this.isDestroyed) {
            throw new Error("VideoAgent has been destroyed and cannot be used");
        }
    }
    cleanupOnDisconnect() {
        if (this.currentStreamAbortController) {
            this.currentStreamAbortController.abort();
            this.currentStreamAbortController = undefined;
        }
        this.speech.reset();
        this._isProcessing = false;
        this.currentFrameData = undefined;
        this.inputQueue.rejectAll(new Error("Connection closed"));
    }
    bubbleEvents(source, events) {
        for (const event of events) {
            source.on(event, (...args) => this.emit(event, ...args));
        }
    }
}
exports.VideoAgent = VideoAgent;
//# sourceMappingURL=VideoAgent.new.js.map