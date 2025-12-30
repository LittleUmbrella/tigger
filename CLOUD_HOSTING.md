# Cloud Hosting Recommendations for Tigger Trading Bot

## Overview
This document provides recommendations for hosting your Tigger trading bot in the cloud, prioritizing **reliability** and **price** for a personal account. **Application hosting must be in India**, but the **database can be in any region**.

## Recommended Solution: DigitalOcean App Platform (India) + Supabase (Database)

### Why This Combination?

**DigitalOcean App Platform** (Hosting - India):
- ✅ **India Region**: Bangalore data center available
- ✅ **Simple pricing**: $5/month for basic app (512MB RAM)
- ✅ **Auto-deploy**: Deploy from GitHub automatically
- ✅ **Always-on**: No sleep, runs 24/7
- ✅ **Built-in monitoring**: Health checks and logs
- ✅ **Docker support**: Works with your existing Dockerfile
- ✅ **Personal account friendly**: Simple setup, no complex billing

**Supabase** (Database - Any Region):
- ✅ **Free tier**: 500MB database, 2GB bandwidth, unlimited projects
- ✅ **Managed PostgreSQL**: Industry-standard, reliable database
- ✅ **Automatic backups**: Daily backups included in free tier
- ✅ **Connection pooling**: Built-in for better performance
- ✅ **Global CDN**: Low latency worldwide
- ✅ **Simple setup**: Get connection string in minutes
- ✅ **No credit card required**: For free tier

### Estimated Monthly Cost
- **DigitalOcean App Platform**: $5/month (basic plan, 512MB RAM)
- **Supabase**: $0/month (free tier)
- **Total**: **$5/month**

**Note**: Database can be in any region (US, EU, etc.) - latency is typically 100-200ms from India, which is acceptable for a trading bot.

**LLM Fallback (Ollama)**: Optional feature. If enabled, requires 2GB+ RAM:
- **With ollama**: Upgrade to Professional plan ($12/month, 2GB RAM)
- **Without ollama**: Basic plan ($5/month, 512MB RAM) is sufficient

---

## Alternative Options

### Option 2: AWS Lightsail (Mumbai) + Supabase

**AWS Lightsail** (Hosting - India):
- ✅ **India Region**: Mumbai (ap-south-1) available
- ✅ **Simple VPS**: $3.50/month for 512MB RAM (t2.nano equivalent)
- ✅ **Predictable pricing**: No surprise bills
- ✅ **Full control**: Docker support
- ✅ **Reliable**: AWS infrastructure
- ⚠️ Slightly more setup required than App Platform

**Supabase** (Database):
- Same as above - free tier, managed PostgreSQL

**Estimated Cost**: **$3.50/month**

### Option 3: Oracle Cloud Free Tier (Mumbai) + Supabase

**Oracle Cloud** (Hosting - India):
- ✅ **India Region**: Mumbai available
- ✅ **Free tier**: 2 VMs with 1GB RAM each (always free)
- ✅ **No credit card required**: For free tier
- ✅ **Full control**: Docker support
- ⚠️ More complex setup
- ⚠️ Free tier has limitations

**Supabase** (Database):
- Same as above - free tier

**Estimated Cost**: **$0/month** (completely free)

### Option 4: DigitalOcean App Platform (India) + Neon

**DigitalOcean App Platform** (Hosting):
- Same as Option 1

**Neon** (Database):
- ✅ **Free tier**: 0.5GB storage, unlimited projects
- ✅ **Serverless PostgreSQL**: Auto-scaling
- ✅ **Branching**: Database branching for testing
- ✅ **Global**: Low latency worldwide
- ✅ **No credit card required**: For free tier

**Estimated Cost**: **$5/month** (hosting only)

### Option 5: AWS Lightsail (Mumbai) + AWS RDS (Mumbai)

**AWS Lightsail** (Hosting - India):
- Same as Option 2

**AWS RDS PostgreSQL** (Database - India):
- ✅ **India Region**: Mumbai (ap-south-1)
- ✅ **Managed service**: Automatic backups and updates
- ✅ **Free tier**: 750 hours/month for 12 months (db.t3.micro)
- ✅ **After free tier**: ~$15-20/month for db.t3.micro
- ✅ **Very reliable**: AWS managed service
- ✅ **Same region**: Lower latency (same region as app)

**Estimated Cost**: 
- First year: $3.50/month (database free tier)
- After first year: ~$18.50-23.50/month

### Option 6: Vultr (Mumbai) + Supabase

**Vultr** (Hosting - India):
- ✅ **India Region**: Mumbai available
- ✅ **Simple VPS**: $6/month for 1GB RAM
- ✅ **Full control**: Docker support
- ✅ **Predictable pricing**: No surprises

**Supabase** (Database):
- Same as above - free tier

**Estimated Cost**: **$6/month**

---

## Database Options (Any Region)

### Recommended: Supabase (Free Tier)
- **Price**: $0/month (free tier: 500MB, 2GB bandwidth)
- **Features**: Managed PostgreSQL, automatic backups, connection pooling
- **Regions**: US, EU (latency ~100-200ms from India)
- **Best for**: Free tier with excellent features, perfect for personal projects
- **Upgrade**: $25/month for Pro (8GB database, 50GB bandwidth)

### Alternative: Neon (Free Tier)
- **Price**: $0/month (free tier: 0.5GB storage)
- **Features**: Serverless PostgreSQL, branching, auto-scaling
- **Regions**: US, EU (latency ~100-200ms from India)
- **Best for**: Development, testing with branching features
- **Upgrade**: $19/month for Launch (10GB storage)

### Alternative: PlanetScale (MySQL - Free Tier)
- **Price**: $0/month (free tier: 5GB storage, 1 billion reads/month)
- **Features**: Serverless MySQL, branching, auto-scaling
- **Note**: Uses MySQL, not PostgreSQL (would require code changes)
- **Best for**: If you're open to MySQL instead of PostgreSQL

### Alternative: DigitalOcean Managed PostgreSQL (India)
- **Price**: $15/month (starter: 1GB)
- **Features**: Managed, automatic backups, monitoring
- **Region**: Bangalore (same region as app = lowest latency)
- **Best for**: Same-region hosting for lowest latency

### Alternative: AWS RDS PostgreSQL (India)
- **Price**: Free tier for 12 months, then ~$15-20/month
- **Features**: Managed, automatic backups, high availability
- **Region**: Mumbai (same region as app = lowest latency)
- **Best for**: AWS ecosystem integration, same-region hosting

### Alternative: Railway Database (Excluded for hosting, but database OK)
- **Price**: $5/month (1GB database)
- **Features**: Managed PostgreSQL, simple setup
- **Note**: Railway hosting excluded (no India region), but database can be used
- **Best for**: Simple managed database if you don't need India region for DB

---

## Cost Comparison Summary

| Provider | Hosting (India) | Database | Monthly Cost | Always-On | Reliability |
|----------|----------------|----------|--------------|-----------|-------------|
| **DigitalOcean + Supabase** | ✅ | ✅ | **$5** | ✅ | ⭐⭐⭐⭐⭐ |
| AWS Lightsail + Supabase | ✅ | ✅ | **$3.50** | ✅ | ⭐⭐⭐⭐⭐ |
| Oracle Cloud + Supabase | ✅ | ✅ | **$0** | ✅ | ⭐⭐⭐⭐ |
| DigitalOcean + Neon | ✅ | ✅ | **$5** | ✅ | ⭐⭐⭐⭐⭐ |
| AWS Lightsail + RDS | ✅ | ✅ | $3.50-23.50 | ✅ | ⭐⭐⭐⭐⭐ |
| Vultr + Supabase | ✅ | ✅ | **$6** | ✅ | ⭐⭐⭐⭐ |

**Winner**: **DigitalOcean App Platform + Supabase** for best balance of price ($5/month), reliability, ease of use, and features.

**Budget Winner**: **AWS Lightsail + Supabase** at $3.50/month.

**Free Option**: **Oracle Cloud + Supabase** at $0/month (if comfortable with setup).

---

## Database Region Considerations

### Latency Impact
- **Same region (India)**: ~5-10ms latency (best)
- **US/EU region**: ~100-200ms latency (acceptable for trading bot)
- **Trading bots**: Low database query frequency, so 100-200ms is fine
- **Connection pooling**: Managed services handle this automatically

### When to Use Same-Region Database
- If you need absolute lowest latency (<10ms)
- If you have high database query frequency
- If compliance requires data in India
- Willing to pay more ($15-20/month vs $0/month)

### When to Use Different-Region Database
- Cost savings (free tier databases often in US/EU)
- More database options available
- 100-200ms latency is acceptable for your use case
- Want to use best-in-class managed services (Supabase, Neon)

---

## India Region Considerations (Application Hosting)

### Latency
- **Mumbai**: Best for most of India
- **Bangalore**: Good for South India, slightly higher latency for North India
- Both are acceptable for a trading bot

### Data Residency
- Application runs in India (important for compliance if needed)
- Database can be in any region (as per your clarification)
- Lower latency for API calls to exchanges (app in India)

### Backup Strategy
- All managed database services include automatic backups
- Consider additional manual backups for critical data
- Cross-region backups provide disaster recovery

---

## Next Steps

1. ✅ Code changes to support PostgreSQL (already implemented)
2. Choose hosting provider in India (DigitalOcean recommended)
3. Set up database (Supabase free tier recommended)
4. Set up hosting (App Platform or VPS)
5. Deploy and test
6. Set up monitoring and alerts

---

## Detailed Setup Guide: DigitalOcean App Platform + Supabase

This section provides step-by-step instructions for deploying your Tigger trading bot to DigitalOcean App Platform with a Supabase PostgreSQL database.

### Prerequisites

Before starting, ensure you have:
- ✅ A GitHub account with your Tigger bot repository
- ✅ A DigitalOcean account (sign up at https://www.digitalocean.com)
- ✅ A Supabase account (sign up at https://supabase.com - no credit card required for free tier)
- ✅ Your `config.json` file ready (or use environment variables)
- ✅ Telegram API credentials (if using Telegram harvesters)
- ✅ Bybit API credentials (if using Bybit exchange)

---

### Step 1: Set Up Supabase Database

#### 1.1 Create a Supabase Project

1. Go to https://supabase.com and sign in (or create a free account)
2. Click **"New Project"**
3. Fill in the project details:
   - **Name**: `tigger-trading-bot` (or your preferred name)
   - **Database Password**: Create a strong password (save this securely!)
   - **Region**: Choose any region (US or EU recommended for free tier)
   - **Pricing Plan**: Select **Free** tier
4. Click **"Create new project"**
5. Wait 2-3 minutes for the project to be provisioned

#### 1.2 Get Database Connection String

1. In your Supabase project dashboard, go to **Settings** → **Database**
2. Scroll down to **Connection string** section
3. Select **URI** tab
4. Copy the connection string (it looks like: `postgresql://postgres:[YOUR-PASSWORD]@db.xxxxx.supabase.co:5432/postgres`)
5. **Important**: Replace `[YOUR-PASSWORD]` with the password you set during project creation
6. Save this connection string securely - you'll need it for DigitalOcean environment variables

#### 1.3 Database Schema (Automatic)

**✅ The bot automatically creates all required database tables on first run.**

When the application starts, it calls `DatabaseManager.initialize()` which:
- Creates all required tables (`messages`, `trades`, `orders`, `message_versions`, `evaluation_results`, `signal_formats`)
- Creates necessary indexes for performance
- Handles schema migrations automatically (adds new columns if they don't exist)

**No manual schema setup required** - just ensure your `DATABASE_URL` environment variable is set correctly in DigitalOcean, and the bot will handle everything on first startup.

**Note**: The connection string includes SSL by default, which is required for Supabase.

---

### Step 2: Prepare Your GitHub Repository

#### 2.1 Ensure Your Repository is Ready

1. Make sure your code is pushed to GitHub
2. Verify your `Dockerfile` is in the repository root
3. Ensure `config.example.json` exists (for reference)
4. **Important**: Never commit `config.json` with real credentials (it should be in `.gitignore`)

#### 2.2 (Optional) Create app.yaml for App Platform

While DigitalOcean can auto-detect Docker, you can create an `app.yaml` file for more control:

```yaml
name: tigger-trading-bot
region: bang
services:
  - name: tigger
    github:
      repo: your-username/tigger
      branch: main
      deploy_on_push: true
    dockerfile_path: Dockerfile
    instance_count: 1
    instance_size_slug: basic-xxs
    envs:
      - key: NODE_ENV
        value: production
    health_check:
      http_path: /
```

**Note**: This is optional - DigitalOcean can auto-detect your Dockerfile.

---

### Step 3: Set Up DigitalOcean App Platform

#### 3.1 Create a New App

1. Log in to DigitalOcean: https://cloud.digitalocean.com
2. Click **"Apps"** in the left sidebar
3. Click **"Create App"**
4. Choose **"GitHub"** as your source
5. Authorize DigitalOcean to access your GitHub account (if first time)
6. Select your repository: `your-username/tigger`
7. Select branch: `main` (or your default branch)
8. Click **"Next"**

#### 3.2 Configure App Settings

1. **Resource Type**: Select **Worker** (not Web Service)
   - ✅ **Worker** is correct because your bot is a long-running background process
   - ❌ **Web Service** is for HTTP servers/web apps (not applicable here)
2. **App Name**: `tigger-trading-bot` (or your preferred name)
3. **Region**: Select **Bangalore (bang)** - this is the India region
4. **Plan**: Select **Basic** plan ($5/month, 512MB RAM)
   - If you need Ollama support, select **Professional** plan ($12/month, 2GB RAM)
5. **Build Command**: Leave empty (handled by Dockerfile)
6. **Run Command**: Leave empty (handled by Dockerfile)
7. Click **"Next"**

#### 3.3 Configure Environment Variables

Click **"Edit"** next to Environment Variables and add the following:

**Required Variables:**

```
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.xxxxx.supabase.co:5432/postgres
NODE_ENV=production
```

**Trading Bot Configuration:**

**Recommended: Use config.json with envVarNames (safe to commit to GitHub)**

Create your `config.json` file using environment variable names (not actual values). This allows you to commit `config.json` to GitHub safely:

```json
{
  "database": {
    "type": "postgresql"
  },
  "accounts": [
    {
      "name": "main",
      "exchange": "bybit",
      "testnet": false,
      "envVarNames": {
        "apiKey": "BYBIT_API_KEY",
        "apiSecret": "BYBIT_API_SECRET"
      }
    }
  ],
  "harvesters": [...],
  "parsers": [...],
  "initiators": [...],
  "monitors": [...],
  "channels": [...]
}
```

**Important**: 
- The `envVarNames` fields contain environment variable names (like `"BYBIT_API_KEY"`), not the actual API keys
- The database connection string should **never** be in `config.json` - it comes from the `DATABASE_URL` environment variable
- Set all actual values (database URL, API keys, etc.) as environment variables in DigitalOcean

**Set these environment variables in DigitalOcean:**

```
# Database (already set above)
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.xxxxx.supabase.co:5432/postgres

# Telegram API (if using Telegram harvesters)
TELEGRAM_API_ID=your_telegram_api_id
TELEGRAM_API_HASH=your_telegram_api_hash

# Bybit API (if using Bybit exchange)
BYBIT_API_KEY=your_bybit_api_key
BYBIT_API_SECRET=your_bybit_api_secret

# Ollama (if using LLM fallback)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:1b
```

**Note**: If your config supports reading from environment variables (check `config.example.json`), use Option B for better security.

#### 3.4 Review and Create

1. Review your configuration
2. Click **"Create Resources"**
3. DigitalOcean will start building and deploying your app
4. This process takes 5-10 minutes

---

### Step 4: Monitor Deployment

#### 4.1 Watch Build Logs

1. In DigitalOcean dashboard, go to your app
2. Click on the **"Runtime Logs"** tab
3. Watch for build progress and any errors
4. Common issues:
   - **Build timeout**: Increase build timeout in app settings
   - **Memory errors**: Upgrade to larger instance size
   - **Database connection errors**: Verify DATABASE_URL is correct

#### 4.2 Verify Deployment

Once deployment completes:
1. Check **"Runtime Logs"** for application startup messages
2. Look for any error messages
3. Verify database connection is successful

---

### Step 5: Configure Database Access (Security)

#### 5.1 Restrict Database Access in Supabase

1. Go to Supabase dashboard → **Settings** → **Database**
2. Scroll to **Connection Pooling** section
3. Note the **Pooler connection string** (different from direct connection)
4. For App Platform, you can use either:
   - **Direct connection**: `postgresql://postgres:password@host:5432/postgres`
   - **Pooler connection**: `postgresql://postgres:password@host:6543/postgres` (port 6543)

**Recommendation**: Use the pooler connection for better performance with App Platform.

#### 5.2 (Optional) Restrict by IP

1. In Supabase → **Settings** → **Database** → **Network Restrictions**
2. Add DigitalOcean App Platform IP ranges (if available)
3. **Note**: App Platform uses dynamic IPs, so this may not be practical

**Alternative**: Use Supabase's built-in SSL requirement (enabled by default) for security.

---

### Step 6: Test Your Deployment

#### 6.1 Check Application Logs

1. In DigitalOcean dashboard → Your App → **Runtime Logs**
2. Look for:
   - Successful database connection messages
   - Harvester startup messages
   - Parser initialization
   - Any error messages

#### 6.2 Verify Database Connection

Your application should automatically connect to Supabase. Check logs for:
- ✅ "Database connected successfully"
- ✅ "Tables created" (if your app creates tables)
- ❌ Any connection timeout or authentication errors

#### 6.3 Test Functionality

1. **Telegram Harvester**: Verify it's polling your Telegram channel
2. **Signal Parsing**: Check if messages are being parsed correctly
3. **Trade Execution**: Test with a small test trade (if using testnet)
4. **Monitoring**: Verify trade monitoring is working

---

### Step 7: Set Up Auto-Deploy (Optional)

#### 7.1 Enable Auto-Deploy from GitHub

1. In DigitalOcean → Your App → **Settings** → **App-Level Settings**
2. Under **GitHub**, ensure **"Deploy on push"** is enabled
3. Now, every push to your main branch will trigger a new deployment

#### 7.2 (Optional) Set Up Deployment Notifications

1. Go to **Settings** → **Notifications**
2. Add email notifications for deployment status
3. Or integrate with Slack/Discord webhooks

---

### Step 8: Managing the Worker (Start/Stop/Restart)

#### 8.1 Stop the Worker

**Via DigitalOcean Dashboard:**
1. Go to your app in DigitalOcean dashboard
2. Click on your app name
3. Go to **"Components"** tab
4. Find your Worker component
5. Click the **"..."** (three dots) menu next to the worker
6. Select **"Suspend"** to stop the worker

**Via DigitalOcean CLI (doctl):**
```bash
doctl apps list  # Get your app ID
doctl apps update <app-id> --spec app.yaml  # With suspended: true in spec
```

**What happens when stopped:**
- The bot stops polling Telegram/Discord channels
- Active trades continue to be monitored (if monitor is running elsewhere)
- No new trades will be initiated
- Database connections are closed gracefully
- The worker stops consuming resources (no charges while suspended)

#### 8.2 Start the Worker

**Via DigitalOcean Dashboard:**
1. Go to your app in DigitalOcean dashboard
2. Click on your app name
3. Go to **"Components"** tab
4. Find your Worker component (it will show "Suspended" status)
5. Click the **"..."** (three dots) menu next to the worker
6. Select **"Resume"** to start the worker

**Via DigitalOcean CLI:**
```bash
doctl apps update <app-id> --spec app.yaml  # With suspended: false in spec
```

**What happens when started:**
- The bot initializes database connection
- Schema is created/verified automatically
- Harvesters start polling channels
- Parsers begin processing messages
- Trade monitoring resumes
- The worker begins consuming resources again

#### 8.3 Restart the Worker

**Via DigitalOcean Dashboard:**
1. Go to your app in DigitalOcean dashboard
2. Click on your app name
3. Go to **"Components"** tab
4. Find your Worker component
5. Click the **"..."** (three dots) menu next to the worker
6. Select **"Restart"** to restart the worker

**Via DigitalOcean CLI:**
```bash
doctl apps create-deployment <app-id>
```

**When to restart:**
- After changing environment variables
- After code updates (auto-restarts on git push if auto-deploy is enabled)
- If the worker becomes unresponsive
- After database connection issues

**Note**: The bot handles graceful shutdown (SIGTERM/SIGINT signals), so it will:
- Stop accepting new messages
- Finish processing current operations
- Close database connections cleanly
- Stop all harvesters and monitors gracefully

---

### Step 9: Monitoring and Maintenance

#### 9.1 Set Up Health Checks

DigitalOcean App Platform automatically sets up health checks. To customize:

1. Go to **Settings** → **App-Level Settings**
2. Configure **Health Check**:
   - **Path**: `/` (or your health check endpoint)
   - **Interval**: 30 seconds
   - **Timeout**: 10 seconds
   - **Unhealthy Threshold**: 3

#### 9.2 Monitor Logs

1. **Runtime Logs**: Real-time application logs
2. **Build Logs**: Build and deployment logs
3. **Metrics**: CPU, memory, and request metrics

#### 9.3 Set Up Alerts

1. Go to **Settings** → **Alerts**
2. Configure alerts for:
   - High memory usage (>80%)
   - High CPU usage (>80%)
   - Deployment failures
   - App crashes

---

### Troubleshooting Common Issues

#### Issue: Database Connection Failed

**Symptoms**: Logs show "Connection refused" or "Authentication failed"

**Solutions**:
1. Verify `DATABASE_URL` is correct in environment variables
2. Check that password in connection string matches Supabase password
3. Ensure SSL is enabled (Supabase requires SSL)
4. Try using the pooler connection string (port 6543) instead of direct (port 5432)
5. Check Supabase dashboard → **Settings** → **Database** → **Connection Pooling** for correct URL

#### Issue: Build Fails

**Symptoms**: Build logs show errors during `npm ci` or `npm run build`

**Solutions**:
1. Check Node.js version in Dockerfile matches your local version
2. Verify all dependencies are in `package.json`
3. Check for TypeScript compilation errors locally first
4. Increase build timeout in app settings if build takes too long

#### Issue: Application Crashes on Startup

**Symptoms**: App starts but immediately crashes

**Solutions**:
1. Check runtime logs for error messages
2. Verify all required environment variables are set
3. Ensure `config.json` exists or all config is in environment variables
4. Verify database schema was created automatically (check logs for "Database initialized" message)
5. Verify file permissions for logs and data directories

#### Issue: High Memory Usage

**Symptoms**: App crashes or becomes unresponsive

**Solutions**:
1. Upgrade to Professional plan (2GB RAM) - $12/month
2. Optimize your code to reduce memory usage
3. Check for memory leaks in long-running processes
4. Consider reducing concurrent harvesters/parsers

#### Issue: Database Queries are Slow

**Symptoms**: High latency, timeouts

**Solutions**:
1. Use Supabase connection pooler (port 6543) instead of direct connection
2. Add database indexes for frequently queried columns
3. Consider upgrading Supabase plan if you exceed free tier limits
4. Check Supabase dashboard for query performance metrics

#### Issue: Environment Variables Not Working

**Symptoms**: App can't read environment variables

**Solutions**:
1. Verify environment variables are set in DigitalOcean dashboard
2. Check variable names match exactly (case-sensitive)
3. Ensure variables are set at app level, not component level
4. Restart the app after adding new environment variables

---

### Cost Optimization Tips

1. **Use Free Tier Database**: Supabase free tier (500MB) is sufficient for most personal bots
2. **Monitor Usage**: Check DigitalOcean and Supabase dashboards regularly
3. **Optimize Code**: Reduce memory and CPU usage to stay on Basic plan
4. **Set Budget Alerts**: Configure spending alerts in DigitalOcean
5. **Use Connection Pooling**: Reduces database connections and costs

---

### Next Steps After Deployment

1. ✅ **Monitor for 24-48 hours**: Watch logs and metrics
2. ✅ **Test all features**: Verify harvesters, parsers, and trading work correctly
3. ✅ **Set up backups**: Configure Supabase backups or manual exports
4. ✅ **Set up alerts**: Configure email/Slack notifications for errors
5. ✅ **Document your setup**: Save connection strings and credentials securely
6. ✅ **Test disaster recovery**: Know how to restore from backups

---

## Backup Strategy

### Managed Databases (Recommended)
- **Supabase**: Automatic daily backups, 7-day point-in-time recovery (free tier)
- **Neon**: Automatic backups, branching for point-in-time recovery
- **DigitalOcean**: Automatic daily backups, 7-day retention
- **AWS RDS**: Automatic backups, configurable retention

### Manual Backups
- Set up cron job to export database weekly
- Store backups in cloud storage (S3, Spaces, etc.)
- Test restore process periodically
- Consider cross-region backups for disaster recovery

---

## Monitoring & Alerts

### Built-in Monitoring
- **DigitalOcean**: Built-in health checks and logs
- **AWS**: CloudWatch monitoring
- **Supabase**: Built-in database monitoring dashboard
- **Neon**: Built-in metrics and monitoring

### Additional Monitoring
- **Uptime monitoring**: UptimeRobot (free tier, supports India)
- **Error tracking**: Sentry (free tier)
- **Logs**: Use provider's built-in logging or external service

---

## Security Considerations

1. **Environment Variables**: Never commit secrets to git
2. **Database**: Use SSL connections (all managed services require SSL)
3. **API Keys**: Rotate regularly
4. **Access Control**: Limit who can access cloud accounts
5. **Backups**: Encrypt sensitive data
6. **Network**: Use VPC/private networking when available
7. **Firewall**: Restrict database access to your app's IP only

---

## Support & Resources

- DigitalOcean Docs: https://docs.digitalocean.com
- Supabase Docs: https://supabase.com/docs
- Neon Docs: https://neon.tech/docs
- AWS Lightsail Docs: https://docs.aws.amazon.com/lightsail
- Oracle Cloud Docs: https://docs.oracle.com/en-us/iaas
- PostgreSQL Docs: https://www.postgresql.org/docs/

---

## Migration Path

### From SQLite to PostgreSQL
1. Export SQLite data to SQL dump
2. Create PostgreSQL database (Supabase, Neon, etc.)
3. Import data into PostgreSQL
4. Update config to use PostgreSQL
5. Test thoroughly
6. Deploy to cloud

### Between Cloud Providers
1. Export database from current provider
2. Set up new database in target provider
3. Import data
4. Update application configuration
5. Test and deploy
6. Monitor for issues
7. Decommission old setup

### Database Region Migration
1. Export database from current region
2. Create database in new region
3. Import data
4. Update connection string
5. Test latency and performance
6. Update application configuration
7. Monitor for issues
