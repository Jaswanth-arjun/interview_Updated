const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const rootDir = path.join(__dirname, '..');
const tempOut = path.join(os.tmpdir(), 'interview-copilot-build');
const releaseDir = path.join(rootDir, 'release');

console.log('Building installer in isolated temp directory:', tempOut);

try {
  if (fs.existsSync(tempOut)) {
    fs.rmSync(tempOut, { recursive: true, force: true });
  }
} catch (e) {
  console.warn('Warning cleaning temp dir:', e.message);
}

try {
  execSync(`npx electron-builder --config.directories.output="${tempOut}"`, {
    stdio: 'inherit',
    cwd: rootDir
  });

  if (!fs.existsSync(releaseDir)) {
    fs.mkdirSync(releaseDir, { recursive: true });
  }

  const files = fs.readdirSync(tempOut);
  for (const file of files) {
    if (file.endsWith('.exe') || file.endsWith('.yml') || file.endsWith('.blockmap')) {
      const src = path.join(tempOut, file);
      const dest = path.join(releaseDir, file);
      fs.copyFileSync(src, dest);
      console.log(`[Success] Saved: ${file} -> release/${file}`);
    }
  }

  // Also copy portable unpacked exe if present
  const unpackedDir = path.join(tempOut, 'win-unpacked');
  const targetUnpacked = path.join(releaseDir, 'win-unpacked');
  if (fs.existsSync(unpackedDir)) {
    try {
      fs.cpSync(unpackedDir, targetUnpacked, { recursive: true, force: true });
      console.log('[Success] Copied win-unpacked -> release/win-unpacked');
    } catch (err) {
      console.warn('win-unpacked could not be overwritten (currently in use), installer was updated.');
    }
  }

  console.log('\nBuild finished successfully!');
  console.log(`Setup installer is ready at: ${path.join(releaseDir, 'Interview Copilot Setup 1.0.0.exe')}`);
} catch (error) {
  console.error('Build failed:', error.message);
  process.exit(1);
}

