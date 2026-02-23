/**
 * A generic serial input queue that ensures only one processor runs at a time.
 *
 * @template T  The shape of each queued item (must include resolve/reject)
 */
export interface QueueItem<T = string> {
    resolve: (v: T) => void;
    reject: (e: unknown) => void;
}
export declare class InputQueue<T extends QueueItem<any>> {
    private queue;
    private processing;
    /** Callback invoked for each item — must return a resolved value */
    processor: (item: T) => Promise<any>;
    /**
     * Enqueue an item for serial processing.
     */
    enqueue(item: T): void;
    /**
     * Reject all pending items (used on disconnect/destroy).
     */
    rejectAll(reason: Error): void;
    /**
     * Number of items waiting in the queue.
     */
    get length(): number;
    /**
     * Whether the queue is currently processing an item.
     */
    get isProcessing(): boolean;
    private drain;
}
//# sourceMappingURL=InputQueue.d.ts.map