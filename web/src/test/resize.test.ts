import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestResizeObserver, notifyResizeObservers, resetResizeObservers } from './resize';

const rect = { x: 0, y: 0, top: 0, left: 0, width: 320, height: 100, right: 320, bottom: 100, toJSON: () => ({}) };
const target = { getBoundingClientRect: () => rect } as unknown as Element;

beforeEach(resetResizeObservers);

describe('controlled resize notifications', () => {
  it('reports only observed targets using the geometry supplied by the test', () => {
    const callback = vi.fn();
    const observer = new TestResizeObserver(callback);
    notifyResizeObservers();
    expect(callback).not.toHaveBeenCalled();
    observer.observe(target);
    expect(callback).not.toHaveBeenCalled();
    notifyResizeObservers();
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0][0]).toEqual([{
      target, contentRect: rect,
      borderBoxSize: [{ blockSize: 100, inlineSize: 320 }],
      contentBoxSize: [{ blockSize: 100, inlineSize: 320 }],
      devicePixelContentBoxSize: [{ blockSize: 100, inlineSize: 320 }],
    }]);
    expect(callback.mock.calls[0][1]).toBe(observer);
  });

  it('stops on unobserve/disconnect and can observe again without leaking between tests', () => {
    const callback = vi.fn();
    const observer = new TestResizeObserver(callback);
    observer.observe(target);
    observer.unobserve(target);
    notifyResizeObservers();
    observer.observe(target);
    observer.disconnect();
    notifyResizeObservers();
    expect(callback).not.toHaveBeenCalled();
    observer.observe(target);
    notifyResizeObservers();
    expect(callback).toHaveBeenCalledOnce();
    resetResizeObservers();
    notifyResizeObservers();
    expect(callback).toHaveBeenCalledOnce();
  });
});
