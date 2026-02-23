/**
 * Workflow Engine
 * 
 * Executes structured workflows for investigations.
 * Provides step-by-step execution with progress tracking.
 */

import { DatabaseManager } from '../db/schema.js';
import { LogglyApiClient, createLogglyApiClient, getLogglyConfigStatus } from '../utils/logglyApiClient.js';
import { RestClientV5 } from 'bybit-api';
import { CTraderClient, CTraderClientConfig } from '../clients/ctraderClient.js';
import { logger } from '../utils/logger.js';
import { traceMessage } from '../scripts/trace_message.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

export interface WorkflowStep {
  id: string;
  name: string;
  execute: (context: WorkflowContext) => Promise<WorkflowStepResult>;
  required?: boolean;
}

export interface WorkflowStepResult {
  success: boolean;
  message: string;
  data?: any;
  error?: string;
  skipRemaining?: boolean; // If true, skip remaining steps
}

export interface WorkflowContext {
  db: DatabaseManager;
  logglyClient?: LogglyApiClient;
  logglyConfigStatus?: import('../utils/logglyApiClient.js').LogglyConfigStatus;
  getBybitClient?: (accountName?: string) => Promise<RestClientV5 | undefined>;
  getCTraderClient?: (accountName?: string) => Promise<CTraderClient | undefined>;
  args: Record<string, any>;
  stepResults: Map<string, WorkflowStepResult>;
  [key: string]: any;
}

export interface WorkflowResult {
  success: boolean;
  steps: Array<{
    step: WorkflowStep;
    result: WorkflowStepResult;
    timestamp: string;
  }>;
  summary: {
    totalSteps: number;
    completedSteps: number;
    failedSteps: number;
    skippedSteps: number;
  };
  findings?: any;
  recommendations?: string[];
  nextSteps?: string[];
}

export class WorkflowEngine {
  private steps: WorkflowStep[] = [];
  private context: WorkflowContext;

  constructor(context: WorkflowContext) {
    this.context = context;
  }

  addStep(step: WorkflowStep): void {
    this.steps.push(step);
  }

  async execute(): Promise<WorkflowResult> {
    const stepResults: Array<{
      step: WorkflowStep;
      result: WorkflowStepResult;
      timestamp: string;
    }> = [];

    let shouldSkipRemaining = false;

    for (const step of this.steps) {
      if (shouldSkipRemaining && !step.required) {
        stepResults.push({
          step,
          result: {
            success: true,
            message: 'Skipped (previous step indicated skip)',
            skipRemaining: false
          },
          timestamp: new Date().toISOString()
        });
        continue;
      }

      try {
        logger.info(`Executing workflow step: ${step.name}`, { stepId: step.id });
        
        const result = await step.execute(this.context);
        
        // Store result in context for subsequent steps
        this.context.stepResults.set(step.id, result);
        
        stepResults.push({
          step,
          result,
          timestamp: new Date().toISOString()
        });

        if (result.skipRemaining) {
          shouldSkipRemaining = true;
        }

        // If step failed and is required, stop workflow
        if (!result.success && step.required) {
          logger.warn('Required step failed, stopping workflow', {
            stepId: step.id,
            stepName: step.name,
            error: result.error
          });
          break;
        }
      } catch (error) {
        logger.error('Error executing workflow step', {
          stepId: step.id,
          stepName: step.name,
          error: error instanceof Error ? error.message : String(error)
        });

        stepResults.push({
          step,
          result: {
            success: false,
            message: 'Step execution failed',
            error: error instanceof Error ? error.message : String(error)
          },
          timestamp: new Date().toISOString()
        });

        if (step.required) {
          break;
        }
      }
    }

    const completedSteps = stepResults.filter(s => s.result.success).length;
    const failedSteps = stepResults.filter(s => !s.result.success).length;
    const skippedSteps = stepResults.filter(s => 
      s.result.message.includes('Skipped')
    ).length;

    return {
      success: failedSteps === 0,
      steps: stepResults,
      summary: {
        totalSteps: this.steps.length,
        completedSteps,
        failedSteps,
        skippedSteps
      }
    };
  }
}

/**
 * Create a workflow context with all necessary dependencies
 */
export async function createWorkflowContext(
  args: Record<string, any>
): Promise<WorkflowContext> {
  const db = new DatabaseManager();
  await db.initialize();

  const logglyClient = createLogglyApiClient();

  // Helper to get Bybit client (loads config and creates client)
  const getBybitClient = async (accountName?: string): Promise<RestClientV5 | undefined> => {
    const configPath = process.env.CONFIG_PATH || path.join(projectRoot, 'config.json');
    let config: any = null;
    
    try {
      const fs = await import('fs-extra');
      if (await fs.default.pathExists(configPath)) {
        const configContent = await fs.default.readFile(configPath, 'utf-8');
        config = JSON.parse(configContent);
      }
    } catch (error) {
      logger.warn('Failed to load config for Bybit client', { error });
    }

    if (!config || !accountName) {
      const apiKey = process.env.BYBIT_API_KEY;
      const apiSecret = process.env.BYBIT_API_SECRET;
      if (!apiKey || !apiSecret) return undefined;
      return new RestClientV5({ 
        key: apiKey, 
        secret: apiSecret, 
        testnet: process.env.BYBIT_TESTNET === 'true' 
      });
    }

    const account = config.accounts?.find((acc: any) => acc.name === accountName);
    if (!account) {
      const apiKey = process.env.BYBIT_API_KEY;
      const apiSecret = process.env.BYBIT_API_SECRET;
      if (!apiKey || !apiSecret) return undefined;
      return new RestClientV5({ 
        key: apiKey, 
        secret: apiSecret, 
        testnet: process.env.BYBIT_TESTNET === 'true' 
      });
    }

    const envVarNameForKey = account.envVarNames?.apiKey || account.envVars?.apiKey;
    const envVarNameForSecret = account.envVarNames?.apiSecret || account.envVars?.apiSecret;
    const apiKey = envVarNameForKey ? process.env[envVarNameForKey] : (account.apiKey || process.env.BYBIT_API_KEY);
    const apiSecret = envVarNameForSecret ? process.env[envVarNameForSecret] : (account.apiSecret || process.env.BYBIT_API_SECRET);
    
    if (!apiKey || !apiSecret) return undefined;

    const testnet = account.testnet || false;
    const demo = account.demo || false;
    const baseUrl = demo ? 'https://api-demo.bybit.com' : undefined;
    const effectiveTestnet = testnet && !demo;

    return new RestClientV5({
      key: apiKey,
      secret: apiSecret,
      testnet: effectiveTestnet,
      ...(baseUrl && { baseUrl })
    });
  };

  // Helper to get cTrader client (loads config and creates client)
  const getCTraderClient = async (accountName?: string): Promise<CTraderClient | undefined> => {
    const configPath = process.env.CONFIG_PATH || path.join(projectRoot, 'config.json');
    let config: any = null;

    try {
      const fs = await import('fs-extra');
      if (await fs.default.pathExists(configPath)) {
        const configContent = await fs.default.readFile(configPath, 'utf-8');
        config = JSON.parse(configContent);
      }
    } catch (error) {
      logger.warn('Failed to load config for cTrader client', { error });
    }

    const account = config?.accounts?.find((acc: any) =>
      acc.exchange === 'ctrader' && (accountName ? acc.name === accountName : true)
    ) || config?.accounts?.find((acc: any) => acc.exchange === 'ctrader');

    if (!account) {
      const clientId = process.env.CTRADER_CLIENT_ID;
      const clientSecret = process.env.CTRADER_CLIENT_SECRET;
      const accessToken = process.env.CTRADER_ACCESS_TOKEN;
      const accountId = process.env.CTRADER_ACCOUNT_ID;
      if (!clientId || !clientSecret || !accessToken || !accountId) return undefined;
      const clientConfig: CTraderClientConfig = {
        clientId,
        clientSecret,
        accessToken,
        accountId,
        environment: 'demo'
      };
      const client = new CTraderClient(clientConfig);
      try {
        await client.connect();
        await client.authenticate();
        return client;
      } catch (err) {
        logger.warn('cTrader connect failed', { error: err });
        return undefined;
      }
    }

    const envKey = account.envVarNames?.apiKey || account.envVars?.apiKey;
    const envSecret = account.envVarNames?.apiSecret || account.envVars?.apiSecret;
    const envToken = account.envVarNames?.accessToken || account.envVars?.accessToken;
    const envAccountId = account.envVarNames?.accountId || account.envVars?.accountId;

    const clientId = envKey ? process.env[envKey] : process.env.CTRADER_CLIENT_ID;
    const clientSecret = envSecret ? process.env[envSecret] : process.env.CTRADER_CLIENT_SECRET;
    const accessToken = envToken ? process.env[envToken] : process.env.CTRADER_ACCESS_TOKEN;
    const accountId = envAccountId ? process.env[envAccountId] : process.env.CTRADER_ACCOUNT_ID;

    if (!clientId || !clientSecret || !accessToken || !accountId) return undefined;

    const clientConfig: CTraderClientConfig = {
      clientId,
      clientSecret,
      accessToken,
      accountId,
      environment: account.demo ? 'demo' : 'live'
    };

    const client = new CTraderClient(clientConfig);
    try {
      await client.connect();
      await client.authenticate();
      return client;
    } catch (err) {
      logger.warn('cTrader connect failed', { accountName: account.name, error: err });
      return undefined;
    }
  };

  const logglyConfigStatus = getLogglyConfigStatus();

  return {
    db,
    logglyClient: logglyClient || undefined,
    logglyConfigStatus,
    getBybitClient,
    getCTraderClient,
    args,
    stepResults: new Map()
  };
}

