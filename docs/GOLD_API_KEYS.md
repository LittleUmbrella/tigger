# Getting API Keys for Historical Gold Price Data

This guide explains how to get API keys for services that provide historical gold price data.

## Services That Require API Keys

### 1. GoldAPI.io (goldapi.io)

**Website**: https://www.goldapi.io/

**Free Tier**: 
- 10 API calls per day
- Historical data available
- Requires API key

**How to Get API Key**:
1. Visit https://www.goldapi.io/
2. Click "Sign Up" or "Get API Key"
3. Register with your email
4. Copy your API key from the dashboard
5. Add to your `.env` file: `GOLDAPI_KEY=your_api_key_here`

**API Endpoint**: `https://www.goldapi.io/api/XAU/USD/{date}`

---

### 2. Alpha Vantage

**Website**: https://www.alphavantage.co/

**Free Tier**:
- 5 API calls per minute
- 500 API calls per day
- Historical commodity data (including gold)

**How to Get API Key**:
1. Visit https://www.alphavantage.co/support/#api-key
2. Fill out the form with:
   - Your email address
   - Purpose (e.g., "Personal use" or "Trading analysis")
3. Click "GET FREE API KEY"
4. Check your email for the API key
5. Add to your `.env` file: `ALPHA_VANTAGE_API_KEY=your_api_key_here`

**API Endpoint**: `https://www.alphavantage.co/query?function=GOLD&interval=daily&apikey={key}`

---

### 3. Fixer.io

**Website**: https://fixer.io/

**Free Tier**:
- 100 API calls per month
- Current exchange rates only (no historical data on free tier)
- Historical data requires paid plan

**How to Get API Key**:
1. Visit https://fixer.io/product
2. Sign up for a free account
3. Get your API key from the dashboard
4. Add to your `.env` file: `FIXER_API_KEY=your_api_key_here`

**Note**: Free tier only provides current rates, not historical data.

---

## Services That Don't Require API Keys

### Gold API (gold-api.com)

**Website**: https://gold-api.com/

**Free Tier**:
- No API key required
- No rate limits mentioned
- Historical data available

**API Endpoint**: `https://api.gold-api.com/...`

**Note**: This is different from GoldAPI.io (goldapi.io). Gold API (gold-api.com) appears to be free without authentication.

---

## Recommended Setup

For historical gold price data, I recommend:

1. **Start with Gold API (gold-api.com)** - No key required, test if it works
2. **If that doesn't work, get Alpha Vantage key** - Free, 500 calls/day, good for historical data
3. **GoldAPI.io as backup** - Free tier is limited (10 calls/day) but has historical data

## Adding API Keys to Your Project

1. Add the keys to your `.env` file (or `.env-investigation` for investigation scripts):

```bash
# Gold Price API Keys (optional - only needed if you want historical gold prices)
GOLDAPI_KEY=your_goldapi_key_here
ALPHA_VANTAGE_API_KEY=your_alphavantage_key_here
FIXER_API_KEY=your_fixer_key_here
```

2. The code will automatically use whichever API keys are available
3. If no keys are set, the script will skip gold price analysis (as designed)

## Testing Your API Keys

After adding keys, test them:

```bash
# Test GoldAPI.io
curl "https://www.goldapi.io/api/XAU/USD" -H "x-access-token: $GOLDAPI_KEY"

# Test Alpha Vantage
curl "https://www.alphavantage.co/query?function=GOLD&interval=daily&apikey=$ALPHA_VANTAGE_API_KEY"

# Test Fixer.io (current rates only)
curl "http://data.fixer.io/api/latest?access_key=$FIXER_API_KEY&symbols=XAU"
```


