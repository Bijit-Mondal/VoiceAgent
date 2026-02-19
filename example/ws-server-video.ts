// ws-server-video.ts
import "dotenv/config";
import { WebSocketServer } from "ws";
import { VideoAgent } from "../src/VideoAgent";   // adjust path
import { tool } from "ai";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ── Frame saving ────────────────────────────────────────────────────────
const __dirname = typeof import.meta.dirname === "string"
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const FRAMES_DIR = join(__dirname, "frames");
mkdirSync(FRAMES_DIR, { recursive: true });
console.log(`[video-ws] Saving received frames to ${FRAMES_DIR}/`);

let frameCounter = 0;

function saveFrame(msg: {
    sequence?: number;
    timestamp?: number;
    triggerReason?: string;
    image: { data: string; format?: string; width?: number; height?: number };
}) {
    const idx = frameCounter++;
    const ext = msg.image.format === "jpeg" ? "jpg" : (msg.image.format || "webp");
    const ts = new Date(msg.timestamp ?? Date.now())
        .toISOString()
        .replace(/[:.]/g, "-");
    const filename = `frame_${String(idx).padStart(5, "0")}_${ts}.${ext}`;
    const filepath = join(FRAMES_DIR, filename);

    const buf = Buffer.from(msg.image.data, "base64");
    writeFileSync(filepath, buf);

    console.log(
        `[frames] Saved ${filename}  (${(buf.length / 1024).toFixed(1)} kB` +
        `${msg.image.width ? `, ${msg.image.width}×${msg.image.height}` : ""}` +
        `, ${msg.triggerReason ?? "unknown"})`
    );
}

const endpoint = process.env.VIDEO_WS_ENDPOINT || "ws://localhost:8081";
const url = new URL(endpoint);
const port = Number(url.port || 8081);
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
const wss = new WebSocketServer({ port, host });

wss.on("listening", () => {
    console.log(`[video-ws] listening on ${endpoint}`);
    console.log(`[video-ws] Open video-client.html and connect → ${endpoint}`);
});

wss.on("connection", (socket) => {
    console.log("[video-ws] ✓ client connected");

    const agent = new VideoAgent({
        model: openai("gpt-4o"),               // or gpt-4o-mini, claude-3.5-sonnet, gemini-1.5-flash…
        transcriptionModel: openai.transcription("whisper-1"),
        speechModel: openai.speech("gpt-4o-mini-tts"),
        instructions: `You are a helpful video+voice assistant.
You can SEE what the user is showing via webcam.
Describe what you see when it helps answer the question.
Keep spoken answers concise and natural.`,
        voice: "alloy",
        streamingSpeech: {
            minChunkSize: 25,
            maxChunkSize: 140,
            parallelGeneration: true,
            maxParallelRequests: 3,
        },
        tools: { getWeather: weatherTool, getTime: timeTool },
        // Tune these depending on your budget & latency goals
        maxContextFrames: 6,           // very important — each frame ≈ 100–400 tokens
        maxFrameInputSize: 2_500_000,  // ~2.5 MB
    });

    // Reuse most of the same event logging you have in ws-server.ts
    agent.on("text", (data: { role: string; text: string }) => {
        console.log(`[video] Text (${data.role}): ${data.text?.substring(0, 100)}...`);
    });
    agent.on("chunk:text_delta", (data: { id: string; text: string }) => {
        process.stdout.write(data.text || "");
    });
    agent.on("frame_received", ({ sequence, size, dimensions, triggerReason }) => {
        console.log(`[video] Frame #${sequence} (${triggerReason}) ${size / 1024 | 0} kB  ${dimensions.width}×${dimensions.height}`);
    });
    agent.on("frame_requested", ({ reason }) => console.log(`[video] Requested frame: ${reason}`));

    // Audio and transcription events
    agent.on("audio_received", ({ size, format }) => {
        console.log(`[video] Audio received: ${size} bytes, format: ${format}`);
    });
    agent.on("transcription", ({ text, language }) => {
        console.log(`[video] Transcription: "${text}" (${language || "unknown"})`);
    });

    // Speech events
    agent.on("speech_start", () => console.log(`[video] Speech started`));
    agent.on("speech_complete", () => console.log(`[video] Speech complete`));
    agent.on("audio_chunk", ({ chunkId, text }) => {
        console.log(`[video] Audio chunk #${chunkId}: "${text?.substring(0, 50)}..."`);
    });

    // Error handling
    agent.on("error", (error: Error) => {
        console.error(`[video] ERROR:`, error);
    });
    agent.on("warning", (warning: string) => {
        console.warn(`[video] WARNING:`, warning);
    });

    agent.on("disconnected", () => {
        agent.destroy();
        console.log("[video-ws] ✗ client disconnected (agent destroyed)");
    });

    // ── Intercept raw messages to save frames to disk ────────────────────
    socket.on("message", (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "video_frame" && msg.image?.data) {
                saveFrame(msg);
            }
        } catch {
            // not JSON — ignore, agent will handle binary etc.
        }
    });

    // The crucial line — same as VoiceAgent
    agent.handleSocket(socket);
});