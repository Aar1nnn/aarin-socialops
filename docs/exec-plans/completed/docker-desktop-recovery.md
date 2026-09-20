# Docker Desktop recovery (2026-09-19)

## Goal

Recover Docker Desktop without resetting images, containers, volumes, settings, or project data.

## Confirmed root cause

- Windows build: `26200`.
- Docker Desktop: `4.80.0`; Docker CLI: `29.6.1`.
- Startup first failed on `%LOCALAPPDATA%\Docker\run\dockerInference` with Windows error `1920`.
- After replacing the `run` directory, startup advanced and then failed on `%LOCALAPPDATA%\docker-secrets-engine\engine.sock` with the same error.
- Both objects are zero-byte NTFS reparse points dated `2026-08-10`.
- Docker/Secrets processes and `com.docker.service` were stopped; ACLs and ownership are correct.
- `Remove-Item`, `fsutil reparsepoint delete`, `Rename-Item`, `.NET Directory.Move`, and an elevated rename all failed on `docker-secrets-engine`.
- This matches Docker Desktop Windows issue `docker/desktop-feedback#554`: stale AF_UNIX sockets on build 26200 can remain kernel-locked until a full reboot.

## Completed actions

- Preserved the original Docker runtime socket directory as:
  - `%LOCALAPPDATA%\Docker\run.stale-20260919-223238`
- Additional empty/failed-attempt runtime backups exist as:
  - `%LOCALAPPDATA%\Docker\run.stale-20260919-223350`
  - `%LOCALAPPDATA%\Docker\run.stale-20260919-223638`
- Created a clean `%LOCALAPPDATA%\Docker\run` directory.
- Confirmed Docker Desktop `AutoStart` is `False` and no Docker startup command is registered.
- No Docker images, containers, volumes, WSL data, settings, or project files were deleted.

## Next actions after explicit reboot approval

1. Perform a full Windows restart.
2. Before starting Docker Desktop, verify no Docker processes are running.
3. Rename `%LOCALAPPDATA%\docker-secrets-engine` to a timestamped `.stale-*` backup.
4. Create a clean `%LOCALAPPDATA%\docker-secrets-engine` directory.
5. Verify `%LOCALAPPDATA%\Docker\run` is clean; rename/recreate it again only if a stale socket remains.
6. Start Docker Desktop.
7. Verify `docker version`, `docker info`, WSL state, and absence of new error-1920 log entries.
8. Consider disabling Docker Model Runner (`EnableDockerAI`) if the bug recurs; do not reset factory defaults.

## Update after first reboot (2026-09-20)

- Verified a full reboot occurred at `2026-09-20 01:54:56`; Docker processes were not running and `com.docker.service` was stopped.
- The build-26200 kernel lock still prevented a normal or elevated rename of `%LOCALAPPDATA%\docker-secrets-engine`.
- Replaced `%LOCALAPPDATA%\Docker\run` again and preserved the stale copy as:
  - `%LOCALAPPDATA%\Docker\run.stale-after-reboot-20260920-020044`
- Successfully registered a Windows `MoveFileExW` operation with `MOVEFILE_DELAY_UNTIL_REBOOT` to rename, not delete:
  - source: `%LOCALAPPDATA%\docker-secrets-engine`
  - target: `%LOCALAPPDATA%\docker-secrets-engine.stale-bootmove-20260920-020129`
- Verified both matching entries exist in `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\PendingFileRenameOperations`.

## Completion (2026-09-20)

- The delayed boot-time rename succeeded:
  - source `%LOCALAPPDATA%\docker-secrets-engine` was absent after boot;
  - backup `%LOCALAPPDATA%\docker-secrets-engine.stale-bootmove-20260920-020129` exists with the old `engine.sock`;
  - the matching pending-rename registry entries were consumed.
- Confirmed `%LOCALAPPDATA%` has EFS inheritance enabled while `%LOCALAPPDATA%\Docker` is unencrypted. A freshly created `%LOCALAPPDATA%\docker-secrets-engine` therefore inherited EFS and could not be decrypted because its EFS key was unavailable to the repair process.
- Replaced the empty EFS directory with a directory junction:
  - public path: `%LOCALAPPDATA%\docker-secrets-engine`
  - unencrypted target: `%LOCALAPPDATA%\Docker\secrets-engine-runtime`
- Docker Desktop started successfully and created `engine.sock` in the unencrypted target.
- Verified:
  - Docker client `29.6.1` connected to Docker server `29.6.1`;
  - `docker info` returned `overlayfs`, `0` containers, and `0` images;
  - `docker ps -a` and `docker image ls` completed successfully;
  - backend logs reported `secrets engine ready`, `docker daemon is ready`, and engine state `running`;
  - no error-1920, inaccessible-file, invalid-volume-label, or backend-crash signature appeared in the repaired startup window;
  - Docker WSL VHDX files remain present.

Status: completed. The stale backup directories are intentionally retained because their corrupted AF_UNIX reparse points resist safe deletion.

## Recovery safety

- Do not use **Reset to factory defaults**; Docker documents that it resets data/settings.
- Do not unregister `docker-desktop` or delete `%LOCALAPPDATA%\Docker\wsl`.
- Stale backup directories may remain undeletable; leaving them is safer than destructive cleanup.
