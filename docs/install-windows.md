# Running Archspace on Windows

**Short version: clone the repository and run it from source.** The downloadable
installer is unsigned, and on a clean Windows 11 machine Windows refuses it
outright with no way through. Source has none of that problem, and it is also
newer than any download.

---

## Which route

| | Installer | From source |
|---|---|---|
| Works on Windows 11 with Smart App Control | **No** — blocked, no override | Yes |
| Works on Windows 10 / managed Windows 11 | Warns; *More info → Run anyway* | Yes |
| Needs Node and git | No | Yes |
| Version | Whatever was last released | Current |
| Confirmed working | **Never** — see below | Yes |

The rest of this page is the source route. The installer is covered at the end.

---

## From source

### 1. Install Node 22 or newer

Check what you have — PowerShell or Command Prompt:

```powershell
node --version
```

If that errors or prints below `v22`, install it. Any one of these:

```powershell
winget install OpenJS.NodeJS.LTS
```

or the MSI from <https://nodejs.org>, or [nvm-windows] if you juggle versions.
**Close and reopen your terminal afterwards** — the installer edits `PATH`, and
an already-open shell keeps the old one. This is the single most common reason
step 2 reports "not recognised" straight after a successful install.

[nvm-windows]: https://github.com/coreybutler/nvm-windows

### 2. Install pnpm

```powershell
npm install -g pnpm
pnpm --version
```

If PowerShell refuses to run `pnpm.ps1` with a message about scripts being
disabled, that is the execution policy, not a broken install. Either use
Command Prompt instead, or allow local scripts for your own user:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### 3. Clone and install

```powershell
git clone https://github.com/jaydenyu0210/archspace.git
cd archspace
pnpm install
```

Clone somewhere with a **short path** — `C:\dev\archspace`, not a deep folder
inside OneDrive. Node projects nest deeply, and Windows' 260-character path
limit is reached more easily than you would expect. If `pnpm install` fails
with `ENAMETOOLONG` or a path error, this is why; either move the clone or
enable long paths:

```powershell
git config --global core.longpaths true
```

### 4. Run it

```powershell
pnpm dev
```

**The first run downloads Electron** — about 100 MB — and prints
`Downloading Electron binary...` while it does. Expect an extra minute. If that
download fails behind a proxy, a dropped connection or antivirus, run it
directly to see the actual error instead of a generic install failure:

```powershell
node packages\app\node_modules\electron\install.js
```

That is the whole thing. A window opens with an example workflow already loaded.

### Why this works when the installer does not

`pnpm dev` launches **Electron's own binary**, which the Electron project signs.
Windows recognises that signature, so Smart App Control has nothing to object
to. The installer packages the same app under a *new* executable that nobody has
signed, and that is the one Windows refuses. Same code, different wrapper.

### Keeping it current

```powershell
git pull
pnpm install
pnpm dev
```

Run `pnpm install` after every pull, not just the first time — a pull that
changes a dependency leaves `node_modules` stale, and the failure that produces
is usually a confusing type or import error rather than an obvious one.

---

## The installer, and why it is not recommended

`pnpm --filter @archspace/app dist:win` builds it, and releases carry it as
`Archspace Setup <version>.exe` plus portable ZIPs for x64 and arm64. It is
**not code-signed**: there is no Authenticode certificate for this project, and
[ADR-0014](adr/0014-windows-packaging.md) records why one was not bought for an
alpha.

What you see depends on which gate your machine has, and only one of them can be
got past:

| Dialog | What it is | What you can do |
|---|---|---|
| **"Windows protected your PC"** (blue) | SmartScreen | **More info → Run anyway** |
| **"Smart App Control blocked an app that may be unsafe"** | Smart App Control | Nothing. Use source. |

Smart App Control is a Windows 11 feature that refuses anything it cannot
attribute to a known publisher. Unlike SmartScreen it offers **no override** —
the dialog's only buttons are *Ok*, *Send feedback* and *Get apps from the
Store*. It is on by default after a clean Windows 11 install, so the newest
machines are exactly the ones that cannot run the download. It can be turned
off, but **that cannot be undone without reinstalling Windows**, and it lowers
protection for every app on the machine. Do not do that to try an alpha.

One honest caveat, recorded because it is the sort of thing a download page
usually omits: **the packaged Windows installer has never been observed to
launch successfully.** Every attempt so far was stopped by one of the two gates
above before the app ran. It builds, and the artifact is real, but nothing
beyond that is confirmed. If you get it running,
[open an issue](https://github.com/jaydenyu0210/archspace/issues) — that report
would be genuinely useful.

Signing is the fix and it is not done.
