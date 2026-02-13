# voice-agent-ai-sdk

Streaming voice/text agent SDK built on AI SDK with optional WebSocket transport.

## Current status

- Streaming text generation is implemented via `streamText`.
- Tool calling is supported in-stream.
- Speech synthesis is implemented with chunked streaming TTS.
- Audio transcription is supported (when `transcriptionModel` is configured).
- WebSocket protocol events are emitted for stream, tool, and speech lifecycle.

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

- `model` (required): chat model
- `transcriptionModel` (optional): STT model
- `speechModel` (optional): TTS model
- `instructions` (optional): system prompt
- `stopWhen` (optional): stopping condition
- `tools` (optional): AI SDK tools map
- `endpoint` (optional): WebSocket endpoint
- `voice` (optional): TTS voice, default `alloy`
- `speechInstructions` (optional): style instructions for TTS
- `outputFormat` (optional): audio format, default `mp3`
- `streamingSpeech` (optional):
    - `minChunkSize`
    - `maxChunkSize`
    - `parallelGeneration`
    - `maxParallelRequests`

### Common methods

- `sendText(text)` – process text input (streamed response)
- `sendAudio(base64Audio)` – process base64 audio input
- `sendAudioBuffer(buffer)` – process raw audio buffer input
- `transcribeAudio(buffer)` – transcribe audio directly
- `generateAndSendSpeechFull(text)` – non-streaming TTS fallback
- `interruptSpeech(reason)` – interrupt streaming speech (barge‑in)
- `connect(url?)` / `handleSocket(ws)` – WebSocket usage

### Key events (from demo)

- `text` – user/assistant messages
- `chunk:text_delta` – streaming text deltas
- `chunk:tool_call` / `tool_result` – tool lifecycle
- `speech_start` / `speech_complete` / `speech_interrupted`
- `speech_chunk_queued` / `audio_chunk` / `audio`
- `connected` / `disconnected`

## Run (text-only check)

This validates LLM + tool + streaming speech without requiring WebSocket:

pnpm demo

Expected logs include `text`, `chunk:text_delta`, tool events, and speech chunk events.

## Run (WebSocket check)

1. Start local WS server:

   pnpm ws:server

2. In another terminal, run demo:

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
