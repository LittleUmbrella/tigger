import { EventEmitter } from 'events';

export interface CTraderEvent {
  type: string;
  date: Date;
  descriptor?: any;
}

export type CTraderEventListener = (event: CTraderEvent) => void | Promise<void>;

/**
 * Event emitter for cTrader events
 * Extends Node.js EventEmitter with typed event handling
 */
export class CTraderEventEmitter extends EventEmitter {
  private listenerMap = new Map<string, { type: string; listener: CTraderEventListener }>();

  constructor() {
    super();
  }

  /**
   * Explicitly declare on to satisfy TypeScript
   * Delegates to parent EventEmitter implementation via prototype
   */
  public on(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    const onFn = (EventEmitter.prototype as unknown as { on: (eventName: string | symbol, listener: (...args: unknown[]) => void) => EventEmitter }).on;
    return onFn.call(this, eventName, listener) as this;
  }

  /**
   * Explicitly declare emit to satisfy TypeScript
   * Delegates to parent EventEmitter implementation via prototype
   */
  public emit(eventName: string | symbol, ...args: unknown[]): boolean {
    const emitFn = (EventEmitter.prototype as unknown as { emit: (eventName: string | symbol, ...args: unknown[]) => boolean }).emit;
    return emitFn.call(this, eventName, ...args);
  }

  /**
   * Explicitly declare removeListener to satisfy TypeScript
   * Delegates to parent EventEmitter implementation via prototype
   */
  public removeListener(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    const removeListenerFn = (EventEmitter.prototype as unknown as { removeListener: (eventName: string | symbol, listener: (...args: unknown[]) => void) => EventEmitter }).removeListener;
    return removeListenerFn.call(this, eventName, listener) as this;
  }

  /**
   * Listen for a specific event type
   */
  onEvent(type: string, listener: CTraderEventListener): string {
    const uuid = `${Date.now()}-${Math.random()}`;
    const eventKey = `event:${type}`; // Listen on the same key that emitEvent uses
    // Cast listener to match EventEmitter's expected signature
    this.on(eventKey, listener as (...args: unknown[]) => void);
    this.listenerMap.set(uuid, { type, listener });
    return uuid;
  }

  /**
   * Remove event listener by UUID
   */
  removeEventListener(uuid: string): void {
    const listenerInfo = this.listenerMap.get(uuid);
    if (listenerInfo) {
      const eventKey = `event:${listenerInfo.type}`; // Use the same key format as onEvent
      // Cast listener to match EventEmitter's expected signature
      this.removeListener(eventKey, listenerInfo.listener as (...args: unknown[]) => void);
      this.listenerMap.delete(uuid);
    }
  }

  /**
   * Emit an event
   */
  emitEvent(type: string, descriptor?: unknown): void {
    const event: CTraderEvent = {
      type,
      date: new Date(),
      descriptor
    };
    this.emit(`event:${type}`, event);
  }
}
