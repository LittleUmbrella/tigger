# Docker Setup Guide

## Running with Docker

### Basic Setup

1. **Build and run:**
   ```bash
   docker-compose up -d
   ```

2. **View logs:**
   ```bash
   docker-compose logs -f tigger-bot
   ```

### Ollama/LLM Fallback Configuration

The LLM fallback parser requires an Ollama service. You have two options:

#### Option 1: Ollama in Docker (Recommended)

The `docker-compose.yml` includes an Ollama service. This is the easiest setup:

1. **Start both services:**
   ```bash
   docker-compose up -d
   ```

2. **Pull a model (first time only):**
   ```bash
   docker exec -it tigger-ollama ollama pull llama3.2:1b
   ```

3. **Configure in `config.json`:**
   ```json
   {
     "parsers": [
       {
         "name": "main_parser",
         "channel": "your_channel",
         "ollama": {
           "baseUrl": "http://ollama:11434",
           "model": "llama3.2:1b"
         }
       }
     ]
   }
   ```

   Note: Use `http://ollama:11434` (service name) instead of `localhost` when ollama is in Docker.

#### Option 2: Ollama on Host Machine

If you're running Ollama on your host machine (outside Docker):

1. **Comment out the ollama service** in `docker-compose.yml`:
   ```yaml
   # ollama:
   #   image: ollama/ollama:latest
   #   ...
   ```

2. **Update docker-compose.yml** to use host network or special hostname:

   **For Mac/Windows:**
   ```yaml
   services:
     tigger-bot:
       # ... other config ...
       extra_hosts:
         - "host.docker.internal:host-gateway"
   ```

   **For Linux:**
   ```yaml
   services:
     tigger-bot:
       # ... other config ...
       network_mode: "host"  # This gives container access to host network
   ```

3. **Configure in `config.json`:**
   
   **Mac/Windows:**
   ```json
   {
     "ollama": {
       "baseUrl": "http://host.docker.internal:11434"
     }
   }
   ```
   
   **Linux (with host network mode):**
   ```json
   {
     "ollama": {
       "baseUrl": "http://localhost:11434"
     }
   }
   ```

### PostgreSQL Database Configuration

The `docker-compose.yml` includes a PostgreSQL service for testing with PostgreSQL (matching DigitalOcean production setup).

#### Connection String Format

PostgreSQL connection strings follow this format:
```
postgresql://[user]:[password]@[host]:[port]/[database]
```

**Components:**
- `user`: PostgreSQL username
- `password`: PostgreSQL password
- `host`: Database hostname or IP address
- `port`: PostgreSQL port (default: 5432)
- `database`: Database name

#### Docker Compose Setup

**IMPORTANT: For security, use environment variables for database connection strings. Never put credentials in `config.json`.**

The `DATABASE_URL` environment variable is already set in `docker-compose.yml`:
```
postgresql://tigger_user:tigger_password@postgres:5432/tigger_db
```

**To use PostgreSQL in docker-compose:**

1. **Update your `config.json`** (safe to commit - no credentials):
   ```json
   {
     "database": {
       "type": "postgresql"
     }
   }
   ```
   
   The bot will automatically read the connection string from the `DATABASE_URL` environment variable.

2. **Start services:**
   ```bash
   docker-compose up -d
   ```

**Note:** 
- The bot will automatically create all required database tables on first run
- The `DATABASE_URL` environment variable takes precedence over any `url` field in config.json
- For production, set `DATABASE_URL` in your hosting platform's environment variables

#### Connection String Examples

**Set these as `DATABASE_URL` environment variable (never in config.json):**

**Docker Compose (local testing):**
```env
DATABASE_URL=postgresql://tigger_user:tigger_password@postgres:5432/tigger_db
```

**Supabase (production):**
```env
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.xxxxx.supabase.co:5432/postgres
```

**Supabase Connection Pooler (recommended for production):**
```env
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.xxxxx.supabase.co:6543/postgres
```

**Neon (production):**
```env
DATABASE_URL=postgresql://user:password@ep-xxxxx.us-east-2.aws.neon.tech:5432/neondb
```

**DigitalOcean Managed PostgreSQL:**
```env
DATABASE_URL=postgresql://doadmin:password@db-postgresql-xxxxx-do-user-xxxxx-0.db.ondigitalocean.com:25060/defaultdb?sslmode=require
```

**Local PostgreSQL (host machine):**
```env
DATABASE_URL=postgresql://postgres:password@host.docker.internal:5432/tigger_db
```

**Your `config.json` should only specify the database type:**
```json
{
  "database": {
    "type": "postgresql"
  }
}
```

#### Security Notes

- **Never put connection strings with passwords in `config.json`** - it should be safe to commit to version control
- **Always use environment variables (`DATABASE_URL`)** for database connection strings
- The docker-compose credentials (`tigger_user`/`tigger_password`) are fine for local development only
- For production, use strong passwords and consider connection pooling
- The `DATABASE_URL` environment variable takes precedence over any `url` field in config.json

#### Accessing PostgreSQL from Host Machine

The PostgreSQL port is exposed on `localhost:5432`, so you can connect from your host machine:

```bash
# Using psql
psql -h localhost -p 5432 -U tigger_user -d tigger_db

# Using connection string
psql "postgresql://tigger_user:tigger_password@localhost:5432/tigger_db"
```

### Environment Variables

Create a `.env` file in the project root:

```env
# Telegram
TG_SESSION=your_session_string
TG_API_HASH=your_api_hash

# Bybit (if not using testnet)
BYBIT_API_KEY=your_api_key
BYBIT_API_SECRET=your_api_secret

# Database (optional, defaults to SQLite)
# For SQLite:
DATABASE_TYPE=sqlite
DATABASE_PATH=/app/data/trading_bot.db

# For PostgreSQL (docker-compose):
# DATABASE_URL is already set in docker-compose.yml
# Or override it here (NEVER put this in config.json):
# DATABASE_URL=postgresql://tigger_user:tigger_password@postgres:5432/tigger_db
```

### Volumes

The following directories are mounted as volumes:
- `./config.json` → `/app/config.json` (read-only)
- `./data` → `/app/data` (database files, only used for SQLite)
- `./logs` → `/app/logs` (log files)
- `postgres-data` → PostgreSQL data (managed by Docker, persists database between restarts)

### GPU Support (Optional)

If you have an NVIDIA GPU and want to use it for Ollama:

1. Install [nvidia-docker](https://github.com/NVIDIA/nvidia-docker)

2. Uncomment the GPU configuration in `docker-compose.yml`:
   ```yaml
   ollama:
     deploy:
       resources:
         reservations:
           devices:
             - driver: nvidia
               count: 1
               capabilities: [gpu]
   ```

3. Restart the services:
   ```bash
   docker-compose down
   docker-compose up -d
   ```

### Troubleshooting

**PostgreSQL connection errors:**
- Check that postgres service is running: `docker-compose ps`
- Verify the connection string in config.json matches docker-compose setup
- Check PostgreSQL logs: `docker-compose logs postgres`
- Verify health check: `docker-compose ps` should show postgres as "healthy"
- Test connection: `docker exec -it tigger-bot psql "postgresql://tigger_user:tigger_password@postgres:5432/tigger_db" -c "SELECT 1;"`

**Database schema not created:**
- The bot automatically creates schema on first run
- Check bot logs: `docker-compose logs -f tigger-bot`
- Look for "Database initialized" message
- If schema creation fails, check PostgreSQL logs for errors

**Ollama connection errors:**
- Check that ollama service is running: `docker-compose ps`
- Verify the baseUrl in config.json matches your setup
- Check network connectivity: `docker exec -it tigger-bot ping ollama` (if using containerized ollama)

**Permission errors:**
- Ensure the `data` and `logs` directories exist and are writable
- On Linux, you may need to adjust ownership: `sudo chown -R $USER:$USER data logs`

**Model not found:**
- Pull the model: `docker exec -it tigger-ollama ollama pull llama3.2:1b`
- Verify model is available: `docker exec -it tigger-ollama ollama list`

