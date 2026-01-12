function calculateTradeDetails(options) {
    const {
      entryPrice,
      leverage = 1,          // default to 1x if not provided
      investment,            // margin in USD (optional if positionSize is provided)
      positionSize,          // quantity (number of tokens) - optional alternative to investment + leverage
      direction,             // 'long' or 'short' (required)
      slPrice,
      tpLevels,              // array of { price: number, quantity: number }
      accountBalance,        // account balance in USD (required for riskPercentage calculation)
      riskPercentage         // risk percentage (e.g., 1 for 1%) (optional - alternative to positionSize/investment)
    } = options;
  
    // ───────────────────────────────────────────────
    // 1. Determine total quantity and position size (notional value in USD)
    // ───────────────────────────────────────────────
    let totalQuantity;
    let finalPositionSize;  // notional value in USD
  
    if (typeof positionSize === 'number' && positionSize > 0) {
      // positionSize is treated as quantity (number of tokens)
      totalQuantity = positionSize;
      finalPositionSize = totalQuantity * entryPrice;
    } else if (typeof investment === 'number' && investment > 0 && typeof leverage === 'number' && leverage > 0) {
      // investment is margin in USD, leverage gives us notional position size
      finalPositionSize = investment * leverage;
      totalQuantity = finalPositionSize / entryPrice;
    } else if (typeof riskPercentage === 'number' && riskPercentage > 0 && typeof accountBalance === 'number' && accountBalance > 0) {
      // Calculate quantity based on risk percentage
      // Risk amount = percentage of account balance (absolute dollar amount to risk)
      const riskAmount = accountBalance * (riskPercentage / 100);
      
      // Calculate price difference between entry and stop loss
      const priceDiff = Math.abs(entryPrice - slPrice);
      
      // The actual loss when stop loss is hit: loss = quantity * priceDiff
      // We want: loss = riskAmount
      // Therefore: quantity = riskAmount / priceDiff
      totalQuantity = riskAmount / priceDiff;
      finalPositionSize = totalQuantity * entryPrice;
      // Note: Leverage doesn't affect the quantity calculation directly,
      // but it affects the margin required: margin = positionSize / leverage
    } else {
      throw new Error(
        'You must provide one of:\n' +
        '  - positionSize (quantity in tokens), OR\n' +
        '  - both investment (margin) AND leverage, OR\n' +
        '  - both accountBalance AND riskPercentage'
      );
    }
  
    if (!['long', 'short'].includes(direction)) {
      throw new Error('Direction must be "long" or "short"');
    }
  
    // ───────────────────────────────────────────────
    // PnL calculator
    // ───────────────────────────────────────────────
    const calculatePnL = (exitPrice, qty) => {
      return direction === 'long'
        ? qty * (exitPrice - entryPrice)
        : qty * (entryPrice - exitPrice);
    };
  
    // ───────────────────────────────────────────────
    // Stop Loss validation & max loss
    // ───────────────────────────────────────────────
    if (direction === 'long' && slPrice >= entryPrice) {
      throw new Error('For long: SL price must be below entry price');
    }
    if (direction === 'short' && slPrice <= entryPrice) {
      throw new Error('For short: SL price must be above entry price');
    }
  
    const pnlAtSL = calculatePnL(slPrice, totalQuantity);
    const maxLoss = Math.abs(pnlAtSL);
  
    // ───────────────────────────────────────────────
    // Take Profit levels validation & calculation
    // ───────────────────────────────────────────────
    if (!Array.isArray(tpLevels) || tpLevels.length === 0) {
      throw new Error('tpLevels must be a non-empty array');
    }
  
    let sumTpQuantities = 0;
    const tpDetails = tpLevels.map(tp => {
      if (typeof tp.quantity !== 'number' || tp.quantity <= 0) {
        throw new Error('Each TP level must have a positive quantity');
      }
  
      if (direction === 'long' && tp.price <= entryPrice) {
        throw new Error('For long: TP prices must be above entry price');
      }
      if (direction === 'short' && tp.price >= entryPrice) {
        throw new Error('For short: TP prices must be below entry price');
      }
  
      const partialPnL = calculatePnL(tp.price, tp.quantity);
      sumTpQuantities += tp.quantity;
  
      return {
        tpPrice: tp.price,
        quantity: tp.quantity,
        partialPnL
      };
    });
  
    // Warn if TPs don't cover full position (optional strict mode possible later)
    if (Math.abs(sumTpQuantities - totalQuantity) > 0.0001) {
      console.warn(
        `Note: Total TP quantity (${sumTpQuantities.toFixed(4)}) ` +
        `≠ full position quantity (${totalQuantity.toFixed(4)})`
      );
    }
  
    const totalMaxGain = tpDetails.reduce((sum, d) => sum + d.partialPnL, 0);
    const riskRewardRatio = maxLoss > 0 ? totalMaxGain / maxLoss : 0;
  
    // ───────────────────────────────────────────────
    // Return result
    // ───────────────────────────────────────────────
    return {
      // Input resolution
      usedPositionSize: finalPositionSize,  // notional value in USD (quantity * entryPrice)
      usedMargin: finalPositionSize / leverage,  // margin required in USD
      leverageUsed: leverage,
      totalQuantity,  // quantity in tokens
  
      // Risk metrics
      maxLoss,
      totalMaxGain,
      riskRewardRatio: riskRewardRatio.toFixed(2),
      pnlAtSL,
  
      // Details
      tpDetails,
      sumTpQuantities,
      positionFullyClosed: Math.abs(sumTpQuantities - totalQuantity) < 0.0001
    };
  }
  
  // ──────────────────────────────────────────────────────────────
  // Examples
  // ──────────────────────────────────────────────────────────────
  
  // A) Using investment + leverage (classic leveraged trade)
//   console.log(calculateTradeDetails({
//     entryPrice: 100,
//     investment: 500,          // $500 margin
//     leverage: 20,
//     direction: 'long',
//     slPrice: 92,
//     tpLevels: [
//       { price: 108, quantity: 50 },
//       { price: 115, quantity: 50 }
//     ]
//   }));
  
  // B) Using positionSize as quantity (number of tokens)
  console.log(calculateTradeDetails({
    entryPrice: 0.07309,
    positionSize: 2460,      // 2,460 tokens (not USD!)
    leverage: 50,            // 50x leverage (used for margin calculation)
    direction: 'long',
    slPrice: 0.065,
    tpLevels: [
        { price: 0.073091, quantity: 490 },
        { price: 0.0735, quantity: 490 },
        { price: 0.074, quantity: 490 },
        { price: 0.0745, quantity: 490 },
        { price: 0.075, quantity: 490 }
    ]
  }));
  
  // C) Using risk percentage (recommended for proper risk management)
  // console.log(calculateTradeDetails({
  //   entryPrice: 0.07309,
  //   accountBalance: 27229,   // Account balance in USD
  //   riskPercentage: 1,       // Risk 1% of account
  //   leverage: 50,            // 50x leverage
  //   direction: 'long',
  //   slPrice: 0.065,
  //   tpLevels: [
  //       { price: 0.073091, quantity: 490 },
  //       { price: 0.0735, quantity: 490 },
  //       { price: 0.074, quantity: 490 },
  //       { price: 0.0745, quantity: 490 },
  //       { price: 0.075, quantity: 490 }
  //   ]
  // }));
