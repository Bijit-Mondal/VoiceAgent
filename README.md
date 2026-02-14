# voice-agent-ai-sdk

[![npm version](https://badge.fury.io/js/voice-agent-ai-sdk.svg)](https://www.npmjs.com/package/voice-agent-ai-sdk)

Streaming voice/text agent SDK built on [AI SDK](https://sdk.vercel.ai/) with optional WebSocket transport.

## Features

- **Streaming text generation** via AI SDK `streamText` with multi-step tool calling.
- **Chunked streaming TTS** — text is split at sentence boundaries and converted to speech in parallel as the LLM streams, giving low time-to-first-audio.
- **Audio transcription** via AI SDK `experimental_transcribe` (e.g. Whisper).
- **Barge-in / interruption** — user speech cancels both the in-flight LLM stream and pending TTS, saving tokens and latency.
- **Memory management** — configurable sliding-window on conversation history (`maxMessages`, `maxTotalChars`) and audio input size limits.
- **Serial request queue** — concurrent `sendText` / audio inputs are queued and processed one at a time, preventing race conditions.
- **Graceful lifecycle** — `disconnect()` aborts all in-flight work; `destroy()` permanently releases every resource.
- **WebSocket transport** with a full protocol of stream, tool, and speech lifecycle events.
- **Works without WebSocket** — call `sendText()` directly for text-only or server-side use.

## Prerequisites

- Node.js 20+
- pnpm
- OpenAI API key

## Setup

1. Install dependencies:

   pnpm install

2. Configure environment variables in `.env`:

   OPENAI_API_KEY=your_openai_api_key
   VOICE_WS_ENDPOINT=ws://localhost:8080

`VOICE_WS_ENDPOINT` is optional for text-only usage.

## VoiceAgent usage (as in the demo)

Minimal end-to-end example using AI SDK tools, streaming text, and streaming TTS:

```ts
import "dotenv/config";
import { VoiceAgent } from "./src";
import { tool } from "ai";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";

const weatherTool = tool({
   description: "Get the weather in a location",
   inputSchema: z.object({ location: z.string() }),
   execute: async ({ location }) => ({ location, temperature: 72, conditions: "sunny" }),
});

const agent = new VoiceAgent({
   model: openai("gpt-4o"),
   transcriptionModel: openai.transcription("whisper-1"),
   speechModel: openai.speech("gpt-4o-mini-tts"),
   instructions: "You are a helpful voice assistant.",
   voice: "alloy",
   speechInstructions: "Speak in a friendly, natural conversational tone.",
   outputFormat: "mp3",
   streamingSpeech: {
      minChunkSize: 40,
      maxChunkSize: 180,
      parallelGeneration: true,
      maxParallelRequests: 2,
   },
   // Memory management (new in 0.1.0)
   history: {
      maxMessages: 50,       // keep last 50 messages
      maxTotalChars: 100_000, // or trim when total chars exceed 100k
   },
   maxAudioInputSize: 5 * 1024 * 1024, // 5 MB limit
   endpoint: process.env.VOICE_WS_ENDPOINT,
   tools: { getWeather: weatherTool },
});

agent.on("text", ({ role, text }) => {
   const prefix = role === "user" ? "👤" : "🤖";
   console.log(prefix, text);
});

agent.on("chunk:text_delta", ({ text }) => process.stdout.write(text));
agent.on("speech_start", ({ streaming }) => console.log("speech_start", streaming));
agent.on("audio_chunk", ({ chunkId, format, uint8Array }) => {
   console.log("audio_chunk", chunkId, format, uint8Array.length);
});

await agent.sendText("What's the weather in San Francisco?");

if (process.env.VOICE_WS_ENDPOINT) {
   await agent.connect(process.env.VOICE_WS_ENDPOINT);
}
```

### Configuration options

The agent accepts:

| Option | Required | Default | Description |
|---|---|---|---|
| `model` | **yes** | — | AI SDK chat model (e.g. `openai("gpt-4o")`) |
| `transcriptionModel` | no | — | AI SDK transcription model (e.g. `openai.transcription("whisper-1")`) |
| `speechModel` | no | — | AI SDK speech model (e.g. `openai.speech("gpt-4o-mini-tts")`) |
| `instructions` | no | `"You are a helpful voice assistant."` | System prompt |
| `stopWhen` | no | `stepCountIs(5)` | Stopping condition for multi-step tool loops |
| `tools` | no | `{}` | AI SDK tools map |
| `endpoint` | no | — | Default WebSocket URL for `connect()` |
| `voice` | no | `"alloy"` | TTS voice |
| `speechInstructions` | no | — | Style instructions passed to the speech model |
| `outputFormat` | no | `"mp3"` | Audio output format (`mp3`, `opus`, `wav`, …) |
| `streamingSpeech` | no | see below | Streaming TTS chunk tuning |
| `history` | no | see below | Conversation memory limits |
| `maxAudioInputSize` | no | `10485760` (10 MB) | Maximum accepted audio input in bytes |

#### `streamingSpeech`

| Key | Default | Description |
|---|---|---|
| `minChunkSize` | `50` | Min characters before a sentence is sent to TTS |
| `maxChunkSize` | `200` | Max characters per chunk (force-split at clause boundary) |
| `parallelGeneration` | `true` | Start TTS for upcoming chunks while the current one plays |
| `maxParallelRequests` | `3` | Cap on concurrent TTS requests |

#### `history`

| Key | Default | Description |
|---|---|---|
| `maxMessages` | `100` | Max messages kept in history (0 = unlimited). Oldest are trimmed in pairs. |
| `maxTotalChars` | `0` (unlimited) | Max total characters across all messages. Oldest are trimmed when exceeded. |

### Methods

| Method | Description |
|---|---|
| `sendText(text)` | Process text input. Returns a promise with the full assistant response. Requests are queued serially. |
| `sendAudio(base64Audio)` | Transcribe base64 audio and process the result. |
| `sendAudioBuffer(buffer)` | Same as above, accepts a raw `Buffer` / `Uint8Array`. |
| `transcribeAudio(buffer)` | Transcribe audio to text without generating a response. |
| `generateAndSendSpeechFull(text)` | Non-streaming TTS fallback (entire text at once). |
| `interruptSpeech(reason?)` | Cancel in-flight TTS only (LLM stream keeps running). |
| `interruptCurrentResponse(reason?)` | Cancel **both** the LLM stream and TTS. Used for barge-in. |
| `connect(url?)` / `handleSocket(ws)` | Establish or attach a WebSocket. Safe to call multiple times. |
| `disconnect()` | Close the socket and abort all in-flight work. |
| `destroy()` | Permanently release all resources. The agent cannot be reused. |
| `clearHistory()` | Clear conversation history. |
| `getHistory()` / `setHistory(msgs)` | Read or restore conversation history. |
| `registerTools(tools)` | Merge additional tools into the agent. |

### Read-only properties

| Property | Type | Description |
|---|---|---|
| `connected` | `boolean` | Whether a WebSocket is connected |
| `processing` | `boolean` | Whether a request is currently being processed |
| `speaking` | `boolean` | Whether audio is currently being generated / sent |
| `pendingSpeechChunks` | `number` | Number of queued TTS chunks |
| `destroyed` | `boolean` | Whether `destroy()` has been called |

### Events

| Event | Payload | When |
|---|---|---|
| `text` | `{ role, text }` | User input received or full assistant response ready |
| `chunk:text_delta` | `{ id, text }` | Each streaming text token from the LLM |
| `chunk:reasoning_delta` | `{ id, text }` | Each reasoning token (models that support it) |
| `chunk:tool_call` | `{ toolName, toolCallId, input }` | Tool invocation detected |
| `tool_result` | `{ name, toolCallId, result }` | Tool execution finished |
| `speech_start` | `{ streaming }` | TTS generation begins |
| `speech_complete` | `{ streaming }` | All TTS chunks sent |
| `speech_interrupted` | `{ reason }` | Speech was cancelled (barge-in, disconnect, error) |
| `speech_chunk_queued` | `{ id, text }` | A text chunk entered the TTS queue |
| `audio_chunk` | `{ chunkId, data, format, text, uint8Array }` | One TTS chunk is ready |
| `audio` | `{ data, format, uint8Array }` | Full non-streaming TTS audio |
| `transcription` | `{ text, language }` | Audio transcription result |
| `audio_received` | `{ size }` | Raw audio input received (before transcription) |
| `history_trimmed` | `{ removedCount, reason }` | Oldest messages evicted from history |
| `connected` / `disconnected` | — | WebSocket lifecycle |
| `warning` | `string` | Non-fatal issues (empty input, etc.) |
| `error` | `Error` | Errors from LLM, TTS, transcription, or WebSocket |

## Run (text-only check)

This validates LLM + tool + streaming speech without requiring WebSocket:

pnpm demo

Expected logs include `text`, `chunk:text_delta`, tool events, and speech chunk events.

## Run (WebSocket check)

1. Start the local WS server:

       pnpm ws:server

2. In another terminal, run the demo:

       pnpm demo

The demo will:
- run `sendText()` first (text-only sanity check), then
- connect to `VOICE_WS_ENDPOINT` if provided,
- emit streaming protocol messages (`text_delta`, `tool_call`, `audio_chunk`, `response_complete`, etc.).

## Browser voice client (HTML)

A simple browser client is available at [example/voice-client.html](example/voice-client.html).

What it does:
- captures microphone speech using Web Speech API (speech-to-text)
- sends transcript to the agent via WebSocket (`type: "transcript"`)
- receives streaming `audio_chunk` messages and plays them in order

How to use:
1. Start your agent server/WebSocket endpoint.
2. Open [example/voice-client.html](example/voice-client.html) in a browser (Chrome/Edge recommended).
3. Connect to `ws://localhost:8080` (or your endpoint), then click **Start Mic**.

## Scripts

- `pnpm build` – build TypeScript
- `pnpm dev` – watch TypeScript
- `pnpm demo` – run demo client
- `pnpm ws:server` – run local test WebSocket server

## Notes

- If `VOICE_WS_ENDPOINT` is empty, WebSocket connect is skipped.
- The sample WS server sends a mock `transcript` message for end-to-end testing.
- Streaming TTS uses chunk queueing and supports interruption (`interrupt`).
