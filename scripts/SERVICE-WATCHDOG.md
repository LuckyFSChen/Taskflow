# TaskFlow / idv-web service watchdog

- Scheduled task: `TaskFlow-idv-web-HourlyCheck`, hourly and at sign-in.
- Desktop: `重啟 TaskFlow 與檢查 idv-web.lnk`.
- Both use WScript window style 0 and PowerShell `-WindowStyle Hidden`; Node starts hidden.
- Ensure mode starts only missing TaskFlow 4310 / Guardian 4311. Existing listeners must belong to this project. A process present without a listener is reported rather than duplicated.
- Restart mode checks for active AI work, pauses the existing Guardian schedule, stops only this project's matching Node processes, and restarts both services. No dependency installation, build, setup, or deployment.
- Cloudflared Windows service: existing automatic startup and 20-second crash recovery are retained. The watchdog attempts Start-Service only if stopped; this may require an administrator. Public TaskFlow health is also checked.
- Live Tunnel `/config` on 2026-09-26 listed only `taskflow.lucky0504.idv.tw -> http://127.0.0.1:4310` plus fallback 404. No idv route was present on this PC's connector.
- idv production checks: `https://idv.lucky0504.idv.tw/api/health` and homepage. Both passed. Repository deploy.ps1 deploys a Cloudflare Worker; there is no local production idv process to restart. No Cloudflare resources or deployments are modified.
- Logs: `F:\TaskFlow\data\service-watchdog.log` (rotates at 2 MiB); each service start has timestamped stdout/stderr files in data.
- Node executable is pinned in `scripts/service-watchdog-config.json`; update it after relocating Node.
- Installation: `scripts/Install-LocalServiceWatchdog.ps1`.

## Current scheduling diagnosis

Interactive scheduled launches (including the pre-existing Guardian task) return `0x800710E0` on this Windows session. A real timer trigger reproduced the failure. A COM RunEx launch explicitly targeting active session 9 completed successfully; this is evidence the wrapper works, not a reliable hourly fix.

The desktop restart wrapper was run successfully: both service PIDs changed, both listeners returned, and public HTTPS checks passed. A subsequent Ensure run retained the existing processes.

Prepared fix: run `Install-LocalServiceWatchdog.ps1 -Unattended` with administrator approval. This registers the same user with S4U / limited privileges, without saving a password, plus a separate SYSTEM task with a fixed inline action that only starts the existing Cloudflared service when stopped. The installer immediately runs both tasks for validation. This mode does not depend on an interactive desktop session. At preparation time administrator approval was pending; do not treat the interactive hourly task as verified working.
