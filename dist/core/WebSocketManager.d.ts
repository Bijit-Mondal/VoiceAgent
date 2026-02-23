import { WebSocket } from "ws";
import { EventEmitter } from "events";
/**
 * Manages a single WebSocket connection lifecycle.
 * Handles connecting, attaching existing sockets, sending messages,
 * and clean disconnection.
 */
export declare class WebSocketManager extends EventEmitter {
    private socket?;
    private _isConnected;
    get isConnected(): boolean;
    get currentSocket(): WebSocket | undefined;
    /**
     * Connect to a WebSocket server by URL.
     */
    connect(url: string): Promise<void>;
    /**
     * Attach an existing WebSocket (server-side usage).
     */
    handleSocket(socket: WebSocket): void;
    /**
     * Send a JSON message via WebSocket if connected.
     * Gracefully handles send failures (e.g., socket closing mid-send).
     */
    send(message: Record<string, unknown>): void;
    /**
     * Disconnect and clean up the current socket.
     */
    disconnect(): void;
    /**
     * Attach internal event listeners on the current socket.
     */
    private attachListeners;
}
//# sourceMappingURL=WebSocketManager.d.ts.map