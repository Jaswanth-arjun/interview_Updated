# Interview Practice Assistant (Interview Copilot)

An intelligent, on-screen desktop assistant designed for mock interview practice. It captures interviewer questions in real-time, filters out background noise/system alerts, transcribes speech with ultra-low latency, and streams context-aware AI interview responses directly on an overlay.

---

## 📑 Table of Contents
1. [Architecture Overview](#-architecture-overview)
2. [Prerequisites & Requirements](#-prerequisites--requirements)
3. [Running Locally for Development](#-running-locally-for-development)
4. [Building the Windows Installer (.exe)](#-building-the-windows-installer-exe)
5. [Render Cloud Backend Setup & Recovery](#-render-cloud-backend-setup--recovery)
6. [Database Setup, Backup & Recovery (Supabase / PostgreSQL)](#-database-setup-backup--recovery)
7. [Environment Variables Reference](#-environment-variables-reference)
8. [Troubleshooting Guide](#-troubleshooting-guide)

---

## 🏗️ Architecture Overview

The application is structured into two main parts:

```
┌──────────────────────────────────────────────┐
│       Windows Desktop Client (Electron)       │
│  - System audio capture & real-time VAD      │
│  - Vocal frequency filtering (300Hz-3200Hz)  │
│  - Stealth overlay window & UI               │
└──────────────────────┬───────────────────────┘
                       │
                       │ Calls localhost:4000 (Local)
                       │ or https://interview-updated.onrender.com (Cloud)
                       ▼
┌──────────────────────────────────────────────┐
│         Backend Server (Node.js/Express)     │
│  - Speech-to-Text: Groq Whisper (ultra-fast) │
│  - AI Responses: Google Gemini Flash         │
│  - Auth & Payments: Google OAuth & Razorpay  │
└──────────────────────┬───────────────────────┘
                       │
                       │ Prisma ORM
                       ▼
┌──────────────────────────────────────────────┐
│     Cloud Database (Supabase PostgreSQL)     │
│  - User profiles, wallet & trial usage       │
└──────────────────────────────────────────────┘
```

---

## ⚙️ Prerequisites & Requirements

- **Operating System**: Windows 10 or 11 (64-bit)
- **Node.js**: Version 18.x, 20.x, or 22.x LTS
- **Package Manager**: npm (bundled with Node.js)
- **Git**: Installed and configured

---

## 💻 Running Locally for Development

### 1. Start the Backend API Server:
```powershell
cd d:\interview\server
npm install
npm run dev
```
The server will start on `http://localhost:4000`. You can test it by opening `http://localhost:4000/health`.

### 2. Start the Desktop App (Electron):
Open a second terminal window in the root directory:
```powershell
cd d:\interview
npm install
npm start
```
The application overlay will launch and automatically connect to your local backend on port 4000.

---

## 📦 Building the Windows Installer (.exe)

When you are ready to distribute or run the app on any Windows machine without running terminal commands:

```powershell
npm run dist
```

### What this command does:
1. Runs an isolated build via `scripts/dist.js` outside the workspace (in `D:\Temp` or `%TEMP%`) to prevent file lock (`EBUSY`) issues.
2. Packages the entire Electron runtime and application assets.
3. Automatically places the ready-to-use installer here:
   👉 **`d:\interview\release\Interview Copilot Setup 1.0.0.exe`**

### Installing & Updating:
- Double-click `Interview Copilot Setup 1.0.0.exe` on any Windows computer.
- If you already have the app installed, running this new setup file will automatically overwrite and update the existing installation without losing any user data.

---

## ☁️ Render Cloud Backend Setup & Recovery

The cloud server is hosted on [Render.com](https://render.com) at:
**`https://interview-updated.onrender.com`**

### 1. Initial Render Deployment Configuration:
- **Service Type**: Web Service
- **Environment**: Node
- **Root Directory**: `server`
- **Build Command**: `npm install && npx prisma generate`
- **Start Command**: `node src/index.js`
- **Health Check Path**: `/health`

---

### 2. What to Do If Render Is Inactive / Sleeping / Suspended:

#### Situation A: Server is "Sleeping" (Free Tier Spin-Down)
- **Cause**: On Render's Free tier, after 15 minutes of inactivity, the web service automatically spins down to save resources.
- **Symptom**: The first request takes 40–50 seconds to respond.
- **Solution**:
  1. Simply make any HTTP request to wake it up (e.g. open `https://interview-updated.onrender.com/health` in your browser).
  2. To keep it awake 24/7 without manual effort, set up a free uptime monitor (like [UptimeRobot.com](https://uptimerobot.com) or [cron-job.org](https://cron-job.org)) to ping `https://interview-updated.onrender.com/health` every 10 minutes.

#### Situation B: Server is "Suspended" or Failed Deployment
- **Steps to Recover**:
  1. Log into your [Render Dashboard](https://dashboard.render.com).
  2. Click on your service: **`interview-updated`**.
  3. Click **"Manual Deploy"** (top right) ➔ **"Clear build cache & deploy"**.
  4. Check the **Logs** tab. If it fails, check whether your environment variables (`DATABASE_URL`, `GEMINI_API_KEY_2`, etc.) are filled in correctly.
  5. If Render suspended the account or service, create a new Web Service on Render, connect your GitHub repository (`Jaswanth-arjun/interview_Updated`), copy the Environment Variables, and update `REMOTE_BACKEND_URL` in `main.js` with the new URL.

---

## 🗄️ Database Setup, Backup & Recovery

The production database is hosted on **Supabase** (PostgreSQL).

### 1. Database Connection String (`DATABASE_URL`):
Always use the **Session Pooler** URL (Port 5432 or 6543) so that both local development and Render cloud servers can connect through firewalls with SSL:
```
DATABASE_URL="postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres?sslmode=require"
```

---

### 2. What to Do If Supabase Is Paused / Suspended:
- **Cause**: Free Supabase projects automatically pause after 7 days of inactivity.
- **Symptom**: Backend logs show `PrismaClientInitializationError: Can't reach database server`.
- **How to Unpause / Restore**:
  1. Open [Supabase Dashboard](https://supabase.com/dashboard).
  2. Select your project.
  3. You will see a banner: *"This project has been paused"*.
  4. Click the green **"Restore Project"** button.
  5. Wait 1–2 minutes; all tables and data will be restored immediately without data loss.

---

### 3. How to Create a Full Database Backup:

#### Method 1: Via Supabase Dashboard (Recommended)
1. Go to your Supabase Project ➔ **Settings** (gear icon) ➔ **Database**.
2. Scroll to **Backups**.
3. Click **Download Backup** (or export SQL dump).

#### Method 2: Manual SQL Dump (CLI)
Run this command from your terminal:
```powershell
pg_dump "YOUR_DATABASE_URL" -F c -b -v -f "interview_db_backup.dump"
```

---

### 4. How to Restore or Migrate to a Brand New Database:
If your database is completely lost, suspended, or if you want to switch to a new provider (e.g. Neon, Render Postgres, AWS RDS):
1. Create a fresh PostgreSQL database.
2. Copy the new connection string into `server/.env` under `DATABASE_URL`.
3. Run the following command from the `server` folder:
   ```powershell
   cd d:\interview\server
   npx prisma db push
   ```
   *This command reads `prisma/schema.prisma` and automatically recreates all tables (`User`, `Device`, `Transaction`, `InterviewSession`, etc.) in seconds!*
4. Run `npx prisma generate` to update the client.

---

## 🔑 Environment Variables Reference

Create a `.env` file in the `server` folder (refer to `server/.env.example`):

| Variable | Description | Where to get it |
| :--- | :--- | :--- |
| `DATABASE_URL` | PostgreSQL connection string | [Supabase Dashboard](https://supabase.com) |
| `JWT_ACCESS_SECRET` | 64-char random hex string | Generated via `crypto.randomBytes(32)` |
| `JWT_REFRESH_SECRET` | 64-char random hex string | Generated via `crypto.randomBytes(32)` |
| `GOOGLE_CLIENT_ID` | OAuth Client ID | [Google Cloud Console](https://console.cloud.google.com) |
| `GOOGLE_CLIENT_SECRET`| OAuth Client Secret | Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | `https://interview-updated.onrender.com/auth/google/callback` | OAuth redirect URI |
| `GEMINI_API_KEY_2` | Google Gemini API Key | [Google AI Studio](https://aistudio.google.com/app/apikey) |
| `GROQ_API_KEY` | Groq Cloud Whisper API Key | [Groq Console](https://console.groq.com/keys) |
| `RAZORPAY_KEY_ID` | Razorpay Key ID | [Razorpay Dashboard](https://dashboard.razorpay.com) |
| `RAZORPAY_KEY_SECRET` | Razorpay Secret | Razorpay Dashboard |

---

## 🛠️ Troubleshooting Guide

### 1. `EBUSY: resource busy or locked, unlink '...app.asar'`
- **Cause**: Antigravity IDE / VS Code has the built `.asar` file open in memory.
- **Solution**: We fixed this in `scripts/dist.js`! Always run `npm run dist`, which builds in an isolated directory and never fails with `EBUSY`.

### 2. "Login Failed: A server error occurred"
- **Cause**: Google OAuth callback URL mismatch or database connection failure.
- **Solution**:
  1. Check if Supabase project is active (not paused).
  2. Verify that `GOOGLE_REDIRECT_URI` in Google Cloud Console matches `https://interview-updated.onrender.com/auth/google/callback` exactly.

### 3. Screen goes blank or reacts to system notification sounds
- **Cause**: Transient notification dings or alert sounds triggered audio capture.
- **Solution**: Already filtered in `src/overlay/overlay.js` via:
  - Formant frequency band analysis (filters >3500Hz high-frequency chimes).
  - 7-frame consecutive voice energy debounce (~115ms).
  - Minimum 900ms audio duration gate before sending to AI.
  - Screen never clears previous answers until a valid question is verified.

---

## 📄 License
Private & Confidential — Created for Interview Practice.
