import "dotenv/config";
import { WebSocketServer, WebSocket } from "ws";
import { readFile } from "fs/promises";
import { existsSync } from "fs";

const endpoint = process.env.VOICE_WS_ENDPOINT || "ws://localhost:8080";
const url = new URL(endpoint);
const port = Number(url.port || 8080);
const host = url.hostname || "localhost";

// Message types for type safety
interface BaseMessage {
    type: string;
}

interface TextDeltaMessage extends BaseMessage {
    type: "text_delta";
    text: string;
}

interface ToolCallMessage extends BaseMessage {
    type: "tool_call";
    toolName: string;
    toolCallId: string;
    input: unknown;
}

interface ToolResultMessage extends BaseMessage {
    type: "tool_result";
    toolName: string;
    toolCallId: string;
    result: unknown;
}

interface AudioMessage extends BaseMessage {
    type: "audio";
    data: string; // base64 encoded
    format: string;
}

interface ResponseCompleteMessage extends BaseMessage {
    type: "response_complete";
    text: string;
    toolCalls: Array<{ toolName: string; toolCallId: string; input: unknown }>;
    toolResults: Array<{ toolName: string; toolCallId: string; output: unknown }>;
}

type AgentMessage =
    | TextDeltaMessage
    | ToolCallMessage
    | ToolResultMessage
    | AudioMessage
    | ResponseCompleteMessage;

const wss = new WebSocketServer({ port, host });

wss.on("listening", () => {
    console.log(`[ws-server] 🚀 listening on ${endpoint}`);
    console.log("[ws-server] Waiting for connections...\n");
});

wss.on("connection", (socket: WebSocket) => {
    console.log("[ws-server] ✓ client connected");

    let streamingText = "";
    let audioChunks: Buffer[] = [];

    // Send a sample transcript to test text pipeline end-to-end.
    setTimeout(() => {
        console.log("[ws-server] -> Sending test transcript...");
        socket.send(
            JSON.stringify({
                type: "transcript",
                text: "What is the weather in Berlin?",
            }),
        );
    }, 500);

    socket.on("message", async (data) => {
        try {
            const msg = JSON.parse(data.toString()) as AgentMessage;

            switch (msg.type) {
                case "text_delta":
                    // Real-time streaming text from the agent
                    streamingText += msg.text;
                    process.stdout.write(msg.text);
                    break;

                case "tool_call":
                    console.log(`\n[ws-server] 🛠️ Tool call: ${msg.toolName}`);
                    console.log(`           Input: ${JSON.stringify(msg.input)}`);
                    break;

                case "tool_result":
                    console.log(`[ws-server] 🛠️ Tool result: ${msg.toolName}`);
                    console.log(`           Result: ${JSON.stringify(msg.result)}`);
                    break;

                case "audio":
                    // Handle audio response from TTS
                    const audioBuffer = Buffer.from(msg.data, "base64");
                    audioChunks.push(audioBuffer);
                    console.log(
                        `[ws-server] 🔊 Received audio: ${audioBuffer.length} bytes (${msg.format})`,
                    );

                    // Optionally save audio to file for testing
                    // await writeFile(`output_${Date.now()}.${msg.format}`, audioBuffer);
                    break;

                case "response_complete":
                    console.log("\n[ws-server] ✅ Response complete");
                    console.log(`           Text length: ${msg.text.length}`);
                    console.log(`           Tool calls: ${msg.toolCalls.length}`);
                    console.log(`           Tool results: ${msg.toolResults.length}`);

                    // Reset for next response
                    streamingText = "";
                    audioChunks = [];
                    break;

                default:
                    console.log("[ws-server] <- Unknown message:", msg);
            }
        } catch {
            console.log("[ws-server] <- raw", data.toString().substring(0, 100));
        }
    });

    socket.on("close", () => {
        console.log("[ws-server] ✗ client disconnected\n");
    });

    socket.on("error", (error) => {
        console.error("[ws-server] Error:", error.message);
    });
});

// Graceful shutdown
process.on("SIGINT", () => {
    console.log("\n[ws-server] Shutting down...");
    wss.close(() => {
        console.log("[ws-server] Server closed");
        process.exit(0);
    });
});

// Helper function to simulate sending audio to the agent
async function simulateAudioInput(socket: WebSocket, audioPath: string) {
    if (!existsSync(audioPath)) {
        console.log(`[ws-server] Audio file not found: ${audioPath}`);
        return;
    }

    const audioBuffer = await readFile(audioPath);
    const base64Audio = audioBuffer.toString("base64");

    console.log(`[ws-server] -> Sending audio: ${audioPath} (${audioBuffer.length} bytes)`);
    socket.send(
        JSON.stringify({
            type: "audio",
            data: base64Audio,
        }),
    );
}

// Export for use as a module
export { wss, simulateAudioInput };
