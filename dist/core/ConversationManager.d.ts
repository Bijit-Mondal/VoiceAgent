import { EventEmitter } from "events";
import { type ModelMessage } from "ai";
import { type HistoryConfig } from "../types";
export interface ConversationManagerOptions {
    history?: Partial<HistoryConfig>;
}
/**
 * Manages conversation history (ModelMessage[]) with configurable
 * limits on message count and total character size.
 */
export declare class ConversationManager extends EventEmitter {
    private conversationHistory;
    private historyConfig;
    constructor(options?: ConversationManagerOptions);
    /**
     * Add a message to history and trim if needed.
     */
    addMessage(message: ModelMessage): void;
    /**
     * Get a copy of the current history.
     */
    getHistory(): ModelMessage[];
    /**
     * Get a direct reference to the history array.
     * Use with caution — prefer getHistory() for safety.
     */
    getHistoryRef(): ModelMessage[];
    /**
     * Replace the entire conversation history.
     */
    setHistory(history: ModelMessage[]): void;
    /**
     * Clear all conversation history.
     */
    clearHistory(): void;
    /**
     * Get the number of messages in history.
     */
    get length(): number;
    /**
     * Trim conversation history to stay within configured limits.
     * Removes oldest messages (always in pairs to preserve user/assistant turns).
     */
    private trimHistory;
}
//# sourceMappingURL=ConversationManager.d.ts.map