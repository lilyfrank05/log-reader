"""Main Flask application for log file viewer"""
import os
import uuid
import hashlib
import json
import logging
import time
from datetime import datetime
from pathlib import Path
from flask import Flask, request, jsonify, session, send_from_directory
from flask_session import Session
from werkzeug.utils import secure_filename
from apscheduler.schedulers.background import BackgroundScheduler
from dateutil import parser as date_parser
import redis

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Import custom modules
from utils import read_last_lines, parse_timestamp
from filters import stream_filtered_logs
from cleanup import cleanup_old_files, daily_full_cleanup

# Initialize Flask app
app = Flask(__name__, static_folder='static')
app.secret_key = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500MB max file size
app.config['MAX_RESULTS'] = 50000  # Maximum number of log lines to return

# Configure Redis session
app.config['SESSION_TYPE'] = 'redis'
app.config['SESSION_PERMANENT'] = False
app.config['SESSION_USE_SIGNER'] = True
app.config['SESSION_KEY_PREFIX'] = 'logviewer:'
redis_url = os.environ.get('REDIS_URL', 'redis://localhost:6379/0')
app.config['SESSION_REDIS'] = redis.from_url(redis_url)

# Initialize session
Session(app)

# Create Redis client for file metadata with optimized connection pool
redis_client = redis.from_url(
    redis_url,
    decode_responses=True,
    max_connections=20,  # Increased pool size for multi-worker setup
    socket_keepalive=True,
    socket_connect_timeout=5,
    retry_on_timeout=True
)

# Ensure upload directory exists
Path(app.config['UPLOAD_FOLDER']).mkdir(exist_ok=True)


# ============================================================================
# Redis Helper Functions for File Metadata
# ============================================================================

def get_session_files_key(session_id):
    """Get Redis key for session files list"""
    return f"files:session:{session_id}"


def get_file_hash_key(file_hash):
    """Get Redis key for file hash mapping"""
    return f"files:hash:{file_hash}"


def get_user_files(session_id):
    """Get list of files uploaded by this session from Redis"""
    key = get_session_files_key(session_id)
    files_json = redis_client.get(key)
    if files_json:
        return json.loads(files_json)
    return []


def has_file_hash(session_id, file_hash):
    """Check if user already uploaded a file with this hash (fast Redis SET check)"""
    key = f"files:session:{session_id}:hashes"
    return redis_client.sismember(key, file_hash)


def add_file_hash_to_session(session_id, file_hash):
    """Add file hash to user's set of uploaded hashes"""
    key = f"files:session:{session_id}:hashes"
    redis_client.sadd(key, file_hash)


def add_file_to_session(session_id, file_info):
    """Add a file to session's file list in Redis"""
    files = get_user_files(session_id)
    files.append(file_info)
    key = get_session_files_key(session_id)
    redis_client.set(key, json.dumps(files))
    # Also add to hash set for fast duplicate checking
    add_file_hash_to_session(session_id, file_info['hash'])


def remove_file_from_session(session_id, file_id):
    """Remove a file from session's file list in Redis"""
    files = get_user_files(session_id)
    # Find the file to get its hash before removing
    file_hash = None
    for f in files:
        if f['id'] == file_id:
            file_hash = f.get('hash')
            break

    files = [f for f in files if f['id'] != file_id]
    key = get_session_files_key(session_id)
    if files:
        redis_client.set(key, json.dumps(files))
    else:
        redis_client.delete(key)

    # Remove hash from the set
    if file_hash:
        hash_set_key = f"files:session:{session_id}:hashes"
        redis_client.srem(hash_set_key, file_hash)
    return files


def get_file_hash_mapping(file_hash):
    """Get stored filename for a file hash from Redis"""
    key = get_file_hash_key(file_hash)
    return redis_client.get(key)


def set_file_hash_mapping(file_hash, stored_name):
    """Set stored filename for a file hash in Redis"""
    key = get_file_hash_key(file_hash)
    redis_client.set(key, stored_name)


def delete_file_hash_mapping(file_hash):
    """Delete file hash mapping from Redis"""
    key = get_file_hash_key(file_hash)
    redis_client.delete(key)


def get_all_session_ids():
    """Get all session IDs that have uploaded files"""
    keys = redis_client.keys("files:session:*")
    return [key.replace("files:session:", "") for key in keys]


# ============================================================================
# Helper Functions
# ============================================================================

def allowed_file(filename):
    """Check if file has .log extension"""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() == 'log'


def get_session_id():
    """Get or create session ID for guest user"""
    if 'session_id' not in session:
        session['session_id'] = str(uuid.uuid4())
    return session['session_id']


def calculate_file_hash(file_stream):
    """Calculate MD5 hash of file contents (faster than SHA-256 for deduplication)"""
    md5_hash = hashlib.md5()
    # Read file in larger chunks for better performance
    for byte_block in iter(lambda: file_stream.read(65536), b""):
        md5_hash.update(byte_block)
    # Reset file pointer to beginning
    file_stream.seek(0)
    return md5_hash.hexdigest()


# ============================================================================
# Routes
# ============================================================================

@app.route('/')
def index():
    """Serve the main HTML page"""
    return send_from_directory('static', 'index.html')


@app.route('/api/upload', methods=['POST'])
def upload_file():
    """Handle file upload"""
    upload_start = time.time()
    session_id = get_session_id()

    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['file']

    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    if not allowed_file(file.filename):
        return jsonify({'error': 'Only .log files are allowed'}), 400

    original_filename = secure_filename(file.filename)
    file_size = file.content_length or 0

    logger.info(f"[UPLOAD START] Session: {session_id[:8]}... | File: {original_filename} | Size: {file_size / 1024 / 1024:.2f}MB")

    # Calculate file hash to check for duplicates
    hash_start = time.time()
    file_hash = calculate_file_hash(file.stream)
    file.stream.seek(0)  # Reset file pointer after hashing
    hash_time = time.time() - hash_start
    logger.info(f"[HASH COMPLETE] Session: {session_id[:8]}... | Hash: {file_hash[:12]}... | Time: {hash_time:.2f}s")

    # Fast check if this user already uploaded this exact file (using Redis SET)
    dup_check_start = time.time()
    if has_file_hash(session_id, file_hash):
        # Find the existing file info
        user_files = get_user_files(session_id)
        for existing_file in user_files:
            if existing_file.get('hash') == file_hash:
                dup_check_time = time.time() - dup_check_start
                total_time = time.time() - upload_start
                logger.info(f"[DUPLICATE DETECTED] Session: {session_id[:8]}... | File: {original_filename} | Dup check: {dup_check_time:.2f}s | Total: {total_time:.2f}s")
                return jsonify({
                    'success': True,
                    'file': existing_file,
                    'duplicate': True,
                    'message': 'You have already uploaded this file'
                })
    dup_check_time = time.time() - dup_check_start
    logger.info(f"[DUP CHECK] Session: {session_id[:8]}... | Time: {dup_check_time:.3f}s | Result: Not duplicate")

    # Check if this file exists globally (uploaded by another user)
    global_check_start = time.time()
    stored_name = get_file_hash_mapping(file_hash)
    if stored_name:
        # Reuse the existing file, but create a new reference for this user
        logger.info(f"[GLOBAL REUSE] Session: {session_id[:8]}... | Reusing stored file: {stored_name}")
    else:
        # New file - save it and add to global hash map
        save_start = time.time()
        stored_name = f"{uuid.uuid4()}_{original_filename}"
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], stored_name)
        file.save(file_path)
        save_time = time.time() - save_start
        logger.info(f"[FILE SAVE] Session: {session_id[:8]}... | Saved as: {stored_name} | Time: {save_time:.2f}s")
        set_file_hash_mapping(file_hash, stored_name)
    global_check_time = time.time() - global_check_start

    # Create a unique file reference for this user
    redis_start = time.time()
    file_info = {
        'id': str(uuid.uuid4()),
        'original_name': original_filename,
        'stored_name': stored_name,
        'hash': file_hash,
        'upload_time': datetime.now().isoformat()
    }
    add_file_to_session(session_id, file_info)
    redis_time = time.time() - redis_start

    total_time = time.time() - upload_start
    logger.info(f"[UPLOAD COMPLETE] Session: {session_id[:8]}... | File: {original_filename} | " +
                f"Hash: {hash_time:.2f}s | Global: {global_check_time:.2f}s | Redis: {redis_time:.3f}s | Total: {total_time:.2f}s")

    return jsonify({
        'success': True,
        'file': file_info,
        'duplicate': False
    })


@app.route('/api/files', methods=['GET'])
def list_files():
    """List all files uploaded by this session"""
    session_id = get_session_id()
    files = get_user_files(session_id)
    return jsonify({'files': files})


@app.route('/api/presets', methods=['GET'])
def get_presets():
    """Load presets from presets.json file with hot-reload support"""
    presets_file = 'presets.json'

    try:
        # Check if file exists
        if not os.path.exists(presets_file):
            return jsonify({
                'success': True,
                'presets': [],
                'message': 'No presets file found'
            })

        # Read and parse JSON file
        with open(presets_file, 'r') as f:
            presets = json.load(f)

        # Validate presets structure
        if not isinstance(presets, list):
            return jsonify({
                'success': False,
                'error': 'Invalid presets format: root must be an array'
            }), 400

        # Validate each preset
        validated_presets = []
        for idx, preset in enumerate(presets):
            if not isinstance(preset, dict):
                continue

            # Check required fields
            if 'name' not in preset:
                continue

            # Validate and set defaults
            validated_preset = {
                'name': str(preset['name']),
                'includes': preset.get('includes', []) if isinstance(preset.get('includes'), list) else [],
                'excludes': preset.get('excludes', []) if isinstance(preset.get('excludes'), list) else [],
                'logic': preset.get('logic', 'AND') if preset.get('logic') in ['AND', 'OR'] else 'AND'
            }

            # Convert all includes/excludes to strings
            validated_preset['includes'] = [str(item) for item in validated_preset['includes']]
            validated_preset['excludes'] = [str(item) for item in validated_preset['excludes']]

            validated_presets.append(validated_preset)

        return jsonify({
            'success': True,
            'presets': validated_presets
        })

    except json.JSONDecodeError as e:
        return jsonify({
            'success': False,
            'error': f'Invalid JSON syntax: {str(e)}'
        }), 400
    except Exception as e:
        return jsonify({
            'success': False,
            'error': f'Error loading presets: {str(e)}'
        }), 500


@app.route('/api/files/<file_id>', methods=['DELETE'])
def delete_file(file_id):
    """Delete a specific file reference for this user"""
    session_id = get_session_id()
    files = get_user_files(session_id)

    file_to_delete = None
    for f in files:
        if f['id'] == file_id:
            file_to_delete = f
            break

    if not file_to_delete:
        return jsonify({'error': 'File not found'}), 404

    stored_name = file_to_delete['stored_name']

    # Remove from this user's session tracking
    remove_file_from_session(session_id, file_id)

    # Check if any other user still references this physical file
    file_still_in_use = False
    for other_session_id in get_all_session_ids():
        other_files = get_user_files(other_session_id)
        for file_info in other_files:
            if file_info['stored_name'] == stored_name:
                file_still_in_use = True
                break
        if file_still_in_use:
            break

    # Only delete the physical file if no one else is using it
    if not file_still_in_use:
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], stored_name)
        try:
            if os.path.exists(file_path):
                os.remove(file_path)

            # Remove from global hash map
            file_hash = file_to_delete.get('hash')
            if file_hash:
                delete_file_hash_mapping(file_hash)
        except Exception as e:
            return jsonify({'error': f'Failed to delete file: {str(e)}'}), 500

    return jsonify({'success': True})


@app.route('/api/files/<file_id>/time-range', methods=['GET'])
def get_file_time_range(file_id):
    """Get the first and last timestamp from the entire log file"""
    session_id = get_session_id()
    files = get_user_files(session_id)

    # Find the requested file
    target_file = None
    for f in files:
        if f['id'] == file_id:
            target_file = f
            break

    if not target_file:
        return jsonify({'error': 'File not found'}), 404

    file_path = os.path.join(app.config['UPLOAD_FOLDER'], target_file['stored_name'])

    if not os.path.exists(file_path):
        return jsonify({'error': 'File no longer exists'}), 404

    # Extract first and last timestamps from entire file
    first_timestamp = None
    last_timestamp = None

    try:
        # Find first timestamp (read from beginning)
        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                ts = parse_timestamp(line.rstrip('\n\r'))
                if ts:
                    first_timestamp = ts
                    break

        # Find last timestamp (efficiently read last lines without loading entire file)
        last_lines = read_last_lines(file_path, num_lines=1000)
        for line in reversed(last_lines):
            ts = parse_timestamp(line)
            if ts:
                last_timestamp = ts
                break

    except Exception as e:
        return jsonify({'error': f'Error reading log file: {str(e)}'}), 500

    response_data = {}
    if first_timestamp:
        response_data['start_time'] = first_timestamp.isoformat()
    if last_timestamp:
        response_data['end_time'] = last_timestamp.isoformat()

    return jsonify(response_data)


@app.route('/api/logs/<file_id>', methods=['POST'])
def get_logs(file_id):
    """Get filtered logs from a specific file"""
    session_id = get_session_id()
    files = get_user_files(session_id)

    # Find the requested file
    target_file = None
    for f in files:
        if f['id'] == file_id:
            target_file = f
            break

    if not target_file:
        return jsonify({'error': 'File not found'}), 404

    file_path = os.path.join(app.config['UPLOAD_FOLDER'], target_file['stored_name'])

    if not os.path.exists(file_path):
        return jsonify({'error': 'File no longer exists'}), 404

    # Parse filter configuration from request
    data = request.json or {}
    filters = []

    # Date filter
    start_date_str = data.get('start_date', '').strip()
    end_date_str = data.get('end_date', '').strip()

    if start_date_str or end_date_str:
        date_filter = {'type': 'date'}
        if start_date_str:
            try:
                dt = date_parser.parse(start_date_str)
                # Ensure naive datetime for comparison
                if dt.tzinfo is not None:
                    dt = dt.replace(tzinfo=None)
                date_filter['start_date'] = dt
            except Exception as e:
                return jsonify({'error': f'Invalid start_date format: {str(e)}'}), 400
        if end_date_str:
            try:
                dt = date_parser.parse(end_date_str)
                # Ensure naive datetime for comparison
                if dt.tzinfo is not None:
                    dt = dt.replace(tzinfo=None)
                date_filter['end_date'] = dt
            except Exception as e:
                return jsonify({'error': f'Invalid end_date format: {str(e)}'}), 400
        filters.append(date_filter)

    # Include filters
    for include_term in data.get('include', []):
        if include_term:
            filters.append({'type': 'include', 'value': include_term})

    # Exclude filters
    for exclude_term in data.get('exclude', []):
        if exclude_term:
            filters.append({'type': 'exclude', 'value': exclude_term})

    logic = data.get('logic', 'AND').upper()
    if logic not in ['AND', 'OR']:
        logic = 'AND'

    # Get case sensitivity option (default True for backwards compatibility)
    case_sensitive = data.get('case_sensitive', True)

    # Stream filtered results and extract time range
    all_lines = []
    first_timestamp = None
    last_timestamp = None
    max_results = app.config['MAX_RESULTS']
    truncated = False

    try:
        for chunk in stream_filtered_logs(file_path, filters if filters else None, logic, case_sensitive):
            # Check if we're about to exceed max results
            if len(all_lines) + len(chunk) > max_results:
                # Add only up to max_results
                remaining = max_results - len(all_lines)
                all_lines.extend(chunk[:remaining])
                truncated = True
                break
            all_lines.extend(chunk)
    except Exception as e:
        return jsonify({'error': f'Error reading log file: {str(e)}'}), 500

    # Extract first and last timestamps from filtered results
    if all_lines:
        for line in all_lines:
            ts = parse_timestamp(line['content'])
            if ts:
                first_timestamp = ts
                break

        for line in reversed(all_lines):
            ts = parse_timestamp(line['content'])
            if ts:
                last_timestamp = ts
                break

    response_data = {
        'lines': all_lines,
        'total': len(all_lines),
        'truncated': truncated,
        'max_results': max_results
    }

    if first_timestamp:
        response_data['start_time'] = first_timestamp.isoformat()
    if last_timestamp:
        response_data['end_time'] = last_timestamp.isoformat()

    return jsonify(response_data)


# ============================================================================
# Scheduler Setup
# ============================================================================

scheduler = BackgroundScheduler()

# Daily full cleanup at 2 AM
scheduler.add_job(
    func=lambda: daily_full_cleanup(app.config['UPLOAD_FOLDER'], redis_client),
    trigger='cron',
    hour=2,
    minute=0
)

# Hourly cleanup of unreferenced files
scheduler.add_job(
    func=lambda: cleanup_old_files(app.config['UPLOAD_FOLDER'], redis_client),
    trigger="interval",
    hours=1
)

scheduler.start()


# ============================================================================
# Application Entry Point
# ============================================================================

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5001, debug=True)
