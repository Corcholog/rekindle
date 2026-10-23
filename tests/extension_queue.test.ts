import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as vm from 'vm';

// F-21: the extension's offline queue was flushed by two senders (the background worker and the
// popup) that each read the queue, sent it and wrote back what was left, so a clip could be sent
// twice or overwritten. The real background.js runs here against a fake chrome API.

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function loadBackground() {
  const store: Record<string, unknown> = {};
  const posted: string[] = [];
  const listeners: Record<string, (...args: any[]) => unknown> = {};
  const event = (name: string) => ({ addListener: (fn: (...args: any[]) => unknown) => { listeners[name] = fn; } });
  const chrome = {
    // Storage is asynchronous with a delay, so reads and writes of overlapping senders interleave
    storage: { local: {
      get: async (defaults: Record<string, unknown>) => { await tick(2); return { ...defaults, ...JSON.parse(JSON.stringify(store)) }; },
      set: async (values: Record<string, unknown>) => { await tick(2); Object.assign(store, JSON.parse(JSON.stringify(values))); },
    } },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}, setTitle: async () => {} },
    alarms: { create: async () => {}, clear: async () => {}, onAlarm: event('alarm') },
    i18n: { getMessage: (key: string) => key },
    runtime: { onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message'), sendMessage: () => Promise.resolve() },
    tabs: { onActivated: event('tab') },
    contextMenus: { onClicked: event('menu'), removeAll: () => {}, create: () => {} },
  };
  const fetch = async (url: string, init?: { body?: string }) => {
    if (url.endsWith('/health')) return { ok: true, status: 200 };
    await tick(10);
    posted.push(JSON.parse(init!.body!).url);
    return { ok: true, status: 202 };
  };
  const context = vm.createContext({ chrome, fetch, AbortSignal, console: { log() {}, warn() {} }, setTimeout, crypto: globalThis.crypto });
  vm.runInContext(await fs.readFile('extension/background.js', 'utf-8'), context);
  const send = (message: unknown) => new Promise(resolve => { listeners.message(message, {}, resolve); });
  return { store, posted, send };
}

describe('extension offline queue', () => {
  it('sends each queued clip once when several flushes overlap', async () => {
    const { store, posted, send } = await loadBackground();
    store.offline_queue = ['a', 'b', 'c'].map((u, i) => ({ id: `id-${u}`, url: `https://x.org/${u}`, title: '', selection: '', timestamp: i, retries: 0 }));
    await Promise.all([send({ type: 'TRIGGER_SYNC' }), send({ type: 'TRIGGER_SYNC' }), send({ type: 'TRIGGER_SYNC' })]);
    expect(posted.sort()).toEqual(['https://x.org/a', 'https://x.org/b', 'https://x.org/c']);
    expect(store.offline_queue).toEqual([]);
  });

  it('keeps a clip queued while a flush is running, and sends it next', async () => {
    const { store, posted, send } = await loadBackground();
    store.offline_queue = [{ id: 'id-a', url: 'https://x.org/a', title: '', selection: '', timestamp: 0, retries: 0 }];
    const flush = send({ type: 'TRIGGER_SYNC' });
    await tick(5); // the flush has read the queue and is sending
    await send({ type: 'ENQUEUE_ITEM', payload: { url: 'https://x.org/nuevo', title: '', selection: '' } });
    await flush;
    await send({ type: 'TRIGGER_SYNC' });
    await tick(50);
    expect(posted.filter(u => u === 'https://x.org/a')).toHaveLength(1);
    expect(posted.filter(u => u === 'https://x.org/nuevo')).toHaveLength(1);
    expect(store.offline_queue).toEqual([]);
  });

  it('the popup asks the background worker instead of rewriting the queue', async () => {
    const popup = await fs.readFile('extension/popup.js', 'utf-8');
    expect(popup).not.toMatch(/set\(\{ \[STORAGE_QUEUE_KEY\]: remaining \}\)/);
    expect(popup).toContain("sendMessage({ type: 'ENQUEUE_ITEM', payload: item })");
    expect(popup).toContain("sendMessage({ type: 'TRIGGER_SYNC' })");
  });
});
