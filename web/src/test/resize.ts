const observers = new Set<TestResizeObserver>();

export class TestResizeObserver implements ResizeObserver {
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    this.targets.add(target);
    observers.add(this);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
    if (!this.targets.size) observers.delete(this);
  }

  disconnect(): void {
    this.targets.clear();
    observers.delete(this);
  }

  notify(): void {
    if (!this.targets.size) return;
    const entries = Array.from(this.targets, (target): ResizeObserverEntry => {
      const contentRect = target.getBoundingClientRect();
      const size = { blockSize: contentRect.height, inlineSize: contentRect.width };
      return { target, contentRect, borderBoxSize: [size], contentBoxSize: [size], devicePixelContentBoxSize: [size] };
    });
    this.callback(entries, this);
  }
}

export function notifyResizeObservers(): void {
  for (const observer of [...observers]) observer.notify();
}

export function resetResizeObservers(): void {
  for (const observer of [...observers]) observer.disconnect();
}
