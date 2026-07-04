/**
 * routes/download.js — Enqueue downloads and open files/folders.
 *
 * POST /download/start            Add download to queue
 * POST /download/open-file        Open file in OS
 * POST /download/open-folder      Open folder in OS
 */

const express = require('express');
const router = express.Router();
const { addToQueue } = require('../queue');
const { detectPlatform } = require('../detector');
const { exec } = require('child_process');
const path = require('path');
const os = require('os');

router.post('/start', (req, res) => {
  const { url, action, options = {}, title, platform: hintPlatform, priority = 0 } = req.body;
  if (!url || !action) return res.status(400).json({ error: 'url and action required' });

  const platform = hintPlatform || detectPlatform(url);

  const id = addToQueue({
    url,
    action,
    options,
    title: title || url,
    platform,
    priority
  });

  res.json({ id, queued: true });
});

// Open file with OS default application
router.post('/open-file', (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });

  // First verify the file actually exists
  const fs = require('fs');
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `File not found: ${filePath}` });
  }

  let cmd;
  if (process.platform === 'win32') {
    // Use 'start' — never fails with an exit-code error the way explorer does
    cmd = `start "" "${filePath}"`;
  } else if (process.platform === 'darwin') {
    cmd = `open "${filePath}"`;
  } else {
    cmd = `xdg-open "${filePath}"`;
  }

  // NOTE: exec callback error is intentionally ignored for all OS file-manager
  // commands. On Windows 'explorer', 'start', and even 'open' on macOS always
  // exit with a non-zero code even when they open the file successfully.
  // We already verified the file exists above, so we just respond OK.
  exec(cmd, () => {});
  res.json({ ok: true });
});

router.post('/open-folder', (req, res) => {
  const { folderPath, filePath } = req.body;
  const target = folderPath || (filePath ? path.dirname(filePath) : null);
  if (!target) return res.status(400).json({ error: 'folderPath or filePath required' });

  // Verify the target directory exists
  const fs = require('fs');
  if (!fs.existsSync(target)) {
    return res.status(404).json({ error: `Folder not found: ${target}` });
  }

  let cmd;
  if (process.platform === 'win32') {
    // /select highlights the file inside the folder; without a file just open folder
    cmd = filePath && fs.existsSync(filePath)
      ? `explorer /select,"${filePath}"`
      : `explorer "${target}"`;
  } else if (process.platform === 'darwin') {
    cmd = filePath && fs.existsSync(filePath) ? `open -R "${filePath}"` : `open "${target}"`;
  } else {
    cmd = `xdg-open "${target}"`;
  }

  // Same as open-file: ignore the exit code — file managers always exit non-zero
  exec(cmd, () => {});
  res.json({ ok: true });
});

module.exports = router;
