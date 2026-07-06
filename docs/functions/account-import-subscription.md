# Account Import Subscription

Use this when a batch of upstream API-key accounts should be pulled from a URL and imported through the normal `juhe-ai` account import path.

## Subscription Format

The URL may return standard import JSON:

```json
{
  "type": "juhe-ai-account-import",
  "version": 1,
  "accounts": [
    {
      "name": "md-01",
      "providerCode": "gpt",
      "providerProtocolProfileId": "profile_gpt_openai_v1",
      "type": "api_key",
      "status": "active",
      "groupName": "md",
      "credentials": {
        "api_key": "sk-...",
        "base_url": "http://example.com"
      },
      "supportedModels": ["gpt-4.1"],
      "concurrencyLimit": 3,
      "priority": 0
    }
  ]
}
```

For convenience, the URL may also return either:

- an `accounts` object without `type/version`;
- a raw account array;
- `base64(JSON)`.

The server normalizes these to `juhe-ai-account-import` before preview/import.

## API

Preview:

```http
POST /__aisys__/api/accounts/import/subscription/preview?systemAccountId=<target>
Content-Type: application/json

{
  "url": "https://example.com/juhe-ai-accounts.json",
  "options": {
    "createMissingGroups": true,
    "createMissingProxies": true,
    "skipDuplicates": true
  }
}
```

Confirm and optionally append imported groups to existing API keys:

```http
POST /__aisys__/api/accounts/import/subscription/confirm?systemAccountId=<target>
Content-Type: application/json

{
  "url": "https://example.com/juhe-ai-accounts.json",
  "bindApiKeyIds": ["key_xxx"],
  "options": {
    "createMissingGroups": true,
    "createMissingProxies": true,
    "skipDuplicates": true
  }
}
```

`bindApiKeyIds` is intentionally explicit. It preserves all existing API-key group bindings and appends only missing imported groups. If a group cannot legally be bound to that API key, the response reports the binding failure instead of silently creating a "no target account" state.

## Limits

- Max subscription response body: 1 MiB.
- Max accounts per import: 200.
- Max proxies per import: 20.
- Fetch timeout: 10 seconds.
- Only `http` and `https` URLs are supported.

Do not put secrets in operation notes or logs. If the subscription needs authorization, pass it in `headers`; header values are not included in the mutation fingerprint.
