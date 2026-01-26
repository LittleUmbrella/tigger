/**
 * Investigation Command Registry
 * 
 * Registry for slash commands used in investigation workflows.
 * Similar pattern to managerRegistry but for investigation commands.
 */

export interface CommandContext {
  args: Record<string, string | number | undefined>;
  db: any; // DatabaseManager
  logglyClient?: any; // LogglyClient
  getBybitClient?: (accountName?: string) => any; // RestClientV5
  [key: string]: any; // Allow additional context
}

export interface CommandResult {
  success: boolean;
  message: string;
  data?: any;
  nextSteps?: string[];
  recommendations?: string[];
  error?: string;
}

export type CommandHandler = (context: CommandContext) => Promise<CommandResult>;

class CommandRegistry {
  private commands = new Map<string, CommandHandler>();
  private commandDescriptions = new Map<string, string>();
  private commandExamples = new Map<string, string[]>();

  register(
    name: string,
    handler: CommandHandler,
    description: string,
    examples: string[] = []
  ): void {
    this.commands.set(name, handler);
    this.commandDescriptions.set(name, description);
    this.commandExamples.set(name, examples);
  }

  get(name: string): CommandHandler | undefined {
    return this.commands.get(name);
  }

  getAll(): Map<string, CommandHandler> {
    return new Map(this.commands);
  }

  getDescription(name: string): string | undefined {
    return this.commandDescriptions.get(name);
  }

  getExamples(name: string): string[] {
    return this.commandExamples.get(name) || [];
  }

  listCommands(): Array<{ name: string; description: string; examples: string[] }> {
    return Array.from(this.commands.keys()).map(name => ({
      name,
      description: this.commandDescriptions.get(name) || '',
      examples: this.commandExamples.get(name) || []
    }));
  }
}

export const commandRegistry = new CommandRegistry();

