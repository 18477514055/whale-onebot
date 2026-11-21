# Bilibili Live over OneBot

Subscribe to a room to receive **public live notices**, not private chat messages. Subscriptions are in memory, isolated by bridge instance, and are not restored after shutdown. Sending live text is a separate, authenticated write; it does not require a subscription.

| Action | Params | Result (`data`) |
| --- | --- | --- |
| `bili_live_subscribe` | `room_id`: positive safe integer or decimal string (short room numbers accepted) | `{room_id, subscription_id, state}`. `connecting` means discovery succeeded, **not** authenticated. Wait for the `active` notice. Repeated calls for the same room return its current state. |
| `bili_live_subscriptions` | `{}` | `{rooms:[...]}` with the same fields. Maximum eight concurrent rooms per instance. |
| `bili_live_unsubscribe` | `room_id`: initial or resolved room number | `{removed:true}` if removed; already absent returns `false`. Stops pending connections, reconnects and heartbeats. |
| `bili_send_live_text` **(write)** | `room_id`, `text`: 1–20 Unicode code points, not blank, no ASCII controls | Upstream success data. Sends exactly one WBI-signed `/msg/send` form (CSRF supplied by the shared transport). Write permission is required. No gift purchases or gift sends. |

For example: `{"action":"bili_live_subscribe","params":{"room_id":6},"echo":"watch"}`. `subscription_id` is the number used when subscribing; `room_id` in subsequent notices is the resolved canonical number.

## Events

Each event carries `platform:"bilibili"`, `post_type:"notice"`, `notice_type:"bili_live"`, `sub_type`, `time` (Unix seconds), `self_id`, `room_id` and `subscription_id`. Unlike DMs these are namespace-specific notices, not contact or group messages. Display names may be masked, and upstream user IDs may be absent or zero; don't use either as authorization. No raw payload, token, URL, medal or unrecognized profile fields are forwarded.

| `sub_type` | Fields / meaning |
| --- | --- |
| `status` | `state`: `active`, `reconnecting` or `stopped`; stopped notices carry a short fixed `reason`, e.g. `challenge` or `disconnected`. |
| `danmu` | `text`, `user_id` (string or null), `nickname` from `DANMU_MSG`. The text is literal, not CQ markup. |
| `presence` | `user_id`, `nickname`, `interaction` (upstream numeric type or null). Handles JSON `INTERACT_WORD` and the observed fields of protobuf `INTERACT_WORD_V2`. |
| `gift` | `user_id`, `nickname`, `gift_id`, `gift_name`, `quantity` from `SEND_GIFT`. |
| `rank_count`, `watched`, `popularity` | `count` from `ONLINE_RANK_COUNT`, `WATCHED_CHANGE`, or the heartbeat reply respectively. Popularity is not a unique viewer count. |
| `rank_update` | `ONLINE_RANK_V3` protobuf update received; member details have no verified schema and are not published. |

## Transport and failure behavior

Discovery uses fixed `https://api.live.bilibili.com` room-info and WBI-signed danmu-info endpoints (`web_location=444.8`). The socket connects only to a single validated `*.chat.bilibili.com` host from discovery, using `wss`, TLS verification, the standard port and fixed `/sub` path. DNS lookup pins a public IPv4 address. No redirects, caller-supplied URL, cookies, or account UID on the socket. The ephemeral discovery token is sent only inside guest socket authentication (`uid:0`, `protover:2`).

An authenticated connection sends a heartbeat every 30 s. A missing heartbeat acknowledgment, invalid frame, policy rejection or authentication timeout stops the subscription. A previously authenticated transport closing abnormally (1006 without a preceding socket error) gets **one** reconnect after 2 s. No backlog is retained or replayed; events during gaps can be missed. Unknown commands are skipped. Binary input is limited to 1 MiB, decompressed packets to 4 MiB per message, with depth and packet-count limits.

A challenge or fatal authorization refusal stops all live subscriptions and blocks further subscription/send requests for that instance. Resolve access manually before starting a fresh instance; there is no automated challenge handling. Per-instance sends are serialized with a minimum 10 s interval between attempted writes. An ambiguous write result is never retried or reported as delivered.

## Offline verification

Run `node --test test/bili-live.test.mjs`. The suite uses synthetic protocol frames, request mocks and a real loopback WebSocket peer. No external room, login, gift, or message send is involved. Offline tests verify request construction and lifecycle, **not** that Bilibili currently accepts authenticated sends or that a posted message is visible in a live room.
