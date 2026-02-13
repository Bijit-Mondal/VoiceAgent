import "dotenv/config";
import { VoiceAgent } from "../src";
import { tool } from "ai";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { writeFile } from "fs/promises";

// 1. Define Tools using standard AI SDK
const weatherTool = tool({
    description: "Get the weather in a location",
    inputSchema: z.object({
        location: z.string().describe("The location to get the weather for"),
    }),
    execute: async ({ location }) => ({
        location,
        temperature: 72 + Math.floor(Math.random() * 21) - 10,
        conditions: ["sunny", "cloudy", "rainy", "partly cloudy"][Math.floor(Math.random() * 4)],
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

// 2. Initialize Agent with full voice support
const agent = new VoiceAgent({
    // Chat model for text generation
    model: openai("gpt-4o"),
    // Transcription model for speech-to-text
    transcriptionModel: openai.transcription("whisper-1"),
    // Speech model for text-to-speech
    speechModel: openai.speech("gpt-4o-mini-tts"),
    // System instructions
    instructions: `You are a helpful voice assistant. 
Keep responses concise and conversational since they will be spoken aloud.
Use tools when needed to provide accurate information.`,
    // TTS voice configuration
    voice: "alloy", // Options: alloy, echo, fable, onyx, nova, shimmer
    speechInstructions: "Speak in a friendly, natural conversational tone.",
    outputFormat: "mp3",
    // WebSocket endpoint
    endpoint: process.env.VOICE_WS_ENDPOINT,
    // Tools
    tools: {
        getWeather: weatherTool,
        getTime: timeTool,
    },
});

// 3. Handle Events

// Connection events
agent.on("connected", () => console.log("✓ Connected to WebSocket"));
agent.on("disconnected", () => console.log("✗ Disconnected from WebSocket"));

// Transcription events (when audio is converted to text)
agent.on("transcription", ({ text, language }: { text: string; language?: string }) => {
    console.log(`[Transcription] (${language || "unknown"}): ${text}`);
});

// Text events (user input and assistant responses)
agent.on("text", (msg: { role: string; text: string }) => {
    const prefix = msg.role === "user" ? "👤 User" : "🤖 Assistant";
    console.log(`${prefix}: ${msg.text}`);
});

// Streaming text delta events (real-time text chunks)
agent.on("text_delta", ({ text }: { text: string }) => {
    process.stdout.write(text);
});

// Tool events
agent.on("tool_start", ({ name, input }: { name: string; input?: unknown }) => {
    console.log(`\n[Tool] Calling ${name}...`, input ? JSON.stringify(input) : "");
});

agent.on("tool_result", ({ name, result }: { name: string; result: unknown }) => {
    console.log(`[Tool] ${name} result:`, JSON.stringify(result));
});

// Speech events
agent.on("speech_start", ({ text }: { text: string }) => {
    console.log(`[TTS] Generating speech for: "${text.substring(0, 50)}..."`);
});

agent.on("speech_complete", () => {
    console.log("[TTS] Speech generation complete");
});

// Audio events (when TTS audio is generated)
agent.on("audio", async (audio: { data: string; format: string; uint8Array: Uint8Array }) => {
    console.log(`[Audio] Received ${audio.format} audio (${audio.uint8Array.length} bytes)`);
    // Optionally save to file for testing
    await writeFile(`output.${audio.format}`, Buffer.from(audio.uint8Array));
});

// Error handling
agent.on("error", (error: Error) => {
    console.error("[Error]", error.message);
});

// 4. Main execution
(async () => {
    console.log("\n=== Voice Agent Demo ===");
    console.log("Testing text-only mode (no WebSocket required)\n");

    try {
        // Test 1: Simple text query with streaming
        console.log("--- Test 1: Weather Query ---");
        const response1 = await agent.sendText("What is the weather in Berlin?");
        console.log("\n");

        // Test 2: Multi-turn conversation
        console.log("--- Test 2: Follow-up Question ---");
        const response2 = await agent.sendText("What about Tokyo?");
        console.log("\n");

        // Test 3: Time query
        console.log("--- Test 3: Time Query ---");
        const response3 = await agent.sendText("What time is it?");
        console.log("\n");

        // Show conversation history
        console.log("--- Conversation History ---");
        const history = agent.getHistory();
        console.log(`Total messages: ${history.length}`);

        // Optional: Connect to WebSocket for real-time voice
        if (process.env.VOICE_WS_ENDPOINT) {
            console.log("\n--- Connecting to WebSocket ---");
            await agent.connect(process.env.VOICE_WS_ENDPOINT);
            console.log("Agent connected. Listening for audio input...");

            // Keep the process running to receive WebSocket messages
            // In a real app, you would stream microphone audio here
        }
    } catch (error) {
        console.error("Agent run failed:", error);
        process.exit(1);
    }
})();

// Example: How to send audio in a real application
// ---------------------------------------------
// import { readFile } from "fs/promises";
//
// // Option 1: Send base64 encoded audio
// const audioBase64 = (await readFile("recording.mp3")).toString("base64");
// await agent.sendAudio(audioBase64);
//
// // Option 2: Send raw audio buffer
// const audioBuffer = await readFile("recording.mp3");
// await agent.sendAudioBuffer(audioBuffer);
//
// // Option 3: Transcribe audio directly
// const transcribedText = await agent.transcribeAudio(audioBuffer);
// console.log("Transcribed:", transcribedText);