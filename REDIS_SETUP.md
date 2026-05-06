# Redis Integration for WhatsApp Bot

## Overview
Redis has been successfully integrated into the Docker environment to provide persistent caching, session management, and state storage capabilities for the WhatsApp bot.

## Architecture

### Services
The docker-compose setup now includes three services:
1. **redis** - Redis 7 Alpine (port 6379)
2. **n8n** - Workflow automation (port 5678)
3. **baileys** - WhatsApp bot (port 3001)

### Configuration

#### Redis Service
- **Image**: redis:7-alpine
- **Port**: 6379 (exposed to host)
- **Volume**: `redis_data:/data` (persistent storage)
- **Persistence**: AOF (Append-Only File) enabled with `--appendonly yes`
- **Health Check**: `redis-cli ping` every 10 seconds
- **Restart Policy**: unless-stopped

#### Baileys Service
- **Dependency**: Waits for Redis to be healthy before starting
- **Environment Variable**: `REDIS_URL=redis://redis:6379`
- **Connection**: Auto-connects on startup via Redis client

## API Endpoints

The Baileys service exposes the following Redis endpoints:

### 1. Health Check
```bash
GET http://localhost:3001/redis/health
```
**Response:**
```json
{
  "success": true,
  "connected": true,
  "status": "connected"
}
```

### 2. Set Cache
```bash
POST http://localhost:3001/redis/set
Content-Type: application/json

{
  "key": "my_key",
  "value": "my_value",
  "ttl": 3600
}
```
**Response:**
```json
{
  "success": true,
  "message": "Value cached successfully"
}
```
**Note**: TTL (time-to-live) is in seconds. Default is 3600 (1 hour).

### 3. Get Cache
```bash
GET http://localhost:3001/redis/get/:key
```
**Example:**
```bash
GET http://localhost:3001/redis/get/my_key
```
**Response (Success):**
```json
{
  "success": true,
  "key": "my_key",
  "value": "my_value"
}
```
**Response (Not Found):**
```json
{
  "success": false,
  "key": "my_key",
  "value": null
}
```

### 4. Delete Cache
```bash
DELETE http://localhost:3001/redis/delete/:key
```
**Example:**
```bash
DELETE http://localhost:3001/redis/delete/my_key
```
**Response:**
```json
{
  "success": true,
  "message": "Key deleted successfully"
}
```

## Redis Helper Functions

The following helper functions are available in `index.js`:

### setCache(key, value, expirationSeconds = 3600)
```javascript
await setCache('user:123', { name: 'John', status: 'active' }, 1800);
```

### getCache(key)
```javascript
const userData = await getCache('user:123');
```

### deleteCache(key)
```javascript
await deleteCache('user:123');
```

## Usage Examples

### PowerShell
```powershell
# Health Check
Invoke-WebRequest -Uri http://localhost:3001/redis/health -UseBasicParsing | Select-Object -ExpandProperty Content

# Set a value
$body = @{ key = 'test'; value = 'Hello'; ttl = 300 } | ConvertTo-Json
Invoke-WebRequest -Uri http://localhost:3001/redis/set -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing | Select-Object -ExpandProperty Content

# Get a value
Invoke-WebRequest -Uri http://localhost:3001/redis/get/test -UseBasicParsing | Select-Object -ExpandProperty Content

# Delete a value
Invoke-WebRequest -Uri http://localhost:3001/redis/delete/test -Method DELETE -UseBasicParsing | Select-Object -ExpandProperty Content
```

### cURL (Linux/Mac)
```bash
# Health Check
curl http://localhost:3001/redis/health

# Set a value
curl -X POST http://localhost:3001/redis/set \
  -H "Content-Type: application/json" \
  -d '{"key":"test","value":"Hello","ttl":300}'

# Get a value
curl http://localhost:3001/redis/get/test

# Delete a value
curl -X DELETE http://localhost:3001/redis/delete/test
```

## Use Cases

### 1. Handover State Persistence
Store which users are in handover mode:
```javascript
// Set handover for 30 minutes
await setCache(`handover:${phoneNumber}`, true, 1800);

// Check handover status
const isHandover = await getCache(`handover:${phoneNumber}`);

// Remove handover
await deleteCache(`handover:${phoneNumber}`);
```

### 2. Message Buffer State
Store message buffers across restarts:
```javascript
// Save buffer
await setCache(`buffer:${userId}`, { messages: [...], timestamp: Date.now() }, 60);

// Retrieve buffer
const buffer = await getCache(`buffer:${userId}`);
```

### 3. Rate Limiting
Track API calls per user:
```javascript
// Increment counter
const count = (await getCache(`rate:${userId}`)) || 0;
await setCache(`rate:${userId}`, count + 1, 60); // 1 minute window
```

### 4. Session Caching
Cache WhatsApp session data:
```javascript
// Cache session info
await setCache(`session:${phoneNumber}`, { connected: true, lastSeen: Date.now() }, 3600);
```

## Docker Commands

### Start all services
```bash
docker-compose up -d
```

### View Redis logs
```bash
docker logs redis
```

### Stop all services
```bash
docker-compose down
```

### Stop and remove volumes (clear all data)
```bash
docker-compose down -v
```

### Access Redis CLI
```bash
docker exec -it redis redis-cli
```

### Monitor Redis commands
```bash
docker exec -it redis redis-cli MONITOR
```

### Check Redis info
```bash
docker exec -it redis redis-cli INFO
```

## Data Persistence

Redis data is persisted in the `redis_data` Docker volume. This ensures:
- Data survives container restarts
- Data survives service updates
- AOF provides write durability

To backup Redis data:
```bash
docker exec redis redis-cli BGSAVE
```

## Connection Details

- **Host** (from host machine): `localhost:6379`
- **Host** (from other containers): `redis:6379`
- **Connection URL**: `redis://redis:6379`

## Dependencies

The following npm package is required:
```json
{
  "redis": "^4.7.0"
}
```

## Troubleshooting

### Check Redis is running
```bash
docker ps | findstr redis
```

### Check Redis health
```bash
docker exec redis redis-cli ping
```
Should return: `PONG`

### View Redis logs for errors
```bash
docker logs redis --tail 50
```

### Check Redis connection from baileys
```bash
docker logs baileys | findstr Redis
```
Should show: `✅ Redis connected successfully`

### Restart Redis service
```bash
docker-compose restart redis
```

## Security Notes

- Redis is exposed on port 6379 for development
- For production, add password authentication:
  ```yaml
  command: redis-server --appendonly yes --requirepass yourpassword
  ```
- Update connection string:
  ```javascript
  const redisClient = createClient({
    url: `redis://:yourpassword@redis:6379`
  });
  ```

## Next Steps

Recommended integrations:
1. ✅ Redis service setup complete
2. ✅ Redis client connection established
3. ✅ Helper functions created
4. ✅ API endpoints exposed
5. ⏳ Integrate with handover system (store handoverUsers in Redis)
6. ⏳ Integrate with message buffer (persist buffer state)
7. ⏳ Add rate limiting for API endpoints
8. ⏳ Cache WhatsApp session metadata
