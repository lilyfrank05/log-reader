"""Cleanup jobs for scheduled file deletion"""
import os
from pathlib import Path
from datetime import datetime, timedelta
import json
import time

# Files newer than this are never swept, even if not yet referenced in Redis.
# Protects files that are mid-upload (written to disk before their Redis
# reference is registered) from being deleted out from under the request.
MIN_FILE_AGE_SECONDS = 600

# Files whose upload time is older than this are removed by the daily
# retention cleanup at 2 AM. Configurable via the FILE_RETENTION_DAYS
# environment variable (docker-compose or a local `export`); missing or
# invalid values fall back to the 7-day default.
def _retention_days_from_env():
    try:
        days = int(os.environ.get('FILE_RETENTION_DAYS', '7'))
    except (TypeError, ValueError):
        return 7
    return days if days >= 1 else 7


FILE_RETENTION_DAYS = _retention_days_from_env()


def parse_upload_time(upload_time_str):
    """Parse an upload_time ISO string; return None if missing or malformed."""
    if not upload_time_str:
        return None
    try:
        return datetime.fromisoformat(upload_time_str)
    except (TypeError, ValueError):
        return None


def remove_file_reference(redis_client, session_id, stored_name):
    """Drop all references to a stored file from one session's list and its hash set."""
    files = get_user_files(redis_client, session_id)
    remaining = []
    file_hash = None
    for f in files:
        if f.get('stored_name') == stored_name:
            file_hash = f.get('hash')
        else:
            remaining.append(f)
    if len(remaining) == len(files):
        return
    key = get_session_files_key(session_id)
    if remaining:
        redis_client.set(key, json.dumps(remaining))
    else:
        redis_client.delete(key)
    if file_hash:
        redis_client.srem(f"files:session:{session_id}:hashes", file_hash)


def get_session_files_key(session_id):
    """Get Redis key for session files list"""
    return f"files:session:{session_id}"


def get_file_hash_key(file_hash):
    """Get Redis key for file hash mapping"""
    return f"files:hash:{file_hash}"


def get_user_files(redis_client, session_id):
    """Get list of files uploaded by this session from Redis"""
    key = get_session_files_key(session_id)
    files_json = redis_client.get(key)
    if files_json:
        return json.loads(files_json)
    return []


def get_all_session_ids(redis_client):
    """Get all session IDs that have uploaded files"""
    keys = redis_client.keys("files:session:*")
    # Filter out hash sets (keys ending with :hashes) and extract session IDs
    session_ids = set()
    for key in keys:
        if not key.endswith(':hashes'):
            # Extract session ID from "files:session:SESSION_ID"
            session_id = key.replace("files:session:", "")
            session_ids.add(session_id)
    return list(session_ids)


def cleanup_old_files(upload_folder, redis_client):
    """
    Cleanup physical files that are no longer referenced by any user session.
    This runs hourly to clean up files that have been deleted by users.
    """
    upload_dir = Path(upload_folder)

    # Get all stored filenames that are still referenced
    referenced_files = set()
    for session_id in get_all_session_ids(redis_client):
        for file_info in get_user_files(redis_client, session_id):
            referenced_files.add(file_info['stored_name'])

    # Delete unreferenced physical files (.log and .log_1)
    now = time.time()
    for pattern in ['*.log', '*.log_1']:
        for file_path in upload_dir.glob(pattern):
            stored_name = file_path.name
            if stored_name not in referenced_files:
                try:
                    if now - file_path.stat().st_mtime < MIN_FILE_AGE_SECONDS:
                        continue
                    file_path.unlink()
                    # Remove from global hash map - scan for the hash key with this stored_name
                    hash_keys = redis_client.keys("files:hash:*")
                    for hash_key in hash_keys:
                        if redis_client.get(hash_key) == stored_name:
                            redis_client.delete(hash_key)
                            break
                except Exception as e:
                    print(f"Error cleaning up {file_path}: {e}")


def daily_retention_cleanup(upload_folder, redis_client):
    """
    Daily 2 AM cleanup: delete physical files (and their Redis references)
    whose upload time is more than FILE_RETENTION_DAYS old, plus any orphaned
    files on disk older than that (falling back to mtime when no Redis
    reference exists). A file shared by multiple sessions is kept while any
    reference is newer than the cutoff.
    """
    upload_dir = Path(upload_folder)
    cutoff = datetime.now() - timedelta(days=FILE_RETENTION_DAYS)

    print(f"Running daily retention cleanup at {datetime.now()} (cutoff: {cutoff.isoformat()})")

    # Map stored_name -> newest upload_time among all session references
    newest_upload = {}
    for session_id in get_all_session_ids(redis_client):
        for file_info in get_user_files(redis_client, session_id):
            stored_name = file_info.get('stored_name')
            if not stored_name:
                continue
            upload_time = parse_upload_time(file_info.get('upload_time'))
            if upload_time is not None and (
                stored_name not in newest_upload or upload_time > newest_upload[stored_name]
            ):
                newest_upload[stored_name] = upload_time

    # Delete physical files older than the cutoff
    for pattern in ['*.log', '*.log_1']:
        for file_path in upload_dir.glob(pattern):
            stored_name = file_path.name
            try:
                upload_time = newest_upload.get(stored_name)
                if upload_time is None:
                    # Unreferenced or unparseable upload_time: fall back to mtime
                    mtime = datetime.fromtimestamp(file_path.stat().st_mtime)
                    if mtime >= cutoff:
                        continue
                elif upload_time >= cutoff:
                    continue
                file_path.unlink()
                print(f"Deleted file: {file_path} (upload: {upload_time.isoformat() if upload_time else 'none'})")
            except Exception as e:
                print(f"Error deleting {file_path}: {e}")
                continue

            # Remove this file's references from all sessions
            for session_id in get_all_session_ids(redis_client):
                remove_file_reference(redis_client, session_id, stored_name)

            # Remove the global hash mapping for this stored_name
            hash_keys = redis_client.keys("files:hash:*")
            for hash_key in hash_keys:
                if redis_client.get(hash_key) == stored_name:
                    redis_client.delete(hash_key)
                    break

    print("Daily retention cleanup completed")
