import { ParsedOrder } from '../../../types/order';

export const ronnieCryptoSignals = (content: string): ParsedOrder | null => {
  // Signal type - check first to determine if we should continue
  const signalTypeMatch = content.match(/LONG|SHORT/i);
  if (!signalTypeMatch) return null;
  const signalTypeText = signalTypeMatch[0].toUpperCase();
  const signalType: 'long' | 'short' = signalTypeText === 'SHORT' ? 'short' : 'long';

  // Trading pair - handle both "SYMBOL/ USDT" and "SYMBOL/USDT" formats (with or without space)
  const pairMatch = content.match(/(\w+)\/\s*USDT/i);
  if (!pairMatch) return null;
  const tradingPair = pairMatch[1].toUpperCase();

  // Leverage - extract number and use lowest value if range (conservative approach)
  // Handle formats: "10x to 20x", "10x-20x", "20x", "5x-10x"
  let leverageMatch = content.match(/(\d+(?:\.\d+)?)\s*[Xx]\s*(?:to|-)\s*(\d+(?:\.\d+)?)\s*[Xx]/i);
  if (!leverageMatch) {
    // Try single leverage value
    leverageMatch = content.match(/(\d+(?:\.\d+)?)\s*[Xx]/i);
    if (!leverageMatch) return null;
  }
  
  const leverage1 = parseFloat(leverageMatch[1]);
  const leverage2 = leverageMatch[2] ? parseFloat(leverageMatch[2]) : null;
  // Use lowest value if range provided (conservative), otherwise use single value
  const leverage = leverage2 !== null ? Math.min(leverage1, leverage2) : leverage1;
  if (leverage < 1 || isNaN(leverage)) return null;

  // Entry price - handle ranges and use worst value for signal type, or allow "current"/"market"
  let entryPrice: number | undefined;
  const entryPriceCurrentMatch = content.match(/(?:Market price|current|market|CMP)/i);
  if (entryPriceCurrentMatch) {
    // Entry price is "current" or "market" - leave undefined for market order
    entryPrice = undefined;
  } else {
    // Try range format: "Entry: 0.3140 - 0.3100" or "0.139$ - 0.144$"
    const entryPriceRangeMatch = content.match(/(?:Entry|ENTRY)[:\s=]*-?\s*([\d.]+)\s*-\s*([\d.]+)/i);
    if (entryPriceRangeMatch) {
      const price1 = parseFloat(entryPriceRangeMatch[1]);
      const price2 = parseFloat(entryPriceRangeMatch[2]);
      // For LONG: worst = highest price (entering higher is worse, you pay more)
      // For SHORT: worst = lowest price (entering lower is worse, you sell for less)
      entryPrice = signalType === 'long' ? Math.max(price1, price2) : Math.min(price1, price2);
    } else {
      // Try single entry price: "Entry: 0.3140" or look for dollar amounts
      const entryPriceSingleMatch = content.match(/(?:Entry|ENTRY)[:\s=]*-?\s*([\d.]+)/i);
      if (entryPriceSingleMatch) {
        entryPrice = parseFloat(entryPriceSingleMatch[1]);
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
  let stopLossMatch = content.match(/(?:StopLoss|stoploss|Stop Loss|Stop loss|SL|stop|STOP LOSS|Stop-Loss|Stoploss|ST)[:\s-]+([\d.]+)/i);
  if (!stopLossMatch) {
    // Try dollar format: "$0.3000" or "0.3000$"
    stopLossMatch = content.match(/\$\s*([\d.]+)|([\d.]+)\s*\$/);
    if (stopLossMatch) {
      stopLossMatch = [stopLossMatch[0], stopLossMatch[1] || stopLossMatch[2]];
    }
  }
  if (!stopLossMatch) return null;
  
  // Validate stop loss - must be a valid number (no spaces in the middle)
  const stopLossStr = stopLossMatch[1];
  if (stopLossStr.includes(' ') || isNaN(parseFloat(stopLossStr))) {
    return null; // Malformed stop loss
  }
  const stopLoss = parseFloat(stopLossStr);
  if (stopLoss <= 0) return null;

  // Take profits - extract all numbers from targets line
  // Handle formats: "Target: 0.3250 - 0.3400 - 0.3600", "TP1: 0.3250 TP2: 0.3400", "Target : 1) 0.00004518$ 2) 0.00005218$"
  const takeProfits: number[] = [];
  
  // Try multiple patterns for take profits
  // Pattern 1: "Target: 0.3250 - 0.3400 - 0.3600" or "Targets: 0.3250 - 0.3400"
  let takeProfitMatch = content.match(/Targets?:?\s*[:\-]?\s*([\d.\s\-+$]+)/i);
  if (!takeProfitMatch) {
    // Pattern 2: "TP1: 0.3250 TP2: 0.3400" format
    takeProfitMatch = content.match(/(?:TP\d*:?\s*)+([\d.\s]+)/i);
  }
  if (!takeProfitMatch) {
    // Pattern 3: "Target : 1) 0.00004518$ 2) 0.00005218$" (numbered targets)
    takeProfitMatch = content.match(/Targets?:?\s*([\d.\s\)$]+)/i);
  }
  
  if (takeProfitMatch) {
    const targetsString = takeProfitMatch[1];
    // Extract all numbers from the targets string, filtering out malformed ones (with spaces in middle)
    const targetNumbers = targetsString.match(/[\d.]+/g);
    if (targetNumbers) {
      // Filter out numbers that are part of malformed entries and validate
      const validTargets = targetNumbers
        .map(t => parseFloat(t))
        .filter(t => !isNaN(t) && t > 0);
      takeProfits.push(...validTargets);
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