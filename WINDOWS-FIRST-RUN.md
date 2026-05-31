# Howa Windows First Run

This RC uses a portable source zip or checkout. There is no MSI, native executable, Docker image, or Electron/Tauri installer.

## Package/install method

Build a Windows RC zip from a checkout:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\package-windows-zip.ps1
```

The zip is written to `release\howa-0.1.0-windows-rc.zip`. A tester can also clone the repo directly and run the same commands below.

## Prerequisites

- Windows 10/11 with PowerShell or Windows Terminal.
- Node.js 18.17 or newer.
- npm from the Node install.
- Git for Windows if cloning or testing external repo/agent adapters.
- Browser: Edge, Chrome, or Firefox.
- Ollama is optional and only needed for local-model/external adapter testing. Offline smoke does not require it.

Python is not required for the RC smoke path.

## Configure `.env`

No environment file is required for the first smoke test. Optional local overrides:

```powershell
Copy-Item .env.example .env
```

## Exact test commands

```powershell
npm ci
npm run build
npm run smoke
npm run start
```

Open:

```text
http://127.0.0.1:18799
```

Optional CLI checks:

```powershell
npm run cli -- list agents
npm run cli -- list packs
```

## Expected output

`npm run smoke` should include:

```text
Running Howa passing smoke test (mock agent + stamina pack)...
Passing smoke test succeeded.
```

The UI should load agent and pack data from the local API.

## Cleanup

Stop the server with `Ctrl+C`, then delete `howa-state` and the extracted zip or checkout folder.

## Known RC gaps

- Native Windows has not been personally verified yet.
- The zip is portable source, not an installed app.
- Global npm/npx UX is not the recommended RC path because API/UI startup still uses `npm run start`.
- External adapters require their own Windows-compatible binaries or services.
