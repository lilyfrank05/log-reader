"""Utility functions for file operations and timestamp parsing"""
import re
from datetime import datetime

# Precompile timestamp regex at module level (avoids re-compilation per call)
# Captures each component separately to bypass strptime overhead
_TIMESTAMP_RE = re.compile(
    r'\[(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\]'
)


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
    match = _TIMESTAMP_RE.match(line)
    if match:
        try:
            # Construct datetime directly from captured groups (avoids strptime overhead)
            return datetime(
                int(match.group(1)), int(match.group(2)), int(match.group(3)),
                int(match.group(4)), int(match.group(5)), int(match.group(6))
            )
        except (ValueError, OverflowError):
            return None
    return None
