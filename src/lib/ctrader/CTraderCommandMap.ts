import { CTraderCommand } from './CTraderCommand.js';

/**
 * Maps client message IDs to pending commands
 */
export class CTraderCommandMap {
  private commands: Map<string, CTraderCommand> = new Map();
  private sendFn: (message: Buffer) => void;

  constructor(sendFn: (message: Buffer) => void) {
    this.sendFn = sendFn;
  }

  /**
   * Create a new command and send the message
   */
  create(clientMsgId: string, message: Buffer): Promise<any> {
    const command = new CTraderCommand(clientMsgId);
    this.commands.set(clientMsgId, command);
    this.sendFn(message);
    return command.promise;
  }

  /**
   * Extract and remove a command by ID
   */
  extractById(clientMsgId: string): CTraderCommand | undefined {
    const command = this.commands.get(clientMsgId);
    if (command) {
      this.commands.delete(clientMsgId);
    }
    return command;
  }

  /**
   * Get all pending commands
   */
  getPendingCommands(): CTraderCommand[] {
    return Array.from(this.commands.values());
  }

  /**
   * Check if a command exists
   */
  hasCommand(clientMsgId: string): boolean {
    return this.commands.has(clientMsgId);
  }
}
