"""Cleanup jobs for scheduled file deletion"""
from pathlib import Path
from datetime import datetime


def cleanup_old_files(upload_folder, session_files, file_hash_map):
    """
    Cleanup physical files that are no longer referenced by any user session.
    This runs hourly to clean up files that have been deleted by users.
    """
    upload_dir = Path(upload_folder)

    # Get all stored filenames that are still referenced
    referenced_files = set()
    for session_id in session_files:
        for file_info in session_files[session_id]:
            referenced_files.add(file_info['stored_name'])

    # Delete unreferenced physical files
    for file_path in upload_dir.glob('*.log'):
        stored_name = file_path.name
        if stored_name not in referenced_files:
            try:
                file_path.unlink()
                # Remove from global hash map
                for hash_key, filename in list(file_hash_map.items()):
                    if filename == stored_name:
                        del file_hash_map[hash_key]
                        break
            except Exception as e:
                print(f"Error cleaning up {file_path}: {e}")


def daily_full_cleanup(upload_folder, session_files, file_hash_map):
    """Daily 2 AM cleanup: Delete ALL physical files and reset all mappings"""
    upload_dir = Path(upload_folder)

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
