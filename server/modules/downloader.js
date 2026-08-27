/**
 * downloader.js — Download execution via yt-dlp and gallery-dl.
 *
 * Key fixes:
 *  - Process stored on item so queue can kill it on cancel
 *  - Progress is monotonic (never goes backward)
 *  - item.cancelled checked per line so cancel stops immediately
 *  - Temp files tracked for cleanup on cancel
 *  - gallery-dl filename template uses correct syntax: {num:03}
 *  - YouTube video always uses --no-playlist
 *  - Recommended quality: ≤720p, never 1080p
 *  - downloadYouTubeVideoWithSubs: subs-only mode + embed mode
 *  - Instagram carousel all/filtered: correct gallery-dl args
 *  - All functions accept optional `item` param for process tracking
 */

'use strict';

const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const { getCookiesArgs } = require('./cookies');
const { getSettings }    = require('./db');
const { broadcastProgress } = require('./websocket');
const log = require('./logger').child('downloader.js');

function getYtDlpBin()    { return process.platform === 'win32' ? 'yt-dlp.exe'     : 'yt-dlp'; }
function getGalleryDlBin(){ return process.platform === 'win32' ? 'gallery-dl.exe' : 'gallery-dl'; }
function getFfmpegBin()   {
  if (process.platform === 'win32') {
    // Check common ffmpeg installation locations
    const possiblePaths = [
      'C:\\ffmpeg-7.0.2-essentials_build\\bin\\ffmpeg.exe',
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\tools\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe',
      process.env.USERPROFILE ? `${process.env.USERPROFILE}\\ffmpeg\\bin\\ffmpeg.exe` : '',
      process.env.USERPROFILE ? `${process.env.USERPROFILE}\\Downloads\\ffmpeg-latest\\bin\\ffmpeg.exe` : '',
      'ffmpeg.exe' // fallback to PATH
    ];

    const fs = require('fs');
    const path = require('path');

    for (const testPath of possiblePaths) {
      if (!testPath) continue; // skip empty strings

      try {
        if (fs.existsSync(testPath)) {
          return testPath;
        }
      } catch (e) {
        // Continue to next path if this one fails
        continue;
      }
    }

    // Fallback to PATH resolution
    return 'ffmpeg.exe';
  }
  return 'ffmpeg';
}

function ensureFolder(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

function sanitizeFilename(name) {
  return (name || 'download')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ').trim().slice(0, 180);
}

function sanitizePlaylistName(name) {
  return sanitizeFilename((name || 'Playlist').replace(/[\/\\]+/g, ' ')).slice(0, 120);
}

function ytRootBase(options, settings) {
  // Base folder for all YouTube downloads. Use settings.downloadFolder if present,
  // otherwise fall back to user's Downloads/GrabIt. Then create a 'YT' subfolder for clarity.
  const base = options?.folder || settings?.downloadFolder || path.join(os.homedir(), 'Downloads', 'GrabIt');
  const ytBase = path.join(base, 'YT');
  ensureFolder(ytBase);
  return ytBase;
}

// Helper function to convert WebP to JPG using ffmpeg
async function convertWebpToJpg(filePath, item, downloadId) {
  if (!filePath || !filePath.toLowerCase().endsWith('.webp')) {
    return filePath;
  }

  const jpgPath = filePath.slice(0, -5) + '.jpg'; // Replace .webp with .jpg

  try {
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      log.warn('convertWebpToJpg', `Source file does not exist: ${filePath}`);
      return filePath;
    }

    // Check if target already exists
    if (fs.existsSync(jpgPath)) {
      // Remove existing file to avoid rename issues
      fs.unlinkSync(jpgPath);
    }

    const ffmpegBin = getFfmpegBin();
    const args = ['-y', '-i', filePath, jpgPath];

    // log.cmd('convertWebpToJpg', ffmpegBin, args);

    log.info(
  'convertWebpToJpg',
  `Converting ${path.basename(filePath)}`
);

    await spawnProcess(ffmpegBin, args, downloadId, item, () => null);

    // Verify the conversion worked
  if (fs.existsSync(jpgPath)) {
    // Remove the original WebP file
    fs.unlinkSync(filePath);

    log.ok(
      'convertWebpToJpg',
      `Converted ${path.basename(filePath)}`
    );

      // Update tempFiles tracking if we're tracking this item
      if (item && item.tempFiles) {
        const webpIndex = item.tempFiles.indexOf(filePath);
        if (webpIndex > -1) {
          item.tempFiles.splice(webpIndex, 1);
        }
        // Add the new JPG file to tracking if not already there
        if (!item.tempFiles.includes(jpgPath)) {
          item.tempFiles.push(jpgPath);
        }
      }

      return jpgPath;
    } else {
      log.warn('convertWebpToJpg', `Conversion failed - output file not found: ${jpgPath}`);
      return filePath;
    }
  } catch (err) {
    log.warn('convertWebpToJpg', `Failed to convert ${filePath} to JPG: ${err.message}`);
    return filePath;
  }
}

// ── Progress parsing ──────────────────────────────────────────────────────────

const YT_PROGRESS_RE = /\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+)([KMGT]iB)(?:\s+at\s+([\d.]+[KMGT]?iB\/s))?(?:\s+ETA\s+([\d:]+))?/i;
const GALLERY_DL_RE  = /\[#\d+\s+([\d.]+)([KMGT]?B)\s+\/\s+([\d.]+)([KMGT]?B)/i;

function parseYtDlpLine(line) {
  const m = YT_PROGRESS_RE.exec(line);
  if (!m) return null;
  const mult = { KiB: 1024, MiB: 1024**2, GiB: 1024**3, TiB: 1024**4 }[m[3]] || 1;
  return { percent: parseFloat(m[1]), totalSize: Math.round(parseFloat(m[2]) * mult), speed: m[4] || null, eta: m[5] || null };
}

// parseGalleryDlLine removed — gallery-dl uses custom file-path tracking

// ── Core process runner ───────────────────────────────────────────────────────

// function spawnProcess(bin, args, downloadId, item, parseLine) {
//   const FN = `spawnProcess[${path.basename(bin)}]`;
//   const isFFmpeg = path.basename(bin).toLowerCase().startsWith('ffmpeg');

//   if (!isFFmpeg) {
//     log.cmd(FN, bin, args);
//     log.download(FN, 'started', {
//       downloadId,
//       bin: path.basename(bin),
//       title: item?.title?.slice(0, 80)
//     });
//   }

//   return new Promise((resolve, reject) => {
//     const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
//     if (item) {
//       item.proc      = proc;
//       item.tempFiles = item.tempFiles || [];
//     }

//     let stdout = '', stderr = '', lastPct = -1;
//     const files = [];

//   const onLine = (line) => {
//     if (line.trim() && !isFFmpeg) {
//       log.debug(FN, 'stdout', {
//         downloadId,
//         line: line.trim().slice(0, 300)
//       });
//     }
//         if (item?.cancelled) { try { proc.kill('SIGTERM'); } catch {} return; }

//         // Capture output filenames
//         const destMatch = line.match(/\[download\] Destination:\s*(.+)$/);
//         if (destMatch) {
//           const f = destMatch[1].trim();
//           files.push(f);
//           if (item && !item.tempFiles.includes(f)) item.tempFiles.push(f);

//           // If this queue item represents a playlist download (server-side options set by probe/popup),
//           // increment the per-playlist downloaded counter and reset per-file progress so the UI
//           // shows a fresh progress bar for the next file.
//           try {
//             if (item && item.options && typeof item.options.playlistTotal === 'number') {
//               item.options.playlistDownloaded = (item.options.playlistDownloaded || 0) + 1;
//               // Reset file-level progress so bar goes back to 0 for the new file
//               item.progress = { percent: 0, speed: null, eta: null, totalSize: null };

//               // Broadcast immediate progress update including playlist counts so the popup can update
//               // the per-item playlist badge without waiting for a full queue refresh.
//               // Immediately notify clients that a new file has been detected and playlist counters changed.
//               // Use websocket.broadcastProgress with immediate=true so the UI can reset per-file bars and update counters.
//               try {
//                 const meta = {
//                   playlistDownloaded: item.options.playlistDownloaded,
//                   playlistTotal: item.options.playlistTotal,
//                   playlistName: item.options.playlistName || item.title
//                 };
//                 // When a new Destination line is seen, reset progress.percent to 0 in-memory and broadcast immediately.
//                 if (!item.progress) item.progress = { percent: 0 };
//                 else item.progress.percent = 0;
//                 broadcastProgress(downloadId, item.progress, meta, true);
//               } catch (e) {
//                 log.warn('spawnProcess', 'Failed to update playlist counters', { error: e.message });
//               }
//             }
//           } catch (e) {
//             log.warn('spawnProcess', 'Failed to update playlist counters', { error: e.message });
//           }
//         }

//         const alreadyMatch = line.match(/\[download\]\s+(.+?)\s+has already been downloaded/i);

//         if (alreadyMatch) {
//             let f = alreadyMatch[1].trim();

//             // If the reported file doesn't exist, try finding the real file
//             if (!fs.existsSync(f)) {
//                 const dir = path.dirname(f);
//                 const ext = path.extname(f);
//                 const id = path.basename(f, ext).split('_').pop();

//                 try {
//                     const match = fs.readdirSync(dir).find(name =>
//                         name.endsWith(`_${id}${ext}`)
//                     );

//                     if (match) {
//                         f = path.join(dir, match);
//                     }
//                 } catch {}
//             }

//             if (!files.includes(f)) {
//                 files.push(f);
//             }

//             if (item && !item.tempFiles.includes(f)) {
//                 item.tempFiles.push(f);
//             }
//         }
//         const mergeMatch = line.match(/Merging formats into "(.+)"/);
//         if (mergeMatch) files.push(mergeMatch[1].trim());
//         const audioMatch = line.match(/\[ExtractAudio\].*Destination:\s*(.+)$/);
//         if (audioMatch) files.push(audioMatch[1].trim());

//         const prog = parseLine(line);
//         if (prog && downloadId) {
//           // Monotonic: never go backward
//           if (prog.percent > lastPct) {
//             lastPct = prog.percent;
//             broadcastProgress(downloadId, prog);
//             if (item) item.progress = prog;
//           }
//         }
//       };

//     let outBuf = '', errBuf = '';
//     proc.stdout.setEncoding('utf8');
//     proc.stderr.setEncoding('utf8');

//     proc.stdout.on('data', chunk => {
//       stdout += chunk; outBuf += chunk;
//       const lines = outBuf.split('\n'); outBuf = lines.pop();
//       lines.forEach(onLine);
//     });
//   proc.stderr.on('data', chunk => {
//   stderr += chunk;
//   errBuf += chunk;
//   const lines = errBuf.split('\n');
//   errBuf = lines.pop();

//   lines.forEach(line => {
//     if (line.trim() && !isFFmpeg) {
//       log.warn(FN, 'stderr', {
//         downloadId,
//         line: line.trim().slice(0, 300)
//       });
//     }

//     onLine(line);
//   });
// });

//     proc.on('close', code => {
//       if (item) item.proc = null;
//       if (item?.cancelled) {
//         log.warn(FN, 'Download cancelled by user', { downloadId });
//         return reject(new Error('Cancelled'));
//       }
//       if (code !== 0 && code !== null) {
//         const errTail = (stderr || stdout).trim().split('\n').slice(-8).join('\n');
//         log.error(FN, `Process exited ${code}`, {
//           downloadId,
//           exitCode: code,
//           stderr: stderr.trim().slice(0, 2000) || '(empty)',
//           stdout: stdout.trim().slice(0, 500) || '(empty)',
//           files
//         });
//         return reject(new Error(`${path.basename(bin)} exited ${code}: ${errTail}`));
//       }
//       // log.download(FN, 'complete', { downloadId, exitCode: code, files, stdoutBytes: stdout.length, stderrBytes: stderr.length });
//         if (!isFFmpeg) {
//       log.download(FN, 'complete', {
//         downloadId,
//         exitCode: code,
//         files,
//         stdoutBytes: stdout.length,
//         stderrBytes: stderr.length
//       });

//       // Clean up subtitle sidecar files for YouTube downloads that embed subtitles
//       const isYtDlp = path.basename(bin).toLowerCase().startsWith('yt-dlp');
//       const hasEmbedSubs = args.some(arg => arg === '--embed-subs');
//       if (isYtDlp && hasEmbedSubs) {
//         const subtitleExtensions = ['.srt', '.vtt', '.ass', '.ssa'];
//         for (const file of files) {
//           if (file && typeof file === 'string') {
//             const basePath = file.substring(0, file.lastIndexOf('.'));
//             for (const ext of subtitleExtensions) {
//               const subtitleFile = basePath + ext;
//               try {
//                 if (fs.existsSync(subtitleFile)) {
//                   fs.unlinkSync(subtitleFile);
//                   log.debug(FN, `Deleted subtitle sidecar: ${path.basename(subtitleFile)}`);
//                 }
//               } catch (unlinkErr) {
//                 log.warn(FN, `Failed to delete subtitle sidecar ${subtitleFile}: ${unlinkErr.message}`);
//               }
//             }
//           }
//         }
//       }
//   }
//       resolve({ success: true, file: files[files.length - 1] || null, files, stdout, stderr });
//     });

//     proc.on('error', err => {
//       if (item) item.proc = null;
//       log.error(FN, `Cannot start process: ${err.message}`, { downloadId, bin, errorCode: err.code });
//       reject(new Error(`Cannot start ${path.basename(bin)}: ${err.message}`));
//     });
//   });
// }

function spawnProcess(bin, args, downloadId, item, parseLine) {
  const FN = `spawnProcess[${path.basename(bin)}]`;
  const isFFmpeg = path.basename(bin).toLowerCase().startsWith('ffmpeg');
  const isYtDlp = path.basename(bin).toLowerCase().startsWith('yt-dlp');

  if (!isFFmpeg) {
    log.cmd(FN, bin, args);

    log.download(FN, 'started', {
      downloadId,
      bin: path.basename(bin),
      title: item?.title?.slice(0, 80)
    });
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    if (item) {
      item.proc = proc;
      item.tempFiles = item.tempFiles || [];
    }

    let stdout = '';
    let stderr = '';
    let lastPct = -1;

    const files = [];

    const addFile = (file) => {
      if (!file || typeof file !== 'string') return;

      const f = file.trim();
      if (!f) return;

      if (!files.includes(f)) {
        files.push(f);
      }

      if (item && !item.tempFiles.includes(f)) {
        item.tempFiles.push(f);
      }
    };

    const onLine = (line) => {
      const trimmed = line.trim();

      if (!trimmed) return;

      if (!isFFmpeg) {
        log.debug(FN, 'stdout', {
          downloadId,
          line: trimmed.slice(0, 300)
        });
      }

      if (item?.cancelled) {
        try {
          proc.kill('SIGTERM');
        } catch {}
        return;
      }

      // ─────────────────────────────────────────────
      // Capture download destination
      // ─────────────────────────────────────────────
      const destMatch = trimmed.match(
        /^\[download\]\s+Destination:\s*(.+)$/
      );

      if (destMatch) {
        const f = destMatch[1].trim();

        addFile(f);

        /*
         * A new destination means a new playlist file.
         * Reset progress tracking so the next file can start
         * from 0% instead of being blocked by the previous 100%.
         */
        if (
          item &&
          item.options &&
          typeof item.options.playlistTotal === 'number'
        ) {
          item.options.playlistDownloaded =
            item.options.playlistDownloaded || 0;

          lastPct = -1;

          item.progress = {
            percent: 0,
            speed: null,
            eta: null,
            totalSize: null
          };

          try {
            const meta = {
              playlistDownloaded: item.options.playlistDownloaded,
              playlistTotal: item.options.playlistTotal,
              playlistName:
                item.options.playlistName || item.title
            };

            broadcastProgress(
              downloadId,
              item.progress,
              meta,
              true
            );
          } catch (e) {
            log.warn(
              FN,
              'Failed to broadcast playlist file start',
              {
                error: e.message
              }
            );
          }
        }
      }

      // ─────────────────────────────────────────────
      // Already downloaded
      // ─────────────────────────────────────────────
      const alreadyMatch = trimmed.match(
        /^\[download\]\s+(.+?)\s+has already been downloaded/i
      );

      if (alreadyMatch) {
        let f = alreadyMatch[1].trim();

        if (!fs.existsSync(f)) {
          const dir = path.dirname(f);
          const ext = path.extname(f);

          const id = path
            .basename(f, ext)
            .split('_')
            .pop();

          try {
            if (fs.existsSync(dir)) {
              const match = fs.readdirSync(dir).find(name =>
                name.endsWith(`_${id}${ext}`)
              );

              if (match) {
                f = path.join(dir, match);
              }
            }
          } catch (err) {
            log.warn(
              FN,
              'Failed to verify already-downloaded file',
              {
                error: err.message,
                path: f
              }
            );
          }
        }

        addFile(f);
      }

      // ─────────────────────────────────────────────
      // Merging formats
      // ─────────────────────────────────────────────
      const mergeMatch = trimmed.match(
        /Merging formats into "(.+)"/
      );

      if (mergeMatch) {
        addFile(mergeMatch[1]);
      }

      // ─────────────────────────────────────────────
      // ExtractAudio destination
      // ─────────────────────────────────────────────
      const audioMatch = trimmed.match(
        /^\[ExtractAudio\].*Destination:\s*(.+)$/
      );

      if (audioMatch) {
        addFile(audioMatch[1]);
      }

      // ─────────────────────────────────────────────
      // Progress
      // ─────────────────────────────────────────────
      if (typeof parseLine === 'function') {
        const prog = parseLine(trimmed);

        if (prog && downloadId) {
          if (prog.percent > lastPct) {
            lastPct = prog.percent;

            broadcastProgress(downloadId, prog);

            if (item) {
              item.progress = prog;
            }
          }
        }
      }
    };

    let outBuf = '';
    let errBuf = '';

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    // ─────────────────────────────────────────────
    // STDOUT
    // ─────────────────────────────────────────────
    proc.stdout.on('data', chunk => {
      stdout += chunk;
      outBuf += chunk;

      const lines = outBuf.split('\n');
      outBuf = lines.pop() || '';

      lines.forEach(onLine);
    });

    // ─────────────────────────────────────────────
    // STDERR
    // IMPORTANT:
    // Do NOT pass stderr into onLine().
    // yt-dlp warnings/errors are not download progress.
    // ─────────────────────────────────────────────
    proc.stderr.on('data', chunk => {
      stderr += chunk;
      errBuf += chunk;

      const lines = errBuf.split('\n');
      errBuf = lines.pop() || '';

      lines.forEach(line => {
        const trimmed = line.trim();

        if (!trimmed || isFFmpeg) return;

        const isError = /error|failed|unable|forbidden|403/i.test(
          trimmed
        );

        if (isError) {
          log.error(FN, 'stderr', {
            downloadId,
            line: trimmed.slice(0, 500)
          });
        } else {
          log.warn(FN, 'stderr', {
            downloadId,
            line: trimmed.slice(0, 500)
          });
        }
      });
    });

    // ─────────────────────────────────────────────
    // PROCESS CLOSED
    // ─────────────────────────────────────────────
    proc.on('close', code => {
      if (item) {
        item.proc = null;
      }

      if (item?.cancelled) {
        log.warn(FN, 'Download cancelled by user', {
          downloadId
        });

        return reject(new Error('Cancelled'));
      }

      if (code !== 0 && code !== null) {
        const output = (stderr || stdout).trim();

        const lines = output
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(Boolean);

        /*
         * Prefer an actual ERROR line instead of blindly returning
         * the final eight lines.
         */
        const errorLine =
          [...lines]
            .reverse()
            .find(line => /^ERROR:/i.test(line)) ||
          lines[lines.length - 1] ||
          'Unknown error';

        log.error(FN, `Process exited ${code}`, {
          downloadId,
          exitCode: code,
          error: errorLine.slice(0, 2000),
          stderr: stderr.trim().slice(0, 3000),
          stdout: stdout.trim().slice(0, 1000),
          files
        });

        return reject(
          new Error(
            `${path.basename(bin)} exited ${code}: ${errorLine}`
          )
        );
      }

      // ─────────────────────────────────────────────
      // SUCCESS
      // ─────────────────────────────────────────────
      if (!isFFmpeg) {
        log.download(FN, 'complete', {
          downloadId,
          exitCode: code,
          files,
          stdoutBytes: stdout.length,
          stderrBytes: stderr.length
        });
      }

      // ─────────────────────────────────────────────
      // Remove subtitle sidecars after successful
      // --embed-subs operation.
      // ─────────────────────────────────────────────
      const hasEmbedSubs = args.some(
  arg => arg === '--embed-subs'
);

if (isYtDlp && hasEmbedSubs) {
  const subtitleExtensions = new Set([
    '.srt',
    '.vtt',
    '.ass',
    '.ssa'
  ]);

  const subtitleFiles = new Set();

  // Look for subtitle files associated with every
  // downloaded/merged output file.
  for (const file of files) {
    if (!file || typeof file !== 'string') continue;

    const fullPath = path.resolve(file);
    const dir = path.dirname(fullPath);
    const filename = path.basename(fullPath);
    const ext = path.extname(filename);

    if (!ext) continue;

    const baseName = filename.slice(
      0,
      -ext.length
    );

    try {
      if (!fs.existsSync(dir)) continue;

      for (const name of fs.readdirSync(dir)) {
        const candidateExt = path.extname(name).toLowerCase();

        if (!subtitleExtensions.has(candidateExt)) {
          continue;
        }

        /*
         * Matches:
         *
         * Video [ID].srt
         * Video [ID].en.srt
         * Video [ID].en-US.srt
         * Video [ID].vtt
         *
         * but does NOT delete unrelated subtitle files.
         */
        if (
          name === `${baseName}${candidateExt}` ||
          name.startsWith(`${baseName}.`)
        ) {
          subtitleFiles.add(
            path.join(dir, name)
          );
        }
      }
    } catch (err) {
      log.warn(
        FN,
        'Failed to scan for subtitle sidecars',
        {
          directory: dir,
          error: err.message
        }
      );
    }
  }

  // Delete only subtitle sidecars discovered
  // next to the actual downloaded output.
  for (const subtitleFile of subtitleFiles) {
    try {
      if (fs.existsSync(subtitleFile)) {
        fs.unlinkSync(subtitleFile);

        log.debug(
          FN,
          `Deleted embedded-subtitle sidecar: ${path.basename(subtitleFile)}`
        );
      }
    } catch (err) {
      log.warn(
        FN,
        'Failed to delete subtitle sidecar',
        {
          subtitleFile,
          error: err.message
        }
      );
    }
  }
}

      resolve({
        success: true,
        file: files[files.length - 1] || null,
        files,
        stdout,
        stderr
      });
    });

    // ─────────────────────────────────────────────
    // PROCESS ERROR
    // ─────────────────────────────────────────────
    proc.on('error', err => {
      if (item) {
        item.proc = null;
      }

      log.error(
        FN,
        `Cannot start process: ${err.message}`,
        {
          downloadId,
          bin,
          errorCode: err.code
        }
      );

      reject(
        new Error(
          `Cannot start ${path.basename(bin)}: ${err.message}`
        )
      );
    });
  });
}

function runYtDlp(args, downloadId, item) {
  return spawnProcess(getYtDlpBin(), args, downloadId, item, parseYtDlpLine);
}

function runGalleryDl(args, downloadId, item, outputDir = null) {
  const FN  = 'runGalleryDl';
  const bin = getGalleryDlBin();

  // Log the exact command — this was previously invisible in the logs
  // log.cmd(FN, bin, args);
  // log.download(FN, 'started', { downloadId, title: item?.title?.slice(0, 80) });
  ///////////////////////////////////////////////////////////////////////////////////////
      const isFFmpeg = path.basename(bin).toLowerCase().startsWith('ffmpeg');
      if (!isFFmpeg) {
  log.cmd(FN, bin, args);
  log.download(FN, 'started', {
    downloadId,
    bin: path.basename(bin),
    title: item?.title?.slice(0,80)
  });
}

  //////////////////////////////////////////////////////////////////////////////////////////

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (item) { item.proc = proc; item.tempFiles = item.tempFiles || []; }

    let stdout = '', stderr = '', fileCount = 0;
    const files = [];
    const { broadcastProgress: bp } = require('./websocket');

    const trackLine = (line) => {
      if (item?.cancelled) { try { proc.kill('SIGTERM'); } catch {} return; }
      const t = line.trim();
      if (!t) return;

      // gallery-dl writes full file paths to stdout (one per downloaded file)
      if (t.includes('/') || t.includes('\\') || /\.[a-z0-9]{2,5}$/i.test(t)) {
        if (fs.existsSync(t)) {          // only track if it's a real file path
          if (!files.includes(t)) files.push(t);
          if (item && !item.tempFiles.includes(t)) item.tempFiles.push(t);
          fileCount++;
          log.ok(FN, `File downloaded: ${path.basename(t)}`, { downloadId, fileCount, path: t });
          if (downloadId) bp(downloadId, { percent: Math.min(fileCount * 15, 90), speed: null, eta: null });
        }
      }
      // Log errors/warnings from gallery-dl stdout
      if (/error|warning|failed|skip/i.test(t)) {
        log.warn(FN, 'gallery-dl message', { downloadId, line: t.slice(0, 300) });
      }
    };

    let outBuf = '', errBuf = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      stdout += chunk; outBuf += chunk;
      const ls = outBuf.split('\n'); outBuf = ls.pop();
      ls.forEach(trackLine);
    });
    proc.stderr.on('data', chunk => {
      stderr += chunk; errBuf += chunk;
      const ls = errBuf.split('\n'); errBuf = ls.pop();
      ls.forEach(line => {
        if (line.trim()) log.warn(FN, 'stderr', { downloadId, line: line.trim().slice(0, 300) });
      });
    });

    proc.on('close', code => {
      if (item) item.proc = null;
      if (item?.cancelled) {
        log.warn(FN, 'Cancelled by user', { downloadId });
        return reject(new Error('Cancelled'));
      }

      // Log raw output for debugging
      log.out(FN, stdout, stderr, code);

      // gallery-dl exit codes:
      //   0 = all files downloaded successfully
      //   1 = partial success (some files skipped / already exist / minor errors)
      //   2 = fatal error (authentication, network, not found)
      //
      // Treat exit 1 as success — it means "some files were skipped because they
      // already exist in the output directory", which is the normal behaviour on
      // repeat downloads of the same carousel.
      if (code === 2) {
        const msg = stderr.trim().split('\n').slice(-5).join('\n');
        log.error(FN, `gallery-dl fatal exit (code 2)`, { downloadId, stderr: msg.slice(0, 1000) });
        return reject(new Error(`gallery-dl failed: ${msg}`));
      }
      // If gallery-dl didn't download anything new, don't scan the entire folder.
      if (files.length === 0) {
        log.info(FN, 'No new files downloaded', {
          downloadId,
          exitCode: code
        });
      }

      if (downloadId) bp(downloadId, { percent: 100, speed: null, eta: null });
      log.download(FN, 'complete', { downloadId, exitCode: code, fileCount: files.length, files: files.map(f => path.basename(f)) });
      resolve({ success: true, file: files[files.length - 1] || null, files, stderr });
    });

    proc.on('error', err => {
      if (item) item.proc = null;
      log.error(FN, `Cannot start gallery-dl: ${err.message}`, { downloadId, bin, errorCode: err.code });
      reject(new Error(`Cannot start gallery-dl: ${err.message}`));
    });
  });
}

// ── YouTube ───────────────────────────────────────────────────────────────────

// async function downloadYouTubeVideo(url, options = {}, downloadId, item) {
//   const settings = getSettings().youtube || {};
//   const ytBase = ytRootBase(options, settings);
//   const folder = ensureFolder(path.join(ytBase, 'Videos'));
//   const quality  = options.quality || settings.defaultQuality || 'recommended';

//   let formatStr;
//   if (quality === 'recommended') {
//     formatStr = [
//       'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]',
//       'bestvideo[height<=720]+bestaudio',
//       'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]',
//       'bestvideo[height<=480]+bestaudio',
//       'best[height<=720]', 'best'
//     ].join('/');
//   } else if (quality === 'best') {
//     formatStr = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
//   } else {
//     const h = parseInt(quality) || 720;
//     formatStr = [
//       `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]`,
//       `bestvideo[height<=${h}]+bestaudio`,
//       `best[height<=${h}]`, 'best'
//     ].join('/');
//   }

//   const args = [
//     '--format', formatStr,
//     '--merge-output-format', 'mp4',
//     '--ffmpeg-location', getFfmpegBin(),
//     '--output', path.join(folder, '%(title)s [%(id)s].%(ext)s'),
//     '--no-playlist',
//     '--convert-thumbnails', 'jpg',
//     '--embed-thumbnail',
//     '--add-metadata',
//     '--progress', '--newline', '--no-warnings',
//     url
//   ];
//   args.push(...getCookiesArgs('yt-dlp'));
//   if (settings.sponsorBlock) args.push('--sponsorblock-remove', 'all');
//   if (settings.customArgs) args.push(...settings.customArgs.trim().split(/\s+/).filter(Boolean));

//   return runYtDlp(args, downloadId, item);
// }   original

async function downloadYouTubeVideo(url, options = {}, downloadId, item) {
  const settings = getSettings().youtube || {};
  const ytBase = ytRootBase(options, settings);
  const folder = ensureFolder(path.join(ytBase, 'Videos'));

  const quality =
    options.quality ||
    settings.defaultQuality ||
    'recommended';

  let formatStr;

  if (quality === 'best') {
    formatStr = 'bestvideo+bestaudio/best';
  } else {
    const h =
      quality === 'recommended'
        ? 720
        : parseInt(quality) || 720;

    formatStr =
      `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`;
  }

  const args = [
    '--format', formatStr,

    '--merge-output-format', 'mp4',
    '--ffmpeg-location', getFfmpegBin(),

    '--output',
    path.join(folder, '%(title)s [%(id)s].%(ext)s'),

    '--no-playlist',

    '--convert-thumbnails', 'jpg',
    '--embed-thumbnail',
    '--add-metadata',

    '--progress',
    '--newline',
    '--no-warnings',

    url
  ];

  args.push(...getCookiesArgs('yt-dlp'));

  if (settings.sponsorBlock) {
    args.push(
      '--sponsorblock-remove',
      'all'
    );
  }

  if (settings.customArgs) {
    args.push(
      ...settings.customArgs
        .trim()
        .split(/\s+/)
        .filter(Boolean)
    );
  }

  return runYtDlp(
    args,
    downloadId,
    item
  );
}


// async function downloadYouTubeVideoWithSubs(url, options = {}, downloadId, item) {
//   const settings = getSettings().youtube || {};
//   const ytBase = ytRootBase(options, settings);
//   const folder = ensureFolder(path.join(ytBase, 'Videos'));

//   const quality = options.quality || 'recommended';
//   const subsOnly = options.subsOnly || false;
//   const subLang =
//     options.subLang ||
//     options.subtitleLang ||
//     settings.autoSubtitleLang ||
//     'en,en-US,en-GB';

//   const h =
//     quality === 'recommended'
//       ? 720
//       : quality === 'best'
//         ? 9999
//         : parseInt(quality) || 720;

//   // Subtitle-only download
//   if (subsOnly) {
//     const args = [
//       '--skip-download',
//       '--write-subs',
//       '--write-auto-subs',
//       '--sub-langs', subLang,
//       '--sub-format', 'srt/vtt/best',
//       '--output', path.join(folder, '%(title)s [%(id)s].%(ext)s'),
//       '--no-playlist',
//       '--no-warnings',
//       url
//     ];

//     args.push(...getCookiesArgs('yt-dlp'));

//     return runYtDlp(args, downloadId, item);
//   }

//   /*
//    * Try format strategies in order.
//    *
//    * IMPORTANT:
//    * Do not force android_vr here.
//    * It only exposed 360p for your test video without a PO token.
//    */

//   const formatCandidates = h >= 9999
//     ? [
//         'bestvideo+bestaudio/best',
//         'best'
//       ]
//     : [
//         `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`,
//         `best[height<=${h}]/best`
//       ];

//   let lastError = null;

//   for (let attempt = 0; attempt < formatCandidates.length; attempt++) {
//     const formatStr = formatCandidates[attempt];

//     const args = [
//       '--format', formatStr,

//       // MKV is intentional because it can contain embedded subtitles
//       // without requiring subtitle conversion to another container.
//       '--merge-output-format', 'mkv',

//       '--ffmpeg-location', getFfmpegBin(),

//       // Download and embed subtitles
//       '--write-subs',
//       '--write-auto-subs',
//       '--sub-langs', subLang,
//       '--sub-format', 'srt/vtt/best',
//       '--embed-subs',

//       '--output',
//       path.join(folder, '%(title)s [%(id)s].%(ext)s'),

//       '--no-playlist',
//       '--add-metadata',
//       '--progress',
//       '--newline',
//       '--no-warnings',

//       url
//     ];

//     args.push(...getCookiesArgs('yt-dlp'));

//     if (settings.sponsorBlock) {
//       args.push('--sponsorblock-remove', 'all');
//     }

//     try {
//       log.info(
//         'downloadYouTubeVideoWithSubs',
//         `Attempt ${attempt + 1}/${formatCandidates.length}`,
//         {
//           downloadId,
//           quality: h,
//           format: formatStr,
//           subtitles: true,
//           subLang
//         }
//       );

//       const result = await runYtDlp(args, downloadId, item);

//       return result;

//     } catch (error) {
//       lastError = error;

//       const message = String(error?.message || error);

//       log.warn(
//         'downloadYouTubeVideoWithSubs',
//         `Attempt ${attempt + 1} failed`,
//         {
//           downloadId,
//           format: formatStr,
//           error: message
//         }
//       );

//       /*
//        * Only try the fallback when the selected format itself
//        * is unavailable.
//        *
//        * Do NOT endlessly retry authentication / network /
//        * YouTube blocking errors with another format.
//        */
//       const formatUnavailable =
//         /requested format is not available/i.test(message);

//       if (!formatUnavailable) {
//         throw error;
//       }
//     }
//   }

//   throw lastError || new Error('Unable to find a compatible YouTube format');
// }

async function downloadYouTubeVideoWithSubs(url, options = {}, downloadId, item) {
  const settings = getSettings().youtube || {};
  const ytBase = ytRootBase(options, settings);
  const folder = ensureFolder(
  options.outputFolder ||
  path.join(ytBase, 'Videos')
);
  const quality = options.quality || 'recommended';
  const subsOnly = options.subsOnly || false;
  const subLang =
    options.subLang ||
    options.subtitleLang ||
    settings.autoSubtitleLang ||
    'en,en-US,en-GB';

  // ─────────────────────────────────────────────
  // SUBTITLES ONLY
  // ─────────────────────────────────────────────
  if (subsOnly) {
    const args = [
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs', subLang,
      '--sub-format', 'srt/vtt/best',
      '--output',
      path.join(folder, '%(title)s [%(id)s].%(ext)s'),
      '--no-playlist',
      '--no-warnings',
      url
    ];

    args.push(...getCookiesArgs('yt-dlp'));

    return runYtDlp(args, downloadId, item);
  }

  // ─────────────────────────────────────────────
  // SELECTED QUALITY
  // ─────────────────────────────────────────────
  const h =
    quality === 'recommended'
      ? 720
      : quality === 'best'
        ? 9999
        : parseInt(quality) || 720;

const formatCandidates = h >= 9999
  ? [
      'bestvideo+bestaudio/best',
      'best'
    ]
  : [
      `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`,
      `best[height<=${h}]/best`,
      'best'
    ];

  // ─────────────────────────────────────────────
  // VIDEO + EMBEDDED SUBTITLES
  // ─────────────────────────────────────────────
let lastError = null;

for (const formatStr of formatCandidates) {
  const args = [
    '--format', formatStr,
    '--merge-output-format', 'mkv',
    '--ffmpeg-location', getFfmpegBin(),

    '--write-subs',
    '--write-auto-subs',
    '--sub-langs', subLang,
    '--sub-format', 'srt/vtt/best',
    '--embed-subs',

    '--output',
    path.join(folder, '%(title)s [%(id)s].%(ext)s'),

    '--no-playlist',
    '--add-metadata',
    '--progress',
    '--newline',
    '--no-warnings',

    url
  ];

  args.push(...getCookiesArgs('yt-dlp'));

  if (settings.sponsorBlock) {
    args.push('--sponsorblock-remove', 'all');
  }

  if (settings.customArgs) {
    args.push(
      ...settings.customArgs
        .trim()
        .split(/\s+/)
        .filter(Boolean)
    );
  }

  try {
    return await runYtDlp(args, downloadId, item);
  } catch (error) {
    lastError = error;

    if (!/requested format is not available/i.test(
      String(error?.message || error)
    )) {
      throw error;
    }

    log.warn(
      'downloadYouTubeVideoWithSubs',
      `Format unavailable, trying fallback`,
      { downloadId, format: formatStr }
    );
  }
}
throw lastError || new Error('No compatible YouTube format found');
}

// async function downloadYouTubeAudio(url, options = {}, downloadId, item) {
//   const settings = getSettings().youtube || {};
//   const ytBase = ytRootBase(options, settings);
//   const folder   = ensureFolder(path.join(ytBase, 'Audio'));
//   const format   = options.format || settings.preferredAudioFormat || 'mp3';

//   const args = [
//     '--format', 'bestaudio',
//     '--extract-audio', '--audio-format', format,
//     '--audio-quality', format === 'mp3' ? '192' : '0',
//     '--convert-thumbnails', 'jpg',
//     '--embed-thumbnail', '--add-metadata',
//     '--output', path.join(folder, '%(title)s [%(id)s].%(ext)s'),
//     '--no-playlist', '--progress', '--newline', '--no-warnings', url
//   ];
//   args.push(...getCookiesArgs('yt-dlp'));
//   if (settings.sponsorBlock) args.push('--sponsorblock-remove', 'all');
//   if (settings.customArgs) args.push(...settings.customArgs.trim().split(/\s+/).filter(Boolean));
//   return runYtDlp(args, downloadId, item);
// }

// async function extractPlaylistEntries(url, downloadId, _item) {
//   const args = [
//     '--flat-playlist',
//     '--print-json',
//     '--no-warnings',
//     '--ignore-errors',
//     url
//   ];

//   // Add cookies if needed
//   args.push(...getCookiesArgs('yt-dlp'));

//   const entries = [];

//   return new Promise((resolve, reject) => {
//     const proc = spawn(getYtDlpBin(), args, {
//     windowsHide: true
//     });

//     let stdout = '';
//     let stderr = '';

//     proc.stdout.on('data', (data) => {
//       stdout += data.toString();
//     });

//     proc.stderr.on('data', (data) => {
//       stderr += data.toString();
//     });

//     proc.on('close', (code) => {
//       if (code === 0) {
//         try {
//           // Parse each line as JSON
//           const lines = stdout.trim().split('\n');
//           for (const line of lines) {
//             if (line.trim()) {
//               try {
//                 const entry = JSON.parse(line);
//                 if (entry.id) {
//                   entries.push({
//                     id: entry.id,
//                     title: entry.title || `Video ${entry.id}`,
//                     url: `https://www.youtube.com/watch?v=${entry.id}`
//                   });
//                 }
//               } catch (e) {
//                 // Skip invalid JSON lines
//                 log.warn('extractPlaylistEntries', `Failed to parse line: ${line.substring(0, 100)}`, {
//                   downloadId,
//                   error: e.message
//                 });
//               }
//             }
//           }
//           resolve(entries);
//         } catch (e) {
//           log.error('extractPlaylistEntries', 'Failed to parse playlist output', {
//             downloadId,
//             error: e.message
//           });
//           reject(e);
//         }
//       } else {
//         log.error('extractPlaylistEntries', 'yt-dlp failed', {
//           downloadId,
//           code,
//           stderr: stderr.substring(0, 500)
//         });
//         reject(new Error(`yt-dlp exited with code ${code}`));
//       }
//     });

//     proc.on('error', (err) => {
//       log.error('extractPlaylistEntries', 'Failed to spawn process', {
//         downloadId,
//         error: err.message
//       });
//       reject(err);
//     });
//   });
// }

async function downloadYouTubeAudio(url, options = {}, downloadId, item) {
  const settings = getSettings().youtube || {};
  const ytBase = ytRootBase(options, settings);
  const folder = ensureFolder(path.join(ytBase, 'Audio'));
  const format = options.format || settings.preferredAudioFormat || 'mp3';

  const args = [
    '--format', 'bestaudio',
    '--extract-audio',
    '--audio-format', format,
    '--audio-quality', format === 'mp3' ? '192' : '0',
    '--convert-thumbnails', 'jpg',
    '--embed-thumbnail',
    '--add-metadata',
    '--output', path.join(folder, '%(title)s [%(id)s].%(ext)s'),
    '--no-playlist',
    '--progress',
    '--newline',
    '--no-warnings',
    url
  ];

  args.push(...getCookiesArgs('yt-dlp'));

  if (settings.sponsorBlock) {
    args.push('--sponsorblock-remove', 'all');
  }

  if (settings.customArgs) {
    args.push(
      ...settings.customArgs
        .trim()
        .split(/\s+/)
        .filter(Boolean)
    );
  }

  return runYtDlp(args, downloadId, item);
}

async function extractPlaylistEntries(url, downloadId, _item) {
  const FN = 'extractPlaylistEntries';

  const args = [
    '--flat-playlist',
    '--print-json',
    '--no-warnings',
    '--ignore-errors',
    '--skip-download',
    url
  ];

  // Use the same cookies configuration as the rest of the YouTube downloader.
  args.push(...getCookiesArgs('yt-dlp'));

  const entries = [];
  const seenIds = new Set();

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const proc = spawn(getYtDlpBin(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', data => {
      stdout += data.toString();
    });

    proc.stderr.on('data', data => {
      stderr += data.toString();
    });

    proc.on('error', err => {
      log.error(FN, 'Failed to spawn yt-dlp', {
        downloadId,
        bin: getYtDlpBin(),
        error: err.message,
        code: err.code
      });

      finish(reject, new Error(
        `Failed to start yt-dlp: ${err.message}`
      ));
    });

    proc.on('close', code => {
      /*
       * yt-dlp can return a non-zero exit code while still producing
       * usable playlist entries because --ignore-errors is enabled.
       *
       * Therefore parse stdout BEFORE treating the process as failed.
       */

      const lines = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          // Ignore playlist/container metadata.
          if (!entry || entry._type === 'playlist') {
            continue;
          }

          if (!entry.id) {
            continue;
          }

          // Prevent duplicate videos.
          if (seenIds.has(entry.id)) {
            continue;
          }

          seenIds.add(entry.id);

          entries.push({
            id: entry.id,
            title: entry.title || `Video ${entry.id}`,
            url:
              entry.webpage_url ||
              entry.url ||
              `https://www.youtube.com/watch?v=${entry.id}`,
            playlist_index:
              entry.playlist_index ??
              entry.playlist_autonumber ??
              entries.length + 1
          });

        } catch {
          // yt-dlp may output non-JSON informational lines.
          // Ignore them instead of failing the entire playlist.
        }
      }

      /*
       * If we obtained entries, consider extraction successful even if
       * yt-dlp returned a non-zero exit code.
       */
      if (entries.length > 0) {
        log.info(FN, 'Playlist entries extracted', {
          downloadId,
          count: entries.length,
          exitCode: code
        });

        if (code !== 0 && code !== null) {
          log.warn(FN, 'yt-dlp exited non-zero but usable entries were recovered', {
            downloadId,
            code,
            stderr: stderr.trim().slice(0, 1000)
          });
        }

        return finish(resolve, entries);
      }

      /*
       * No entries means extraction genuinely failed.
       */
      const errorText = stderr.trim();

      log.error(FN, 'No playlist entries could be extracted', {
        downloadId,
        code,
        stderr: errorText.slice(0, 2000),
        stdout: stdout.trim().slice(0, 1000)
      });

      finish(
        reject,
        new Error(
          errorText
            ? `Unable to extract playlist: ${errorText.slice(0, 500)}`
            : `yt-dlp exited with code ${code ?? 'unknown'} and returned no playlist entries`
        )
      );
    });
  });
}

async function downloadYouTubePlaylist(url, options = {}, downloadId, item) {
  const settings  = getSettings().youtube || {};
  const ytBase = ytRootBase(options, settings);
  const audioOnly = options.audioOnly || false;
  const format    = options.format    || settings.preferredAudioFormat || 'mp3';
  const quality   = options.quality   || 'recommended';
  // const subtitles = options.subtitles || false;
  const subtitles =
    options.subtitles === true ||
    options.subtitle === true ||
    options.subLang != null ||
    options.subtitleLang != null ||
    options.action === 'download_playlist_subs';
  console.log('[PlaylistSubs TRACE] FINAL subtitles =', subtitles);
  const playlistName = sanitizePlaylistName(options.playlistName || item?.title || 'Playlist');
  const playlistFolder = audioOnly ? path.join(ytBase, 'Audio', playlistName) : path.join(ytBase, 'Playlists', playlistName);
  const folder = ensureFolder(playlistFolder);

  const matchFilter = 'availability != "needs_auth" & availability != "unavailable"';
  const h = quality === 'recommended' ? 720 : parseInt(quality) || 720;

  // Handle audio-only playlists (no change to existing behavior)
  if (audioOnly) {
    const args = [
      '--format', 'bestaudio',
      '--extract-audio', '--audio-format', format,
      '--audio-quality', format === 'mp3' ? '192' : '0',
      '--convert-thumbnails', 'jpg',
      '--embed-thumbnail', '--add-metadata',
      '--output', path.join(folder, '%(playlist_index)s - %(title)s.%(ext)s'),
      '--yes-playlist', '--match-filter', matchFilter,
      '--progress', '--newline', '--no-warnings', '--ignore-errors', url
    ];
    args.push(...getCookiesArgs('yt-dlp'));
    if (settings.sponsorBlock) args.push('--sponsorblock-remove', 'all');
    if (settings.customArgs) args.push(...settings.customArgs.trim().split(/\s+/).filter(Boolean));
    const result = await runYtDlp(args, downloadId, item);
    return result;
  }

  // Handle non-subtitle playlists (no change to existing behavior)
  if (!subtitles) {
    const fmtStr = h >= 9999
  ? 'bestvideo+bestaudio/best'
  : `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`;
      const args = [
      '--format', fmtStr,
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', getFfmpegBin(),
      '--convert-thumbnails', 'jpg',
      '--embed-thumbnail',
      '--add-metadata',
      '--output', path.join(folder, '%(playlist_index)s - %(title)s [%(id)s].%(ext)s'),
      '--yes-playlist', '--match-filter', matchFilter,
      '--progress', '--newline', '--no-warnings', '--ignore-errors', url
    ];
    args.push(...getCookiesArgs('yt-dlp'));
    if (settings.sponsorBlock) args.push('--sponsorblock-remove', 'all');
    if (settings.customArgs) args.push(...settings.customArgs.trim().split(/\s+/).filter(Boolean));
    const result = await runYtDlp(args, downloadId, item);
    return result;
  }

  // Handle subtitle playlists: process each video individually
  // Initialize playlist tracking
  if (!item.options) item.options = {};
  item.options.playlistTotal = 0; // Will be set after extracting entries
  item.options.playlistDownloaded = 0;

  try {
    // Extract playlist entries
    const entries = await extractPlaylistEntries(url, downloadId, item);

    if (entries.length === 0) {
      log.warn('downloadYouTubePlaylist', 'No entries found in playlist', { downloadId });
      return { success: true, file: null, files: [], stdout: '', stderr: '' };
    }

    item.options.playlistTotal = entries.length;
    log.info('downloadYouTubePlaylist', `Starting download of ${entries.length} videos`, { downloadId });

    // Process each video individually
    const results = [];
    let allFiles = [];
    let combinedStdout = '';
    let combinedStderr = '';

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const videoUrl = entry.url;

      // Check for cancellation before each video
      if (item?.cancelled) {
        log.warn('downloadYouTubePlaylist', 'Cancelled by user', { downloadId });
        return { success: false, error: 'Cancelled' };
      }

      log.info('downloadYouTubePlaylist', `Downloading video ${i + 1}/${entries.length}: ${entry.title}`, { downloadId });

      // Download individual video with subtitles
      const videoResult = await downloadYouTubeVideoWithSubs(
  videoUrl,
  {
    quality: options.quality,
    subLang: options.subLang ||
      settings.autoSubtitleLang ||
      'en,en-US,en-GB',

    // Keep playlist videos inside:
    // YT/Playlists/{playlistname}/
    outputFolder: folder
  },
  downloadId,
  item
);


      // Collect results
      results.push(videoResult);
      if (videoResult.file) allFiles.push(videoResult.file);
      if (videoResult.files) allFiles = [...allFiles, ...videoResult.files];
      if (videoResult.stdout) combinedStdout += videoResult.stdout + '\n';
      if (videoResult.stderr) combinedStderr += videoResult.stderr + '\n';

      // Update playlist progress
      item.options.playlistDownloaded = i + 1;

      try {
        const meta = {
          playlistDownloaded: item.options.playlistDownloaded,
          playlistTotal: item.options.playlistTotal,
          playlistName: item.options.playlistName || item.title || playlistName
        };

        // Broadcast progress with 100% for completed video, but reset for next video
        broadcastProgress(
          downloadId,
          {
            percent: 100, // Show completed for this video
            speed: null,
            eta: null,
            totalSize: null
          },
          meta,
          true
        );
      } catch (e) {
        log.warn('downloadYouTubePlaylist', 'Failed to broadcast playlist progress', { error: e.message });
      }

      log.info('downloadYouTubePlaylist', `Completed video ${i + 1}/${entries.length}`, {
        downloadId,
        playlistDownloaded: item.options.playlistDownloaded,
        playlistTotal: item.options.playlistTotal
      });
    }

    // Final progress update
    try {
      const meta = {
        playlistDownloaded: item.options.playlistTotal,
        playlistTotal: item.options.playlistTotal,
        playlistName: item.options.playlistName || item.title || playlistName
      };

      broadcastProgress(
        downloadId,
        {
          percent: 100,
          speed: null,
          eta: null,
          totalSize: null
        },
        meta,
        true
      );
    } catch (e) {
      log.warn('downloadYouTubePlaylist', 'Failed to broadcast final playlist progress', { error: e.message });
    }

    log.info('downloadYouTubePlaylist', `Completed playlist download: ${item.options.playlistTotal}/${item.options.playlistTotal} videos`, { downloadId });

    return {
      success: true,
      file: allFiles.length > 0 ? allFiles[allFiles.length - 1] : null,
      files: allFiles,
      stdout: combinedStdout,
      stderr: combinedStderr
    };
  } catch (error) {
    log.error('downloadYouTubePlaylist', 'Failed to download playlist', {
      downloadId,
      error: error.message
    });

    // Try to broadcast error progress
    try {
      const meta = {
        playlistDownloaded: item.options.playlistDownloaded || 0,
        playlistTotal: item.options.playlistTotal || 0,
        playlistName: item.options.playlistName || item.title || playlistName
      };

      broadcastProgress(
        downloadId,
        {
          percent: 0,
          speed: null,
          eta: null,
          totalSize: null
        },
        meta,
        true
      );
    } catch (e) {
      // Ignore broadcast errors
    }

    throw error;
  }
}

// ── Instagram ─────────────────────────────────────────────────────────────────

function igBase(sub, options, settings) {
  return ensureFolder(path.join(
    options.folder || settings.downloadFolder || path.join(os.homedir(), 'Downloads', 'GrabIt', 'Instagram'),
    sub
  ));
}

async function downloadInstagramReel(url, options = {}, downloadId, item) {
  const settings = getSettings().instagram || {};
  const folder   = igBase('Reels', options, settings);
  const args = [
    '--no-playlist',
    '--output', path.join(folder, '%(uploader)s_%(id)s.%(ext)s'),
    '--progress', '--newline', '--no-warnings', url
  ];
  args.push(...getCookiesArgs('yt-dlp'));
  return runYtDlp(args, downloadId, item);
}

async function downloadInstagramReelAudio(url, options = {}, downloadId, item) {
  const settings = getSettings().instagram || {};
  const folder   = igBase('Audio', options, settings);
  const format   = options.format || settings.preferredAudioFormat || 'mp3';
  const args = [
    '--extract-audio', '--audio-format', format, '--audio-quality', format === 'mp3' ? '192' : '0',
    '--convert-thumbnails', 'jpg',
    '--embed-thumbnail', '--add-metadata',
    '--no-playlist',
    '--output', path.join(folder, '%(uploader)s_%(id)s.%(ext)s'),
    '--progress', '--newline', '--no-warnings', url
  ];
  args.push(...getCookiesArgs('yt-dlp'));
  return runYtDlp(args, downloadId, item);
}

async function downloadInstagramPhoto(url, options = {}, downloadId, item) {
  const settings = getSettings().instagram || {};

  // Extract Instagram media ID (shortcode) from URL for naming
  const idMatch = url.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)\/?/);
  const mediaId = idMatch ? idMatch[1] : 'unknown';

  const folder   = igBase('Photos', options, settings);

  // Use simple filename template and rename after download
  const bin = getGalleryDlBin();
  const args = [
    '--directory', folder,
    '--filename', '{num:>02}.{extension}',
    ...getCookiesArgs('gallery-dl'),
    url
  ];
  log.cmd('downloadInstagramPhoto', bin, args);
  try {
    const result = await runGalleryDl(args, downloadId, item, folder);
    // Convert any WebP images to JPG and rename files
    // if (Array.isArray(result.files) && result.files.length) {
    //   const processed = await Promise.all(
    //     result.files.map(async (filePath, index) => {
    //       const ext = path.extname(filePath).toLowerCase();
    //       const dir = path.dirname(filePath);

    //       // Convert WebP to JPG if needed
    //       let processedPath = filePath;
    //       if (ext === '.webp') {
    //         processedPath = await convertWebpToJpg(filePath, item, downloadId);
    //         // Update extension after conversion
    //         if (processedPath !== filePath) {
    //           const newExt = path.extname(processedPath).toLowerCase();
    //           // Update tempFiles tracking if we changed extensions
    //           if (item && item.tempFiles) {
    //             const oldIndex = item.tempFiles.indexOf(filePath);
    //             if (oldIndex > -1) {
    //               item.tempFiles.splice(oldIndex, 1);
    //             }
    //             item.tempFiles.push(processedPath);
    //           }
    //         }

    //         // Rename file to use mediaId
    //       const newName = `${mediaId}_${String(index + 1).padStart(2, '0')}${path.extname(processedPath)}`;
    //       const newPath = path.join(dir, newName);
    //       try {
    //         // Check if target file already exists to prevent overwriting
    //         if (fs.existsSync(newPath)) {
    //           fs.unlinkSync(newPath);
    //         }
    //         fs.renameSync(processedPath, newPath);

    //         // Update tempFiles tracking
    //         if (item && item.tempFiles) {
    //           const oldIndex = item.tempFiles.indexOf(processedPath);
    //           if (oldIndex > -1) {
    //             item.tempFiles.splice(oldIndex, 1);
    //           }
    //           item.tempFiles.push(newPath);
    //         }

    //         return newPath;
    //       } catch (renameErr) {
    //         log.warn('downloadInstagramPhoto', `Failed to rename ${processedPath} to ${newPath}`, { error: renameErr.message });
    //         // If rename fails, return the processed path (converted WebP or original)
    //         return processedPath;
    //       }
    //     })
    //   );

    //   result.files = processed;
    //   result.file = result.files[result.files.length - 1] || null;
    // }

    ///////////////////////////////////////
  if (Array.isArray(result.files) && result.files.length) {
  let filePath = result.files[0];

  // Convert WebP to JPG if needed
  if (path.extname(filePath).toLowerCase() === '.webp') {
    filePath = await convertWebpToJpg(filePath, item, downloadId);
  }

  const dir = path.dirname(filePath);
  const newPath = path.join(
    dir,
    `${mediaId}_01${path.extname(filePath)}`
  );

  try {
    if (fs.existsSync(newPath)) {
      fs.unlinkSync(newPath);
    }

    fs.renameSync(filePath, newPath);

    if (item && item.tempFiles) {
      const oldIndex = item.tempFiles.indexOf(filePath);
      if (oldIndex > -1) {
        item.tempFiles.splice(oldIndex, 1);
      }
      item.tempFiles.push(newPath);
    }

    result.files = [newPath];
    result.file = newPath;

  } catch (renameErr) {
    log.warn(
      'downloadInstagramPhoto',
      `Failed to rename ${filePath} to ${newPath}`,
      { error: renameErr.message }
    );

    result.files = [filePath];
    result.file = filePath;
  }
}
    ///////////////////////////////////////
    return result;
  } catch (err) {
    log.error('downloadInstagramPhoto', `gallery-dl failed for photo ${url}`, {
      errorMsg: err.message,
      stack: err.stack,
      bin,
      args: args.join(' '),
      url
    });
    throw err;
  }
}

async function downloadInstagramSlide(url, slideObj, options = {}, downloadId, item) {
  const settings = getSettings().instagram || {};
  const folder   = igBase('Slides', options, settings);
  const slideNum = slideObj.index + 1; // gallery-dl is 1-based

  // Extract Instagram media ID (shortcode) from URL for naming
  const idMatch = url.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)\/?/);
  const mediaId = idMatch ? idMatch[1] : 'unknown';

  const gdArgs = [
    '--range', `${slideNum}-${slideNum}`,
    '--directory', folder,
    '--filename', '{id}_{num:>02}.{extension}',
    ...getCookiesArgs('gallery-dl'),
    url
  ];

  const result = await runGalleryDl(gdArgs, downloadId, item, folder);
  // Rename file to use our extracted mediaId and slide number
  const videoFile = result.files?.[0];
  if (videoFile) {
    const ext = path.extname(videoFile);
    const newName = `${mediaId}_${String(slideNum).padStart(2, '0')}${ext}`;
    const newPath = path.join(folder, newName);
    try {
      // Check if target file already exists to prevent overwriting
      if (fs.existsSync(newPath)) {
        // Remove existing file first to prevent rename failure
        fs.unlinkSync(newPath);
      }
      fs.renameSync(videoFile, newPath);
      result.files = [newPath];
      result.file = newPath;
      log.ok('downloadInstagramSlide', `Renamed to: ${path.basename(newPath)}`);
    } catch (renameErr) {
      // If rename fails, keep the original file but warn
      log.warn('downloadInstagramSlide', `Failed to rename ${videoFile} to ${newPath}`, { error: renameErr.message });
    }

    // Convert WebP to JPG if needed
    const extLower = ext.toLowerCase();
    if (extLower === '.webp') {
      const jpgPath = await convertWebpToJpg(newPath, item, downloadId);
      if (jpgPath !== newPath) {
        // Conversion succeeded
        result.files = [jpgPath];
        result.file = jpgPath;
      }
      // If conversion failed, jpgPath === newPath, so we keep the original
    }
  }

  return { ...result, file: result.files?.[0] || null, folder };
}

async function downloadInstagramSlideAudio(url, slideObj, options = {}, downloadId, item) {
  const settings  = getSettings().instagram || {};
  const folder    = igBase('Audio', options, settings);
  const format    = options.format || settings.preferredAudioFormat || 'mp3';
  const slideNum  = slideObj.index + 1;

  // Extract Instagram media ID (shortcode) from URL for naming
  const idMatch = url.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)\/?/);
  const mediaId = idMatch ? idMatch[1] : 'unknown';

  // Download the video slide to a temp dir, then extract audio
  const tmpDir = path.join(os.tmpdir(), `mg_slide_${downloadId || Date.now()}`);
  ensureFolder(tmpDir);
  if (item) (item.tempFiles = item.tempFiles || []).push(tmpDir);

  const gdArgs = [
    '--range', `${slideNum}-${slideNum}`,
    '--directory', tmpDir,
    '--filename', '{id}_{num:>02}.{extension}',
    ...getCookiesArgs('gallery-dl'),
    url
  ];

  const gdResult = await runGalleryDl(gdArgs, downloadId, item);
  if (item?.cancelled) throw new Error('Cancelled');

  let videoFile = gdResult.files?.[0];
  if (!videoFile || !fs.existsSync(videoFile)) throw new Error(`Slide ${slideNum} not found for audio extraction`);

  const videoExt = path.extname(videoFile);
  const desiredVideoName = `${mediaId}_${String(slideNum).padStart(2, '0')}${videoExt}`;
  const desiredVideoPath = path.join(tmpDir, desiredVideoName);
  try {
    // Check if target file already exists to prevent overwriting
    if (fs.existsSync(desiredVideoPath)) {
      // Remove existing file first to prevent rename failure
      fs.unlinkSync(desiredVideoPath);
    }
    fs.renameSync(videoFile, desiredVideoPath);
    videoFile = desiredVideoPath;
    // Track the renamed file in tempFiles if we’re tracking the original
    if (item && item.tempFiles) {
      const index = item.tempFiles.indexOf(videoFile);
      if (index > -1) {
        item.tempFiles.splice(index, 1);
      }
      item.tempFiles.push(desiredVideoPath);
    }
  } catch (renameErr) {
    // If rename fails, keep original file but warn
    log.warn('downloadInstagramSlideAudio', `Failed to rename ${videoFile} to ${desiredVideoPath}`, { error: renameErr.message });
  }

  const outFile = path.join(folder, `${mediaId}_${String(slideNum).padStart(2, '0')}.${format}`);
  const ffArgs  = ['-y', '-i', videoFile, '-vn',
    '-acodec', format === 'mp3' ? 'libmp3lame' : format === 'aac' ? 'aac' : 'copy',
    '-q:a', '2', outFile
  ];
  await spawnProcess(getFfmpegBin(), ffArgs, downloadId, item, () => null);
  try {
    fs.unlinkSync(videoFile);
    // Remove from tempFiles if tracked
    if (item && item.tempFiles) {
      const index = item.tempFiles.indexOf(videoFile);
      if (index > -1) {
        item.tempFiles.splice(index, 1);
      }
    }
    fs.rmdirSync(tmpDir);
  } catch {}

  // If we renamed the video file earlier, the output file already has correct name.
  // If rename failed, we may want to rename the output file to correct name as fallback.
  if (!videoFile.endsWith(desiredVideoName)) {
    const desiredAudioName = `${mediaId}_${String(slideNum).padStart(2, '0')}.${format}`;
    const desiredAudioPath = path.join(folder, desiredAudioName);
    try {
      // Check if target file already exists to prevent overwriting
      if (fs.existsSync(desiredAudioPath)) {
        fs.unlinkSync(desiredAudioPath);
      }
      fs.renameSync(outFile, desiredAudioPath);
      return { success: true, file: desiredAudioPath, files: [desiredAudioPath] };
    } catch (renameErr2) {
      log.warn('downloadInstagramSlideAudio', `Failed to rename audio ${outFile} to ${desiredAudioPath}`, { error: renameErr2.message });
      return { success: true, file: outFile, files: [outFile] };
    }
  }

  return { success: true, file: outFile, files: [outFile] };
}

async function downloadInstagramCarouselAll(url, options = {}, downloadId, item) {
  const settings    = getSettings().instagram || {};
  const title       = sanitizeFilename(options.title || 'Carousel');
  const carouselDir = ensureFolder(path.join(
    options.folder || settings.downloadFolder || path.join(os.homedir(), 'Downloads', 'GrabIt', 'Instagram'),
    'Carousels'
  ));

  // Extract Instagram media ID (shortcode) from URL for naming
  const idMatch = url.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)\/?/);
  const mediaId = idMatch ? idMatch[1] : 'unknown';

  const bin = getGalleryDlBin();
  const args = [
    '--directory', carouselDir,
    '--filename', '{num:>02}.{extension}',
    ...getCookiesArgs('gallery-dl'),
    url
  ];
  log.cmd('downloadInstagramCarouselAll', bin, args);
  let result;
  try {
    result = await runGalleryDl(args, downloadId, item, carouselDir);
  } catch (err) {
    log.error('downloadInstagramCarouselAll', `gallery-dl failed for carousel ${url}`, {
      errorMsg: err.message,
      stack: err.stack,
      bin,
      args: args.join(' '),
      url
    });
    throw err;
  }
  // Convert any WebP images to JPG
  if (Array.isArray(result.files) && result.files.length) {
        const converted = [];

    for (const filePath of result.files) {
      const ext = path.extname(filePath).toLowerCase();

      if (ext === '.webp') {
        converted.push(await convertWebpToJpg(filePath, item, downloadId));
      } else {
        converted.push(filePath);
      }
    }

    result.files = converted;

    const renamed = [];

    for (let index = 0; index < result.files.length; index++) {
      const filePath = result.files[index];
      const ext = path.extname(filePath);
      const dir = path.dirname(filePath);

      const newName = `${mediaId}_${String(index + 1).padStart(2, '0')}${ext}`;
      const newPath = path.join(dir, newName);

      try {
        if (fs.existsSync(newPath)) {
          fs.unlinkSync(newPath);
        }

        fs.renameSync(filePath, newPath);

        if (item && item.tempFiles) {
          const oldIndex = item.tempFiles.indexOf(filePath);
          if (oldIndex > -1) {
            item.tempFiles.splice(oldIndex, 1);
          }
          item.tempFiles.push(newPath);
        }

        renamed.push(newPath);

      } catch (renameErr) {
        log.warn(
          'downloadInstagramCarouselAll',
          `Failed to rename ${filePath} to ${newPath}`,
          { error: renameErr.message }
        );

        renamed.push(filePath);
      }
    }

    result.files = renamed;
    result.file = renamed[renamed.length - 1] || null;
  }
  // Metadata file creation DISABLED per user request
  // Original code removed to prevent metadata.json generation
  //Remove Commented Code if you want metadata.json file
    /*
  try {
    let metadataName = 'metadata.json';
    if (result.files && result.files.length > 0) {
      const first = path.basename(result.files[0]);
      const underscoreIdx = first.indexOf('_');
      const id = underscoreIdx > 0 ? first.slice(0, underscoreIdx) : '';
      if (id && id !== 'unknown') {
        metadataName = `${id}_metadata.json`;
      }
    } else {
      metadataName = `metadata_${Date.now().toString()}.json`;
    }
    fs.writeFileSync(
      path.join(carouselDir, metadataName),
      JSON.stringify({ url, title, downloadedAt: new Date().toISOString(), files: result.files }, null, 2)
    );
  } catch {}
  */
  return { ...result, folder: carouselDir };
}

async function downloadInstagramCarouselFiltered(url, slideIndices, options = {}, downloadId, item) {
  const settings    = getSettings().instagram || {};
  const carouselDir = ensureFolder(path.join(
    options.folder || settings.downloadFolder || path.join(os.homedir(), 'Downloads', 'GrabIt', 'Instagram'),
    'Carousels'
  ));

  // Extract Instagram media ID (shortcode) from URL for naming
  const idMatch = url.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)\/?/);
  const mediaId = idMatch ? idMatch[1] : 'unknown';

  const bin = getGalleryDlBin();
  const args = [
    '--range', slideIndices,
    '--directory', carouselDir,
    '--filename', '{num:>02}.{extension}',
    ...getCookiesArgs('gallery-dl'),
    url
  ];
  log.cmd('downloadInstagramCarouselFiltered', bin, args);
  let result;
  try {
    result = await runGalleryDl(args, downloadId, item, carouselDir);
  } catch (err) {
    log.error('downloadInstagramCarouselFiltered', `gallery-dl failed for carousel ${url}`, {
      errorMsg: err.message,
      stack: err.stack,
      bin,
      args: args.join(' '),
      url
    });
    throw err;
  }
  // Convert any WebP images to JPG
  if (Array.isArray(result.files) && result.files.length) {
    const converted = await Promise.all(
      result.files.map(async (filePath) => {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.webp') {
          const jpgPath = await convertWebpToJpg(filePath, item, downloadId);
          // If conversion succeeded, we'll rename it below; if not, keep original
          return jpgPath;
        }
        return filePath;
      })
    );
    result.files = converted;

    // Rename files to use our mediaId and proper sequence numbers
    // Note: For filtered slides, we want to preserve the original numbering from slideIndices
    const renamed = await Promise.all(
      result.files.map(async (filePath, index) => {
        const ext = path.extname(filePath);
        const dir = path.dirname(filePath);
        // For filtered slides, we need to map the index to the actual slide number
        // slideIndices is a string like "1,3,5" or "2-4"
        // For simplicity, we'll use sequential numbering based on the result files order
        // A more sophisticated approach would parse slideIndices to get exact numbers
        const slideNum = index + 1; // This assumes the files are in order
        const newName = `${mediaId}_${String(slideNum).padStart(2, '0')}${ext}`;
        const newPath = path.join(dir, newName);
        try {
          // Check if target file already exists to prevent overwriting
          if (fs.existsSync(newPath)) {
            fs.unlinkSync(newPath);
          }
          fs.renameSync(filePath, newPath);
          // Update tempFiles tracking
          if (item && item.tempFiles) {
            const oldIndex = item.tempFiles.indexOf(filePath);
            if (oldIndex > -1) {
              item.tempFiles.splice(oldIndex, 1);
            }
            item.tempFiles.push(newPath);
          }
          return newPath;
        } catch (renameErr) {
          log.warn('downloadInstagramCarouselFiltered', `Failed to rename ${filePath} to ${newPath}`, { error: renameErr.message });
          // If rename fails, keep original file
          return filePath;
        }
      })
    );
    result.files = renamed;
    result.file = result.files[result.files.length - 1] || null;
  }
  // Metadata file creation DISABLED per user request
  // Original code removed to prevent metadata.json generation
  // Remove Commented Code if you want Metadata.json
    /*
  try {
    let metadataName = 'metadata.json';
    if (result.files && result.files.length > 0) {
      const first = path.basename(result.files[0]);
      const underscoreIdx = first.indexOf('_');
      const id = underscoreIdx > 0 ? first.slice(0, underscoreIdx) : '';
      if (id && id !== 'unknown') {
        metadataName = `${id}_metadata.json`;
      }
    } else {
      metadataName = `metadata_${Date.now().toString()}.json`;
    }
    fs.writeFileSync(
      path.join(carouselDir, metadataName),
      JSON.stringify({ url, title, downloadedAt: new Date().toISOString(), files: result.files }, null, 2)
    );
  } catch {}
  */
  return { ...result, folder: carouselDir };
}

// Legacy alias
async function downloadInstagramCarouselSlide(url, slideIndex, options = {}, downloadId, item) {
  return downloadInstagramSlide(url, { index: slideIndex, ...options }, options, downloadId, item);
}

async function downloadGeneric(url, options = {}, downloadId, item) {
  const settings = getSettings().generic || {};
  const folder   = ensureFolder(options.folder || settings.downloadFolder || path.join(os.homedir(), 'Downloads', 'GrabIt', 'Other'));
  const audioOnly = options.audioOnly || false;

  let formatStr;
  if (audioOnly) {
    formatStr = null; // handled via --extract-audio below
  } else if (options.formatId) {
    formatStr = `${options.formatId}/best`;
  } else if (options.quality && options.quality !== 'best') {
    const h = parseInt(options.quality, 10) || (settings.maxResolution || 1080);
    formatStr = `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
  } else {
    formatStr = `bestvideo[height<=${settings.maxResolution || 1080}][ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best`;
  }

  const args = audioOnly ? [
    '--extract-audio', '--audio-format', options.format || settings.preferredAudioFormat || 'mp3',
    '--audio-quality', (options.format || settings.preferredAudioFormat || 'mp3') === 'mp3' ? '192' : '0',
    '--convert-thumbnails', 'jpg',
    '--embed-thumbnail', '--add-metadata',
    '--output', path.join(folder, '%(title)s.%(ext)s'),
    '--no-playlist', '--progress', '--newline', '--no-warnings', url
  ] : [
    '--format', formatStr,
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', getFfmpegBin(),
    '--output', path.join(folder, '%(title)s.%(ext)s'),
    '--no-playlist', '--progress', '--newline', '--no-warnings', url
  ];
  args.push(...getCookiesArgs('yt-dlp'));
  if (settings.customArgs) args.push(...settings.customArgs.trim().split(/\s+/).filter(Boolean));
  return runYtDlp(args, downloadId, item);
}

async function verifyFile(filePath) {
  if (!filePath) return { ok: false, reason: 'No path' };
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return { ok: false, reason: 'Empty or not a file' };
    return { ok: true, size: stat.size, path: filePath };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * downloadStream — Download HLS (m3u8), DASH (mpd), and direct media URLs.
 *
 * yt-dlp handles HLS and DASH natively via its generic extractor, so we
 * just pass the URL directly. For format selection:
 *   - HLS/DASH: "best[ext=mp4]/best" picks highest quality and re-muxes to MP4
 *   - Direct MP4/WebM: downloaded as-is with no re-encode
 *
 * The `quality` option accepts a height (e.g. "720") to cap resolution.
 */
async function downloadStream(url, options = {}, downloadId, item) {
  const FN       = 'downloadStream';
  const settings = getSettings().generic || {};
  const folder   = ensureFolder(
    options.folder || settings.downloadFolder ||
    path.join(os.homedir(), 'Downloads', 'GrabIt', 'Streams')
  );

  const type = (options.streamType || '').toUpperCase();

  // For HLS and DASH, yt-dlp can download and merge directly.
  // For direct files (MP4/WebM/MKV/MOV) just download without yt-dlp overhead.
  if (['MP4', 'WEBM', 'MKV', 'MOV', 'AVI', 'FLV', 'OGG', 'TS'].includes(type) && !options.forceYtDlp) {
    // Attempt direct download via yt-dlp generic extractor (handles auth/redirects)
  }

  const qualityCap = parseInt(options.quality, 10) || 0;
  const formatStr  = qualityCap
    ? `bestvideo[height<=${qualityCap}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${qualityCap}]+bestaudio/best[height<=${qualityCap}]/best`
    : `bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best`;

  const title = options.name
    ? sanitizeFilename(options.name)
    : '%(title)s';

  const args = [
    '--format',              formatStr,
    '--merge-output-format', 'mp4',
    '--ffmpeg-location',     getFfmpegBin(),
    '--output',              path.join(folder, `${title}.%(ext)s`),
    '--no-playlist',
    '--no-check-formats',
    '--progress', '--newline', '--no-warnings',
    ...getCookiesArgs('yt-dlp'),
    url
  ];

  if (settings.customArgs) args.push(...settings.customArgs.trim().split(/\s+/).filter(Boolean));

  log.cmd(FN, getYtDlpBin(), args);
  log.download(FN, 'started', { downloadId, url, type, quality: options.quality });

  const result = await runYtDlp(args, downloadId, item);
  return { ...result, folder };
}

module.exports = {
  downloadYouTubeVideo,
  downloadYouTubeVideoWithSubs,
  downloadYouTubeAudio,
  downloadYouTubePlaylist,
  downloadInstagramReel,
  downloadInstagramReelAudio,
  downloadInstagramPhoto,
  downloadInstagramCarouselAll,
  downloadInstagramCarouselFiltered,
  downloadInstagramCarouselSlide,
  downloadInstagramSlide,
  downloadInstagramSlideAudio,
  downloadGeneric,
  downloadStream,
  verifyFile
};