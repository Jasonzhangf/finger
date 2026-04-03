---
name: image-generation
description: Generate images via RouteCodex OpenAI-compatible endpoint /v1/images/generations (Qwen t2i). Use when user asks to create AI images, posters, avatars, covers, or visual drafts.
---

# Image Generation (Qwen T2I)

Use this skill when the user asks to generate an image.

## Endpoint

- URL: `http://127.0.0.1:5555/v1/images/generations`
- Auth header: `Authorization: Bearer $ROUTECODEX_HTTP_APIKEY`
- Content-Type: `application/json`

## Request fields

- `prompt` (required)
- `model` (default: `qwenchat.qwen3.6-plus`)
- `n` (1-10)
- `size` (`1:1`, `16:9`, or `WxH`)
- `response_format` (`url` or `b64_json`)

## Preferred execution path

1. Use `exec_command` to call the endpoint.
2. Default to `response_format="url"` unless user explicitly asks for base64/raw data.
3. If user asks to send image to channel directly, use `send_local_image` after downloading/decoding to a local file.

## Minimal command (URL response)

```bash
curl -s http://127.0.0.1:5555/v1/images/generations \
  -H "Authorization: Bearer $ROUTECODEX_HTTP_APIKEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"qwenchat.qwen3.6-plus",
    "prompt":"一只戴墨镜的柴犬，像素风",
    "n":1,
    "size":"1:1",
    "response_format":"url"
  }'
```

## b64_json handling

If `response_format="b64_json"`, decode to local file when needed:

```bash
python3 - <<'PY'
import json, base64, pathlib, sys
obj=json.load(sys.stdin)
b64=obj["data"][0]["b64_json"]
out=pathlib.Path('/tmp/generated-image.png')
out.write_bytes(base64.b64decode(b64))
print(str(out))
PY
```

## Validation checklist

- HTTP status is 200.
- Response contains `data` with at least one item.
- For `url` format: `data[0].url` is non-empty.
- For `b64_json` format: decoded file exists and size > 0.

## Failure handling

- If auth missing: check `ROUTECODEX_HTTP_APIKEY` is exported.
- If endpoint unavailable: report service/port issue (`127.0.0.1:5555`).
- Do not fake success; return raw error body + next actionable fix.
