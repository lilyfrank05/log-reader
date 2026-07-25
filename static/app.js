// State variables
let currentFiles = [];
let currentFileId = null;
let includeFilters = [];
let excludeFilters = [];
let fileTimeRange = null;
let presets = [];

// Main view filters are remembered per file (like the context panel's), so
// switching files doesn't leak one file's filters/date range into another's
// query, and "Restore Previous" never crosses file boundaries.
let mainFiltersByFile = {}; // { [fileId]: { include, exclude, logic, caseSensitive, startDate, endDate, presetValue } }
let mainHistoryByFile = {}; // { [fileId]: { history: [...states], index: number } }

// Context panel state - its own filter set, independent of the main filters.
// Remembered per file so drilling into a different entry in the same file
// reuses the same secondary filters, but switching files starts fresh.
let contextIncludeFilters = [];
let contextExcludeFilters = [];
let contextFiltersByFile = {};

// Context panel has its own undo stack, separate from the main view's -
// "Restore Previous" in each panel only walks back through that panel's own history.
// Scoped per file (like contextFiltersByFile above) so restoring never pulls in a
// different file's date range/filters after switching files.
let contextHistoryByFile = {}; // { [fileId]: { history: [...states], index: number } }

// DOM elements
const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const selectedFileName = document.getElementById('selectedFileName');
const uploadMessage = document.getElementById('uploadMessage');
const presetSelector = document.getElementById('presetSelector');

// Prevent keyboard input on datetime-local fields
const startDateInput = document.getElementById('startDate');
const endDateInput = document.getElementById('endDate');
const startDateDisplay = document.getElementById('startDateDisplay');
const endDateDisplay = document.getElementById('endDateDisplay');

startDateInput.addEventListener('keydown', (e) => e.preventDefault());
endDateInput.addEventListener('keydown', (e) => e.preventDefault());
startDateInput.addEventListener('paste', (e) => e.preventDefault());
endDateInput.addEventListener('paste', (e) => e.preventDefault());

// Update 24-hour format display when date/time changes
function updateDateTimeDisplay(input, displayElement) {
    if (!input.value) {
        displayElement.textContent = '';
        return;
    }
    const date = new Date(input.value);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    displayElement.textContent = `${day}/${month}/${year}, ${hours}:${minutes}:${seconds}`;
}

startDateInput.addEventListener('change', () => {
    updateDateTimeDisplay(startDateInput, startDateDisplay);
    saveMainFiltersForFile(currentFileId);
});
endDateInput.addEventListener('change', () => {
    updateDateTimeDisplay(endDateInput, endDateDisplay);
    saveMainFiltersForFile(currentFileId);
});
document.getElementById('filterLogic').addEventListener('change', () => saveMainFiltersForFile(currentFileId));
document.getElementById('caseSensitive').addEventListener('change', () => saveMainFiltersForFile(currentFileId));

// Load presets when page loads
async function loadPresets() {
    try {
        const response = await fetch('/api/presets');
        const data = await response.json();

        if (data.success && data.presets) {
            presets = data.presets;
            populatePresetDropdown();
        }
    } catch (error) {
        console.error('Error loading presets:', error);
    }
}

// Populate preset dropdown
function populatePresetDropdown() {
    presetSelector.innerHTML = '<option value="">-- Select Preset --</option>';
    presets.forEach((preset, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = preset.name;
        presetSelector.appendChild(option);
    });
}

// Handle preset selection
presetSelector.addEventListener('change', (e) => {
    const presetIndex = e.target.value;
    if (presetIndex === '') return;

    const preset = presets[presetIndex];
    if (!preset) return;

    // Clear current filters
    includeFilters = [];
    excludeFilters = [];

    // Apply preset filters (don't touch date range)
    preset.includes.forEach(text => {
        if (text.trim()) {
            includeFilters.push(text);
        }
    });

    preset.excludes.forEach(text => {
        if (text.trim()) {
            excludeFilters.push(text);
        }
    });

    // Set logic
    document.getElementById('filterLogic').value = preset.logic;

    // Update UI
    renderFilters();
    saveMainFiltersForFile(currentFileId);
});

// Load presets on page load
loadPresets();

// Handle file selection
fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        selectedFileName.textContent = file.name;
        uploadBtn.disabled = false;
    } else {
        selectedFileName.textContent = '';
        uploadBtn.disabled = true;
    }
});

// Handle file upload
uploadBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    await uploadFile(file);
});

// Drag and drop handlers
const dropZone = document.getElementById('dropZone');
let dragCounter = 0;

dropZone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
});

dropZone.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter === 0) {
        dropZone.classList.remove('drag-over');
    }
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    selectedFileName.textContent = file.name;
    uploadFile(file);
});

async function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);

    uploadBtn.disabled = true;

    // Show progress bar
    const uploadProgress = document.getElementById('uploadProgress');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    uploadProgress.style.display = 'block';
    uploadMessage.style.display = 'none';

    // Simulate upload progress with stage indicators
    let progress = 0;
    let stage = 'uploading';
    progressFill.style.width = '0%';
    progressText.textContent = 'Uploading file to server...';

    const progressInterval = setInterval(() => {
        if (stage === 'uploading' && progress < 70) {
            progress += Math.random() * 10;
            if (progress > 70) {
                progress = 70;
                stage = 'hashing';
                progressText.textContent = 'Server processing (calculating hash)...';
            }
            progressFill.style.width = progress + '%';
        } else if (stage === 'hashing' && progress < 85) {
            progress += Math.random() * 5;
            if (progress > 85) {
                progress = 85;
                stage = 'saving';
                progressText.textContent = 'Server processing (saving file)...';
            }
            progressFill.style.width = progress + '%';
        } else if (stage === 'saving' && progress < 95) {
            progress += Math.random() * 3;
            if (progress > 95) progress = 95;
            progressFill.style.width = progress + '%';
        }
    }, 300);

    try {
        const uploadStart = Date.now();
        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });

        const fetchTime = Date.now() - uploadStart;
        console.log(`[CLIENT] Fetch completed in ${fetchTime}ms`);

        // Complete upload phase
        clearInterval(progressInterval);
        progressFill.style.width = '100%';
        progressText.textContent = 'Finalizing...';

        const parseStart = Date.now();
        const data = await response.json();
        const parseTime = Date.now() - parseStart;
        console.log(`[CLIENT] JSON parse in ${parseTime}ms | Server time: ${data.server_time?.toFixed(2)}s`);

        if (response.ok) {
            progressFill.style.width = '100%';
            progressText.textContent = 'Upload complete!';

            const totalTime = Date.now() - uploadStart;
            console.log(`[CLIENT] Total upload flow: ${totalTime}ms`);

            // Refresh file list in the background so the current file
            // selection and log view are not interrupted.
            loadFiles();

            setTimeout(() => {
                uploadProgress.style.display = 'none';
                uploadMessage.style.display = 'block';

                // Handle different response types
                if (data.is_zip && !data.duplicate) {
                    showMessage(uploadMessage, data.message || 'File extracted from zip and uploaded successfully!', 'success');
                } else if (data.duplicate) {
                    showMessage(uploadMessage, data.message || 'You have already uploaded this file', 'info');
                } else {
                    showMessage(uploadMessage, 'File uploaded successfully!', 'success');
                }
                fileInput.value = '';
                selectedFileName.textContent = '';
            }, 300);
        } else {
            uploadProgress.style.display = 'none';
            uploadMessage.style.display = 'block';
            showMessage(uploadMessage, data.error || 'Upload failed', 'error');
            uploadBtn.disabled = false;
        }
    } catch (error) {
        clearInterval(progressInterval);
        uploadProgress.style.display = 'none';
        uploadMessage.style.display = 'block';
        showMessage(uploadMessage, 'Upload failed: ' + error.message, 'error');
        uploadBtn.disabled = false;
    }
}

// Load files for current session
async function loadFiles() {
    try {
        const response = await fetch('/api/files');
        const data = await response.json();
        currentFiles = data.files || [];
        renderFiles();
    } catch (error) {
        console.error('Failed to load files:', error);
    }
}

// Render file list
function renderFiles() {
    const container = document.getElementById('filesContainer');

    if (currentFiles.length === 0) {
        container.innerHTML = '<div class="message info">No files uploaded yet</div>';
        return;
    }

    container.innerHTML = currentFiles.map(file => {
        // Build Mid/Tid display
        let midTidText = '';
        if (file.mid || file.tid) {
            const parts = [];
            if (file.mid) parts.push(`Mid: ${file.mid}`);
            if (file.tid) parts.push(`Tid: ${file.tid}`);
            midTidText = `<span class="file-mid-tid">${parts.join(', ')}</span>`;
        }

        return `
            <div class="file-item ${file.id === currentFileId ? 'active' : ''}"
                 onclick="selectFile('${file.id}')">
                <div class="file-info">
                    <span class="file-name">${file.original_name}</span>
                    ${midTidText}
                </div>
                <button class="delete-btn" onclick="deleteFile(event, '${file.id}')">Delete</button>
            </div>
        `;
    }).join('');
}

// Select a file to view
async function selectFile(fileId) {
    currentFileId = fileId;
    renderFiles();

    // Load this file's own remembered filters (or defaults if never visited)
    // rather than leaving whatever filters/date range the previous file left behind
    loadMainFiltersForFile(fileId);
    updateRestoreButton();

    // The context panel's content belongs to the previous file - close it
    // rather than show stale results against the newly selected file
    closeContextPanel();
    updateContextRestoreButton();

    // Load file time range
    await loadFileTimeRange(fileId);

    applyFilters();
}

// Load and display file time range
async function loadFileTimeRange(fileId) {
    try {
        const response = await fetch(`/api/files/${fileId}/time-range`);
        const data = await response.json();

        if (response.ok && (data.start_time || data.end_time)) {
            fileTimeRange = data;
            displayFileTimeRange(data.start_time, data.end_time);
        } else {
            fileTimeRange = null;
            document.getElementById('fileTimeRange').innerHTML = '';
        }
    } catch (error) {
        console.error('Failed to load file time range:', error);
        fileTimeRange = null;
        document.getElementById('fileTimeRange').innerHTML = '';
    }
}

// Helper function to format datetime as DD/MM/YYYY HH:MM:SS
function formatDateTime(isoString) {
    if (!isoString) return 'N/A';
    const date = new Date(isoString);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${day}/${month}/${year}, ${hours}:${minutes}:${seconds}`;
}

// Display file time range
function displayFileTimeRange(startTime, endTime) {
    const fileTimeRangeDiv = document.getElementById('fileTimeRange');
    fileTimeRangeDiv.innerHTML = `
        <div class="file-time-info">
            <strong>Log File Time Range:</strong> ${formatDateTime(startTime)} → ${formatDateTime(endTime)}
        </div>
    `;
}


// Delete a file
async function deleteFile(event, fileId) {
    event.stopPropagation();

    if (!confirm('Are you sure you want to delete this file?')) {
        return;
    }

    try {
        const response = await fetch(`/api/files/${fileId}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            delete contextFiltersByFile[fileId];
            delete contextHistoryByFile[fileId];
            delete mainFiltersByFile[fileId];
            delete mainHistoryByFile[fileId];

            if (currentFileId === fileId) {
                currentFileId = null;
                document.getElementById('logsContainer').innerHTML =
                    '<div class="message info">Select a file to view logs</div>';
                document.getElementById('logCount').textContent = 'No logs loaded';
                closeContextPanel();
            }
            loadFiles();
        } else {
            alert('Failed to delete file');
        }
    } catch (error) {
        alert('Failed to delete file: ' + error.message);
    }
}

// Load a file's own remembered main filters (empty/default if never visited before)
function loadMainFiltersForFile(fileId) {
    const saved = mainFiltersByFile[fileId] || {
        include: [], exclude: [], logic: 'AND', caseSensitive: false, startDate: '', endDate: '', presetValue: ''
    };

    includeFilters = [...saved.include];
    excludeFilters = [...saved.exclude];
    document.getElementById('filterLogic').value = saved.logic;
    document.getElementById('caseSensitive').checked = saved.caseSensitive;
    startDateInput.value = saved.startDate;
    endDateInput.value = saved.endDate;
    presetSelector.value = saved.presetValue;

    updateDateTimeDisplay(startDateInput, startDateDisplay);
    updateDateTimeDisplay(endDateInput, endDateDisplay);
    renderFilters();
}

// Persist the main view's current filters against the given file
function saveMainFiltersForFile(fileId) {
    if (!fileId) return;
    mainFiltersByFile[fileId] = {
        include: [...includeFilters],
        exclude: [...excludeFilters],
        logic: document.getElementById('filterLogic').value,
        caseSensitive: document.getElementById('caseSensitive').checked,
        startDate: startDateInput.value,
        endDate: endDateInput.value,
        presetValue: presetSelector.value
    };
}

// Add filter
function addFilter(type) {
    const input = document.getElementById(type + 'Input');
    const value = input.value.trim();

    if (!value) return;

    if (type === 'include') {
        includeFilters.push(value);
    } else {
        excludeFilters.push(value);
    }

    input.value = '';
    renderFilters();
    saveMainFiltersForFile(currentFileId);
}

// Remove filter
function removeFilter(type, index) {
    if (type === 'include') {
        includeFilters.splice(index, 1);
    } else {
        excludeFilters.splice(index, 1);
    }
    renderFilters();
    saveMainFiltersForFile(currentFileId);
}

// Render filter tags
function renderFilters() {
    const includeContainer = document.getElementById('includeFilters');
    const excludeContainer = document.getElementById('excludeFilters');

    includeContainer.innerHTML = includeFilters.map((filter, index) => `
        <div class="filter-tag">
            ${filter}
            <button onclick="removeFilter('include', ${index})">×</button>
        </div>
    `).join('');

    excludeContainer.innerHTML = excludeFilters.map((filter, index) => `
        <div class="filter-tag exclude">
            ${filter}
            <button onclick="removeFilter('exclude', ${index})">×</button>
        </div>
    `).join('');
}

// Save current filter state to this file's own history
function saveToHistory() {
    if (!currentFileId) return;

    const entry = mainHistoryByFile[currentFileId] || { history: [], index: -1 };

    const state = {
        includeFilters: [...includeFilters],
        excludeFilters: [...excludeFilters],
        logic: document.getElementById('filterLogic').value,
        caseSensitive: document.getElementById('caseSensitive').checked,
        startDate: document.getElementById('startDate').value,
        endDate: document.getElementById('endDate').value,
        presetValue: presetSelector.value,
        timestamp: Date.now()
    };

    // If we're not at the end of history, truncate everything after current position
    if (entry.index < entry.history.length - 1) {
        entry.history = entry.history.slice(0, entry.index + 1);
    }

    entry.history.push(state);
    entry.index = entry.history.length - 1;
    mainHistoryByFile[currentFileId] = entry;

    try {
        sessionStorage.setItem('mainHistoryByFile', JSON.stringify(mainHistoryByFile));
    } catch (e) {
        console.error('Failed to save history to sessionStorage:', e);
    }

    updateRestoreButton();
}

// Restore the main view's previous state for the current file only (never
// crosses into another file's history, and never touches the context panel's)
function restoreFilters() {
    const entry = mainHistoryByFile[currentFileId];
    if (!entry || entry.index <= 0) {
        alert('No previous state to restore');
        return;
    }

    entry.index--;
    const state = entry.history[entry.index];

    // Restore filters
    includeFilters = [...state.includeFilters];
    excludeFilters = [...state.excludeFilters];

    // Restore UI elements
    document.getElementById('filterLogic').value = state.logic;
    document.getElementById('caseSensitive').checked = state.caseSensitive;
    document.getElementById('startDate').value = state.startDate;
    document.getElementById('endDate').value = state.endDate;
    presetSelector.value = state.presetValue;

    // Update datetime displays
    updateDateTimeDisplay(startDateInput, startDateDisplay);
    updateDateTimeDisplay(endDateInput, endDateDisplay);

    // Update filter tags UI
    renderFilters();
    saveMainFiltersForFile(currentFileId);

    try {
        sessionStorage.setItem('mainHistoryByFile', JSON.stringify(mainHistoryByFile));
    } catch (e) {
        console.error('Failed to save history index to sessionStorage:', e);
    }

    updateRestoreButton();

    // Automatically apply the restored filters without saving to history
    applyFilters(true);
}

// Update restore button enabled/disabled state, based on the current file's history
function updateRestoreButton() {
    const restoreBtn = document.getElementById('restoreBtn');
    const entry = mainHistoryByFile[currentFileId];
    if (entry && entry.index > 0) {
        restoreBtn.disabled = false;
        restoreBtn.style.opacity = '1';
    } else {
        restoreBtn.disabled = true;
        restoreBtn.style.opacity = '0.5';
    }
}

// Load the main view's per-file history from sessionStorage on page load
function loadHistoryFromSession() {
    try {
        const saved = sessionStorage.getItem('mainHistoryByFile');

        if (saved) {
            mainHistoryByFile = JSON.parse(saved);
        }

        updateRestoreButton();
    } catch (e) {
        console.error('Failed to load history from sessionStorage:', e);
        mainHistoryByFile = {};
    }
}

// Apply filters and load logs
function clearFilters() {
    // Clear include and exclude filters
    includeFilters = [];
    excludeFilters = [];

    // Reset preset selector
    presetSelector.value = '';

    // Reset logic to AND
    document.getElementById('filterLogic').value = 'AND';

    // Update UI to show cleared filters
    renderFilters();
    saveMainFiltersForFile(currentFileId);

    // Note: Date range is NOT cleared
}

// Shared fetch used by both the main log view and the context panel
async function fetchFilteredLogs(fileId, filterData) {
    const response = await fetch(`/api/logs/${fileId}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(filterData)
    });
    const data = await response.json();
    return { ok: response.ok, data };
}

async function applyFilters(skipSave = false) {
    if (!currentFileId) {
        alert('Please select a file first');
        return;
    }

    saveMainFiltersForFile(currentFileId);

    // Save current state to history before applying new filters (unless restoring)
    if (!skipSave) {
        saveToHistory();
    }

    // Clear any selected log line
    clearSelection();

    const logsContainer = document.getElementById('logsContainer');
    logsContainer.innerHTML = '<div class="loading">Loading logs...</div>';

    const filterData = {
        include: includeFilters,
        exclude: excludeFilters,
        logic: document.getElementById('filterLogic').value,
        case_sensitive: document.getElementById('caseSensitive').checked
    };

    const startDate = document.getElementById('startDate').value;
    const endDate = document.getElementById('endDate').value;

    if (startDate) {
        filterData.start_date = startDate;
    }
    if (endDate) {
        filterData.end_date = endDate;
    }

    try {
        const { ok, data } = await fetchFilteredLogs(currentFileId, filterData);

        if (ok) {
            renderLogs(data.lines, data.total, data.start_time, data.end_time, data.truncated, data.max_results);
            return data;
        } else {
            logsContainer.innerHTML = `<div class="message error">${data.error || 'Failed to load logs'}</div>`;
            return null;
        }
    } catch (error) {
        logsContainer.innerHTML = `<div class="message error">Failed to load logs: ${error.message}</div>`;
        return null;
    }
}

// Render logs
function renderLogs(lines, total, startTime, endTime, truncated, maxResults) {
    const logsContainer = document.getElementById('logsContainer');
    const logCount = document.getElementById('logCount');
    const timeRange = document.getElementById('timeRange');

    if (lines.length === 0) {
        logsContainer.innerHTML = '<div class="message info">No logs match the current filters</div>';
        logCount.textContent = '0 lines';
        timeRange.innerHTML = '';
        return;
    }

    // Show truncation warning if results were limited
    let warningHtml = '';
    if (truncated) {
        warningHtml = `<div class="message warning" style="background: #fff3cd; color: #856404; border-left: 4px solid #ffc107; margin-bottom: 10px;">
            <strong>Results Truncated:</strong> Only showing first ${maxResults.toLocaleString()} lines. Please refine your filters to see more specific results.
        </div>`;
    }

    logsContainer.innerHTML = warningHtml + lines.map((line, index) =>
        `<div class="log-line" onclick="selectLogLine(this)" data-log-content="${escapeHtml(line.content).replace(/"/g, '&quot;')}" data-line-number="${line.line_number}">
            <span class="line-number">${line.line_number}</span>
            <span class="line-content">${escapeHtml(line.content)}</span>
        </div>`
    ).join('');

    logCount.textContent = `${total.toLocaleString()} lines`;

    // Display time range if available
    if (startTime || endTime) {
        timeRange.innerHTML = `
            <div class="time-range">
                <strong>Time Range:</strong>
                ${formatDateTime(startTime)} → ${formatDateTime(endTime)}
            </div>
        `;
    } else {
        timeRange.innerHTML = '<div class="time-range">No timestamps found in logs</div>';
    }
}

// Utility function to show messages
function showMessage(element, text, type) {
    element.innerHTML = `<div class="message ${type}">${text}</div>`;
    setTimeout(() => {
        element.innerHTML = '';
    }, 3000);
}

// Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Extract timestamp from log line
function extractTimestamp(logLine) {
    // Match pattern like [2025-11-19 08:03:22]
    const match = logLine.match(/\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\]/);
    if (match) {
        return new Date(match[1]);
    }
    return null;
}

// Store selected log line content
let selectedLogContent = null;
let selectedLineNumber = null;

// Clear selection state
function clearSelection() {
    selectedLogContent = null;
    selectedLineNumber = null;

    // Remove selection from all log lines
    document.querySelectorAll('.log-line').forEach(line => {
        line.classList.remove('selected');
    });

    // Disable the context buttons
    const contextBtn = document.getElementById('contextBtn');
    contextBtn.disabled = true;
    contextBtn.style.opacity = '0.5';

    const lineContextBtn = document.getElementById('lineContextBtn');
    lineContextBtn.disabled = true;
    lineContextBtn.style.opacity = '0.5';
}

// Select a log line
function selectLogLine(element) {
    // Remove selection from all log lines
    document.querySelectorAll('.log-line').forEach(line => {
        line.classList.remove('selected');
    });

    // Add selection to clicked line
    element.classList.add('selected');

    // Get log content from data attribute
    const logContent = element.getAttribute('data-log-content');

    // Decode HTML entities back to original text
    const textarea = document.createElement('textarea');
    textarea.innerHTML = logContent;
    selectedLogContent = textarea.value;
    selectedLineNumber = parseInt(element.getAttribute('data-line-number'), 10);

    // Enable the context buttons
    const contextBtn = document.getElementById('contextBtn');
    contextBtn.disabled = false;
    contextBtn.style.opacity = '1';

    const lineContextBtn = document.getElementById('lineContextBtn');
    lineContextBtn.disabled = false;
    lineContextBtn.style.opacity = '1';
}

// Format a Date object for a datetime-local input (YYYY-MM-DDTHH:MM:SS)
function formatDateForInput(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

// Set a pair of datetime-local inputs (and their display labels) from timestamps
function setDateRangeInputs(startInput, startDisplay, endInput, endDisplay, startTime, endTime) {
    if (startTime) {
        startInput.value = formatDateForInput(new Date(startTime));
    }
    if (endTime) {
        endInput.value = formatDateForInput(new Date(endTime));
    }
    updateDateTimeDisplay(startInput, startDisplay);
    updateDateTimeDisplay(endInput, endDisplay);
}

// ============================================================================
// Context Panel
// ============================================================================
// "Apply Context" never touches the main filtered view - it opens a side
// panel with its own independent filters, seeded with the date range spanned
// by the selected line's time/line window. This lets you drill into the
// surrounding logs of one entry, close the panel, and pick another entry in
// the main view without losing or having to restore the original search.

const contextStartDateInput = document.getElementById('contextStartDate');
const contextEndDateInput = document.getElementById('contextEndDate');
const contextStartDateDisplay = document.getElementById('contextStartDateDisplay');
const contextEndDateDisplay = document.getElementById('contextEndDateDisplay');
const contextPanel = document.getElementById('contextPanel');
const logsArea = document.getElementById('logsArea');

function openContextPanel() {
    contextPanel.classList.add('open');
}

function closeContextPanel() {
    contextPanel.classList.remove('open');
}

// Load this file's remembered context filters into the panel (empty if none yet)
function loadContextFiltersForFile(fileId) {
    const saved = contextFiltersByFile[fileId] || { include: [], exclude: [], logic: 'AND', caseSensitive: false };
    contextIncludeFilters = [...saved.include];
    contextExcludeFilters = [...saved.exclude];
    document.getElementById('contextFilterLogic').value = saved.logic;
    document.getElementById('contextCaseSensitive').checked = saved.caseSensitive;
    renderContextFilters();
}

// Persist the panel's current filters against the given file
function saveContextFiltersForFile(fileId) {
    if (!fileId) return;
    contextFiltersByFile[fileId] = {
        include: [...contextIncludeFilters],
        exclude: [...contextExcludeFilters],
        logic: document.getElementById('contextFilterLogic').value,
        caseSensitive: document.getElementById('contextCaseSensitive').checked
    };
}

function addContextFilter(type) {
    const input = document.getElementById(type === 'include' ? 'contextIncludeInput' : 'contextExcludeInput');
    const value = input.value.trim();
    if (!value) return;

    if (type === 'include') {
        contextIncludeFilters.push(value);
    } else {
        contextExcludeFilters.push(value);
    }

    input.value = '';
    renderContextFilters();
    saveContextFiltersForFile(currentFileId);
}

function removeContextFilter(type, index) {
    if (type === 'include') {
        contextIncludeFilters.splice(index, 1);
    } else {
        contextExcludeFilters.splice(index, 1);
    }
    renderContextFilters();
    saveContextFiltersForFile(currentFileId);
}

function renderContextFilters() {
    document.getElementById('contextIncludeFilters').innerHTML = contextIncludeFilters.map((filter, index) => `
        <div class="filter-tag">
            ${filter}
            <button onclick="removeContextFilter('include', ${index})">×</button>
        </div>
    `).join('');

    document.getElementById('contextExcludeFilters').innerHTML = contextExcludeFilters.map((filter, index) => `
        <div class="filter-tag exclude">
            ${filter}
            <button onclick="removeContextFilter('exclude', ${index})">×</button>
        </div>
    `).join('');
}

document.getElementById('contextFilterLogic').addEventListener('change', () => saveContextFiltersForFile(currentFileId));
document.getElementById('contextCaseSensitive').addEventListener('change', () => saveContextFiltersForFile(currentFileId));

// Save the panel's current state to this file's own undo stack
function saveContextToHistory() {
    if (!currentFileId) return;

    const entry = contextHistoryByFile[currentFileId] || { history: [], index: -1 };

    const state = {
        includeFilters: [...contextIncludeFilters],
        excludeFilters: [...contextExcludeFilters],
        logic: document.getElementById('contextFilterLogic').value,
        caseSensitive: document.getElementById('contextCaseSensitive').checked,
        startDate: contextStartDateInput.value,
        endDate: contextEndDateInput.value,
        timestamp: Date.now()
    };

    if (entry.index < entry.history.length - 1) {
        entry.history = entry.history.slice(0, entry.index + 1);
    }

    entry.history.push(state);
    entry.index = entry.history.length - 1;
    contextHistoryByFile[currentFileId] = entry;

    try {
        sessionStorage.setItem('contextHistoryByFile', JSON.stringify(contextHistoryByFile));
    } catch (e) {
        console.error('Failed to save context history to sessionStorage:', e);
    }

    updateContextRestoreButton();
}

// Restore the context panel's previous state for the current file only (does
// not touch the main view's history, and never crosses into another file's history)
function restoreContextFilters() {
    const entry = contextHistoryByFile[currentFileId];
    if (!entry || entry.index <= 0) {
        alert('No previous state to restore');
        return;
    }

    entry.index--;
    const state = entry.history[entry.index];

    contextIncludeFilters = [...state.includeFilters];
    contextExcludeFilters = [...state.excludeFilters];

    document.getElementById('contextFilterLogic').value = state.logic;
    document.getElementById('contextCaseSensitive').checked = state.caseSensitive;
    contextStartDateInput.value = state.startDate;
    contextEndDateInput.value = state.endDate;

    updateDateTimeDisplay(contextStartDateInput, contextStartDateDisplay);
    updateDateTimeDisplay(contextEndDateInput, contextEndDateDisplay);

    renderContextFilters();
    saveContextFiltersForFile(currentFileId);

    try {
        sessionStorage.setItem('contextHistoryByFile', JSON.stringify(contextHistoryByFile));
    } catch (e) {
        console.error('Failed to save context history index to sessionStorage:', e);
    }

    updateContextRestoreButton();

    // Automatically re-apply the restored state without saving it again
    applyContextPanelFilters(true);
}

// Enable/disable the context panel's own restore button, based on the current file's history
function updateContextRestoreButton() {
    const restoreBtn = document.getElementById('contextRestoreBtn');
    const entry = contextHistoryByFile[currentFileId];
    if (entry && entry.index > 0) {
        restoreBtn.disabled = false;
        restoreBtn.style.opacity = '1';
    } else {
        restoreBtn.disabled = true;
        restoreBtn.style.opacity = '0.5';
    }
}

// Load the context panel's per-file history from sessionStorage on page load
function loadContextHistoryFromSession() {
    try {
        const saved = sessionStorage.getItem('contextHistoryByFile');

        if (saved) {
            contextHistoryByFile = JSON.parse(saved);
        }

        updateContextRestoreButton();
    } catch (e) {
        console.error('Failed to load context history from sessionStorage:', e);
        contextHistoryByFile = {};
    }
}

// Run the panel's own filters (independent of the main view's) against the current file
async function applyContextPanelFilters(skipSave = false) {
    if (!currentFileId) return;

    if (!skipSave) {
        saveContextToHistory();
    }

    saveContextFiltersForFile(currentFileId);

    const contextLogsContainer = document.getElementById('contextLogsContainer');
    contextLogsContainer.innerHTML = '<div class="loading">Loading logs...</div>';

    const filterData = {
        include: contextIncludeFilters,
        exclude: contextExcludeFilters,
        logic: document.getElementById('contextFilterLogic').value,
        case_sensitive: document.getElementById('contextCaseSensitive').checked
    };

    const startDate = contextStartDateInput.value;
    const endDate = contextEndDateInput.value;

    if (startDate) {
        filterData.start_date = startDate;
    }
    if (endDate) {
        filterData.end_date = endDate;
    }

    try {
        const { ok, data } = await fetchFilteredLogs(currentFileId, filterData);

        if (ok) {
            renderContextLogs(data.lines, data.total, data.start_time, data.end_time, data.truncated, data.max_results);
        } else {
            contextLogsContainer.innerHTML = `<div class="message error">${data.error || 'Failed to load logs'}</div>`;
        }
    } catch (error) {
        contextLogsContainer.innerHTML = `<div class="message error">Failed to load logs: ${error.message}</div>`;
    }
}

// Render logs inside the context panel (read-only - no line selection/nesting)
function renderContextLogs(lines, total, startTime, endTime, truncated, maxResults) {
    const logsContainer = document.getElementById('contextLogsContainer');
    const logCount = document.getElementById('contextLogCount');
    const timeRange = document.getElementById('contextTimeRange');

    if (lines.length === 0) {
        logsContainer.innerHTML = '<div class="message info">No logs match the current filters</div>';
        logCount.textContent = '0 lines';
        timeRange.innerHTML = '';
        return;
    }

    let warningHtml = '';
    if (truncated) {
        warningHtml = `<div class="message warning" style="background: #fff3cd; color: #856404; border-left: 4px solid #ffc107; margin-bottom: 10px;">
            <strong>Results Truncated:</strong> Only showing first ${maxResults.toLocaleString()} lines. Please refine your filters to see more specific results.
        </div>`;
    }

    logsContainer.innerHTML = warningHtml + lines.map(line =>
        `<div class="log-line">
            <span class="line-number">${line.line_number}</span>
            <span class="line-content">${escapeHtml(line.content)}</span>
        </div>`
    ).join('');

    logCount.textContent = `${total.toLocaleString()} lines`;

    if (startTime || endTime) {
        timeRange.innerHTML = `
            <div class="time-range">
                <strong>Time Range:</strong>
                ${formatDateTime(startTime)} → ${formatDateTime(endTime)}
            </div>
        `;
    } else {
        timeRange.innerHTML = '<div class="time-range">No timestamps found in logs</div>';
    }
}

// Open (or refill) the context panel with a computed date range, reusing
// this file's remembered secondary filters, then apply immediately
function openContextWithRange(startTime, endTime) {
    loadContextFiltersForFile(currentFileId);

    setDateRangeInputs(contextStartDateInput, contextStartDateDisplay, contextEndDateInput, contextEndDateDisplay, startTime, endTime);

    openContextPanel();
    applyContextPanelFilters();
}

// Apply time window to selected log line
function applyTimeWindowToSelected() {
    if (!selectedLogContent) {
        alert('Please select a log line first');
        return;
    }

    // Extract timestamp from the log line
    const timestamp = extractTimestamp(selectedLogContent);

    if (!timestamp || isNaN(timestamp.getTime())) {
        alert('No valid timestamp found in the selected log entry');
        return;
    }

    // Get the selected time window (in minutes)
    const windowMinutes = parseInt(document.getElementById('timeWindow').value);

    // Calculate start and end times
    const startTime = new Date(timestamp.getTime() - windowMinutes * 60 * 1000);
    const endTime = new Date(timestamp.getTime() + windowMinutes * 60 * 1000);

    openContextWithRange(startTime, endTime);
}

// Apply line window to selected log line: translate "± N lines" into the
// date range those surrounding lines span, then open it in the context panel
// the same way the time-window context does.
async function applyLineWindowToSelected() {
    if (!selectedLogContent || selectedLineNumber == null || isNaN(selectedLineNumber)) {
        alert('Please select a log line first');
        return;
    }

    if (!currentFileId) {
        alert('Please select a file first');
        return;
    }

    const windowLines = parseInt(document.getElementById('lineWindow').value);

    let contextData;
    try {
        const response = await fetch(
            `/api/files/${currentFileId}/line-context?line_number=${selectedLineNumber}&window=${windowLines}`
        );
        contextData = await response.json();

        if (!response.ok) {
            alert(contextData.error || 'Failed to load line context');
            return;
        }
    } catch (error) {
        alert('Failed to load line context: ' + error.message);
        return;
    }

    if (!contextData.start_time && !contextData.end_time) {
        alert('No valid timestamps found in the surrounding lines');
        return;
    }

    openContextWithRange(contextData.start_time, contextData.end_time);
}

// Load files and history on page load
loadHistoryFromSession();
loadContextHistoryFromSession();
loadFiles();
