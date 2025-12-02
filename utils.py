"""Utility functions for file operations and timestamp parsing"""
import re
from datetime import datetime


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


def parse_timestamp(line):
    """Extract timestamp from log line. Returns None if no timestamp found."""
    # Match pattern like [2025-11-19 08:03:22].099
    match = re.match(r'\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\]', line)
    if match:
        try:
            dt = datetime.strptime(match.group(1), '%Y-%m-%d %H:%M:%S')
            # Ensure naive datetime (no timezone)
            if dt.tzinfo is not None:
                dt = dt.replace(tzinfo=None)
            return dt
        except:
            return None
    return None
