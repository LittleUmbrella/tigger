import { ParsedOrder } from '../../../types/order';

export const ronnieCryptoSignals = (content: string): ParsedOrder | null => {
  // Signal type - check first to determine if we should continue
  // Handle formats: "LONG", "SHORT", "Long SIGNAL", "Short SIGNAL", "LONG SIGNAL", "SHORT SIGNAL"
  const signalTypeMatch = content.match(/(?:^|\s)(Long|Short|LONG|SHORT)(?:\s+SIGNAL)?/i);
  if (!signalTypeMatch) return null;
  const signalTypeText = signalTypeMatch[1].toUpperCase();
  const signalType: 'long' | 'short' = signalTypeText === 'SHORT' ? 'short' : 'long';

  // Trading pair - handle various formats:
  // - "SYMBOL/USDT" (no spaces)
  // - "#SYMBOL/USDT" (with # prefix)
  // - "SYMBOL/ USDT" (space after slash)
  // - "SYMBOL / USDT" (space before and after slash)
  // - "ETHUSDT" (without slash) - treat as "ETH/USDT"
  let pairMatch = content.match(/#?(\w+)\s*\/\s*USDT/i);
  if (!pairMatch) {
    // Try format without slash: "ETHUSDT" -> "ETH/USDT"
    pairMatch = content.match(/#?(\w+)USDT/i);
    if (!pairMatch) return null;
  }
  const tradingPair = pairMatch[1].toUpperCase();

  // Leverage - extract number and use lowest value if range (conservative approach)
  // Handle formats: "10x to 20x", "10x-20x", "20x", "5x-10x", "Cross Full", "Lvrg: full"
  let leverageMatch = content.match(/(\d+(?:\.\d+)?)\s*[Xx]\s*(?:to|-)\s*(\d+(?:\.\d+)?)\s*[Xx]/i);
  if (!leverageMatch) {
    // Try single leverage value
    leverageMatch = content.match(/(\d+(?:\.\d+)?)\s*[Xx]/i);
  }
  
  // If no numeric leverage found, check for "Cross Full" or "Lvrg: full" (use default 50x)
  let leverage: number;
  if (!leverageMatch) {
    const fullMatch = content.match(/(?:Cross\s+)?(?:Full|full)|Lvrg\s*:\s*full/i);
    if (fullMatch) {
      leverage = 50; // Default to 50x for "full" leverage
    } else {
      return null; // No leverage found
    }
  } else {
    const leverage1 = parseFloat(leverageMatch[1]);
    const leverage2 = leverageMatch[2] ? parseFloat(leverageMatch[2]) : null;
    // Use lowest value if range provided (conservative), otherwise use single value
    leverage = leverage2 !== null ? Math.min(leverage1, leverage2) : leverage1;
    if (leverage < 1 || isNaN(leverage)) return null;
  }

  // Entry price - handle ranges and use worst value for signal type, or allow "current"/"market"
  // Handle formats: "Entry: 0.3140 - 0.3100", "Buy: 0.08710 - 0.08457", "✅ Entry: 0.48-0.46"
  let entryPrice: number | undefined;
  const entryPriceCurrentMatch = content.match(/(?:Market price|current|market|CMP)/i);
  if (entryPriceCurrentMatch) {
    // Entry price is "current" or "market" - leave undefined for market order
    entryPrice = undefined;
  } else {
    // Try range format: "Entry: 0.3140 - 0.3100" or "Buy: 0.08710 - 0.08457" or "✅ Entry: 0.48-0.46"
    // Handle numbers with commas: "Entry: 3,148.60" -> "3148.60"
    // Handle parentheses: "Entry (Limit Order) : 3,148.60"
    let entryPriceRangeMatch = content.match(/(?:Entry|ENTRY|Buy|BUY)[^:]*:\s*-?\s*([\d,]+\.?\d*)\s*-\s*([\d,]+\.?\d*)/i);
    if (!entryPriceRangeMatch) {
      // Try with optional characters before (e.g., emojis)
      entryPriceRangeMatch = content.match(/.*?(?:Entry|ENTRY|Buy|BUY)[^:]*:\s*-?\s*([\d,]+\.?\d*)\s*-\s*([\d,]+\.?\d*)/i);
    }
    if (entryPriceRangeMatch) {
      // Remove commas from numbers before parsing
      const price1 = parseFloat(entryPriceRangeMatch[1].replace(/,/g, ''));
      const price2 = parseFloat(entryPriceRangeMatch[2].replace(/,/g, ''));
      // For LONG: worst = highest price (entering higher is worse, you pay more)
      // For SHORT: worst = lowest price (entering lower is worse, you sell for less)
      entryPrice = signalType === 'long' ? Math.max(price1, price2) : Math.min(price1, price2);
    } else {
      // Try single entry price: "Entry: 0.3140" or "Buy: 0.08710" or "Entry (Limit Order) : 3,148.60"
      // Handle numbers with commas: "3,148.60" -> "3148.60"
      // Handle parentheses: "Entry (Limit Order) : 3,148.60"
      let entryPriceSingleMatch = content.match(/(?:Entry|ENTRY|Buy|BUY)[^:]*:\s*-?\s*([\d,]+\.?\d*)/i);
      if (!entryPriceSingleMatch) {
        // Try with optional characters before
        entryPriceSingleMatch = content.match(/.*?(?:Entry|ENTRY|Buy|BUY)[^:]*:\s*-?\s*([\d,]+\.?\d*)/i);
      }
      if (entryPriceSingleMatch) {
        // Remove commas from number before parsing
        const priceStr = entryPriceSingleMatch[1].replace(/,/g, '');
        entryPrice = parseFloat(priceStr);
      } else {
        // Try dollar format: "$0.139" or "0.139$"
        const entryDollarMatch = content.match(/\$?([\d.]+)\s*\$/);
        if (entryDollarMatch) {
          entryPrice = parseFloat(entryDollarMatch[1]);
        } else {
          // No entry price found - allow undefined for market orders
          entryPrice = undefined;
        }
      }
    }
  }

  // Stop loss - handle various formats: "$0.3000", "Stop Loss: 0.3000", "Stoploss: 0.44", "ST: 0.00002018$"
  // Allow for emojis or other characters between keyword and separator (e.g., "❌ Stoploss: 0.44" or "🧨 StopLoss: 0.08220")
  // Handle numbers with commas: "Stop Loss: 3,058.80$" -> "3058.80"
  let stopLossMatch = content.match(/(?:StopLoss|stoploss|Stop Loss|Stop loss|SL|stop|STOP LOSS|Stop-Loss|Stoploss|ST)\s*[:\s-]+\s*([\d,]+\.?\d*)/i);
  if (!stopLossMatch) {
    // Try pattern that allows for characters (like emojis) between keyword and separator
    stopLossMatch = content.match(/(?:StopLoss|stoploss|Stop Loss|Stop loss|SL|stop|STOP LOSS|Stop-Loss|Stoploss|ST).*?[:\s-]+\s*([\d,]+\.?\d*)/i);
  }
  if (!stopLossMatch) {
    // Try dollar format: "$0.3000" or "0.3000$" or "$3,058.80" or "3,058.80$"
    stopLossMatch = content.match(/\$\s*([\d,]+\.?\d*)|([\d,]+\.?\d*)\s*\$/);
    if (stopLossMatch) {
      stopLossMatch = [stopLossMatch[0], stopLossMatch[1] || stopLossMatch[2]];
    }
  }
  if (!stopLossMatch) return null;
  
  // Validate stop loss - must be a valid number (no spaces in the middle)
  let stopLossStr = stopLossMatch[1];
  // Remove commas from number
  stopLossStr = stopLossStr.replace(/,/g, '');
  if (stopLossStr.includes(' ') || isNaN(parseFloat(stopLossStr))) {
    return null; // Malformed stop loss
  }
  const stopLoss = parseFloat(stopLossStr);
  if (stopLoss <= 0) return null;

  // Take profits - extract all numbers from targets line
  // Handle formats: "Target: 0.3250 - 0.3400 - 0.3600", "TP1: 0.3250 TP2: 0.3400", "Target : 1) 0.00004518$ 2) 0.00005218$"
  // Also handle numbered lists: "1. 🎯 3,211.57$ 2. 🎯 3,275.80$"
  const takeProfits: number[] = [];
  
  // Try multiple patterns for take profits
  // Pattern 1: "TP1: 0.3250 TP2: 0.3400" format - check this FIRST as it's most specific
  // Extract all TP values from the entire content section
  const tpRegex = /TP\d*:?\s*([\d,]+\.?\d*)\s*\$?/gi;
  const tpMatches = Array.from(content.matchAll(tpRegex));
  let takeProfitMatch: RegExpMatchArray | null = null;
  if (tpMatches.length > 0) {
    const tpValues: string[] = [];
    for (const match of tpMatches) {
      if (match[1]) {
        tpValues.push(match[1]);
      }
    }
    if (tpValues.length > 0) {
      // Create a fake match object with all TP values joined
      takeProfitMatch = ['', tpValues.join(' ')];
    }
  }
  
  if (!takeProfitMatch) {
    // Pattern 2: "Target: 0.3250 - 0.3400 - 0.3600" or "Targets: 0.3250 - 0.3400" or "🏹 Targets : 0.50-0.55-0.58"
    takeProfitMatch = content.match(/Targets?:?\s*[:\-]?\s*([\d.\s\-+$]+)/i);
    if (!takeProfitMatch) {
      // Pattern 2b: Allow for emojis before "Targets" (e.g., "🏹 Targets : 0.50-0.55")
      takeProfitMatch = content.match(/.*?Targets?:?\s*[:\-]?\s*([\d.\s\-+$]+)/i);
    }
  }
  if (!takeProfitMatch) {
    // Pattern 3: "Target : 1) 0.00004518$ 2) 0.00005218$" (numbered targets)
    takeProfitMatch = content.match(/Targets?:?\s*([\d.\s\)$]+)/i);
  }
  
  if (takeProfitMatch) {
    // Check if this was from TP pattern (Pattern 2) - values are already extracted and joined
    // TP pattern creates a match with space-separated values like "0.104 0.106 0.108 0.120"
    const matchValue = takeProfitMatch[1];
    if (matchValue && matchValue.includes(' ') && !matchValue.includes('-') && !matchValue.includes(')')) {
      // This is from TP pattern - values are space-separated
      const tpValues = matchValue.split(/\s+/).filter(v => v.trim());
      const validTargets = tpValues
        .map(t => parseFloat(t.replace(/,/g, '')))
        .filter(t => !isNaN(t) && t > 0);
      takeProfits.push(...validTargets);
    } else {
      // Extract everything after "Targets:" until stop loss or end of content
      // This handles numbered lists and multi-line formats
      const targetsSection = content.split(/Targets?:?/i)[1];
      if (targetsSection) {
        // Stop at stop loss indicators: "Stop Loss", "StopLoss", "🧨", "❌", or "Stop-Loss"
        // Use a regex to find the earliest stop loss indicator
        const stopLossPattern = /(?:🧨|❌|stop\s*[-]?loss|stoploss)/i;
        const stopLossMatch = targetsSection.match(stopLossPattern);
        const stopLossIndex = stopLossMatch && stopLossMatch.index !== undefined ? stopLossMatch.index : -1;
        const relevantSection = stopLossIndex > 0 
          ? targetsSection.substring(0, stopLossIndex)
          : targetsSection;
        
        // Extract all numbers with commas and decimals from the section
        // Handle formats: "3,211.57$", "🎯 3,275.80$", "1. 🎯 3,211.57$"
        const targetNumbers = relevantSection.match(/[\d,]+\.?\d*/g);
        if (targetNumbers) {
          // Filter out numbers that are part of malformed entries and validate
          // Remove commas before parsing, filter out numbers that are too small (likely list numbers like "1", "2")
          // Also filter out numbers that are clearly stop loss values (very large differences from targets)
          const parsedNumbers = targetNumbers.map(t => parseFloat(t.replace(/,/g, ''))).filter(t => !isNaN(t) && t > 0);
          
          // If we have multiple targets, filter out outliers that are likely stop loss values
          // Stop loss values are typically much different from targets (either much higher for shorts or much lower for longs)
          if (parsedNumbers.length > 1) {
            const sorted = [...parsedNumbers].sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];
            const validTargets = parsedNumbers.filter(t => {
              // Keep numbers that are close to other numbers (likely targets)
              // Or numbers that are reasonable (not extreme outliers)
              const isCloseToOthers = parsedNumbers.some(other => other !== t && Math.abs(other - t) / Math.max(other, t) < 0.5);
              return isCloseToOthers || (t > 10 && Math.abs(t - median) / median < 2); // Within 2x of median
            });
            takeProfits.push(...validTargets);
          } else {
            // Single number or no clear pattern - use filter > 10
            const validTargets = parsedNumbers.filter(t => t > 10);
            takeProfits.push(...validTargets);
          }
        }
      }
    }
  }
  
  if (takeProfits.length === 0) return null;

  return {
    tradingPair: `${tradingPair}/USDT`,
    entryPrice,
    stopLoss,
    takeProfits,
    leverage,
    signalType,
  };
};