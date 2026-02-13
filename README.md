# voice-agent-ai-sdk

Minimal voice/text agent SDK built on AI SDK with optional WebSocket transport.

## Current status

- Text flow works via `sendText()` (no WebSocket required).
- WebSocket flow works when `connect()` is used with a running WS endpoint.
- Voice streaming is not implemented yet.

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

## Run (text-only check)

This validates model + tool calls without requiring WebSocket:

pnpm demo

Expected logs include `text` events and optional `tool_start`.

## Run (WebSocket check)

1. Start local WS server:

   pnpm ws:server

2. In another terminal, run demo:

   pnpm demo

The demo will:
- run `sendText()` first (text-only sanity check), then
- connect to `VOICE_WS_ENDPOINT` if provided.

## Scripts

- `pnpm build` – build TypeScript
- `pnpm dev` – watch TypeScript
- `pnpm demo` – run demo client
- `pnpm ws:server` – run local test WebSocket server

## Notes

- If `VOICE_WS_ENDPOINT` is empty, WebSocket connect is skipped.
- The sample WS server sends a mock `transcript` message for end-to-end testing.
