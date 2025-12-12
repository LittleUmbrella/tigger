/**
 * Zod schemas for validating LLM parser output
 */
import { z } from 'zod';

/**
 * Action types that the LLM can output
 */
export const LLMActionSchema = z.enum(['OPEN', 'CLOSE_ALL', 'SET_TP', 'SET_SL', 'ADJUST_ENTRY', 'NONE']);

/**
 * Side types for trading positions
 */
export const LLMSideSchema = z.enum(['LONG', 'SHORT']);

/**
 * Quantity type schema
 */
export const LLMQuantityTypeSchema = z.enum(['PERCENT_BALANCE', 'FIXED_AMOUNT']);

/**
 * Order type schema
 */
export const LLMOrderTypeSchema = z.enum(['MARKET', 'LIMIT']);

/**
 * Base schema for all LLM outputs
 */
export const LLMOutputBaseSchema = z.object({
  action: LLMActionSchema,
  reason: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

/**
 * Schema for OPEN action
 */
export const LLMOpenActionSchema = LLMOutputBaseSchema.extend({
  action: z.literal('OPEN'),
  symbol: z.string().min(1).transform((val) => val.toUpperCase().replace('/', '')),
  side: LLMSideSchema,
  price: z.union([
    z.number().positive(),
    z.literal('MARKET'),
  ]),
  quantity_type: LLMQuantityTypeSchema,
  quantity: z.number().positive(),
  leverage: z.number().int().min(1).max(100).optional().default(1),
  order_type: LLMOrderTypeSchema.optional().default('MARKET'),
  sl: z.number().positive(),
  tps: z.array(z.number().positive()).min(1),
});

/**
 * Schema for CLOSE_ALL action
 */
export const LLMCloseAllActionSchema = LLMOutputBaseSchema.extend({
  action: z.literal('CLOSE_ALL'),
  symbol: z.string().min(1).transform((val) => val.toUpperCase().replace('/', '')),
  side: LLMSideSchema,
  price: z.union([
    z.number().positive(),
    z.literal('MARKET'),
  ]),
});

/**
 * Schema for SET_TP action
 */
export const LLMSetTPActionSchema = LLMOutputBaseSchema.extend({
  action: z.literal('SET_TP'),
  symbol: z.string().min(1).transform((val) => val.toUpperCase().replace('/', '')),
  price: z.number().positive(),
  reason: z.string().optional(),
});

/**
 * Schema for SET_SL action
 */
export const LLMSetSLActionSchema = LLMOutputBaseSchema.extend({
  action: z.literal('SET_SL'),
  symbol: z.string().min(1).transform((val) => val.toUpperCase().replace('/', '')),
  price: z.number().positive(),
  reason: z.string().optional(),
});

/**
 * Schema for ADJUST_ENTRY action
 */
export const LLMAdjustEntryActionSchema = LLMOutputBaseSchema.extend({
  action: z.literal('ADJUST_ENTRY'),
  symbol: z.string().min(1).transform((val) => val.toUpperCase().replace('/', '')),
  price: z.number().positive(),
  reason: z.string().optional(),
});

/**
 * Schema for NONE action (non-signal message)
 */
export const LLMNoneActionSchema = LLMOutputBaseSchema.extend({
  action: z.literal('NONE'),
  reason: z.string().min(1), // Required for NONE action
});

/**
 * Union schema for all possible LLM outputs
 */
export const LLMOutputSchema = z.discriminatedUnion('action', [
  LLMOpenActionSchema,
  LLMCloseAllActionSchema,
  LLMSetTPActionSchema,
  LLMSetSLActionSchema,
  LLMAdjustEntryActionSchema,
  LLMNoneActionSchema,
]);

/**
 * Type inference from schema
 */
export type LLMOutput = z.infer<typeof LLMOutputSchema>;
export type LLMOpenAction = z.infer<typeof LLMOpenActionSchema>;
export type LLMCloseAllAction = z.infer<typeof LLMCloseAllActionSchema>;
export type LLMSetTPAction = z.infer<typeof LLMSetTPActionSchema>;
export type LLMSetSLAction = z.infer<typeof LLMSetSLActionSchema>;
export type LLMAdjustEntryAction = z.infer<typeof LLMAdjustEntryActionSchema>;
export type LLMNoneAction = z.infer<typeof LLMNoneActionSchema>;

