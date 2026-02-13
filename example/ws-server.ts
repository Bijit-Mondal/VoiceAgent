import "dotenv/config";
import { WebSocketServer } from "ws";

const endpoint = process.env.VOICE_WS_ENDPOINT || "ws://localhost:8080";
const url = new URL(endpoint);
const port = Number(url.port || 8080);
const host = url.hostname || "localhost";

const wss = new WebSocketServer({ port, host });

wss.on("listening", () => {
    console.log(`[ws-server] listening on ${endpoint}`);
});

wss.on("connection", (socket) => {
    console.log("[ws-server] client connected");

    // Send a sample transcript to test text pipeline end-to-end.
    setTimeout(() => {
        socket.send(
            JSON.stringify({
                type: "transcript",
                text: "What is the weather in Berlin?",
            }),
        );
    }, 500);

    socket.on("message", (data) => {
        try {
            const msg = JSON.parse(data.toString()) as {
                type?: string;
                text?: string;
            };
            console.log("[ws-server] <-", msg);
        } catch {
            console.log("[ws-server] <- raw", data.toString());
        }
    });

    socket.on("close", () => {
        console.log("[ws-server] client disconnected");
    });
});
