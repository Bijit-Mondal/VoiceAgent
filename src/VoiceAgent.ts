import { WebSocket } from "ws";
import { EventEmitter } from "events";
import { generateText, LanguageModel, stepCountIs, type Tool } from "ai";

export interface VoiceAgentOptions {
  model: LanguageModel; /// AI SDK Model (e.g., openai('gpt-4o'))
  instructions?: string;
  stopWhen?: NonNullable<Parameters<typeof generateText>[0]["stopWhen"]>;
  tools?: Record<string, Tool>;
  endpoint?: string;
}

export class VoiceAgent extends EventEmitter {
  private socket?: WebSocket;
  private tools: Record<string, Tool> = {};
  private model: LanguageModel;
  private instructions: string;
  private stopWhen: NonNullable<Parameters<typeof generateText>[0]["stopWhen"]>;
  private endpoint?: string;
  private isConnected = false;

  constructor(options: VoiceAgentOptions) {
    super();
    this.model = options.model;
    this.instructions =
      options.instructions || "You are a helpful voice assistant.";
    this.stopWhen = options.stopWhen || stepCountIs(5);
    this.endpoint = options.endpoint;
    if (options.tools) {
      this.tools = { ...options.tools };
    }
  }

  private setupListeners() {
    if (!this.socket) return;

    this.socket.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());

        // Example: Handle transcribed text from the client/STT
        if (message.type === "transcript") {
          await this.processUserInput(message.text);
        }
        // Handle audio data
        if (message.type === "audio") {
          this.emit("audio", message.data);
        }
      } catch (err) {
        console.error("Failed to process message:", err);
      }
    });

    this.socket.on("close", () => {
      console.log("Disconnected");
      this.isConnected = false;
      this.emit("disconnected");
    });
  }

  public registerTools(tools: Record<string, Tool>) {
    this.tools = { ...this.tools, ...tools };
  }

  public async connect(url?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Use provided URL, configured endpoint, or default URL
        const wsUrl = url || this.endpoint || "ws://localhost:8080";
        this.socket = new WebSocket(wsUrl);
        this.setupListeners();

        this.socket.once("open", () => {
          this.isConnected = true;
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

  public async sendText(text: string): Promise<void> {
    await this.processUserInput(text);
  }

  public sendAudio(audioData: string): void {
    if (this.socket && this.isConnected) {
      this.socket.send(JSON.stringify({
        type: "audio",
        data: audioData
      }));
    }
  }

  private async processUserInput(text: string) {
    // Emit text event for incoming user input
    this.emit("text", { role: "user", text });

    const result = await generateText({
      model: this.model,
      system: this.instructions,
      prompt: text,
      tools: this.tools,
      stopWhen: this.stopWhen,
    });

    for (const toolCall of result.toolCalls ?? []) {
      this.emit("tool_start", { name: toolCall.toolName });
    }

    // Emit text event for assistant response
    this.emit("text", { role: "assistant", text: result.text });

    // Send the response back (either text to be TTSed or tool results)
    if (this.socket && this.isConnected) {
      this.socket.send(
        JSON.stringify({
          type: "response",
          text: result.text,
          toolCalls: result.toolCalls,
          toolResults: result.toolResults,
        }),
      );
    }
  }

  startListening() {
    console.log("Starting voice agent...");
  }
}
