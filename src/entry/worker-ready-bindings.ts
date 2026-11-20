/** Keep the fast boot path without keeping obsolete Operator configuration after a binding-only deployment. */
export type WorkerReadyStamp = readonly (string | undefined)[];

type Entry<T> = { stamp: WorkerReadyStamp; value: Promise<T> };

export class WorkerReadyBindings<T> {
  private entry: Entry<T> | undefined;

  get primed(): boolean { return this.entry !== undefined; }

  setBooted(stamp: WorkerReadyStamp, value: T): void {
    this.entry = { stamp, value: Promise.resolve(value) };
  }

  clear(): void { this.entry = undefined; }

  get(stamp: WorkerReadyStamp, boot: () => Promise<T>): Promise<T> {
    const previous = this.entry;
    if (previous && previous.stamp.length === stamp.length && previous.stamp.every((v, i) => v === stamp[i])) {
      return previous.value;
    }
    const next: Entry<T> = {
      stamp,
      value: boot().catch((error: unknown) => {
        // An older asynchronous boot must never clear a newer binding snapshot.
        if (this.entry === next) this.entry = undefined;
        throw error;
      }),
    };
    this.entry = next;
    return next.value;
  }
}
