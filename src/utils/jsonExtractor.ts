/**
 * Utilities for extracting JSON from LLM output
 * LLMs often wrap JSON in markdown code blocks or add explanatory text
 */

/**
 * Extract JSON from markdown code fences or plain text
 * @param llmOutput - Raw output from LLM
 * @returns Extracted JSON string or null if not found
 */
export function extractJSON(llmOutput: string): string | null {
  if (!llmOutput || typeof llmOutput !== 'string') {
    return null;
  }

  // Try to extract from markdown code block (```json ... ``` or ``` ... ```)
  const codeBlockMatch = llmOutput.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Try to find JSON object in plain text (look for { ... })
  const jsonObjectMatch = llmOutput.match(/\{[\s\S]*\}/);
  if (jsonObjectMatch) {
    return jsonObjectMatch[0].trim();
  }

  // Try to find JSON array (less common but possible)
  const jsonArrayMatch = llmOutput.match(/\[[\s\S]*\]/);
  if (jsonArrayMatch) {
    return jsonArrayMatch[0].trim();
  }

  return null;
}

/**
 * Parse JSON with error handling
 * @param jsonString - JSON string to parse
 * @returns Parsed object or null if parsing fails
 */
export function safeParseJSON<T = unknown>(jsonString: string): T | null {
  try {
    return JSON.parse(jsonString) as T;
  } catch (error) {
    return null;
  }
}

/**
 * Extract and parse JSON from LLM output in one step
 * @param llmOutput - Raw output from LLM
 * @returns Parsed object or null if extraction/parsing fails
 */
export function extractAndParseJSON<T = unknown>(llmOutput: string): T | null {
  const extracted = extractJSON(llmOutput);
  if (!extracted) {
    return null;
  }
  return safeParseJSON<T>(extracted);
}

