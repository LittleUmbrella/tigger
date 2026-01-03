/**
 * Helper to safely access Bybit API response fields that may be camelCase or snake_case
 * Bybit's API may return fields in either format depending on SDK version or API version
 * 
 * @param obj - The object containing the field
 * @param camelCase - The camelCase field name (e.g., 'orderId')
 * @param snakeCase - Optional explicit snake_case name (e.g., 'order_id'). If not provided, converts camelCase automatically
 * @returns The field value or undefined if not found
 */
export const getBybitField = <T>(obj: any, camelCase: string, snakeCase?: string): T | undefined => {
  if (!obj) return undefined;
  
  // Try camelCase first (most common in newer SDKs)
  if (obj[camelCase] !== undefined) {
    return obj[camelCase];
  }
  
  // Try explicit snake_case if provided
  if (snakeCase && obj[snakeCase] !== undefined) {
    return obj[snakeCase];
  }
  
  // Auto-convert camelCase to snake_case as fallback
  const autoSnakeCase = camelCase.replace(/([A-Z])/g, '_$1').toLowerCase();
  if (obj[autoSnakeCase] !== undefined) {
    return obj[autoSnakeCase];
  }
  
  return undefined;
};

