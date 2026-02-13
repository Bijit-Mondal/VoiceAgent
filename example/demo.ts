import "dotenv/config";
import { VoiceAgent } from "../src";
import { tool } from "ai";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";

// 1. Define Tools using standard AI SDK
const weatherTool = tool({
    description: 'Get the weather in a location',
    inputSchema: z.object({
        location: z.string().describe('The location to get the weather for'),
    }),
    execute: async ({ location }) => ({
        location,
        temperature: 72 + Math.floor(Math.random() * 21) - 10,
    }),
});

// 2. Initialize Agent
const agent = new VoiceAgent({
    model: openai('gpt-4o'),
    instructions: "You are a helpful voice assistant. Use tools when needed.",
    endpoint: process.env.VOICE_WS_ENDPOINT,
    tools: {
        getWeather: weatherTool, // Pass the AI SDK tool directly
    },
});

// 3. Handle Events
agent.on("connected", () => console.log("Connected to WebSocket"));

// Handle incoming audio from AI (play this to user)
agent.on("audio", (base64Audio: string) => {
    // process.stdout.write(Buffer.from(base64Audio, 'base64')); 
});

// Logs
agent.on("text", (msg: { role: string; text: string }) => console.log(`${msg.role}: ${msg.text}`));
agent.on("tool_start", ({ name }: { name: string }) => console.log(`[System] Calling ${name}...`));

// 4. Start (wrap in async function since we can't use top-level await)
(async () => {
    try {
        // For now: text-only sanity check, no voice pipeline required.
        await agent.sendText("What is the weather in Berlin?");

        // Optional: connect only when an endpoint is provided.
        if (process.env.VOICE_WS_ENDPOINT) {
            await agent.connect(process.env.VOICE_WS_ENDPOINT);
            console.log("Agent connected successfully");
        }
    } catch (error) {
        console.error("Agent run failed:", error);
    }
})();

// 5. Simulate sending audio (in a real app, stream microphone data here)
// agent.sendAudio("Base64EncodedPCM16AudioData...");