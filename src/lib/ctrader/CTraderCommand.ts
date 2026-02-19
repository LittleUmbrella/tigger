/**
 * Represents a pending command waiting for a response
 */
export class CTraderCommand {
  private clientMsgId: string;
  private resolveFn?: (response: any) => void;
  private rejectFn?: (response: any) => void;
  private responsePromise: Promise<any>;

  constructor(clientMsgId: string) {
    this.clientMsgId = clientMsgId;
    this.responsePromise = new Promise((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
  }

  get id(): string {
    return this.clientMsgId;
  }

  get promise(): Promise<any> {
    return this.responsePromise;
  }

  resolve(response: any): void {
    this.resolveFn?.(response);
  }

  reject(response: any): void {
    this.rejectFn?.(response);
  }
}
