"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebSocketManager = void 0;
const ws_1 = require("ws");
const events_1 = require("events");
/**
 * Manages a single WebSocket connection lifecycle.
 * Handles connecting, attaching existing sockets, sending messages,
 * and clean disconnection.
 */
class WebSocketManager extends events_1.EventEmitter {
    socket;
    _isConnected = false;
    get isConnected() {
        return this._isConnected;
    }
    get currentSocket() {
        return this.socket;
    }
    /**
     * Connect to a WebSocket server by URL.
     */
    connect(url) {
        // Clean up any existing connection first
        if (this.socket) {
            this.disconnect();
        }
        return new Promise((resolve, reject) => {
            try {
                this.socket = new ws_1.WebSocket(url);
                this.attachListeners();
                this.socket.once("open", () => {
                    this._isConnected = true;
                    this.emit("connected");
                    resolve();
                });
                this.socket.once("error", (error) => {
                    reject(error);
                });
            }
            catch (error) {
                reject(error);
            }
        });
    }
    /**
     * Attach an existing WebSocket (server-side usage).
     */
    handleSocket(socket) {
        // Clean up any existing connection first
        if (this.socket) {
            this.disconnect();
        }
        this.socket = socket;
        this._isConnected = true;
        this.attachListeners();
        this.emit("connected");
    }
    /**
     * Send a JSON message via WebSocket if connected.
     * Gracefully handles send failures (e.g., socket closing mid-send).
     */
    send(message) {
        if (!this.socket || !this._isConnected)
            return;
        try {
            if (this.socket.readyState === ws_1.WebSocket.OPEN) {
                this.socket.send(JSON.stringify(message));
            }
            else {
                console.warn(`Cannot send message, socket state: ${this.socket.readyState}`);
            }
        }
        catch (error) {
            // Socket may have closed between the readyState check and send()
            console.error("Failed to send WebSocket message:", error);
            this.emit("error", error);
        }
    }
    /**
     * Disconnect and clean up the current socket.
     */
    disconnect() {
        if (!this.socket)
            return;
        try {
            this.socket.removeAllListeners();
            if (this.socket.readyState === ws_1.WebSocket.OPEN ||
                this.socket.readyState === ws_1.WebSocket.CONNECTING) {
                this.socket.close();
            }
        }
        catch {
            // Ignore close errors — socket may already be dead
        }
        this.socket = undefined;
        this._isConnected = false;
    }
    /**
     * Attach internal event listeners on the current socket.
     */
    attachListeners() {
        if (!this.socket)
            return;
        this.socket.on("message", (data) => {
            try {
                const message = JSON.parse(data.toString());
                this.emit("message", message);
            }
            catch (err) {
                console.error("Failed to parse WebSocket message:", err);
                this.emit("error", err);
            }
        });
        this.socket.on("close", () => {
            this._isConnected = false;
            this.emit("disconnected");
        });
        this.socket.on("error", (error) => {
            console.error("WebSocket error:", error);
            this.emit("error", error);
        });
    }
}
exports.WebSocketManager = WebSocketManager;
//# sourceMappingURL=WebSocketManager.js.map