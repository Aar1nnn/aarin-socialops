# Social Media Poster upstream record

- Original GitHub URL: https://github.com/EbaAdisu/social-media-poster
- Pinned commit SHA: `33f00657e5babcc27455758aef4b8b2b97d1eba9`
- License: MIT, from root `LICENSE`
- Last audited/synced: 2026-09-21

## Audited source areas

- `packages/platform-adapters/src/adapter.interface.ts`
- `packages/platform-adapters/src/types.ts`
- `packages/platform-adapters/src/registry.ts`
- `packages/platform-adapters/src/http-client.ts`
- `packages/platform-adapters/src/meta-shared.ts`
- `packages/platform-adapters/src/instagram/`
- Future platform folders: `linkedin/`, `tiktok/`, `youtube/`, `x/`

## Aarin use

- Phase 1: adapt registry shape, HTTP timeout/rate-limit parsing, platform error normalization, and capability descriptors.
- Phase 2: port/adapt Instagram media validation, container creation, video readiness polling, carousel assembly, media publish, and media status query.
- Aarin targets: `src/lib/platforms/`, `src/lib/adapters/instagram-graph.ts`, and `src/services/publish-adapter-service.ts`.

## Local modifications

- Replace upstream token ownership with Aarin `PlatformConnection`, `SocialAccount`, and `TokenVault`.
- Replace upstream result/error contracts with Aarin `PublishResult` and explicit `failurePhase`.
- Disable hidden retries for all mutating provider calls to preserve `POST_DISPATCH -> UNKNOWN` safety.
- Resolve media through Aarin `StorageAdapter`; reject URLs Meta cannot fetch.
- Keep native Facebook code unchanged.

## MIT license notice retained for ported/adapted portions

```text
MIT License

Copyright (c) 2026 social-media-poster contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
