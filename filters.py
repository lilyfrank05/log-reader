"""Filtering logic for log lines"""
from utils import parse_timestamp


def apply_filter(line, filter_config, case_sensitive=True, line_lower=None, cached_timestamp=None):
    """
    Apply a single filter to a line.
    filter_config: {
        'type': 'date' | 'include' | 'exclude',
        'value': string,
        'start_date': optional datetime,
        'end_date': optional datetime
    }
    case_sensitive: boolean, whether string matching is case sensitive
    line_lower: pre-computed lowercase version of line (optional)
    cached_timestamp: pre-parsed timestamp (optional)
    Returns True if line passes the filter
    """
    filter_type = filter_config.get('type')

    if filter_type == 'date':
        # Use cached timestamp if provided, otherwise parse
        timestamp = cached_timestamp if cached_timestamp is not None else parse_timestamp(line)
        if timestamp is None:
            return False

        start_date = filter_config.get('start_date')
        end_date = filter_config.get('end_date')

        if start_date and timestamp < start_date:
            return False
        if end_date and timestamp > end_date:
            return False
        return True

    elif filter_type == 'include':
        search_value = filter_config['value']
        if not case_sensitive:
            search_value = search_value.lower()
            # Use pre-computed lowercase line if available
            search_line = line_lower if line_lower is not None else line.lower()
        else:
            search_line = line
        return search_value in search_line

    elif filter_type == 'exclude':
        search_value = filter_config['value']
        if not case_sensitive:
            search_value = search_value.lower()
            # Use pre-computed lowercase line if available
            search_line = line_lower if line_lower is not None else line.lower()
        else:
            search_line = line
        return search_value not in search_line

    return True


def apply_filters(line, filters, logic='AND', case_sensitive=True):
    """
    Apply multiple filters with specified logic.
    Date filters always use AND logic.
    Include/exclude filters use the specified logic (AND/OR).

    OPTIMIZED VERSION:
    - Pre-computes lowercase line once if needed
    - Pre-parses timestamp once if needed
    - Uses short-circuit evaluation
    - Avoids redundant filter separation

    filters: list of filter configs
    logic: 'AND' | 'OR' - applies only to include/exclude filters
    case_sensitive: boolean, whether string matching is case sensitive
    """
    if not filters:
        return True

    # Pre-compute lowercase line if case-insensitive matching is needed
    line_lower = None
    if not case_sensitive:
        line_lower = line.lower()

    # Pre-parse timestamp if any date filter exists
    cached_timestamp = None
    has_date_filter = any(f.get('type') == 'date' for f in filters)
    if has_date_filter:
        cached_timestamp = parse_timestamp(line)

    # Process filters in one pass with short-circuit evaluation
    date_filters = []
    content_filters = []

    for f in filters:
        if f.get('type') == 'date':
            date_filters.append(f)
        elif f.get('type') in ['include', 'exclude']:
            content_filters.append(f)

    # Date filters must ALL pass (AND logic) - short circuit on first failure
    if date_filters:
        for f in date_filters:
            if not apply_filter(line, f, case_sensitive, line_lower, cached_timestamp):
                return False

    # Content filters use the specified logic
    if content_filters:
        if logic == 'AND':
            # Short circuit: return False on first failure
            for f in content_filters:
                if not apply_filter(line, f, case_sensitive, line_lower, cached_timestamp):
                    return False
            return True
        elif logic == 'OR':
            # Short circuit: return True on first success
            for f in content_filters:
                if apply_filter(line, f, case_sensitive, line_lower, cached_timestamp):
                    return True
            return False

    return True


def stream_filtered_logs(file_path, filters=None, logic='AND', case_sensitive=True, chunk_size=1000):
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
            if filters and not apply_filters(line, filters, logic, case_sensitive):
                continue

            lines_buffer.append({'line_number': line_number, 'content': line})

            # Yield chunk when buffer reaches chunk_size
            if len(lines_buffer) >= chunk_size:
                yield lines_buffer
                lines_buffer = []

        # Yield remaining lines
        if lines_buffer:
            yield lines_buffer
