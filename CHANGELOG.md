# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2025-07-15

### Added

- **Conversation history limits** — new `history` option with `maxMessages` (default 100)
  and `maxTotalChars` (default unlimited) to prevent unbounded memory growth.
  Oldest messages are trimmed in pairs to preserve user/assistant turn structure.
  Emits `history_trimmed` event when messages are evicted.
- **Audio input size validation** — new `maxAudioInputSize` option (default 10 MB).
  Oversized or empty audio payloads are rejected early with an `error` / `warning` event
  instead of being forwarded to the transcription model.
- **Serial input queue** — `sendText()`, WebSocket `transcript` messages, and
  transcribed audio are now queued and processed one at a time. This prevents
  race conditions where concurrent calls could corrupt `conversationHistory` or
  interleave streaming output.
- **LLM stream cancellation** — an `AbortController` is now threaded into
  `streamText()` via `abortSignal`. Barge-in, disconnect, and explicit
  interrupts abort the LLM stream immediately (saving tokens) instead of only
  cancelling TTS.
- **`interruptCurrentResponse(reason)`** — new public method that aborts both
  the LLM stream *and* ongoing speech in a single call. WebSocket barge-in
  (`transcript` / `audio` / `interrupt` messages) now uses this instead of
  `interruptSpeech()` alone.
- **`destroy()`** — permanently tears down the agent, releasing the socket,
  clearing history and tools, and removing all event listeners.
  A `destroyed` getter is also exposed. Any subsequent method call throws.
- **`history_trimmed` event** — emitted with `{ removedCount, reason }` when
  the sliding-window trims old messages.
- **Input validation** — `sendText("")` now throws, and incoming WebSocket
  `transcript` / `audio` messages are validated before processing.

### Changed

- **`disconnect()` is now a full cleanup** — aborts in-flight LLM and TTS
  streams, clears the speech queue, rejects pending queued inputs, and removes
  socket listeners before closing. Previously it only called `socket.close()`.
- **`connect()` and `handleSocket()` are idempotent** — calling either when a
  socket is already attached will cleanly tear down the old connection first
  instead of leaking it.
- **`sendWebSocketMessage()` is resilient** — checks `socket.readyState` and
  wraps `send()` in a try/catch so a socket that closes mid-send does not throw
  an unhandled exception.
- **Speech queue completion uses a promise** — `processUserInput` now awaits a
  `speechQueueDonePromise` instead of busy-wait polling
  (`while (queue.length) { await sleep(100) }`), reducing CPU waste and
  eliminating a race window.
- **`interruptSpeech()` resolves the speech-done promise** — so
  `processUserInput` can proceed immediately after a barge-in instead of
  potentially hanging.
- **WebSocket message handler uses `if/else if`** — prevents a single message
  from accidentally matching multiple type branches.
- **Chunk ID wraps at `Number.MAX_SAFE_INTEGER`** — avoids unbounded counter
  growth in very long-running sessions.
- **`processUserInput` catch block cleans up speech state** — on stream error
  the pending text buffer is cleared and any in-progress speech is interrupted,
  so the agent does not get stuck in a broken state.
- **WebSocket close handler calls `cleanupOnDisconnect()`** — aborts LLM + TTS,
  clears queues, and rejects pending input promises.

### Fixed

- Typo in JSDoc: `"Process text deltra"` → `"Process text delta"`.

## [0.0.1] - 2025-07-14

### Added

- Initial release.
- Streaming text generation via AI SDK `streamText`.
- Multi-step tool calling with `stopWhen`.
- Chunked streaming TTS with parallel generation and barge-in support.
- Audio transcription via AI SDK `experimental_transcribe`.
- WebSocket transport with full stream/tool/speech lifecycle events.
- Browser voice client example (`example/voice-client.html`).
