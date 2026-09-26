# Roblox Account Manager (V2)

A modern rebuild of ic3w0lf's Roblox Account Manager, in Electron + Node. Manage
many Roblox accounts, launch them into games, run several clients at once, and
keep sessions alive.

> This repo contains **only the app code** — no accounts, cookies or passwords.
> Your accounts are stored, encrypted, in `%USERPROFILE%/.roblox-account-manager-v2`
> on the machine you run it on, and never in this project.

## Run it on a new computer

You need [Node.js](https://nodejs.org) (v18 or newer) installed.

```bash
git clone <your-repo-url>
cd RobloxAccountManagerV2
npm install
npm start
```

## Build a standalone app (an .exe you can pin, no terminal)

```bash
npm run pack
```

The app appears in `dist/Roblox Account Manager-win32-x64/Roblox Account Manager.exe`.
Make a desktop shortcut to it and pin that.

## First-time setup

- **Add Account ▾ → Import from RAM** to bring in accounts from the old ic3w0lf
  Roblox Account Manager (`AccountData.json`). No password needed — it's protected
  by your Windows login.
- Or **Add Account** (manual login), **Auto login** (paste `user:pass` lines), or
  **Login with cookie(s)**.

## Features

- Encrypted local account vault (Windows DPAPI, same as RAM)
- Launch into a place, a specific server, a VIP/private link, or follow a user
- Multi-Roblox (run several clients at once), with a max-clients limit
- Automatic cookie refresh + a scheduled keep-alive so sessions don't expire
- Account browser per account (your installed Chrome/Edge, one profile each)
- Alias, groups, drag-select, right-click menu, Account Utilities (display name,
  password, privacy, summary)

## What it does NOT do

No FPS unlock, no captcha-solving automation. You solve any captcha yourself.

## Data location

`%USERPROFILE%/.roblox-account-manager-v2/` — `accounts.dat` (encrypted), `settings.json`,
and one browser profile per account under `profiles/`.
