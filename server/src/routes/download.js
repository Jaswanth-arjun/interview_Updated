// ─── Download Routing ────────────────────────────────────────
const express = require('express');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /download/app
 * Serves the desktop application executable file.
 * Downloads to user's default Downloads folder.
 */
router.get('/app', requireAuth, async (req, res) => {
    try {
        // Path to the built executable in dist folder
        const appName = 'Interview Copilot Setup 1.0.0.exe';

        // Try multiple possible paths for the executable
        const possiblePaths = [
            path.join(__dirname, '../../../dist', appName),
            path.join(process.cwd(), 'dist', appName),
            path.join('/app/dist', appName) // For Docker/deployment
        ];

        let executablePath = null;
        for (const filePath of possiblePaths) {
            if (fs.existsSync(filePath)) {
                executablePath = filePath;
                break;
            }
        }

        // Check if file exists
        if (!executablePath) {
            logger.error(`Executable not found in any of these paths:`, possiblePaths);
            return res.status(404).json({
                success: false,
                error: 'Application file not found on server. Please contact support.',
                code: 'FILE_NOT_FOUND'
            });
        }

        // Get file size for logging
        const fileStats = fs.statSync(executablePath);
        const fileSizeInMB = (fileStats.size / (1024 * 1024)).toFixed(2);

        logger.info(`Download initiated by user: ${req.user.email}, File: ${appName}, Size: ${fileSizeInMB} MB`);

        // Set response headers for file download
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${appName}"`);
        res.setHeader('Content-Length', fileStats.size);
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Access-Control-Allow-Origin', '*');

        // Create read stream and pipe to response
        const fileStream = fs.createReadStream(executablePath);

        fileStream.on('error', (err) => {
            logger.error(`Stream error during download for ${req.user.email}:`, err);
            if (!res.headersSent) {
                res.status(500).json({
                    success: false,
                    error: 'Error streaming file',
                    code: 'STREAM_ERROR'
                });
            }
        });

        fileStream.on('end', () => {
            logger.info(`Download completed for user: ${req.user.email}`);
