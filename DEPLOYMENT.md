# Deployment Guide

This guide covers deploying Tigger to cloud platforms with PostgreSQL support. **Application hosting must be in India**, but the **database can be in any region**.

## Quick Start: DigitalOcean App Platform (India) + Supabase (Recommended)

### 1. Set Up Supabase Database

1. Go to [supabase.com](https://supabase.com) and create a free account
2. Click **New Project**
3. Fill in:
   - **Name**: Your project name
   - **Database Password**: Choose a strong password
   - **Region**: Choose any region (US or EU recommended for free tier)
4. Wait for database to be created (~2 minutes)
5. Go to **Settings** → **Database**
6. Copy the connection string (it looks like: `postgresql://postgres:[PASSWORD]@[HOST]:5432/postgres`)
7. Save this connection string for later

**Note**: Database region doesn't need to be India - US or EU regions work fine with ~100-200ms latency from India.

### 2. Set Up DigitalOcean App Platform

1. Go to [digitalocean.com](https://digitalocean.com) and create an account
2. Navigate to **Apps** → **Create App**
3. Connect your GitHub repository
4. DigitalOcean will auto-detect your Dockerfile
5. Configure:
   - **Region**: **Bangalore** (India region - required)
   - **Plan**: Basic ($5/month) - 512MB RAM
   - **Resource Type**: Web Service (always-on)

### 3. Configure Environment Variables

In DigitalOcean App Platform, go to your app → **Settings** → **App-Level Environment Variables** and add:

```bash
# Database (use Supabase connection string)
DATABASE_URL=postgresql://postgres:[PASSWORD]@[HOST]:5432/postgres
DATABASE_TYPE=postgresql

# Telegram API
TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash

# Bybit API
BYBIT_API_KEY=your_key
BYBIT_API_SECRET=your_secret

# Config (optional)
CONFIG_PATH=/app/config.json
LOG_LEVEL=info
```

**Note on LLM Fallback (Ollama):**
- DigitalOcean App Platform basic plan (512MB RAM) is **not sufficient** for running ollama
- For LLM fallback, you'll need at least 2GB RAM (Professional plan: $12/month)
- Alternatively, run ollama on a separate service or disable LLM fallback
- To disable: Simply don't include `ollama` configuration in your `config.json`

### 4. Add Config File

**Option A: Environment Variable (Recommended)**
1. Store your `config.json` as an environment variable named `CONFIG_JSON`
2. Create a startup script in your Dockerfile that writes it to `/app/config.json`

**Option B: DigitalOcean Spaces**
1. Upload `config.json` to DigitalOcean Spaces
2. Mount it as a volume or download on startup

**Option C: GitHub Secrets**
1. Store config in GitHub Secrets
2. Use GitHub Actions to deploy with config

### 5. Deploy

DigitalOcean will automatically deploy when you push to your repository. Check the **Runtime Logs** to ensure everything starts correctly.

---

## Alternative: AWS Lightsail (Mumbai) + Supabase

### 1. Set Up Supabase Database

Follow the same steps as above (Section 1).

### 2. Set Up AWS Lightsail

1. Go to [aws.amazon.com](https://aws.amazon.com) and create an account
2. Navigate to **Lightsail** → **Create Instance**
3. Select:
   - **Linux/Unix** platform
   - **Mumbai (ap-south-1)** region (India - required)
   - **$3.50/month** plan (512MB RAM) - **Note**: Not sufficient for ollama. Use $5/month (1GB) or $10/month (2GB) if using LLM fallback
4. After creation, connect via SSH
5. Install Docker and Docker Compose:

```bash
# Install Docker
sudo yum update -y
sudo yum install docker -y
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker ec2-user

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
```

### 3. Configure Environment Variables

Create a `.env` file on your Lightsail instance:

```bash
DATABASE_URL=postgresql://postgres:[PASSWORD]@[SUPABASE-HOST]:5432/postgres
DATABASE_TYPE=postgresql
TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash
BYBIT_API_KEY=your_key
BYBIT_API_SECRET=your_secret
CONFIG_PATH=/app/config.json
LOG_LEVEL=info
```

### 4. Deploy with Docker

**Without LLM fallback (512MB RAM sufficient):**
```bash
# On your Lightsail instance
git clone your-repo
cd your-repo
docker build -t tigger-bot .
docker run -d --name tigger --restart unless-stopped --env-file .env tigger-bot
```

**With LLM fallback (requires 2GB+ RAM):**
```bash
# On your Lightsail instance (upgrade to $10/month plan for 2GB RAM)
git clone your-repo
cd your-repo
docker-compose up -d  # Uses docker-compose.yml with ollama service
docker exec -it tigger-ollama ollama pull llama3.2:1b
```

**Note**: Update your `config.json` to use `"baseUrl": "http://ollama:11434"` when ollama is in Docker.

### 5. Set Up Auto-Deploy (Optional)

Use GitHub Actions or a simple script to pull updates and restart the container.

---

## Alternative: Oracle Cloud Free Tier (Mumbai) + Supabase

### 1. Set Up Supabase Database

Follow the same steps as above (Section 1).

### 2. Set Up Oracle Cloud Account

1. Go to [oracle.com/cloud](https://oracle.com/cloud) and sign up
2. Create a free tier account (no credit card required for free tier)
3. Select **Mumbai** as your home region

### 3. Create Compute Instance

1. Go to **Compute** → **Instances** → **Create Instance**
2. Select:
   - **Mumbai** region (India - required)
   - **VM.Standard.E2.1.Micro** (Always Free - 1GB RAM) - **Note**: May be tight for ollama. Consider paid instance (2GB+) if using LLM fallback
   - **Oracle Linux** or **Ubuntu**
3. Configure networking (allow HTTP/HTTPS if needed)
4. Create and connect via SSH

### 4. Install Docker and Deploy

```bash
# On Oracle Cloud instance
sudo yum update -y
sudo yum install docker -y
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker opc

# Clone and deploy
git clone your-repo
cd your-repo
docker build -t tigger-bot .
docker run -d --name tigger --restart unless-stopped \
  -e DATABASE_URL="postgresql://postgres:[PASSWORD]@[SUPABASE-HOST]:5432/postgres" \
  -e DATABASE_TYPE=postgresql \
  -e TELEGRAM_API_ID=your_id \
  -e TELEGRAM_API_HASH=your_hash \
  -e BYBIT_API_KEY=your_key \
  -e BYBIT_API_SECRET=your_secret \
  tigger-bot
```

**Cost**: **$0/month** (completely free)

---

## Alternative: DigitalOcean App Platform (India) + Neon

### 1. Set Up Neon Database

1. Go to [neon.tech](https://neon.tech) and create a free account
2. Click **Create Project**
3. Fill in:
   - **Project Name**: Your project name
   - **Region**: Choose any region (US or EU)
4. Wait for database to be created
5. Go to **Connection Details**
6. Copy the connection string
7. Save for later

### 2. Set Up DigitalOcean App Platform

Follow the same steps as the main guide (Section 2), but use Neon connection string instead of Supabase.

**Cost**: **$5/month** (hosting only, database free)

---

## Database Configuration

### Using PostgreSQL (Cloud)

In your `config.json`:

```json
{
  "database": {
    "type": "postgresql",
    "url": "postgresql://user:password@host:5432/dbname"
  }
}
```

Or use the `DATABASE_URL` environment variable (recommended for security).

### Using SQLite (Local Development)

In your `config.json`:

```json
{
  "database": {
    "type": "sqlite",
    "path": "data/trading_bot.db"
  }
}
```

---

## Environment Variables

The application supports the following environment variables:

- `DATABASE_TYPE`: `sqlite` or `postgresql` (defaults to `sqlite` if `DATABASE_URL` not set)
- `DATABASE_URL`: PostgreSQL connection string (takes precedence over config)
- `DATABASE_PATH`: SQLite database path (for SQLite only)
- `CONFIG_PATH`: Path to config.json file (default: `config.json`)
- `LOG_LEVEL`: Logging level (default: `info`)
- `TELEGRAM_API_ID`: Telegram API ID
- `TELEGRAM_API_HASH`: Telegram API hash
- `BYBIT_API_KEY`: Bybit API key
- `BYBIT_API_SECRET`: Bybit API secret

**Note**: LLM fallback parser (ollama) is optional. If not configured, the bot will use strict parsers only.

---

## Docker Deployment

### Using Dockerfile (Recommended)

Your existing Dockerfile works out of the box:

```bash
docker build -t tigger-bot .
docker run -d --name tigger --restart unless-stopped \
  --env-file .env \
  -v $(pwd)/config.json:/app/config.json:ro \
  tigger-bot
```

### Using Docker Compose

See `docker-compose.yml` in the repository for the full configuration. It includes an optional Ollama service for LLM fallback parsing.

**Basic setup (without LLM fallback):**
- Comment out the `ollama` service in `docker-compose.yml`
- Ensure your `config.json` doesn't include `ollama` configuration, or the LLM fallback will be disabled automatically

**With LLM fallback (ollama in Docker):**
- Keep the `ollama` service enabled in `docker-compose.yml`
- In your `config.json`, set `baseUrl` to `"http://ollama:11434"` (service name)
- Pull a model: `docker exec -it tigger-ollama ollama pull llama3.2:1b`

**Resource requirements:**
- Ollama needs at least 2GB RAM for small models (llama3.2:1b)
- Consider upgrading your hosting plan if using ollama
- For cloud deployments, ollama may not be feasible on free/low-tier plans

Run with:
```bash
docker-compose up -d
```

See `DOCKER.md` for detailed ollama configuration options.

---

## Migration from SQLite to PostgreSQL

### Step 1: Export SQLite Data

```bash
# Install sqlite3 if not already installed
sqlite3 data/trading_bot.db .dump > backup.sql
```

### Step 2: Convert SQL Dump for PostgreSQL

You'll need to:
1. Remove SQLite-specific syntax
2. Convert data types (BOOLEAN, TIMESTAMP, etc.)
3. Adjust AUTOINCREMENT to SERIAL

Or use a migration tool like `pgloader`:

```bash
# Install pgloader
sudo apt-get install pgloader

# Migrate to Supabase/Neon
pgloader sqlite://data/trading_bot.db postgresql://user:pass@host:5432/dbname
```

### Step 3: Update Configuration

Update your `config.json` or set `DATABASE_URL` environment variable.

### Step 4: Test Locally

Test the migration locally before deploying to production.

### Step 5: Deploy

Deploy to cloud with new database configuration.

---

## LLM Fallback (Ollama) Configuration

### Option 1: Disable LLM Fallback (Recommended for Cloud)

Simply don't include `ollama` configuration in your `config.json`. The bot will work fine with strict parsers only.

### Option 2: Run Ollama in Same Container (Not Recommended)

- Requires 2GB+ RAM
- Increases container size significantly
- Not recommended for cloud deployments

### Option 3: Run Ollama as Separate Service

**For Docker Compose deployments:**
- Use the `ollama` service in `docker-compose.yml`
- Set `baseUrl` to `"http://ollama:11434"` in config
- Requires 2GB+ RAM total (bot + ollama)

**For single-container deployments:**
- Run ollama on a separate VPS/instance
- Set `baseUrl` to the ollama instance's IP/domain
- Ensure network connectivity between services

### Resource Requirements

- **Without ollama**: 512MB RAM sufficient
- **With ollama (small model)**: 2GB RAM minimum
- **With ollama (larger model)**: 4GB+ RAM recommended

### Cost Impact

- **Basic plan ($3.50-5/month)**: Not sufficient for ollama
- **With ollama**: Upgrade to 2GB+ plan ($10-12/month)

**Recommendation**: Start without ollama. Add it later if needed and upgrade resources accordingly.

## Troubleshooting

### Database Connection Issues

**Problem**: Cannot connect to PostgreSQL database

**Solutions**:
- Verify `DATABASE_URL` is correct
- Check database firewall rules (Supabase/Neon allow all IPs by default)
- Ensure SSL is enabled (add `?sslmode=require` to connection string)
- Test connection from local machine first: `psql $DATABASE_URL`
- Check database logs in Supabase/Neon dashboard
- Verify database is not paused (Neon pauses inactive databases)

**Supabase**: Go to **Settings** → **Database** → Check connection string
**Neon**: Go to **Connection Details** → Verify connection string

### Application Won't Start

**Problem**: Application fails to start

**Solutions**:
- Check application logs: `docker logs tigger-bot`
- Verify all environment variables are set
- Ensure `config.json` is valid JSON
- Check database is accessible
- Verify Docker image builds correctly
- Check DigitalOcean/AWS logs for errors

### Performance Issues

**Problem**: Application is slow or timing out

**Solutions**:
- Check database connection pooling (Supabase/Neon include this automatically)
- Monitor database query performance in Supabase/Neon dashboard
- Check resource limits (RAM, CPU) on hosting platform
- Review application logs for errors
- Consider upgrading to higher tier if needed
- Database latency (100-200ms from India) is normal and acceptable

### Region-Specific Issues

**Problem**: High latency or connection issues

**Solutions**:
- **App in India, DB in US/EU**: 100-200ms latency is normal and acceptable for trading bots
- Use connection pooling (managed services handle this)
- Check network connectivity between app and database
- Consider same-region database if latency is critical (but costs more)
- Monitor database connection metrics in dashboard

### Database Paused (Neon Specific)

**Problem**: Neon database is paused

**Solutions**:
- Neon pauses inactive databases after 5 minutes
- First connection will auto-resume (takes ~1-2 seconds)
- This is normal behavior for Neon free tier
- Consider upgrading if you need always-on database

---

## Monitoring & Maintenance

### Health Checks

Set up health check endpoints (if you add them to your app):
- DigitalOcean: Built-in health checks
- AWS: Use CloudWatch or Lightsail monitoring
- Oracle: Use OCI monitoring

### Logs

View logs:
- **DigitalOcean**: App Platform → Runtime Logs
- **AWS Lightsail**: SSH into instance → `docker logs tigger-bot`
- **Oracle Cloud**: SSH into instance → `docker logs tigger-bot`
- **Supabase**: Dashboard → Logs
- **Neon**: Dashboard → Query Logs

### Backups

**Managed Databases**:
- **Supabase**: Automatic daily backups, 7-day point-in-time recovery (free tier)
- **Neon**: Automatic backups, branching for point-in-time recovery
- **DigitalOcean**: Automatic daily backups (7-day retention)
- **AWS RDS**: Automatic backups (configurable retention)

**Manual Backups**:
```bash
# Export PostgreSQL database
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d).sql

# Restore
psql $DATABASE_URL < backup_20240115.sql
```

### Updates

**Update Application**:
```bash
# Pull latest code
git pull

# Rebuild and restart
docker-compose down
docker-compose build
docker-compose up -d
```

**Update Database**:
- Managed databases update automatically
- Monitor for breaking changes in PostgreSQL versions

---

## Security Best Practices

1. **Never commit secrets**: Use environment variables or secrets management
2. **Use SSL connections**: Always use `sslmode=require` for database connections (Supabase/Neon require SSL)
3. **Rotate API keys**: Regularly rotate Telegram and Bybit API keys
4. **Limit access**: Use firewall rules to restrict database access (if available)
5. **Regular updates**: Keep Docker images and dependencies updated
6. **Backup encryption**: Encrypt database backups
7. **Monitor access**: Review logs for suspicious activity
8. **Database passwords**: Use strong, unique passwords for databases

---

## Cost Optimization

1. **Use free tier databases**: Supabase and Neon offer generous free tiers
2. **Right-size resources**: Start small, scale up if needed
3. **Monitor usage**: Set up billing alerts
4. **Clean up**: Remove unused resources
5. **Database region**: Using US/EU regions for database saves money (free tiers)
6. **Connection pooling**: Managed services handle this automatically (saves resources)

---

## Support & Resources

- **DigitalOcean Docs**: https://docs.digitalocean.com
- **Supabase Docs**: https://supabase.com/docs
- **Neon Docs**: https://neon.tech/docs
- **AWS Lightsail Docs**: https://docs.aws.amazon.com/lightsail
- **Oracle Cloud Docs**: https://docs.oracle.com/en-us/iaas
- **PostgreSQL Docs**: https://www.postgresql.org/docs/
- **Docker Docs**: https://docs.docker.com

---

## Next Steps

1. Choose your hosting provider in India (DigitalOcean recommended for simplicity)
2. Set up database (Supabase free tier recommended)
3. Set up hosting platform
4. Configure environment variables
5. Deploy application
6. Set up monitoring and alerts
7. Test thoroughly
8. Set up backup strategy

---

## Database Region Selection Guide

### When to Use US/EU Database Regions (Recommended for Free Tiers)
- ✅ Want to use free tier databases (Supabase, Neon)
- ✅ 100-200ms latency is acceptable
- ✅ Want to save money
- ✅ Trading bot has low database query frequency

### When to Use India Database Region
- ✅ Need absolute lowest latency (<10ms)
- ✅ High database query frequency
- ✅ Compliance requires data in India
- ✅ Willing to pay more ($15-20/month vs $0/month)

**Recommendation**: Start with US/EU region database (Supabase/Neon free tier). If latency becomes an issue, migrate to India region database later.
