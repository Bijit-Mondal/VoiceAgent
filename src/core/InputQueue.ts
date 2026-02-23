/**
 * A generic serial input queue that ensures only one processor runs at a time.
 *
 * @template T  The shape of each queued item (must include resolve/reject)
 */
export interface QueueItem<T = string> {
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export class InputQueue<T extends QueueItem<any>> {
  private queue: T[] = [];
  private processing = false;

  /** Callback invoked for each item — must return a resolved value */
  public processor: (item: T) => Promise<any> = async () => "";

  /**
   * Enqueue an item for serial processing.
   */
  enqueue(item: T): void {
    this.queue.push(item);
    this.drain();
  }

  /**
   * Reject all pending items (used on disconnect/destroy).
   */
  rejectAll(reason: Error): void {
    for (const item of this.queue) {
      item.reject(reason);
    }
    this.queue = [];
    this.processing = false;
  }

  /**
   * Number of items waiting in the queue.
   */
  get length(): number {
    return this.queue.length;
  }

  /**
   * Whether the queue is currently processing an item.
   */
  get isProcessing(): boolean {
    return this.processing;
  }

  // ── Private ──────────────────────────────────────────

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          const result = await this.processor(item);
          item.resolve(result);
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
