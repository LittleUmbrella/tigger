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
