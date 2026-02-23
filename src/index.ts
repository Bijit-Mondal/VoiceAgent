// Agents
export { VoiceAgent, type VoiceAgentOptions } from "./VoiceAgent.new";
export {
    VideoAgent,
    type VideoAgentOptions,
    type VideoFrame,
    type AudioData,
    type VideoAgentConfig,
    type FrameContext,
    type FrameTriggerReason,
} from "./VideoAgent.new";

// Shared types
export {
    type SpeechChunk,
    type StreamingSpeechConfig,
    type HistoryConfig,
    type StopWhenCondition,
    DEFAULT_STREAMING_SPEECH_CONFIG,
    DEFAULT_HISTORY_CONFIG,
    DEFAULT_MAX_AUDIO_SIZE,
} from "./types";
