import "dotenv/config";
import { WebSocketServer } from "ws";
import { VoiceAgent } from "../src";
import { tool } from "ai";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";

const endpoint = process.env.VOICE_WS_ENDPOINT || "ws://localhost:8080";
const url = new URL(endpoint);
const port = Number(url.port || 8080);
const host = url.hostname || "localhost";

// ── Tools (same as demo.ts) ────────────────────────────────────────────
const weatherTool = tool({
    description: "Get the weather in a location",
    inputSchema: z.object({
        location: z.string().describe("The location to get the weather for"),
    }),
    execute: async ({ location }) => ({
        location,
        temperature: 72 + Math.floor(Math.random() * 21) - 10,
        conditions: ["sunny", "cloudy", "rainy", "partly cloudy"][
            Math.floor(Math.random() * 4)
        ],
    }),
});

const timeTool = tool({
    description: "Get the current time",
    inputSchema: z.object({}),
    execute: async () => ({
        time: new Date().toLocaleTimeString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
});

// ── WebSocket server ───────────────────────────────────────────────────
const wss = new WebSocketServer({ port, host });

wss.on("listening", () => {
    console.log(`[ws-server] listening on ${endpoint}`);
    console.log("[ws-server] Waiting for connections...\n");
});

wss.on("connection", (socket) => {
    console.log("[ws-server] ✓ client connected");

    // Create a fresh VoiceAgent per connection
    const agent = new VoiceAgent({
        model: openai("gpt-4o"),
        transcriptionModel: openai.transcription("whisper-1"),
        speechModel: openai.speech("gpt-4o-mini-tts"),
        instructions: `You are a helpful voice assistant.
Keep responses concise and conversational since they will be spoken aloud.
Use tools when needed to provide accurate information.`,
        voice: "alloy",
        speechInstructions: "Speak in a friendly, natural conversational tone.",
        outputFormat: "opus",
        streamingSpeech: {
            minChunkSize: 40,
            maxChunkSize: 180,
            parallelGeneration: true,
            maxParallelRequests: 2,
        },
        tools: {
            getWeather: weatherTool,
            getTime: timeTool,
        },
    });

    // Wire agent events to server logs
    agent.on("text", (msg: { role: string; text: string }) => {
        const prefix = msg.role === "user" ? "👤 User" : "🤖 Assistant";
        console.log(`[ws-server] ${prefix}: ${msg.text}`);
    });

    agent.on("chunk:text_delta", ({ text }: { text: string }) => {
        process.stdout.write(text);
    });

    agent.on("chunk:tool_call", ({ toolName }: { toolName: string }) => {
        console.log(`\n[ws-server] 🛠️  Tool call: ${toolName}`);
    });

    agent.on("tool_result", ({ name, result }: { name: string; result: unknown }) => {
        console.log(`[ws-server] 🛠️  Tool result (${name}):`, JSON.stringify(result));
    });

    agent.on("speech_start", () => console.log("[ws-server] 🔊 Speech started"));
    agent.on("speech_complete", () => console.log("[ws-server] 🔊 Speech complete"));
    agent.on("speech_interrupted", ({ reason }: { reason: string }) =>
        console.log(`[ws-server] ⏸️  Speech interrupted: ${reason}`),
    );

    agent.on("audio_chunk", ({ chunkId, format, uint8Array }: { chunkId: number; format: string; uint8Array: Uint8Array }) => {
        console.log(`[ws-server] 🔊 Audio chunk #${chunkId}: ${uint8Array.length} bytes (${format})`);
    });

    agent.on("transcription", ({ text, language }: { text: string; language?: string }) => {
        console.log(`[ws-server] 📝 Transcription (${language || "unknown"}): ${text}`);
    });

    agent.on("audio_received", ({ size }: { size: number }) => {
        console.log(`[ws-server] 🎤 Audio received: ${(size / 1024).toFixed(1)} KB`);
    });

    agent.on("chunk:reasoning_delta", ({ text }: { text: string }) => {
        process.stdout.write(text);
    });

    agent.on("warning", (msg: string) => {
        console.log(`[ws-server] ⚠️  Warning: ${msg}`);
    });

    agent.on("speech_chunk_queued", ({ id, text }: { id: number; text: string }) => {
        console.log(`[ws-server] 🔊 Queued speech chunk #${id}: ${text.substring(0, 50)}...`);
    });

    agent.on("error", (err: Error) => console.error("[ws-server] ❌ Error:", err.message));

    agent.on("disconnected", () => {
        console.log("[ws-server] ✗ client disconnected\n");
    });

    // Hand the accepted socket to the agent – this is the key line.
    // The agent will listen for "transcript", "audio", "interrupt" messages
    // and send back "text_delta", "audio_chunk", "response_complete", etc.
    agent.handleSocket(socket);
});

// Graceful shutdown
process.on("SIGINT", () => {
    console.log("\n[ws-server] Shutting down...");
    wss.close(() => {
        console.log("[ws-server] Server closed");
        process.exit(0);
    });
});

export { wss };
