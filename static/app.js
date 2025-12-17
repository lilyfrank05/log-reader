// State variables
let currentFiles = [];
let currentFileId = null;
let includeFilters = [];
let excludeFilters = [];
let fileTimeRange = null;
let presets = [];

// Filter history stack
let filterHistory = [];
let currentHistoryIndex = -1;

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

startDateInput.addEventListener('change', () => updateDateTimeDisplay(startDateInput, startDateDisplay));
endDateInput.addEventListener('change', () => updateDateTimeDisplay(endDateInput, endDateDisplay));

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
            // Complete progress
            progressFill.style.width = '100%';
            progressText.textContent = 'Loading file list...';

            // Load files and show success after
            const listStart = Date.now();
            await loadFiles();
            const listTime = Date.now() - listStart;
            console.log(`[CLIENT] File list loaded in ${listTime}ms`);

            const totalTime = Date.now() - uploadStart;
            console.log(`[CLIENT] Total upload flow: ${totalTime}ms`);

            setTimeout(() => {
                uploadProgress.style.display = 'none';
                uploadMessage.style.display = 'block';

                // Handle different response types
                if (data.is_zip && !data.duplicate) {
                    // Zip file extracted and uploaded
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
});

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
            if (currentFileId === fileId) {
                currentFileId = null;
                document.getElementById('logsContainer').innerHTML =
                    '<div class="message info">Select a file to view logs</div>';
                document.getElementById('logCount').textContent = 'No logs loaded';
            }
            loadFiles();
        } else {
            alert('Failed to delete file');
        }
    } catch (error) {
        alert('Failed to delete file: ' + error.message);
    }
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
}

// Remove filter
function removeFilter(type, index) {
    if (type === 'include') {
        includeFilters.splice(index, 1);
    } else {
        excludeFilters.splice(index, 1);
    }
    renderFilters();
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

// Save current filter state to history
function saveToHistory() {
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
    if (currentHistoryIndex < filterHistory.length - 1) {
        filterHistory = filterHistory.slice(0, currentHistoryIndex + 1);
    }

    // Add new state to history
    filterHistory.push(state);
    currentHistoryIndex = filterHistory.length - 1;

    // Save to sessionStorage
    try {
        sessionStorage.setItem('filterHistory', JSON.stringify(filterHistory));
        sessionStorage.setItem('currentHistoryIndex', currentHistoryIndex.toString());
    } catch (e) {
        console.error('Failed to save history to sessionStorage:', e);
    }

    // Update restore button state
    updateRestoreButton();
}

// Restore previous filter state from history
function restoreFilters() {
    if (currentHistoryIndex <= 0) {
        alert('No previous state to restore');
        return;
    }

    // Move back in history
    currentHistoryIndex--;
    const state = filterHistory[currentHistoryIndex];

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

    // Save current index to sessionStorage
    try {
        sessionStorage.setItem('currentHistoryIndex', currentHistoryIndex.toString());
    } catch (e) {
        console.error('Failed to save history index to sessionStorage:', e);
    }

    // Update restore button state
    updateRestoreButton();

    // Automatically apply the restored filters without saving to history
    applyFilters(true);
}

// Update restore button enabled/disabled state
function updateRestoreButton() {
    const restoreBtn = document.getElementById('restoreBtn');
    if (currentHistoryIndex > 0) {
        restoreBtn.disabled = false;
        restoreBtn.style.opacity = '1';
    } else {
        restoreBtn.disabled = true;
        restoreBtn.style.opacity = '0.5';
    }
}

// Load filter history from sessionStorage on page load
function loadHistoryFromSession() {
    try {
        const savedHistory = sessionStorage.getItem('filterHistory');
        const savedIndex = sessionStorage.getItem('currentHistoryIndex');

        if (savedHistory) {
            filterHistory = JSON.parse(savedHistory);
        }
        if (savedIndex !== null) {
            currentHistoryIndex = parseInt(savedIndex);
        }

        updateRestoreButton();
    } catch (e) {
        console.error('Failed to load history from sessionStorage:', e);
        filterHistory = [];
        currentHistoryIndex = -1;
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

    // Note: Date range is NOT cleared
}

async function applyFilters(skipSave = false) {
    if (!currentFileId) {
        alert('Please select a file first');
        return;
    }

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
        const response = await fetch(`/api/logs/${currentFileId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(filterData)
        });

        const data = await response.json();

        if (response.ok) {
            renderLogs(data.lines, data.total, data.start_time, data.end_time, data.truncated, data.max_results);
        } else {
            logsContainer.innerHTML = `<div class="message error">${data.error || 'Failed to load logs'}</div>`;
        }
    } catch (error) {
        logsContainer.innerHTML = `<div class="message error">Failed to load logs: ${error.message}</div>`;
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
        `<div class="log-line" onclick="selectLogLine(this)" data-log-content="${escapeHtml(line.content).replace(/"/g, '&quot;')}">
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

// Clear selection state
function clearSelection() {
    selectedLogContent = null;

    // Remove selection from all log lines
    document.querySelectorAll('.log-line').forEach(line => {
        line.classList.remove('selected');
    });

    // Disable the context button
    const contextBtn = document.getElementById('contextBtn');
    contextBtn.disabled = true;
    contextBtn.style.opacity = '0.5';
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

    // Enable the context button
    const contextBtn = document.getElementById('contextBtn');
    contextBtn.disabled = false;
    contextBtn.style.opacity = '1';
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

    // Format dates for datetime-local input (YYYY-MM-DDTHH:MM:SS)
    const formatForInput = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
    };

    // Set the date range inputs
    startDateInput.value = formatForInput(startTime);
    endDateInput.value = formatForInput(endTime);

    // Update the display labels
    updateDateTimeDisplay(startDateInput, startDateDisplay);
    updateDateTimeDisplay(endDateInput, endDateDisplay);

    // Automatically apply filters (this will clear selection)
    applyFilters();
}

// Load files and history on page load
loadHistoryFromSession();
loadFiles();
