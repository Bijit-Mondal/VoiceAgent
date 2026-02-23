"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InputQueue = void 0;
class InputQueue {
    queue = [];
    processing = false;
    /** Callback invoked for each item — must return a resolved value */
    processor = async () => "";
    /**
     * Enqueue an item for serial processing.
     */
    enqueue(item) {
        this.queue.push(item);
        this.drain();
    }
    /**
     * Reject all pending items (used on disconnect/destroy).
     */
    rejectAll(reason) {
        for (const item of this.queue) {
            item.reject(reason);
        }
        this.queue = [];
        this.processing = false;
    }
    /**
     * Number of items waiting in the queue.
     */
    get length() {
        return this.queue.length;
    }
    /**
     * Whether the queue is currently processing an item.
     */
    get isProcessing() {
        return this.processing;
    }
    // ── Private ──────────────────────────────────────────
    async drain() {
        if (this.processing)
            return;
        this.processing = true;
        try {
            while (this.queue.length > 0) {
                const item = this.queue.shift();
                try {
                    const result = await this.processor(item);
                    item.resolve(result);
                }
                catch (error) {
                    item.reject(error);
                }
            }
        }
        finally {
            this.processing = false;
        }
    }
}
exports.InputQueue = InputQueue;
//# sourceMappingURL=InputQueue.js.map