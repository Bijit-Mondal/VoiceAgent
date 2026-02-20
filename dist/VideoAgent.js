"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VideoAgent = void 0;
const ws_1 = require("ws");
const events_1 = require("events");
const ai_1 = require("ai");
const types_1 = require("./types");
/** Default maximum frame input size (5 MB) */
const DEFAULT_MAX_FRAME_SIZE = 5 * 1024 * 1024;
/** Default video agent config */
const DEFAULT_VIDEO_AGENT_CONFIG = {
    maxContextFrames: 10,
};
class VideoAgent extends events_1.EventEmitter {
    socket;
    tools = {};
    model;
    transcriptionModel;
    speechModel;
    instructions;
    stopWhen;
    endpoint;
    isConnected = false;
    conversationHistory = [];
    voice;
    speechInstructions;
    outputFormat;
    isProcessing = false;
    isDestroyed = false;
    // Session management
    sessionId;
    frameSequence = 0;
    lastFrameTimestamp = 0;
    lastFrameHash;
    // Frame context buffer for visual conversation history
    frameContextBuffer = [];
    currentFrameData; // Base64 encoded current frame
    // Video agent configuration
    videoConfig;
    // Concurrency: queue incoming requests so they run serially
    inputQueue = [];
    processingQueue = false;
    // Abort controller for the current LLM stream so we can cancel it on interrupt/disconnect
    currentStreamAbortController;
    // Memory management
    historyConfig;
    maxAudioInputSize;
    maxFrameInputSize;
    // Streaming speech state
    streamingSpeechConfig;
    currentSpeechAbortController;
    speechChunkQueue = [];
    nextChunkId = 0;
    isSpeaking = false;
    pendingTextBuffer = "";
    // Promise-based signal for speech queue completion
    speechQueueDonePromise;
    speechQueueDoneResolve;
    constructor(options) {
        super();
        this.model = options.model;
        this.transcriptionModel = options.transcriptionModel;
        this.speechModel = options.speechModel;
        this.instructions =
            options.instructions ||
                `You are a helpful multimodal AI assistant that can see through the user's camera and hear their voice.
When analyzing images, be concise but informative. Describe what you see when asked.
Keep responses conversational since they will be spoken aloud.
Use tools when needed to provide accurate information.`;
        this.stopWhen = options.stopWhen || (0, ai_1.stepCountIs)(5);
        this.endpoint = options.endpoint;
        this.voice = options.voice || "alloy";
        this.speechInstructions = options.speechInstructions;
        this.outputFormat = options.outputFormat || "mp3";
        this.maxAudioInputSize = options.maxAudioInputSize ?? types_1.DEFAULT_MAX_AUDIO_SIZE;
        this.maxFrameInputSize = options.maxFrameInputSize ?? DEFAULT_MAX_FRAME_SIZE;
        // Generate or use provided session ID
        this.sessionId = options.sessionId || this.generateSessionId();
        // Initialize video config
        this.videoConfig = {
            ...DEFAULT_VIDEO_AGENT_CONFIG,
            maxContextFrames: options.maxContextFrames ?? DEFAULT_VIDEO_AGENT_CONFIG.maxContextFrames,
        };
        if (options.tools) {
            this.tools = { ...options.tools };
        }
        // Initialize streaming speech config with defaults
        this.streamingSpeechConfig = {
            ...types_1.DEFAULT_STREAMING_SPEECH_CONFIG,
            ...options.streamingSpeech,
        };
        // Initialize history config with defaults
        this.historyConfig = {
            ...types_1.DEFAULT_HISTORY_CONFIG,
            ...options.history,
        };
    }
    /**
     * Generate a unique session ID
     */
    generateSessionId() {
        const timestamp = Date.now().toString(36);
        const randomPart = Math.random().toString(36).substring(2, 10);
        return `vs_${timestamp}_${randomPart}`;
    }
    /**
     * Simple hash function for frame comparison
     */
    hashFrame(data) {
        let hash = 0;
        for (let i = 0; i < data.length; i++) {
            const char = data.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return `frame_${this.frameSequence}_${Math.abs(hash).toString(16)}`;
    }
    /**
     * Ensure the agent has not been destroyed. Throws if it has.
     */
    ensureNotDestroyed() {
        if (this.isDestroyed) {
            throw new Error("VideoAgent has been destroyed and cannot be used");
        }
    }
    /**
     * Get current video agent configuration
     */
    getConfig() {
        return { ...this.videoConfig };
    }
    /**
     * Update video agent configuration
     */
    updateConfig(config) {
        this.videoConfig = { ...this.videoConfig, ...config };
        this.emit("config_changed", this.videoConfig);
    }
    setupListeners() {
        if (!this.socket)
            return;
        this.socket.on("message", async (data) => {
            try {
                const message = JSON.parse(data.toString());
                switch (message.type) {
                    // Handle transcribed text from the client/STT
                    case "transcript":
                        if (typeof message.text !== "string" || !message.text.trim()) {
                            this.emit("warning", "Received empty or invalid transcript message");
                            return;
                        }
                        // Interrupt ongoing speech when user starts speaking (barge-in)
                        this.interruptCurrentResponse("user_speaking");
                        // Force capture current frame when user speaks
                        this.requestFrameCapture("user_request");
                        await this.enqueueTextInput(message.text);
                        break;
                    // Handle raw audio data that needs transcription
                    case "audio":
                        if (typeof message.data !== "string" || !message.data) {
                            this.emit("warning", "Received empty or invalid audio message");
                            return;
                        }
                        // Interrupt ongoing speech when user starts speaking (barge-in)
                        this.interruptCurrentResponse("user_speaking");
                        // Force capture current frame when user speaks
                        this.requestFrameCapture("user_request");
                        try {
                            await this.processAudioInput(message);
                        }
                        catch (audioError) {
                            this.emit("error", audioError);
                        }
                        break;
                    // Handle video frame from client
                    case "video_frame":
                        await this.handleVideoFrame(message);
                        break;
                    // Handle explicit interrupt request from client
                    case "interrupt":
                        this.interruptCurrentResponse(message.reason || "client_request");
                        break;
                    // Handle client ready signal
                    case "client_ready":
                        this.handleClientReady(message);
                        break;
                    default:
                        break;
                }
            }
            catch (err) {
                this.emit("error", err);
            }
        });
        this.socket.on("close", () => {
            this.isConnected = false;
            this.cleanupOnDisconnect();
            this.emit("disconnected");
        });
        this.socket.on("error", (error) => {
            this.emit("error", error);
        });
    }
    /**
     * Handle client ready signal
     */
    handleClientReady(message) {
        // Send session info to client
        this.sendWebSocketMessage({
            type: "session_init",
            sessionId: this.sessionId,
        });
        this.emit("client_ready", message.capabilities);
    }
    /**
     * Handle incoming video frame
     */
    async handleVideoFrame(frame) {
        try {
            // Validate frame
            if (!frame.image?.data) {
                this.emit("warning", "Received empty or invalid video frame");
                return;
            }
            // Check frame size
            const frameSize = Buffer.from(frame.image.data, "base64").length;
            if (frameSize > this.maxFrameInputSize) {
                const sizeMB = (frameSize / (1024 * 1024)).toFixed(1);
                const maxMB = (this.maxFrameInputSize / (1024 * 1024)).toFixed(1);
                this.emit("error", new Error(`Frame too large (${sizeMB} MB). Maximum allowed: ${maxMB} MB`));
                return;
            }
            // Update frame tracking
            const frameHash = this.hashFrame(frame.image.data);
            this.lastFrameTimestamp = frame.timestamp;
            this.lastFrameHash = frameHash;
            this.currentFrameData = frame.image.data;
            // Add to context buffer
            this.addFrameToContext({
                sequence: frame.sequence,
                timestamp: frame.timestamp,
                triggerReason: frame.triggerReason,
                frameHash,
            });
            // Emit frame received event
            this.emit("frame_received", {
                sequence: frame.sequence,
                timestamp: frame.timestamp,
                triggerReason: frame.triggerReason,
                size: frameSize,
                dimensions: { width: frame.image.width, height: frame.image.height },
            });
            // Acknowledge frame receipt to client
            this.sendWebSocketMessage({
                type: "frame_ack",
                sequence: frame.sequence,
                timestamp: Date.now(),
            });
        }
        catch (error) {
            this.emit("error", error);
        }
    }
    /**
     * Add frame to context buffer
     */
    addFrameToContext(context) {
        this.frameContextBuffer.push(context);
        // Trim buffer if needed
        if (this.frameContextBuffer.length > this.videoConfig.maxContextFrames) {
            this.frameContextBuffer.shift();
        }
    }
    /**
     * Request client to capture and send a frame
     */
    requestFrameCapture(reason) {
        this.sendWebSocketMessage({
            type: "capture_frame",
            reason,
            timestamp: Date.now(),
        });
        this.emit("frame_requested", { reason });
    }
    /**
     * Clean up all in-flight state when the connection drops.
     */
    cleanupOnDisconnect() {
        // Abort ongoing LLM stream
        if (this.currentStreamAbortController) {
            this.currentStreamAbortController.abort();
            this.currentStreamAbortController = undefined;
        }
        // Abort ongoing speech generation
        if (this.currentSpeechAbortController) {
            this.currentSpeechAbortController.abort();
            this.currentSpeechAbortController = undefined;
        }
        // Clear speech state
        this.speechChunkQueue = [];
        this.pendingTextBuffer = "";
        this.isSpeaking = false;
        this.isProcessing = false;
        // Clear frame state
        this.currentFrameData = undefined;
        // Resolve any pending speech-done waiters
        if (this.speechQueueDoneResolve) {
            this.speechQueueDoneResolve();
            this.speechQueueDoneResolve = undefined;
            this.speechQueueDonePromise = undefined;
        }
        // Reject any queued inputs
        for (const item of this.inputQueue) {
            item.reject(new Error("Connection closed"));
        }
        this.inputQueue = [];
        this.processingQueue = false;
    }
    registerTools(tools) {
        this.tools = { ...this.tools, ...tools };
    }
    /**
     * Transcribe audio data to text using the configured transcription model
     */
    async transcribeAudio(audioData) {
        if (!this.transcriptionModel) {
            throw new Error("Transcription model not configured");
        }
        try {
            const result = await (0, ai_1.experimental_transcribe)({
                model: this.transcriptionModel,
                audio: audioData,
            });
            this.emit("transcription", {
                text: result.text,
                language: result.language,
            });
            // Also send transcription to client for immediate feedback
            this.sendWebSocketMessage({
                type: "transcription_result",
                text: result.text,
                language: result.language,
            });
            return result.text;
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Generate speech from text using the configured speech model
     */
    async generateSpeechFromText(text, abortSignal) {
        if (!this.speechModel) {
            throw new Error("Speech model not configured");
        }
        const result = await (0, ai_1.experimental_generateSpeech)({
            model: this.speechModel,
            text,
            voice: this.voice,
            instructions: this.speechInstructions,
            outputFormat: this.outputFormat,
            abortSignal,
        });
        return result.audio.uint8Array;
    }
    /**
     * Interrupt ongoing speech generation and playback
     */
    interruptSpeech(reason = "interrupted") {
        if (!this.isSpeaking && this.speechChunkQueue.length === 0) {
            return;
        }
        if (this.currentSpeechAbortController) {
            this.currentSpeechAbortController.abort();
            this.currentSpeechAbortController = undefined;
        }
        this.speechChunkQueue = [];
        this.pendingTextBuffer = "";
        this.isSpeaking = false;
        if (this.speechQueueDoneResolve) {
            this.speechQueueDoneResolve();
            this.speechQueueDoneResolve = undefined;
            this.speechQueueDonePromise = undefined;
        }
        this.sendWebSocketMessage({
            type: "speech_interrupted",
            reason,
        });
        this.emit("speech_interrupted", { reason });
    }
    /**
     * Interrupt both the current LLM stream and ongoing speech
     */
    interruptCurrentResponse(reason = "interrupted") {
        if (this.currentStreamAbortController) {
            this.currentStreamAbortController.abort();
            this.currentStreamAbortController = undefined;
        }
        this.interruptSpeech(reason);
    }
    /**
     * Extract complete sentences from text buffer
     */
    extractSentences(text) {
        const sentences = [];
        let remaining = text;
        const sentenceEndPattern = /[.!?]+(?:\s+|$)/g;
        let lastIndex = 0;
        let match;
        while ((match = sentenceEndPattern.exec(text)) !== null) {
            const sentence = text.slice(lastIndex, match.index + match[0].length).trim();
            if (sentence.length >= this.streamingSpeechConfig.minChunkSize) {
                sentences.push(sentence);
                lastIndex = match.index + match[0].length;
            }
            else if (sentences.length > 0) {
                sentences[sentences.length - 1] += " " + sentence;
                lastIndex = match.index + match[0].length;
            }
        }
        remaining = text.slice(lastIndex);
        if (remaining.length > this.streamingSpeechConfig.maxChunkSize) {
            const clausePattern = /[,;:]\s+/g;
            let clauseMatch;
            let splitIndex = 0;
            while ((clauseMatch = clausePattern.exec(remaining)) !== null) {
                if (clauseMatch.index >= this.streamingSpeechConfig.minChunkSize) {
                    splitIndex = clauseMatch.index + clauseMatch[0].length;
                    break;
                }
            }
            if (splitIndex > 0) {
                sentences.push(remaining.slice(0, splitIndex).trim());
                remaining = remaining.slice(splitIndex);
            }
        }
        return [sentences, remaining];
    }
    /**
     * Trim conversation history to stay within configured limits
     */
    trimHistory() {
        const { maxMessages, maxTotalChars } = this.historyConfig;
        if (maxMessages > 0 && this.conversationHistory.length > maxMessages) {
            const excess = this.conversationHistory.length - maxMessages;
            const toRemove = excess % 2 === 0 ? excess : excess + 1;
            this.conversationHistory.splice(0, toRemove);
            this.emit("history_trimmed", { removedCount: toRemove, reason: "max_messages" });
        }
        if (maxTotalChars > 0) {
            let totalChars = this.conversationHistory.reduce((sum, msg) => {
                const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
                return sum + content.length;
            }, 0);
            let removedCount = 0;
            while (totalChars > maxTotalChars && this.conversationHistory.length > 2) {
                const removed = this.conversationHistory.shift();
                if (removed) {
                    const content = typeof removed.content === "string" ? removed.content : JSON.stringify(removed.content);
                    totalChars -= content.length;
                    removedCount++;
                }
            }
            if (removedCount > 0) {
                this.emit("history_trimmed", { removedCount, reason: "max_total_chars" });
            }
        }
    }
    /**
     * Queue a text chunk for speech generation
     */
    queueSpeechChunk(text) {
        if (!this.speechModel || !text.trim())
            return;
        if (this.nextChunkId >= Number.MAX_SAFE_INTEGER) {
            this.nextChunkId = 0;
        }
        const chunk = {
            id: this.nextChunkId++,
            text: text.trim(),
        };
        if (!this.speechQueueDonePromise) {
            this.speechQueueDonePromise = new Promise((resolve) => {
                this.speechQueueDoneResolve = resolve;
            });
        }
        if (this.streamingSpeechConfig.parallelGeneration) {
            const activeRequests = this.speechChunkQueue.filter((c) => c.audioPromise).length;
            if (activeRequests < this.streamingSpeechConfig.maxParallelRequests) {
                chunk.audioPromise = this.generateChunkAudio(chunk);
            }
        }
        this.speechChunkQueue.push(chunk);
        this.emit("speech_chunk_queued", { id: chunk.id, text: chunk.text });
        if (!this.isSpeaking) {
            this.processSpeechQueue();
        }
    }
    /**
     * Generate audio for a single chunk
     */
    async generateChunkAudio(chunk) {
        if (!this.currentSpeechAbortController) {
            this.currentSpeechAbortController = new AbortController();
        }
        try {
            const audioData = await this.generateSpeechFromText(chunk.text, this.currentSpeechAbortController.signal);
            return audioData;
        }
        catch (error) {
            if (error.name === "AbortError") {
                return null;
            }
            this.emit("error", error);
            return null;
        }
    }
    /**
     * Process the speech queue and send audio chunks in order
     */
    async processSpeechQueue() {
        if (this.isSpeaking)
            return;
        this.isSpeaking = true;
        this.emit("speech_start", { streaming: true });
        this.sendWebSocketMessage({ type: "speech_stream_start" });
        try {
            while (this.speechChunkQueue.length > 0) {
                const chunk = this.speechChunkQueue[0];
                if (!chunk.audioPromise) {
                    chunk.audioPromise = this.generateChunkAudio(chunk);
                }
                const audioData = await chunk.audioPromise;
                if (!this.isSpeaking) {
                    break;
                }
                this.speechChunkQueue.shift();
                if (audioData) {
                    const base64Audio = Buffer.from(audioData).toString("base64");
                    this.sendWebSocketMessage({
                        type: "audio_chunk",
                        chunkId: chunk.id,
                        data: base64Audio,
                        format: this.outputFormat,
                        text: chunk.text,
                    });
                    this.emit("audio_chunk", {
                        chunkId: chunk.id,
                        data: base64Audio,
                        format: this.outputFormat,
                        text: chunk.text,
                        uint8Array: audioData,
                    });
                }
                if (this.streamingSpeechConfig.parallelGeneration) {
                    const activeRequests = this.speechChunkQueue.filter((c) => c.audioPromise).length;
                    const toStart = Math.min(this.streamingSpeechConfig.maxParallelRequests - activeRequests, this.speechChunkQueue.length);
                    if (toStart > 0) {
                        for (let i = 0; i < toStart; i++) {
                            const nextChunk = this.speechChunkQueue.find((c) => !c.audioPromise);
                            if (nextChunk) {
                                nextChunk.audioPromise = this.generateChunkAudio(nextChunk);
                            }
                        }
                    }
                }
            }
        }
        catch (error) {
            this.emit("error", error);
        }
        finally {
            this.isSpeaking = false;
            this.currentSpeechAbortController = undefined;
            if (this.speechQueueDoneResolve) {
                this.speechQueueDoneResolve();
                this.speechQueueDoneResolve = undefined;
                this.speechQueueDonePromise = undefined;
            }
            this.sendWebSocketMessage({ type: "speech_stream_end" });
            this.emit("speech_complete", { streaming: true });
        }
    }
    /**
     * Process text delta for streaming speech
     */
    processTextForStreamingSpeech(textDelta) {
        if (!this.speechModel)
            return;
        this.pendingTextBuffer += textDelta;
        const [sentences, remaining] = this.extractSentences(this.pendingTextBuffer);
        this.pendingTextBuffer = remaining;
        for (const sentence of sentences) {
            this.queueSpeechChunk(sentence);
        }
    }
    /**
     * Flush any remaining text in the buffer to speech
     */
    flushStreamingSpeech() {
        if (!this.speechModel || !this.pendingTextBuffer.trim())
            return;
        this.queueSpeechChunk(this.pendingTextBuffer);
        this.pendingTextBuffer = "";
    }
    /**
     * Process incoming audio data: transcribe and generate response
     */
    async processAudioInput(audioMessage) {
        if (!this.transcriptionModel) {
            const error = new Error("Transcription model not configured for audio input");
            this.emit("error", error);
            this.sendWebSocketMessage({
                type: "error",
                error: error.message,
            });
            return;
        }
        try {
            const audioBuffer = Buffer.from(audioMessage.data, "base64");
            if (audioBuffer.length > this.maxAudioInputSize) {
                const sizeMB = (audioBuffer.length / (1024 * 1024)).toFixed(1);
                const maxMB = (this.maxAudioInputSize / (1024 * 1024)).toFixed(1);
                this.emit("error", new Error(`Audio input too large (${sizeMB} MB). Maximum allowed: ${maxMB} MB`));
                return;
            }
            if (audioBuffer.length === 0) {
                this.emit("warning", "Received empty audio data");
                return;
            }
            this.emit("audio_received", {
                size: audioBuffer.length,
                format: audioMessage.format,
                sessionId: audioMessage.sessionId || this.sessionId,
            });
            const transcribedText = await this.transcribeAudio(audioBuffer);
            if (transcribedText.trim()) {
                await this.enqueueTextInput(transcribedText);
            }
            else {
                this.emit("warning", "Transcription returned empty text");
                this.sendWebSocketMessage({
                    type: "transcription_error",
                    error: "Whisper returned empty text",
                });
            }
        }
        catch (error) {
            this.emit("error", error);
            this.sendWebSocketMessage({
                type: "transcription_error",
                error: `Transcription failed: ${error.message || String(error)}`,
            });
        }
    }
    async connect(url) {
        this.ensureNotDestroyed();
        if (this.socket) {
            this.disconnectSocket();
        }
        return new Promise((resolve, reject) => {
            try {
                const wsUrl = url || this.endpoint || "ws://localhost:8080";
                this.socket = new ws_1.WebSocket(wsUrl);
                this.setupListeners();
                this.socket.once("open", () => {
                    this.isConnected = true;
                    this.emit("connected");
                    resolve();
                });
                this.socket.once("error", (error) => {
                    reject(error);
                });
            }
            catch (error) {
                reject(error);
            }
        });
    }
    /**
     * Attach an existing WebSocket (server-side usage)
     */
    handleSocket(socket) {
        this.ensureNotDestroyed();
        if (this.socket) {
            this.disconnectSocket();
        }
        this.socket = socket;
        this.isConnected = true;
        this.setupListeners();
        this.emit("connected");
    }
    /**
     * Send text input for processing (bypasses transcription)
     */
    async sendText(text) {
        this.ensureNotDestroyed();
        if (!text || !text.trim()) {
            throw new Error("Text input cannot be empty");
        }
        return this.enqueueTextInput(text);
    }
    /**
     * Send audio data to be transcribed and processed
     */
    async sendAudio(audioData) {
        this.ensureNotDestroyed();
        await this.processAudioInput({
            type: "audio",
            sessionId: this.sessionId,
            data: audioData,
            format: "unknown",
            timestamp: Date.now(),
        });
    }
    /**
     * Send raw audio buffer to be transcribed and processed
     */
    async sendAudioBuffer(audioBuffer) {
        this.ensureNotDestroyed();
        const base64Audio = Buffer.from(audioBuffer).toString("base64");
        await this.processAudioInput({
            type: "audio",
            sessionId: this.sessionId,
            data: base64Audio,
            format: "unknown",
            timestamp: Date.now(),
        });
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
     * Enqueue a text input for serial processing
     */
    enqueueTextInput(text) {
        return new Promise((resolve, reject) => {
            this.inputQueue.push({ text, resolve, reject });
            this.drainInputQueue();
        });
    }
    /**
     * Enqueue a multimodal input (text + frame) for serial processing
     */
    enqueueMultimodalInput(text, frame) {
        return new Promise((resolve, reject) => {
            this.inputQueue.push({ text, frame, resolve, reject });
            this.drainInputQueue();
        });
    }
    /**
     * Drain the input queue, processing one request at a time
     */
    async drainInputQueue() {
        if (this.processingQueue) {
            return;
        }
        this.processingQueue = true;
        try {
            while (this.inputQueue.length > 0) {
                const item = this.inputQueue.shift();
                try {
                    let result;
                    if (item.frame && item.text) {
                        result = await this.processMultimodalInput(item.text, item.frame);
                    }
                    else if (item.text) {
                        result = await this.processUserInput(item.text);
                    }
                    else {
                        result = "";
                    }
                    item.resolve(result);
                }
                catch (error) {
                    item.reject(error);
                }
            }
        }
        finally {
            this.processingQueue = false;
        }
    }
    /**
     * Build the message content array for multimodal input
     */
    buildMultimodalContent(text, frameData) {
        const content = [];
        // Add frame context description if available
        if (this.frameContextBuffer.length > 0) {
            const contextSummary = `[Visual context: ${this.frameContextBuffer.length} frames captured, latest at ${new Date(this.lastFrameTimestamp).toISOString()}]`;
            content.push({ type: "text", text: contextSummary });
        }
        // Add current frame if available
        const imageData = frameData || this.currentFrameData;
        if (imageData) {
            content.push({
                type: "image",
                image: imageData,
            });
        }
        // Add user query
        content.push({ type: "text", text });
        return content;
    }
    /**
     * Process multimodal input (text + video frame)
     */
    async processMultimodalInput(text, frame) {
        this.isProcessing = true;
        this.currentStreamAbortController = new AbortController();
        const streamAbortSignal = this.currentStreamAbortController.signal;
        try {
            this.emit("text", { role: "user", text, hasImage: true });
            // Build multimodal message content
            const content = this.buildMultimodalContent(text, frame.image.data);
            // Add to conversation history (simplified for history)
            this.conversationHistory.push({
                role: "user",
                content: [{ type: "text", text: `[Image attached] ${text}` }],
            });
            this.trimHistory();
            // Use streamText with multimodal content
            const result = (0, ai_1.streamText)({
                model: this.model,
                system: this.instructions,
                messages: [
                    ...this.conversationHistory.slice(0, -1), // Previous history
                    { role: "user", content }, // Current multimodal message
                ],
                tools: this.tools,
                stopWhen: this.stopWhen,
                abortSignal: streamAbortSignal,
                onChunk: ({ chunk }) => {
                    this.handleStreamChunk(chunk);
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
            return await this.processStreamResult(result);
        }
        catch (error) {
            this.pendingTextBuffer = "";
            if (this.speechChunkQueue.length > 0 || this.isSpeaking) {
                this.interruptSpeech("stream_error");
            }
            throw error;
        }
        finally {
            this.isProcessing = false;
            this.currentStreamAbortController = undefined;
        }
    }
    /**
     * Process user input with streaming text generation
     */
    async processUserInput(text) {
        this.isProcessing = true;
        this.currentStreamAbortController = new AbortController();
        const streamAbortSignal = this.currentStreamAbortController.signal;
        try {
            this.emit("text", { role: "user", text });
            // Check if we have current frame data - if so, include it
            const hasVisualContext = !!this.currentFrameData;
            let messages;
            if (hasVisualContext) {
                // Build multimodal message
                const content = this.buildMultimodalContent(text);
                // Store simplified version in history
                this.conversationHistory.push({
                    role: "user",
                    content: [{ type: "text", text: `[Visual context] ${text}` }],
                });
                messages = [
                    ...this.conversationHistory.slice(0, -1),
                    { role: "user", content },
                ];
            }
            else {
                // Text-only message
                this.conversationHistory.push({ role: "user", content: text });
                messages = this.conversationHistory;
            }
            this.trimHistory();
            const result = (0, ai_1.streamText)({
                model: this.model,
                system: this.instructions,
                messages,
                tools: this.tools,
                stopWhen: this.stopWhen,
                abortSignal: streamAbortSignal,
                onChunk: ({ chunk }) => {
                    this.handleStreamChunk(chunk);
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
            return await this.processStreamResult(result);
        }
        catch (error) {
            this.pendingTextBuffer = "";
            if (this.speechChunkQueue.length > 0 || this.isSpeaking) {
                this.interruptSpeech("stream_error");
            }
            throw error;
        }
        finally {
            this.isProcessing = false;
            this.currentStreamAbortController = undefined;
        }
    }
    /**
     * Handle individual stream chunks
     */
    handleStreamChunk(chunk) {
        switch (chunk.type) {
            case "text-delta":
                this.emit("chunk:text_delta", { id: chunk.id, text: chunk.text });
                break;
            case "reasoning-delta":
                this.emit("chunk:reasoning_delta", { id: chunk.id, text: chunk.text });
                break;
            case "tool-call":
                this.emit("chunk:tool_call", {
                    toolName: chunk.toolName,
                    toolCallId: chunk.toolCallId,
                    input: chunk.input,
                });
                break;
            case "tool-result":
                this.emit("chunk:tool_result", {
                    toolName: chunk.toolName,
                    toolCallId: chunk.toolCallId,
                    result: chunk.output,
                });
                break;
            case "tool-input-start":
                this.emit("chunk:tool_input_start", {
                    id: chunk.id,
                    toolName: chunk.toolName,
                });
                break;
            case "tool-input-delta":
                this.emit("chunk:tool_input_delta", {
                    id: chunk.id,
                    delta: chunk.delta,
                });
                break;
            case "source":
                this.emit("chunk:source", chunk);
                break;
        }
    }
    /**
     * Process the full stream result and return the response text
     */
    async processStreamResult(result) {
        let fullText = "";
        let fullReasoning = "";
        const allToolCalls = [];
        const allToolResults = [];
        const allSources = [];
        const allFiles = [];
        for await (const part of result.fullStream) {
            switch (part.type) {
                case "start":
                    this.sendWebSocketMessage({ type: "stream_start" });
                    break;
                case "finish":
                    this.emit("text", { role: "assistant", text: fullText });
                    this.sendWebSocketMessage({
                        type: "stream_finish",
                        finishReason: part.finishReason,
                        usage: part.totalUsage,
                    });
                    break;
                case "error":
                    this.emit("error", part.error);
                    this.sendWebSocketMessage({
                        type: "stream_error",
                        error: String(part.error),
                    });
                    break;
                case "abort":
                    this.emit("abort", { reason: part.reason });
                    this.sendWebSocketMessage({
                        type: "stream_abort",
                        reason: part.reason,
                    });
                    break;
                case "start-step":
                    this.sendWebSocketMessage({
                        type: "step_start",
                        warnings: part.warnings,
                    });
                    break;
                case "finish-step":
                    this.sendWebSocketMessage({
                        type: "step_finish",
                        finishReason: part.finishReason,
                        usage: part.usage,
                    });
                    break;
                case "text-start":
                    this.sendWebSocketMessage({ type: "text_start", id: part.id });
                    break;
                case "text-delta":
                    fullText += part.text;
                    this.processTextForStreamingSpeech(part.text);
                    this.sendWebSocketMessage({
                        type: "text_delta",
                        id: part.id,
                        text: part.text,
                    });
                    break;
                case "text-end":
                    this.flushStreamingSpeech();
                    this.sendWebSocketMessage({ type: "text_end", id: part.id });
                    break;
                case "reasoning-start":
                    this.sendWebSocketMessage({ type: "reasoning_start", id: part.id });
                    break;
                case "reasoning-delta":
                    fullReasoning += part.text;
                    this.sendWebSocketMessage({
                        type: "reasoning_delta",
                        id: part.id,
                        text: part.text,
                    });
                    break;
                case "reasoning-end":
                    this.sendWebSocketMessage({ type: "reasoning_end", id: part.id });
                    break;
                case "tool-input-start":
                    this.sendWebSocketMessage({
                        type: "tool_input_start",
                        id: part.id,
                        toolName: part.toolName,
                    });
                    break;
                case "tool-input-delta":
                    this.sendWebSocketMessage({
                        type: "tool_input_delta",
                        id: part.id,
                        delta: part.delta,
                    });
                    break;
                case "tool-input-end":
                    this.sendWebSocketMessage({ type: "tool_input_end", id: part.id });
                    break;
                case "tool-call":
                    allToolCalls.push({
                        toolName: part.toolName,
                        toolCallId: part.toolCallId,
                        input: part.input,
                    });
                    this.sendWebSocketMessage({
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
                    this.sendWebSocketMessage({
                        type: "tool_result",
                        toolName: part.toolName,
                        toolCallId: part.toolCallId,
                        result: part.output,
                    });
                    break;
                case "tool-error":
                    this.sendWebSocketMessage({
                        type: "tool_error",
                        toolName: part.toolName,
                        toolCallId: part.toolCallId,
                        error: String(part.error),
                    });
                    break;
                case "source":
                    allSources.push(part);
                    this.sendWebSocketMessage({
                        type: "source",
                        source: part,
                    });
                    break;
                case "file":
                    allFiles.push(part.file);
                    this.sendWebSocketMessage({
                        type: "file",
                        file: part.file,
                    });
                    break;
            }
        }
        // Add assistant response to conversation history
        if (fullText) {
            this.conversationHistory.push({ role: "assistant", content: fullText });
            this.trimHistory();
        }
        // Ensure any remaining speech is flushed
        this.flushStreamingSpeech();
        // Wait for all speech chunks to complete
        if (this.speechQueueDonePromise) {
            await this.speechQueueDonePromise;
        }
        // Send the complete response
        this.sendWebSocketMessage({
            type: "response_complete",
            sessionId: this.sessionId,
            text: fullText,
            reasoning: fullReasoning || undefined,
            toolCalls: allToolCalls,
            toolResults: allToolResults,
            sources: allSources.length > 0 ? allSources : undefined,
            files: allFiles.length > 0 ? allFiles : undefined,
            frameContext: this.frameContextBuffer.length > 0 ? {
                frameCount: this.frameContextBuffer.length,
                lastFrameSequence: this.frameContextBuffer[this.frameContextBuffer.length - 1]?.sequence,
            } : undefined,
        });
        return fullText;
    }
    /**
     * Send a message via WebSocket if connected
     */
    sendWebSocketMessage(message) {
        if (!this.socket || !this.isConnected)
            return;
        try {
            if (this.socket.readyState === ws_1.WebSocket.OPEN) {
                this.socket.send(JSON.stringify(message));
            }
        }
        catch (error) {
            this.emit("error", error);
        }
    }
    /**
     * Start listening for voice/video input
     */
    startListening() {
        this.emit("listening");
    }
    /**
     * Stop listening for voice/video input
     */
    stopListening() {
        this.emit("stopped");
    }
    /**
     * Clear conversation history
     */
    clearHistory() {
        this.conversationHistory = [];
        this.frameContextBuffer = [];
        this.emit("history_cleared");
    }
    /**
     * Get current conversation history
     */
    getHistory() {
        return [...this.conversationHistory];
    }
    /**
     * Set conversation history
     */
    setHistory(history) {
        this.conversationHistory = [...history];
    }
    /**
     * Get frame context buffer
     */
    getFrameContext() {
        return [...this.frameContextBuffer];
    }
    /**
     * Get session ID
     */
    getSessionId() {
        return this.sessionId;
    }
    /**
     * Internal helper to close and clean up the current socket
     */
    disconnectSocket() {
        if (!this.socket)
            return;
        this.cleanupOnDisconnect();
        try {
            this.socket.removeAllListeners();
            if (this.socket.readyState === ws_1.WebSocket.OPEN ||
                this.socket.readyState === ws_1.WebSocket.CONNECTING) {
                this.socket.close();
            }
        }
        catch {
            // Ignore close errors
        }
        this.socket = undefined;
        this.isConnected = false;
    }
    /**
     * Disconnect from WebSocket and stop all in-flight work
     */
    disconnect() {
        this.disconnectSocket();
    }
    /**
     * Permanently destroy the agent, releasing all resources
     */
    destroy() {
        this.isDestroyed = true;
        this.disconnectSocket();
        this.conversationHistory = [];
        this.frameContextBuffer = [];
        this.tools = {};
        this.removeAllListeners();
    }
    /**
     * Check if agent is connected to WebSocket
     */
    get connected() {
        return this.isConnected;
    }
    /**
     * Check if agent is currently processing a request
     */
    get processing() {
        return this.isProcessing;
    }
    /**
     * Check if agent is currently speaking
     */
    get speaking() {
        return this.isSpeaking;
    }
    /**
     * Get the number of pending speech chunks in the queue
     */
    get pendingSpeechChunks() {
        return this.speechChunkQueue.length;
    }
    /**
     * Check if agent has been permanently destroyed
     */
    get destroyed() {
        return this.isDestroyed;
    }
    /**
     * Get current frame sequence number
     */
    get currentFrameSequence() {
        return this.frameSequence;
    }
    /**
     * Check if there is visual context available
     */
    get hasVisualContext() {
        return !!this.currentFrameData;
    }
}
exports.VideoAgent = VideoAgent;
//# sourceMappingURL=VideoAgent.js.map