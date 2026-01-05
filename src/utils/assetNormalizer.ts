/**
 * Asset Name Normalizer
 * 
 * Utilities for normalizing asset names for exchange compatibility.
 * Handles variants like "1000SHIB" <-> "SHIB1000"
 */

/**
 * Get alternative asset name variant by moving "1000" prefix to suffix
 * Example: "1000SHIB" -> "SHIB1000"
 * 
 * @param assetName - The asset name to get variant for (e.g., "1000SHIB", "SHIB")
 * @returns The alternative variant if applicable, or null if no variant exists
 */
export function getAssetVariant(assetName: string): string | null {
  // Check if asset name starts with "1000"
  if (assetName.startsWith('1000')) {
    // Extract the base asset (everything after "1000")
    const baseAsset = assetName.substring(4);
    // Move "1000" to the end
    return `${baseAsset}1000`;
  }
  
  // No variant available
  return null;
}

