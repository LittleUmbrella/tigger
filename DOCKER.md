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
DATABASE_TYPE=sqlite
DATABASE_PATH=/app/data/trading_bot.db

# Or for PostgreSQL
# DATABASE_TYPE=postgresql
# DATABASE_URL=postgresql://user:password@host:5432/dbname
```

### Volumes

The following directories are mounted as volumes:
- `./config.json` → `/app/config.json` (read-only)
- `./data` → `/app/data` (database files)
- `./logs` → `/app/logs` (log files)

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

