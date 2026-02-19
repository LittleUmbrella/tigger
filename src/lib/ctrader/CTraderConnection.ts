import { v1 as uuidv1 } from 'uuid';
import { CTraderSocket } from './CTraderSocket.js';
import { CTraderCommandMap } from './CTraderCommandMap.js';
import { CTraderEventEmitter } from './CTraderEventEmitter.js';
import { CTraderProtobufHandler } from './CTraderProtobufHandler.js';
import { logger } from '../../utils/logger.js';

export interface CTraderConnectionConfig {
  host: string;
  port: number;
}

/**
 * cTrader OpenAPI connection handler
 * Manages TLS connection, protobuf encoding/decoding, and command/response mapping
 */
export class CTraderConnection {
  private socket: CTraderSocket;
  private commandMap: CTraderCommandMap;
  private eventEmitter: CTraderEventEmitter;
  private protobufHandler: CTraderProtobufHandler;
  private encoderDecoder: MessageEncoderDecoder;
  private connected: boolean = false;
  private initialized: boolean = false;

  constructor(config: CTraderConnectionConfig) {
    this.socket = new CTraderSocket(config);
    this.commandMap = new CTraderCommandMap((message) => this.sendMessage(message));
    this.eventEmitter = new CTraderEventEmitter();
    this.protobufHandler = new CTraderProtobufHandler();
    this.encoderDecoder = new MessageEncoderDecoder((data) => this.handleDecodedData(data));

    // Setup socket event handlers
    this.socket.on('data', (data: Buffer) => {
      this.encoderDecoder.decode(data);
    });

    this.socket.on('error', (error: Error) => {
      logger.error('CTrader socket error', { error: error.message });
    });

    this.socket.on('close', () => {
      this.connected = false;
      logger.info('CTrader socket closed');
    });
  }

  /**
   * Initialize protobuf handler and connect
   */
  async open(): Promise<void> {
    if (!this.initialized) {
      await this.protobufHandler.initialize();
      this.initialized = true;
    }

    await this.socket.connect();
    this.connected = true;
  }

  /**
   * Close the connection
   */
  close(): void {
    this.socket.disconnect();
    this.connected = false;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected && this.socket.isConnected();
  }

  /**
   * Send a command and wait for response
   */
  async sendCommand(payloadName: string, data?: any, messageId?: string): Promise<any> {
    if (!this.initialized) {
      throw new Error('Connection not initialized');
    }

    const clientMsgId = messageId || uuidv1();
    const message = this.protobufHandler.encode(payloadName, data || {}, clientMsgId);

    // Handle special cases (events, requests without responses)
    if (payloadName.endsWith('EVENT')) {
      // Events don't have responses
      this.sendMessage(message);
      return Promise.resolve({});
    }

    if (payloadName.endsWith('REQ')) {
      // Check if there's a corresponding RES type
      const resName = payloadName.slice(0, -3) + 'Res';
      const resType = this.protobufHandler.getPayloadTypeByName(resName);
      if (resType === -1) {
        // No response expected
        this.sendMessage(message);
        return Promise.resolve({});
      }
    }

    return this.commandMap.create(clientMsgId, message);
  }

  /**
   * Try to send a command, return undefined on error
   */
  async trySendCommand(payloadName: string, data?: any, messageId?: string): Promise<any | undefined> {
    try {
      return await this.sendCommand(payloadName, data, messageId);
    } catch (error) {
      logger.warn('Failed to send command', {
        payloadName,
        error: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  }

  /**
   * Get payload type by name
   */
  getPayloadTypeByName(name: string): number {
    return this.protobufHandler.getPayloadTypeByName(name);
  }

  /**
   * Get payload name by type
   */
  getPayloadNameByType(type: number): string {
    return this.protobufHandler.getPayloadNameByType(type);
  }

  /**
   * Listen for events
   */
  on(payloadName: string, listener?: (event: any) => void): Promise<any> | string {
    const payloadType = this.getPayloadTypeByName(payloadName);
    if (payloadType === -1) {
      throw new Error(`Unknown payload type: ${payloadName}`);
    }

    if (listener) {
      return this.eventEmitter.onEvent(payloadType.toString(), listener);
    } else {
      return new Promise((resolve) => {
        const uuid = this.eventEmitter.onEvent(payloadType.toString(), (event) => {
          this.eventEmitter.removeEventListener(uuid);
          resolve(event.descriptor);
        });
      });
    }
  }

  /**
   * Remove event listener
   */
  removeEventListener(uuid: string): void {
    this.eventEmitter.removeEventListener(uuid);
  }

  /**
   * Send heartbeat
   */
  sendHeartbeat(): void {
    this.sendCommand('ProtoHeartbeatEvent').catch(() => {
      // Ignore heartbeat errors
    });
  }

  /**
   * Send encoded message over socket
   */
  private sendMessage(message: Buffer): void {
    const framed = this.encoderDecoder.encode(message);
    this.socket.send(framed);
  }

  /**
   * Handle decoded data from socket
   * Receives a Buffer from MessageEncoderDecoder, needs to decode it first
   */
  private handleDecodedData(buffer: Buffer): void {
    // Decode the protobuf message
    let decoded: { payloadType: number; payload: any; clientMsgId: string };
    try {
      decoded = this.protobufHandler.decode(buffer);
    } catch (error) {
      logger.error('Failed to decode protobuf message', {
        error: error instanceof Error ? error.message : String(error),
        bufferLength: buffer.length
      });
      return;
    }
    
    logger.debug('Handling decoded data', {
      payloadType: decoded.payloadType,
      payloadTypeHex: decoded.payloadType !== undefined && decoded.payloadType !== 0 ? `0x${decoded.payloadType.toString(16)}` : String(decoded.payloadType),
      clientMsgId: decoded.clientMsgId,
      payloadKeys: decoded.payload ? Object.keys(decoded.payload) : [],
      payloadName: this.getPayloadNameByType(decoded.payloadType)
    });
    
    // If payloadType is 0, it means decode failed - try to handle by clientMsgId anyway
    if (decoded.payloadType === 0) {
      if (decoded.clientMsgId) {
        const command = this.commandMap.extractById(decoded.clientMsgId);
        if (command) {
          logger.debug('Resolving command with payloadType=0', { clientMsgId: decoded.clientMsgId });
          command.resolve(decoded.payload || {});
          return;
        }
      }
      logger.warn('Received message with payloadType=0 and no clientMsgId');
      return;
    }
    
    const payloadName = this.getPayloadNameByType(decoded.payloadType);
    if (!payloadName) {
      logger.debug('Unknown payload type received', { 
        payloadType: decoded.payloadType,
        clientMsgId: decoded.clientMsgId,
        payloadKeys: decoded.payload ? Object.keys(decoded.payload) : []
      });
      // Try to handle it anyway if it has a clientMsgId (might be a response)
      if (decoded.clientMsgId) {
        const command = this.commandMap.extractById(decoded.clientMsgId);
        if (command) {
          logger.debug('Resolving command for unknown payload type', { 
            payloadType: decoded.payloadType,
            clientMsgId: decoded.clientMsgId 
          });
          // Check for error in payload
          const hasError = decoded.payload && (decoded.payload.errorCode !== undefined && decoded.payload.errorCode !== null);
          if (hasError) {
            command.reject(decoded.payload);
          } else {
            command.resolve(decoded.payload);
          }
          return;
        }
      }
      return;
    }

    const response = {
      ...decoded.payload,
      payloadType: payloadName,
      clientMsgId: decoded.clientMsgId
    };

    // Check if it's an event (case-insensitive check)
    if (payloadName.toUpperCase().endsWith('EVENT')) {
      this.eventEmitter.emitEvent(decoded.payloadType.toString(), response);
      return;
    }

    // Check if it's a response to a pending command (case-insensitive)
    if (payloadName.endsWith('RES') || payloadName.endsWith('Res')) {
      if (decoded.clientMsgId) {
        const command = this.commandMap.extractById(decoded.clientMsgId);
        if (command) {
          logger.debug('Resolving command response', {
            payloadName,
            clientMsgId: decoded.clientMsgId,
            hasError: response.errorCode !== undefined && response.errorCode !== null,
            responseKeys: Object.keys(response)
          });
          // Check for error
          if (response.errorCode !== undefined && response.errorCode !== null) {
            command.reject(response);
          } else {
            command.resolve(response);
          }
          return;
        } else {
          logger.warn('Response received but no matching command found', {
            payloadName,
            clientMsgId: decoded.clientMsgId,
            pendingCommands: this.commandMap.getPendingCommands().length
          });
        }
      } else {
        logger.debug('RES message without clientMsgId', { payloadName });
      }
      // RES without matching command - might be a broadcast response, ignore
      return;
    }

    logger.debug('Unhandled message', { payloadName, clientMsgId: decoded.clientMsgId });
  }

  /**
   * Static method to get access token accounts (workaround for library bug)
   */
  static async getAccessTokenAccounts(accessToken: string): Promise<any[]> {
    const https = await import('https');
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.spotware.com',
        path: `/connect/tradingaccounts?access_token=${accessToken}`,
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed)) {
              resolve(parsed);
            } else if (parsed && typeof parsed === 'object' && parsed.data) {
              resolve(Array.isArray(parsed.data) ? parsed.data : []);
            } else {
              resolve([]);
            }
          } catch (error) {
            reject(new Error(`Failed to parse response: ${error instanceof Error ? error.message : String(error)}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.end();
    });
  }
}

/**
 * Message encoder/decoder for cTrader protocol
 * Handles 4-byte size prefix framing
 */
class MessageEncoderDecoder {
  private sizeLength: number = 4;
  private expectedSize?: number;
  private buffer?: Buffer;
  private decodeHandler: (data: Buffer) => void;

  constructor(decodeHandler: (data: Buffer) => void) {
    this.decodeHandler = decodeHandler;
  }

  encode(message: Buffer): Buffer {
    const size = Buffer.alloc(this.sizeLength);
    size.writeUInt32BE(message.length, 0);
    return Buffer.concat([size, message], this.sizeLength + message.length);
  }

  decode(data: Buffer): void {
    let workingBuffer = this.buffer ? Buffer.concat([this.buffer, data]) : data;
    this.buffer = undefined;

    while (workingBuffer.length > 0) {
      if (this.expectedSize === undefined) {
        if (workingBuffer.length >= this.sizeLength) {
          this.expectedSize = workingBuffer.readUInt32BE(0);
          workingBuffer = workingBuffer.slice(this.sizeLength);
        } else {
          this.buffer = workingBuffer;
          return;
        }
      }

      if (workingBuffer.length >= this.expectedSize) {
        const message = workingBuffer.slice(0, this.expectedSize);
        try {
          this.decodeHandler(message);
        } catch (error) {
          logger.error('Error in decodeHandler', {
            error: error instanceof Error ? error.message : String(error),
            messageLength: message.length,
            expectedSize: this.expectedSize
          });
        }
        workingBuffer = workingBuffer.slice(this.expectedSize);
        this.expectedSize = undefined;
      } else {
        this.buffer = workingBuffer;
        return;
      }
    }
  }
}
