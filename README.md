# Log File Viewer

A web service for reading and filtering `.log` files with memory-efficient streaming and advanced filtering capabilities.

## Features

- **Guest Access**: No user authentication required - uses session-based file isolation
- **File Upload**: Upload multiple `.log` files (only `.log` extension accepted)
- **Memory Efficient**: Streams large log files without loading entire file into memory
- **Filter Presets**: Define and load reusable filter presets from JSON file
- **Multiple Filters**:
  - Filter by date range (always applies as AND)
  - Include/exclude specific strings
  - Combine content filters with AND/OR logic
- **File Management**:
  - Upload multiple files and switch between them
  - Delete files manually
  - Automatic daily cleanup of files older than 24 hours at 2 AM
- **Exception Handling**: Gracefully handles logs without timestamps
- **Production Ready**: Docker support with multi-architecture builds

## Quick Start with Docker

The easiest way to run the application is using Docker:

```bash
# Set environment variables
export GITHUB_REPOSITORY=yourusername/log-reader
export VERSION=latest
export SECRET_KEY=your-secure-secret-key

# Pull and run from GitHub Container Registry
docker-compose up -d
```

Or manually:

```bash
docker pull ghcr.io/yourusername/log-reader:latest
docker run -d -p 5001:5001 -e SECRET_KEY=your-secret-key ghcr.io/yourusername/log-reader:latest
```

Then open your browser and navigate to:
```
http://localhost:5001
```

### Uploads Folder Permissions (docker-compose)

The container runs as a non-root user with UID/GID `1000` and bind-mounts `./uploads` from the same directory as `docker-compose.yml`. Make sure that local folder is writable by that user before starting:

```bash
mkdir -p uploads
# Prefer matching the container user
sudo chown -R 1000:1000 uploads
# If you can't change ownership, loosen permissions instead
chmod -R 775 uploads
```

On Linux with SELinux you may also need to add `:z` to the volume entry (`- ./uploads:/app/uploads:z`).

## Docker Deployment

### Building Locally

To build the Docker image locally:

```bash
docker build -t log-reader:latest .
```

### Automated Builds

The project includes a GitHub Actions workflow that automatically builds and pushes Docker images to GitHub Container Registry (GHCR) when code is merged to the `main` or `master` branch.

The workflow:
- Builds multi-architecture images (linux/amd64, linux/arm64)
- Tags images with version from VERSION file
- Tags images as `latest` on default branch
- Uses build cache for faster builds

To use automated builds:
1. Push code to `main` or `master` branch
2. GitHub Actions will build and push the image to `ghcr.io/yourusername/log-reader`
3. Update `docker-compose.yml` with your repository name
4. Pull and run with `docker-compose up -d`

## Development Setup

### Requirements

- Python 3.11+
- Flask
- APScheduler
- Gunicorn (for production)

### Installation

1. Install dependencies:
```bash
pip install -r requirements.txt
```

2. Start the development server:
```bash
python app.py
```

3. Open your browser and navigate to:
```
http://localhost:5001
```

4. Upload a `.log` file and start filtering!

## API Endpoints

### Upload File
```
POST /api/upload
Content-Type: multipart/form-data

Response: { "success": true, "file": {...} }
```

### List Files
```
GET /api/files

Response: { "files": [...] }
```

### Delete File
```
DELETE /api/files/<file_id>

Response: { "success": true }
```

### Get Filtered Logs
```
POST /api/logs/<file_id>
Content-Type: application/json

Body: {
  "start_date": "2025-11-19T08:00:00",
  "end_date": "2025-11-19T09:00:00",
  "include": ["string1", "string2"],
  "exclude": ["string3"],
  "logic": "AND"
}

Response: { "lines": [...], "total": 1234 }
```

### Get Presets
```
GET /api/presets

Response: { "success": true, "presets": [...] }
```

## Filter Presets

You can create reusable filter presets in `presets.json` file. Presets allow you to quickly apply common filter combinations.

### Preset File Format

Create a `presets.json` file in the same directory as `docker-compose.yml`:

```json
[
  {
    "name": "Errors Only",
    "includes": ["ERROR", "FATAL"],
    "excludes": [],
    "logic": "OR"
  },
  {
    "name": "Warnings and Errors",
    "includes": ["WARN", "ERROR"],
    "excludes": [],
    "logic": "OR"
  },
  {
    "name": "Database Operations",
    "includes": ["SQL", "query", "database", "DB"],
    "excludes": [],
    "logic": "OR"
  }
]
```

### Preset Fields

- **name** (required): Display name for the preset
- **includes** (array): List of strings to include in logs
- **excludes** (array): List of strings to exclude from logs
- **logic** (string): Either "AND" or "OR" - applies to include/exclude filters only

### Using Presets

1. Select a preset from the "Load Preset" dropdown
2. The include/exclude filters and logic will be populated automatically
3. Date range is NOT affected by presets - set it manually
4. You can add additional filters after loading a preset
5. The selected preset stays selected even when you modify filters

### Hot Reloading

Presets are loaded fresh each time you reload the page. To update presets:
1. Edit the `presets.json` file
2. Reload the page in your browser
3. New presets will be available immediately

### Error Handling

- If `presets.json` is missing, the app works normally without presets
- Invalid JSON syntax will be reported in the API response
- Invalid preset entries are skipped (e.g., missing "name" field)

## Configuration

### Environment Variables

- **SECRET_KEY**: (Required in production) Secret key for Flask session management
  - Default in docker-compose: `change-this-secret-key-in-production`
  - Set a secure random string in production

### Application Settings

- **Upload Folder**: `uploads/` (created automatically, persisted in Docker volume)
- **Max File Size**: 500MB
- **Port**: 5001
- **Cleanup Schedule**:
  - Daily full cleanup at 2:00 AM (deletes all files)
  - Hourly cleanup of unreferenced files
- **File Deduplication**: SHA-256 hash-based with reference counting

## Development

The application uses:
- **Backend**: Flask (Python)
- **Frontend**: Vanilla JavaScript with modern CSS
- **Scheduler**: APScheduler for automated cleanup
- **Session Management**: Flask sessions for guest user isolation

## Security Notes

### Application Security
- **Session Isolation**: Files are isolated per session (guest users can only see their own files)
- **File Validation**: Only `.log` file extensions accepted
- **File Size Limit**: 500MB maximum upload size
- **Secret Key**: Always set a secure `SECRET_KEY` environment variable in production

### Docker Security
- **Non-root User**: Application runs as non-root user (`appuser`) inside container
- **Read-only Filesystem**: Only `/app/uploads` is writable
- **Health Checks**: Container includes health check endpoint for monitoring
- **Multi-architecture**: Supports both AMD64 and ARM64 platforms

## License

MIT
