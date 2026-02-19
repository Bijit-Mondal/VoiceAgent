"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_MAX_AUDIO_SIZE = exports.DEFAULT_HISTORY_CONFIG = exports.DEFAULT_STREAMING_SPEECH_CONFIG = void 0;
/**
 * Default streaming speech configuration
 */
exports.DEFAULT_STREAMING_SPEECH_CONFIG = {
    minChunkSize: 50,
    maxChunkSize: 200,
    parallelGeneration: true,
    maxParallelRequests: 3,
};
/**
 * Default history configuration
 */
exports.DEFAULT_HISTORY_CONFIG = {
    maxMessages: 100,
    maxTotalChars: 0, // unlimited by default
};
/** Default maximum audio input size (10 MB) */
exports.DEFAULT_MAX_AUDIO_SIZE = 10 * 1024 * 1024;
//# sourceMappingURL=types.js.map