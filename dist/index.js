"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_MAX_AUDIO_SIZE = exports.DEFAULT_HISTORY_CONFIG = exports.DEFAULT_STREAMING_SPEECH_CONFIG = exports.VideoAgent = exports.VoiceAgent = void 0;
// Agents
var VoiceAgent_1 = require("./VoiceAgent");
Object.defineProperty(exports, "VoiceAgent", { enumerable: true, get: function () { return VoiceAgent_1.VoiceAgent; } });
var VideoAgent_1 = require("./VideoAgent");
Object.defineProperty(exports, "VideoAgent", { enumerable: true, get: function () { return VideoAgent_1.VideoAgent; } });
// Shared types
var types_1 = require("./types");
Object.defineProperty(exports, "DEFAULT_STREAMING_SPEECH_CONFIG", { enumerable: true, get: function () { return types_1.DEFAULT_STREAMING_SPEECH_CONFIG; } });
Object.defineProperty(exports, "DEFAULT_HISTORY_CONFIG", { enumerable: true, get: function () { return types_1.DEFAULT_HISTORY_CONFIG; } });
Object.defineProperty(exports, "DEFAULT_MAX_AUDIO_SIZE", { enumerable: true, get: function () { return types_1.DEFAULT_MAX_AUDIO_SIZE; } });
//# sourceMappingURL=index.js.map