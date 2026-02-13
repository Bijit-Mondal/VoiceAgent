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

## VoiceAgent configuration

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
