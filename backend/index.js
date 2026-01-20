// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const ytSearch = require('yt-search');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let ytDlpExecWrapper = null;
try {
    const mod = require('yt-dlp-exec');
    ytDlpExecWrapper = typeof mod === 'function' ? mod : (mod.default || null);
    if (ytDlpExecWrapper) console.log('yt-dlp-exec wrapper detected.');
} catch (e) {
    // not installed — we'll use system yt-dlp
}

const app = express();
const PORT = process.env.PORT || 5000;

// Set ffmpeg path (ffmpeg-static)
ffmpeg.setFfmpegPath(ffmpegStatic);

// Use system temp directory to avoid nodemon restarts issues
const downloadsDir = path.join(os.tmpdir(), 'youtube-mp3-downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}
console.log(`📁 Using temp directory: ${downloadsDir}`);

// CORS config (dev: permissive; production: set FRONTEND_URL)
const frontendUrl = process.env.FRONTEND_URL;
const corsOptions = {
    origin: (origin, cb) => {
        if (process.env.NODE_ENV === 'production') {
            if (!frontendUrl) return cb(new Error('No FRONTEND_URL set in production'), false);
            return cb(null, frontendUrl);
        }
        cb(null, true); // dev: allow all
    },
    credentials: true,
    exposedHeaders: ['Content-Disposition', 'Content-Length']
};
app.use(cors(corsOptions));
app.use(express.json());

// Helper: get yt-dlp metadata via `yt-dlp -j`
function ytDlpMetadata(videoUrl) {
    return new Promise((resolve, reject) => {
        if (ytDlpExecWrapper) {
            ytDlpExecWrapper(videoUrl, { dumpSingleJson: true })
                .then(output => {
                    try {
                        const parsed = typeof output === 'string' ? JSON.parse(output) : output;
                        resolve(parsed);
                    } catch (err) {
                        reject(err);
                    }
                })
                .catch(err => reject(err));
            return;
        }

        const proc = spawn('yt-dlp', ['-j', videoUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        proc.stdout.on('data', d => out += d.toString());
        proc.stderr.on('data', d => err += d.toString());

        proc.on('error', () => reject(new Error('yt-dlp not found on PATH')));
        proc.on('close', code => {
            if (code !== 0) return reject(new Error(`yt-dlp exited ${code}: ${err.trim().split('\n').slice(-5).join('\n')}`));
            try { resolve(JSON.parse(out)); } catch (parseErr) { reject(parseErr); }
        });
    });
}

// Search endpoint
app.get('/api/search', async (req, res) => {
    try {
        const { query } = req.query;
        if (!query) return res.status(400).json({ error: 'Query parameter is required' });

        const results = await ytSearch(query);
        const videos = (results.videos || []).map(v => ({
            id: v.videoId,
            title: v.title,
            description: v.description,
            thumbnail: v.thumbnail,
            channelTitle: v.author?.name || '',
            duration: v.duration?.seconds || 0,
            timestamp: v.timestamp,
            views: v.views,
            ago: v.ago
        }));
        res.json(videos);
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Search failed', details: String(error) });
    }
});

// Video metadata endpoint
app.get('/api/video/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const url = `https://www.youtube.com/watch?v=${id}`;
        const meta = await ytDlpMetadata(url);

        res.json({
            title: meta.title,
            duration: Math.floor(meta.duration || 0),
            author: meta.uploader || meta.uploader_id || '',
            thumbnail: (meta.thumbnails && meta.thumbnails.length) ? meta.thumbnails[0].url : null,
            formats: meta.formats || []
        });
    } catch (error) {
        console.error('Video info error:', error);
        res.status(500).json({ error: 'Failed to get video info', details: String(error).slice(0, 500) });
    }
});

/**
 * Download endpoint:
 * - mp3 => yt-dlp bestaudio -> ffmpeg -> MP3 -> stream to client
 * - mp4 => yt-dlp merge -> write temp mp4 -> stream file -> delete temp file
 *
 * Query: ?format=mp3|mp4 (default mp3)
 */
app.get('/api/download/:id', async (req, res) => {
    const id = req.params.id;
    const format = (req.query.format || 'mp3').toLowerCase();
    const url = `https://www.youtube.com/watch?v=${id}`;

    let ytProc = null;
    let tempFilePath = null;

    try {
        // fetch metadata for safe filename and duration checks
        const meta = await ytDlpMetadata(url);
        const duration = Math.floor(meta.duration || 0);
        if (duration > 3600) { // 1 hour max (adjust if desired)
            return res.status(400).json({ error: 'Video too long. Maximum 1 hour allowed.' });
        }
        const safeTitle = (meta.title || 'download').replace(/[^\w\s.-]/gi, '').substring(0, 60);

        if (format === 'mp3') {
            const filename = `${safeTitle}.mp3`;

            // headers
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Transfer-Encoding', 'chunked');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
            res.flushHeaders?.();

            // spawn yt-dlp -> stdout (bestaudio)
            ytProc = spawn('yt-dlp', ['-f', 'bestaudio', '-o', '-', '--no-playlist', url], { stdio: ['ignore', 'pipe', 'pipe'] });

            ytProc.on('error', (err) => {
                console.error('yt-dlp spawn error (mp3):', err);
            });
            let ytErr = '';
            ytProc.stderr.on('data', d => { ytErr += d.toString(); });

            // convert to mp3 using ffmpeg (fluent-ffmpeg)
            const ff = ffmpeg(ytProc.stdout)
                .audioBitrate(128)
                .audioCodec('libmp3lame')
                .format('mp3')
                .on('start', cmd => console.log('FFmpeg command:', cmd))
                .on('progress', p => { if (p && p.timemark) console.log('FFmpeg progress', p.timemark); })
                .on('error', (err, stdout, stderr) => {
                    console.error('FFmpeg error:', err && err.message ? err.message : err);
                    console.error('ffmpeg stderr:', stderr || '');
                    try { ytProc.kill(); } catch (_) { }
                    if (!res.headersSent) {
                        res.status(500).json({ error: 'Conversion failed', details: String(err) });
                    } else {
                        try { res.end(); } catch (_) { }
                    }
                })
                .on('end', () => console.log(`Conversion finished: ${filename}`));

            // pipe ffmpeg output to the response (streaming)
            ff.pipe(res, { end: true });

            // cleanup on client abort
            req.on('close', () => {
                if (req.aborted || res.finished) {
                    console.log('Client disconnected (mp3), killing yt-dlp/ffmpeg processes.');
                    try { ytProc && ytProc.kill('SIGKILL'); } catch (_) { }
                }
            });

            return; // mp3 handled
        }

        else if (format === 'mp4') {
            const filename = `${safeTitle}.mp4`;
            // We'll download to temp file first (reliable merge)
            tempFilePath = path.join(downloadsDir, `${safeTitle.replace(/\s+/g, '_')}-${Date.now()}.mp4`);
            console.log('Downloading MP4 to temp file:', tempFilePath);

            let dlProc = null;
            let abortedDuringDownload = false;

            // If client disconnects while yt-dlp is downloading, kill dlProc and cleanup
            const onClientCloseWhileDownloading = () => {
                if (dlProc) {
                    abortedDuringDownload = true;
                    try { dlProc.kill('SIGKILL'); } catch (e) { /* ignore */ }
                }
            };
            req.on('close', onClientCloseWhileDownloading);

            // spawn yt-dlp to download merged mp4 to temp file
            await new Promise((resolve, reject) => {
                dlProc = spawn('yt-dlp', [
                    '-f', 'bv*+ba/b',
                    '--merge-output-format', 'mp4',
                    '-o', tempFilePath,
                    '--no-playlist',
                    url
                ], { stdio: ['ignore', 'pipe', 'pipe'] });

                let stderr = '';
                dlProc.stderr.on('data', d => { stderr += d.toString(); });

                dlProc.on('error', (e) => {
                    console.error('yt-dlp fallback spawn error:', e);
                    reject(e);
                });

                dlProc.on('close', (code) => {
                    if (abortedDuringDownload) {
                        // client disconnected; cleanup and reject so outer catch will handle
                        try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (e) { console.warn('Failed cleanup after abort:', e); }
                        return reject(new Error('Client disconnected during download.'));
                    }

                    if (code !== 0) {
                        console.error('yt-dlp fallback exited with code', code, 'stderr:', stderr.slice(-1000));
                        return reject(new Error(`yt-dlp fallback failed: ${stderr.split('\n').slice(-5).join('\n')}`));
                    }

                    console.log('yt-dlp fallback download finished:', tempFilePath);
                    resolve();
                });
            });

            // if we reached here, file exists
            if (!fs.existsSync(tempFilePath)) {
                throw new Error('Expected temp file not found after yt-dlp finished.');
            }

            const stat = fs.statSync(tempFilePath);

            // set headers and stream file
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Length', String(stat.size));
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');

            const readStream = fs.createReadStream(tempFilePath);

            // cleanup handlers
            const cleanupTemp = () => {
                try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (e) { console.warn('Failed to delete temp file:', e); }
            };

            readStream.on('error', (e) => {
                console.error('Error reading temp file:', e);
                cleanupTemp();
            });

            readStream.on('end', () => {
                cleanupTemp();
            });

            req.on('close', () => {
                // client disconnected while streaming file
                try { readStream.destroy(); } catch (_) { }
                cleanupTemp();
            });

            readStream.pipe(res);
            return;
        }

        else {
            return res.status(400).json({ error: 'Invalid format. Use mp3 or mp4.' });
        }
    } catch (err) {
        console.error('Download error:', err);
        // kill any running yt-dlp
        try { ytProc && ytProc.kill(); } catch (e) { /* ignore */ }

        // cleanup temp file if present
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            try { fs.unlinkSync(tempFilePath); } catch (e) { console.warn('Failed to cleanup temp file', e); }
        }

        if (!res.headersSent) {
            res.status(500).json({ error: 'Download failed', details: String(err).slice(0, 500) });
        } else {
            try { res.end(); } catch (e) { /* ignore */ }
        }
    }
});

// Health endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString(), tempDir: downloadsDir });
});

// Generic error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error', message: process.env.NODE_ENV === 'development' ? String(err) : undefined });
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// Graceful shutdown
const shutdown = () => {
    console.log('Shutting down server...');
    server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
