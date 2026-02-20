import * as tls from 'tls';
import { EventEmitter } from 'events';

export interface CTraderSocketConfig {
  host: string;
  port: number;
}

/**
 * TLS socket wrapper for cTrader OpenAPI connection
 */
export class CTraderSocket extends EventEmitter {
  private host: string;
  private port: number;
  private socket: tls.TLSSocket | null = null;

  constructor(config: CTraderSocketConfig) {
    super();
    this.host = config.host;
    this.port = config.port;
  }

  /**
   * Explicitly declare emit to satisfy TypeScript
   * Delegates to parent EventEmitter implementation via prototype
   */
  public emit(event: string | symbol, ...args: unknown[]): boolean {
    const emitFn = (EventEmitter.prototype as unknown as { emit: (event: string | symbol, ...args: unknown[]) => boolean }).emit;
    return emitFn.call(this, event, ...args);
  }

  /**
   * Explicitly declare on to satisfy TypeScript
   * Delegates to parent EventEmitter implementation via prototype
   */
  public on(eventName: string | symbol, listener: (...args: any[]) => void): this {
    const onFn = (EventEmitter.prototype as unknown as { on: (eventName: string | symbol, listener: (...args: any[]) => void) => EventEmitter }).on;
    return onFn.call(this, eventName, listener) as this;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use explicit port/host signature to avoid TypeScript overload confusion
      const socket = tls.connect(this.port, this.host, {}, () => {
        resolve();
        this.emit('open');
      });

      socket.on('data', (data: Buffer) => {
        this.emit('data', data);
      });

      socket.on('end', () => {
        this.emit('close');
      });

      socket.on('error', (error: Error) => {
        this.emit('error', error);
        reject(error);
      });

      this.socket = socket;
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  send(buffer: Buffer): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(buffer);
    }
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }
}
