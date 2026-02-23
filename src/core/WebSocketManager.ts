import { WebSocket } from "ws";
import { EventEmitter } from "events";

/**
 * Manages a single WebSocket connection lifecycle.
 * Handles connecting, attaching existing sockets, sending messages,
 * and clean disconnection.
 */
export class WebSocketManager extends EventEmitter {
  private socket?: WebSocket;
  private _isConnected = false;

  get isConnected(): boolean {
    return this._isConnected;
  }

  get currentSocket(): WebSocket | undefined {
    return this.socket;
  }

  /**
   * Connect to a WebSocket server by URL.
   */
  connect(url: string): Promise<void> {
    // Clean up any existing connection first
    if (this.socket) {
      this.disconnect();
    }

    return new Promise((resolve, reject) => {
      try {
        this.socket = new WebSocket(url);
        this.attachListeners();

        this.socket.once("open", () => {
          this._isConnected = true;
          this.emit("connected");
          resolve();
        });

        this.socket.once("error", (error) => {
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Attach an existing WebSocket (server-side usage).
   */
  handleSocket(socket: WebSocket): void {
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
  send(message: Record<string, unknown>): void {
    if (!this.socket || !this._isConnected) return;

    try {
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(message));
      } else {
        console.warn(`Cannot send message, socket state: ${this.socket.readyState}`);
      }
    } catch (error) {
      // Socket may have closed between the readyState check and send()
      console.error("Failed to send WebSocket message:", error);
      this.emit("error", error);
    }
  }

  /**
   * Disconnect and clean up the current socket.
   */
  disconnect(): void {
    if (!this.socket) return;

    try {
      this.socket.removeAllListeners();
      if (
        this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING
      ) {
        this.socket.close();
      }
    } catch {
      // Ignore close errors — socket may already be dead
    }

    this.socket = undefined;
    this._isConnected = false;
  }

  /**
   * Attach internal event listeners on the current socket.
   */
  private attachListeners(): void {
    if (!this.socket) return;

    this.socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.emit("message", message);
      } catch (err) {
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
