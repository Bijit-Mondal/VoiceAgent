import { EventEmitter } from "events";
import { type ModelMessage } from "ai";
import { type HistoryConfig, DEFAULT_HISTORY_CONFIG } from "../types";

export interface ConversationManagerOptions {
  history?: Partial<HistoryConfig>;
}

/**
 * Manages conversation history (ModelMessage[]) with configurable
 * limits on message count and total character size.
 */
export class ConversationManager extends EventEmitter {
  private conversationHistory: ModelMessage[] = [];
  private historyConfig: HistoryConfig;

  constructor(options: ConversationManagerOptions = {}) {
    super();
    this.historyConfig = {
      ...DEFAULT_HISTORY_CONFIG,
      ...options.history,
    };
  }

  /**
   * Add a message to history and trim if needed.
   */
  addMessage(message: ModelMessage): void {
    this.conversationHistory.push(message);
    this.trimHistory();
  }

  /**
   * Get a copy of the current history.
   */
  getHistory(): ModelMessage[] {
    return [...this.conversationHistory];
  }

  /**
   * Get a direct reference to the history array.
   * Use with caution — prefer getHistory() for safety.
   */
  getHistoryRef(): ModelMessage[] {
    return this.conversationHistory;
  }

  /**
   * Replace the entire conversation history.
   */
  setHistory(history: ModelMessage[]): void {
    this.conversationHistory = [...history];
  }

  /**
   * Clear all conversation history.
   */
  clearHistory(): void {
    this.conversationHistory = [];
    this.emit("history_cleared");
  }

  /**
   * Get the number of messages in history.
   */
  get length(): number {
    return this.conversationHistory.length;
  }

  /**
   * Trim conversation history to stay within configured limits.
   * Removes oldest messages (always in pairs to preserve user/assistant turns).
   */
  private trimHistory(): void {
    const { maxMessages, maxTotalChars } = this.historyConfig;

    // Trim by message count
    if (maxMessages > 0 && this.conversationHistory.length > maxMessages) {
      const excess = this.conversationHistory.length - maxMessages;
      // Round up to even number to preserve turn pairs
      const toRemove = excess % 2 === 0 ? excess : excess + 1;
      this.conversationHistory.splice(0, toRemove);
      this.emit("history_trimmed", {
        removedCount: toRemove,
        reason: "max_messages",
      });
    }

    // Trim by total character count
    if (maxTotalChars > 0) {
      let totalChars = this.conversationHistory.reduce((sum, msg) => {
        const content =
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content);
        return sum + content.length;
      }, 0);

      let removedCount = 0;
      while (
        totalChars > maxTotalChars &&
        this.conversationHistory.length > 2
      ) {
        const removed = this.conversationHistory.shift();
        if (removed) {
          const content =
            typeof removed.content === "string"
              ? removed.content
              : JSON.stringify(removed.content);
          totalChars -= content.length;
          removedCount++;
        }
      }
      if (removedCount > 0) {
        this.emit("history_trimmed", {
          removedCount,
          reason: "max_total_chars",
        });
      }
    }
  }
}
