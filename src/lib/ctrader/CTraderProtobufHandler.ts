import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';
const protobuf = require('protobufjs');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Handles Protobuf encoding/decoding for cTrader OpenAPI messages
 */
export class CTraderProtobufHandler {
  private builder: any = null;
  private payloadTypeMap: Map<string, number> = new Map();
  private payloadNameMap: Map<number, string> = new Map();
  private messageTypes: Map<string, any> = new Map();

  /**
   * Load and build protobuf definitions
   */
  async initialize(): Promise<void> {
    const protoDir = path.join(__dirname, 'protobuf');
    
    // Load all proto files (using loadProtoFile like the original library)
    const protoFiles = [
      path.join(protoDir, 'OpenApiCommonMessages.proto'),
      path.join(protoDir, 'OpenApiMessages.proto'),
      path.join(protoDir, 'OpenApiCommonModelMessages.proto'),
      path.join(protoDir, 'OpenApiModelMessages.proto')
    ];

    this.builder = undefined;
    
    for (const protoFile of protoFiles) {
      if (fs.existsSync(protoFile)) {
        this.builder = protobuf.loadProtoFile(protoFile, this.builder);
      }
    }

    if (!this.builder) {
      throw new Error('Failed to load protobuf files');
    }

    this.builder.resolveAll();

    // Build payload type maps
    this.buildPayloadMaps();
  }

  /**
   * Build maps for payload type <-> name conversion
   */
  private buildPayloadMaps(): void {
    if (!this.builder) return;

    // Build the builder to get access to messages
    this.builder.build();

    // Find all message types (similar to original library)
    const messages: any[] = [];
    const enums: any[] = [];

    if (this.builder.ns && this.builder.ns.children) {
      this.builder.ns.children.forEach((reflect: any) => {
        const className = reflect.className;
        if (className === 'Message') {
          messages.push(reflect);
        } else if (className === 'Enum') {
          enums.push(reflect);
        }
      });
    }

    // Extract payload types from messages
    messages
      .filter((message) => typeof this.findPayloadType(message) === 'number')
      .forEach((message) => {
        const name = message.name;
        const payloadType = this.findPayloadType(message);
        if (typeof payloadType === 'number') {
          const messageBuilded = this.builder.build(name);
          this.messageTypes.set(name, messageBuilded);
          this.payloadTypeMap.set(name, payloadType);
          this.payloadNameMap.set(payloadType, name);
        }
      });

    // Store ProtoMessage wrapper (it doesn't have a payloadType)
    const protoMessageName = 'ProtoMessage';
    const protoMessageBuilded = this.builder.build(protoMessageName);
    this.messageTypes.set(protoMessageName, protoMessageBuilded);
    // ProtoMessage doesn't have payloadType, so we don't add it to maps
  }

  /**
   * Find payload type from message reflection
   */
  private findPayloadType(message: any): number | undefined {
    if (!message.children) return undefined;
    const field = message.children.find((f: any) => f.name === 'payloadType');
    return field?.defaultValue;
  }

  /**
   * Get payload type number by message name
   */
  getPayloadTypeByName(name: string): number {
    return this.payloadTypeMap.get(name) ?? -1;
  }

  /**
   * Get message name by payload type number
   */
  getPayloadNameByType(type: number): string {
    return this.payloadNameMap.get(type) ?? '';
  }

  /**
   * Encode a message
   */
  encode(payloadName: string, data: any, clientMsgId: string): Buffer {
    if (!this.builder) {
      throw new Error('Protobuf handler not initialized');
    }

    const payloadType = this.getPayloadTypeByName(payloadName);
    if (payloadType === -1) {
      throw new Error(`Unknown payload type: ${payloadName}`);
    }

    const MessageType = this.messageTypes.get(payloadName);
    if (!MessageType) {
      throw new Error(`Message type not found: ${payloadName}`);
    }

    // Create the payload message
    const payloadMessage = new MessageType(data);
    const payloadBuffer = payloadMessage.toBuffer();

    // Wrap in ProtoMessage
    const ProtoMessage = this.messageTypes.get('ProtoMessage');
    if (!ProtoMessage) {
      throw new Error('ProtoMessage type not found');
    }

    const wrapper = new ProtoMessage({
      payloadType,
      payload: payloadBuffer,
      clientMsgId
    });

    return wrapper.toBuffer();
  }

  /**
   * Decode a message
   */
  decode(buffer: Buffer): { payloadType: number; payload: any; clientMsgId: string } {
    if (!this.builder) {
      throw new Error('Protobuf handler not initialized');
    }

    const ProtoMessage = this.messageTypes.get('ProtoMessage');
    if (!ProtoMessage) {
      throw new Error('ProtoMessage type not found');
    }

    let wrapper: any;
    try {
      wrapper = ProtoMessage.decode(buffer);
    } catch (error) {
      logger.error('Failed to decode ProtoMessage', { error: error instanceof Error ? error.message : String(error) });
      throw new Error(`Failed to decode ProtoMessage: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    // Extract properties - try multiple methods (protobufjs v5 can be tricky)
    let payloadType: number | undefined;
    let payloadBuffer: Buffer | Uint8Array | undefined;
    let clientMsgId: string = '';
    
    // Extract properties - protobufjs decoded messages have properties directly accessible
    payloadType = (wrapper as any).payloadType;
    const payload = (wrapper as any).payload;
    clientMsgId = (wrapper as any).clientMsgId || '';
    
    // Convert payload to Buffer - it might be ByteBuffer, Uint8Array, or Buffer
    if (payload) {
      if (Buffer.isBuffer(payload)) {
        payloadBuffer = payload;
      } else if (payload instanceof Uint8Array) {
        payloadBuffer = Buffer.from(payload);
      } else if (payload.toArray) {
        // ByteBuffer has toArray() method
        payloadBuffer = Buffer.from(payload.toArray());
      } else if (payload.toBuffer) {
        // ByteBuffer might have toBuffer() method
        payloadBuffer = payload.toBuffer();
      } else if (typeof payload === 'object' && payload.buffer) {
        // Might be ArrayBufferView
        payloadBuffer = Buffer.from(payload.buffer, payload.byteOffset || 0, payload.byteLength || payload.length);
      } else {
        // Last resort: try to convert
        try {
          payloadBuffer = Buffer.from(payload as any);
        } catch (e) {
          logger.error('Failed to convert payload to Buffer', {
            payloadType: typeof payload,
            payloadConstructor: payload?.constructor?.name,
            error: e instanceof Error ? e.message : String(e)
          });
        }
      }
    }
    
    logger.debug('ProtoMessage extraction result', {
      payloadType,
      hasPayloadBuffer: !!payloadBuffer,
      payloadBufferLength: payloadBuffer?.length,
      clientMsgId,
      payloadType: typeof payload,
      payloadConstructor: payload?.constructor?.name
    });
    
    // Log extraction result
    logger.debug('ProtoMessage decode result', {
      payloadType,
      hasPayloadBuffer: !!payloadBuffer,
      clientMsgId,
      bufferLength: buffer.length
    });
    
    // Debug logging if extraction failed
    if (payloadType === undefined || payloadType === 0) {
      const wrapperMethods = Object.getOwnPropertyNames(wrapper).filter(name => typeof (wrapper as any)[name] === 'function');
      const wrapperProps = Object.keys(wrapper);
      const wrapperStr = typeof (wrapper as any).encodeJSON === 'function' ? (wrapper as any).encodeJSON() : 'no encodeJSON';
      // Log detailed error
      const errorInfo = {
        payloadType,
        hasEncodeJSON: typeof (wrapper as any).encodeJSON === 'function',
        wrapperMethods: wrapperMethods.slice(0, 10),
        wrapperProps: wrapperProps.slice(0, 10),
        wrapperType: typeof wrapper,
        directPayloadType: (wrapper as any).payloadType,
        directPayload: (wrapper as any).payload ? 'exists' : 'missing',
        wrapperObjPayloadType: wrapperObj?.payloadType,
        wrapperObjKeys: wrapperObj ? Object.keys(wrapperObj).slice(0, 10) : []
      };
      console.error('ERROR: Failed to extract payloadType:', JSON.stringify(errorInfo, null, 2));
      logger.error('Failed to extract payloadType from ProtoMessage wrapper', errorInfo);
    }
    
    if (payloadType === undefined || !payloadBuffer) {
      return {
        payloadType: 0,
        payload: {},
        clientMsgId
      };
    }

    // Decode the actual payload
    const payloadName = this.getPayloadNameByType(payloadType);
    let payloadJson: any = {};
    
    if (payloadName) {
      const PayloadType = this.messageTypes.get(payloadName);
      if (PayloadType) {
        try {
    const payload = PayloadType.decode(payloadBuffer);
    // Convert to object - protobufjs 5.0.1 uses toObject, not encodeJSON
    // The original library's encodeJSON was likely a custom method
    if (PayloadType.toObject) {
      payloadJson = PayloadType.toObject(payload, {
        longs: String,
        enums: String,
        bytes: String,
        defaults: true,
        arrays: true,
        objects: true,
        oneofs: true
      });
    } else {
      // Fallback: try direct property access
      payloadJson = payload;
    }
        } catch (error) {
          // If decoding fails, return empty object
          payloadJson = {};
        }
      }
    }

    return {
      payloadType,
      payload: payloadJson,
      clientMsgId
    };
  }
}
