import os
import re
import uuid
import hashlib
import json
from datetime import datetime, timedelta
from pathlib import Path
from flask import Flask, request, jsonify, session, send_from_directory
from werkzeug.utils import secure_filename
from apscheduler.schedulers.background import BackgroundScheduler
from dateutil import parser as date_parser

app = Flask(__name__, static_folder='static')
app.secret_key = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500MB max file size
app.config['MAX_RESULTS'] = 50000  # Maximum number of log lines to return

# Ensure upload directory exists
Path(app.config['UPLOAD_FOLDER']).mkdir(exist_ok=True)

# Store mapping of session_id -> list of uploaded files
session_files = {}

# Store mapping of file_hash -> stored_filename for deduplication across users
file_hash_map = {}


def allowed_file(filename):
    """Check if file has .log extension"""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() == 'log'


def get_session_id():
    """Get or create session ID for guest user"""
    if 'session_id' not in session:
        session['session_id'] = str(uuid.uuid4())
    return session['session_id']


def get_user_files(session_id):
    """Get list of files uploaded by this session"""
    return session_files.get(session_id, [])


def read_last_lines(file_path, num_lines=1000, buffer_size=8192):
    """
    Efficiently read the last N lines from a file without loading entire file.
    Uses buffer reading from end of file.
    """
    with open(file_path, 'rb') as f:
        # Seek to end of file
        f.seek(0, 2)
        file_size = f.tell()

        if file_size == 0:
            return []

        # Read backwards in chunks
        lines = []
        buffer = b''
        offset = 0

        while len(lines) < num_lines and offset < file_size:
            # Calculate how much to read
            read_size = min(buffer_size, file_size - offset)
            offset += read_size

            # Seek and read
            f.seek(file_size - offset)
            chunk = f.read(read_size)

            # Prepend to buffer
            buffer = chunk + buffer

            # Split into lines
            lines = buffer.split(b'\n')

            # If we have enough lines, break
            if len(lines) > num_lines:
                break

        # Decode lines (skip empty last line if exists)
        decoded_lines = []
        for line in lines:
            try:
                decoded_lines.append(line.decode('utf-8', errors='replace').rstrip('\r'))
            except:
                continue

        # Return last num_lines (reversed to get chronological order from end)
        return [line for line in decoded_lines if line][-num_lines:]


def calculate_file_hash(file_stream):
    """Calculate SHA-256 hash of file contents"""
    sha256_hash = hashlib.sha256()
    # Read file in chunks to handle large files efficiently
    for byte_block in iter(lambda: file_stream.read(4096), b""):
        sha256_hash.update(byte_block)
    # Reset file pointer to beginning
    file_stream.seek(0)
    return sha256_hash.hexdigest()


def cleanup_old_files():
    """Remove files older than 24 hours and clean up mappings"""
    now = datetime.now()
    upload_dir = Path(app.config['UPLOAD_FOLDER'])

    # First, remove old file references from session_files based on age
    files_to_remove = set()
    for session_id in list(session_files.keys()):
        updated_files = []
        for file_info in session_files[session_id]:
            upload_time = datetime.fromisoformat(file_info['upload_time'])
            file_age = now - upload_time
            if file_age <= timedelta(days=1):
                updated_files.append(file_info)
            else:
                files_to_remove.add(file_info['stored_name'])

        session_files[session_id] = updated_files
        if not session_files[session_id]:
            del session_files[session_id]

    # Build a set of files still in use by any session
    files_in_use = set()
    for session_id in session_files:
        for file_info in session_files[session_id]:
            files_in_use.add(file_info['stored_name'])

    # Delete physical files that are no longer referenced by any session
    for file_path in upload_dir.glob('*.log'):
        stored_name = file_path.name
        if stored_name not in files_in_use:
            try:
                file_path.unlink()
                print(f"Cleaned up unreferenced file: {file_path}")
                # Remove from global hash map
                for hash_key, filename in list(file_hash_map.items()):
                    if filename == stored_name:
                        del file_hash_map[hash_key]
                        break
            except Exception as e:
                print(f"Error cleaning up {file_path}: {e}")


def daily_full_cleanup():
    """Daily 2 AM cleanup: Delete ALL physical files and reset all mappings"""
    upload_dir = Path(app.config['UPLOAD_FOLDER'])

    print(f"Running daily full cleanup at {datetime.now()}")

    # Delete all physical log files
    for file_path in upload_dir.glob('*.log'):
        try:
            file_path.unlink()
            print(f"Deleted file: {file_path}")
        except Exception as e:
            print(f"Error deleting {file_path}: {e}")

    # Clear all session files
    session_files.clear()

    # Clear global hash map
    file_hash_map.clear()

    print("Daily full cleanup completed")


def parse_timestamp(line):
    """Extract timestamp from log line. Returns None if no timestamp found."""
    # Match pattern like [2025-11-19 08:03:22].099
    match = re.match(r'\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\]', line)
    if match:
        try:
            # Parse as naive datetime (no timezone)
            dt = date_parser.parse(match.group(1))
            # Ensure it's naive (remove timezone if present)
            if dt.tzinfo is not None:
                dt = dt.replace(tzinfo=None)
            return dt
        except:
            return None
    return None


def apply_filter(line, filter_config):
    """
    Apply a single filter to a line.
    filter_config: {
        'type': 'date' | 'include' | 'exclude',
        'value': string,
        'start_date': optional datetime,
        'end_date': optional datetime
    }
    Returns True if line passes the filter
    """
    filter_type = filter_config.get('type')

    if filter_type == 'date':
        timestamp = parse_timestamp(line)
        if timestamp is None:
            # If no timestamp and we're filtering by date, exclude the line
            return False

        start_date = filter_config.get('start_date')
        end_date = filter_config.get('end_date')

        if start_date and timestamp < start_date:
            return False
        if end_date and timestamp > end_date:
            return False
        return True

    elif filter_type == 'include':
        return filter_config['value'] in line

    elif filter_type == 'exclude':
        return filter_config['value'] not in line

    return True


def apply_filters(line, filters, logic='AND'):
    """
    Apply multiple filters with specified logic.
    Date filters always use AND logic.
    Include/exclude filters use the specified logic (AND/OR).

    filters: list of filter configs
    logic: 'AND' | 'OR' - applies only to include/exclude filters
    """
    if not filters:
        return True

    # Separate date filters from include/exclude filters
    date_filters = [f for f in filters if f.get('type') == 'date']
    content_filters = [f for f in filters if f.get('type') in ['include', 'exclude']]

    # Date filters must ALL pass (AND logic)
    if date_filters:
        date_results = [apply_filter(line, f) for f in date_filters]
        if not all(date_results):
            return False

    # Content filters use the specified logic
    if content_filters:
        content_results = [apply_filter(line, f) for f in content_filters]
        if logic == 'AND':
            return all(content_results)
        elif logic == 'OR':
            return any(content_results)

    return True


def stream_filtered_logs(file_path, filters=None, logic='AND', chunk_size=1000):
    """
    Memory-efficient log file reading with filtering.
    Yields lines in chunks to avoid loading entire file into memory.
    Returns tuples of (line_number, line_content)
    """
    lines_buffer = []

    with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
        for line_number, line in enumerate(f, start=1):
            line = line.rstrip('\n\r')

            # Apply filters if provided
            if filters and not apply_filters(line, filters, logic):
                continue

            lines_buffer.append({'line_number': line_number, 'content': line})

            # Yield chunk when buffer reaches chunk_size
            if len(lines_buffer) >= chunk_size:
                yield lines_buffer
                lines_buffer = []

        # Yield remaining lines
        if lines_buffer:
            yield lines_buffer


@app.route('/')
def index():
    """Serve the main HTML page"""
    return send_from_directory('static', 'index.html')


@app.route('/api/upload', methods=['POST'])
def upload_file():
    """Handle file upload"""
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['file']

    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    if not allowed_file(file.filename):
        return jsonify({'error': 'Only .log files are allowed'}), 400

    # Calculate file hash to check for duplicates
    file_hash = calculate_file_hash(file.stream)
    original_filename = secure_filename(file.filename)

    # Track file for this session
    session_id = get_session_id()
    if session_id not in session_files:
        session_files[session_id] = []

    # Check if this user already uploaded this exact file
    for existing_file in session_files[session_id]:
        if existing_file.get('hash') == file_hash:
            return jsonify({
                'success': True,
                'file': existing_file,
                'duplicate': True,
                'message': 'You have already uploaded this file'
            })

    # Check if this file exists globally (uploaded by another user)
    if file_hash in file_hash_map:
        # Reuse the existing file, but create a new reference for this user
        stored_name = file_hash_map[file_hash]
    else:
        # New file - save it and add to global hash map
        stored_name = f"{uuid.uuid4()}_{original_filename}"
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], stored_name)
        file.save(file_path)
        file_hash_map[file_hash] = stored_name

    # Create a unique file reference for this user
    file_info = {
        'id': str(uuid.uuid4()),
        'original_name': original_filename,
        'stored_name': stored_name,
        'hash': file_hash,
        'upload_time': datetime.now().isoformat()
    }
    session_files[session_id].append(file_info)

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
    session_files[session_id].remove(file_to_delete)

    # Check if any other user still references this physical file
    file_still_in_use = False
    for other_session_id in session_files:
        for file_info in session_files[other_session_id]:
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
                print(f"Deleted physical file: {file_path}")

            # Remove from global hash map
            file_hash = file_to_delete.get('hash')
            if file_hash and file_hash in file_hash_map:
                del file_hash_map[file_hash]
        except Exception as e:
            print(f"Error deleting physical file: {e}")

    return jsonify({'success': True})


@app.route('/api/logs/<file_id>/timerange', methods=['GET'])
def get_file_timerange(file_id):
    """Get the time range of the entire log file"""
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

    # Stream filtered results and extract time range
    all_lines = []
    first_timestamp = None
    last_timestamp = None
    max_results = app.config['MAX_RESULTS']
    truncated = False

    try:
        for chunk in stream_filtered_logs(file_path, filters if filters else None, logic):
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


# Set up cleanup schedulers
scheduler = BackgroundScheduler()

# Daily full cleanup at 2 AM
scheduler.add_job(func=daily_full_cleanup, trigger='cron', hour=2, minute=0)

# Hourly cleanup of unreferenced files
scheduler.add_job(func=cleanup_old_files, trigger="interval", hours=1)

scheduler.start()


if __name__ == '__main__':
    # Run cleanup once on startup
    cleanup_old_files()

    # Start the Flask app
    app.run(debug=True, host='0.0.0.0', port=5001)
