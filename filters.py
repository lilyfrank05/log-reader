"""Filtering logic for log lines"""
from utils import parse_timestamp


def apply_filter(line, filter_config, case_sensitive=True):
    """
    Apply a single filter to a line.
    filter_config: {
        'type': 'date' | 'include' | 'exclude',
        'value': string,
        'start_date': optional datetime,
        'end_date': optional datetime
    }
    case_sensitive: boolean, whether string matching is case sensitive
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
        search_value = filter_config['value']
        search_line = line
        if not case_sensitive:
            search_value = search_value.lower()
            search_line = line.lower()
        return search_value in search_line

    elif filter_type == 'exclude':
        search_value = filter_config['value']
        search_line = line
        if not case_sensitive:
            search_value = search_value.lower()
            search_line = line.lower()
        return search_value not in search_line

    return True


def apply_filters(line, filters, logic='AND', case_sensitive=True):
    """
    Apply multiple filters with specified logic.
    Date filters always use AND logic.
    Include/exclude filters use the specified logic (AND/OR).

    filters: list of filter configs
    logic: 'AND' | 'OR' - applies only to include/exclude filters
    case_sensitive: boolean, whether string matching is case sensitive
    """
    if not filters:
        return True

    # Separate date filters from include/exclude filters
    date_filters = [f for f in filters if f.get('type') == 'date']
    content_filters = [f for f in filters if f.get('type') in ['include', 'exclude']]

    # Date filters must ALL pass (AND logic)
    if date_filters:
        date_results = [apply_filter(line, f, case_sensitive) for f in date_filters]
        if not all(date_results):
            return False

    # Content filters use the specified logic
    if content_filters:
        content_results = [apply_filter(line, f, case_sensitive) for f in content_filters]
        if logic == 'AND':
            return all(content_results)
        elif logic == 'OR':
            return any(content_results)

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
