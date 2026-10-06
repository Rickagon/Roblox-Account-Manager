# 🚀 Roblox Account Manager

![platform](https://img.shields.io/badge/platform-Windows-0a7bbb)
[![latest release](https://img.shields.io/github/v/release/Rickagon/Roblox-Account-Manager)](https://github.com/Rickagon/Roblox-Account-Manager/releases/latest)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Run your whole army of Roblox accounts from one window.** Launch them into any
game, fire up a dozen clients at once, and never get logged out again. Built for
people who are *done* juggling browser tabs.

> 🔒 **Your accounts never leave your PC. Period.** This repo is just the app:
> no accounts, no cookies, no passwords. It all lives encrypted on *your*
> machine and stays there.

## 📸 Look at it

![Roblox Account Manager](docs/screenshot.png)

## ⬇️ Get it running (zero setup)

1. Grab the **[latest release](https://github.com/Rickagon/Roblox-Account-Manager/releases/latest)**.
2. Download **`RobloxAccountManager-win-x64.zip`**.
3. Unzip it anywhere. Keep the whole folder together.
4. Double-click **`Roblox Account Manager.exe`**. Done.

No installer. No command line. No nonsense. Right-click the .exe and
**Pin to taskbar** so it's always a click away.

> Windows might throw a "protected your PC" popup. That's just because the app
> isn't code-signed (that costs money). Hit **More info → Run anyway**. Scan it
> with Windows Defender if you want the peace of mind.

## ⚡ Load your accounts in

- **Import from RAM** - drop in your old `AccountData.json` and they all show up.
- **Auto login** - paste `user:pass` lines and let it do the work.
- **Cookies** - paste `.ROBLOSECURITY` cookies. No captcha, ever.
- **Manual** - sign in once in a browser window.

## 🔥 What it does

- 🎮 **Multi-Roblox** - run as many clients at once as your PC can handle.
- 🚀 **Launch anywhere** - a game, a specific server, a VIP/private link, or follow a friend.
- 🔄 **Never log out** - automatic cookie refresh + a scheduled keep-alive.
- 🔒 **Encrypted vault** - every account locked down with Windows-grade encryption.
- 🪟 **Lives in your tray** - holds the Multi-Roblox lock all session, can boot on startup.
- 🎨 **Make it yours** - themes, aliases, groups, drag-select, right-click menus, bulk tools.
- 🖥️ **Per-account browsers** - each account gets its own profile in your Chrome/Edge.

## 🗂️ Where your stuff lives

Everything sits in `%USERPROFILE%\.roblox-account-manager-v2\`: the encrypted
vault, your settings, and a browser profile per account. All local. All yours.

---

<details>
<summary>🛠️ Building from source (for the nerds)</summary>

You do **not** need this to use the app - just grab the release zip above.
To build it yourself you need [Node.js](https://nodejs.org) 18+:

```bash
git clone <your-repo-url>
cd Roblox-Account-Manager
npm install
npm start        # run in dev
npm run pack     # build the standalone .exe into dist/
```

The packaged app lands in `dist\Roblox Account Manager-win32-x64\`.

</details>

## License

[MIT](LICENSE) - do whatever you want with it.
