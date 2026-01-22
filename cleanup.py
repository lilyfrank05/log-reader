"""Cleanup jobs for scheduled file deletion"""
from pathlib import Path
from datetime import datetime
import json


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
    for pattern in ['*.log', '*.log_1']:
        for file_path in upload_dir.glob(pattern):
            stored_name = file_path.name
            if stored_name not in referenced_files:
                try:
                    file_path.unlink()
                    # Remove from global hash map - scan for the hash key with this stored_name
                    hash_keys = redis_client.keys("files:hash:*")
                    for hash_key in hash_keys:
                        if redis_client.get(hash_key) == stored_name:
                            redis_client.delete(hash_key)
                            break
                except Exception as e:
                    print(f"Error cleaning up {file_path}: {e}")


def daily_full_cleanup(upload_folder, redis_client):
    """Daily 2 AM cleanup: Delete ALL physical files and reset all mappings"""
    upload_dir = Path(upload_folder)

    print(f"Running daily full cleanup at {datetime.now()}")

    # Delete all physical log files (.log and .log_1)
    for pattern in ['*.log', '*.log_1']:
        for file_path in upload_dir.glob(pattern):
            try:
                file_path.unlink()
                print(f"Deleted file: {file_path}")
            except Exception as e:
                print(f"Error deleting {file_path}: {e}")

    # Clear all session files and hash sets from Redis
    session_keys = redis_client.keys("files:session:*")
    if session_keys:
        redis_client.delete(*session_keys)

    # Clear global hash map from Redis
    hash_keys = redis_client.keys("files:hash:*")
    if hash_keys:
        redis_client.delete(*hash_keys)

    print("Daily full cleanup completed")
