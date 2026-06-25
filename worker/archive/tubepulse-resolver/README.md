# Legacy TubePulse Resolver Worker

This directory contains the legacy standalone resolver worker.

It exposed the old resolver behaviour for YouTube channel handle/channelId lookup:

- `GET /?handle=@handle`
- `GET /?channelId=UC...`

This worker has been superseded by `worker/tubepulse-api` and its `/resolve` endpoint. The live app-facing API is `tubepulse-api`, not `tubepulse-resolver`.

These files are archived for reference only. Do not deploy this worker unless deliberately restoring historical resolver behaviour.