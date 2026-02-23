"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationManager = void 0;
const events_1 = require("events");
const types_1 = require("../types");
/**
 * Manages conversation history (ModelMessage[]) with configurable
 * limits on message count and total character size.
 */
class ConversationManager extends events_1.EventEmitter {
    conversationHistory = [];
    historyConfig;
    constructor(options = {}) {
        super();
        this.historyConfig = {
            ...types_1.DEFAULT_HISTORY_CONFIG,
            ...options.history,
        };
    }
    /**
     * Add a message to history and trim if needed.
     */
    addMessage(message) {
        this.conversationHistory.push(message);
        this.trimHistory();
    }
    /**
     * Get a copy of the current history.
     */
    getHistory() {
        return [...this.conversationHistory];
    }
    /**
     * Get a direct reference to the history array.
     * Use with caution — prefer getHistory() for safety.
     */
    getHistoryRef() {
        return this.conversationHistory;
    }
    /**
     * Replace the entire conversation history.
     */
    setHistory(history) {
        this.conversationHistory = [...history];
    }
    /**
     * Clear all conversation history.
     */
    clearHistory() {
        this.conversationHistory = [];
        this.emit("history_cleared");
    }
    /**
     * Get the number of messages in history.
     */
    get length() {
        return this.conversationHistory.length;
    }
    /**
     * Trim conversation history to stay within configured limits.
     * Removes oldest messages (always in pairs to preserve user/assistant turns).
     */
    trimHistory() {
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
                const content = typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content);
                return sum + content.length;
            }, 0);
            let removedCount = 0;
            while (totalChars > maxTotalChars &&
                this.conversationHistory.length > 2) {
                const removed = this.conversationHistory.shift();
                if (removed) {
                    const content = typeof removed.content === "string"
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
exports.ConversationManager = ConversationManager;
//# sourceMappingURL=ConversationManager.js.map