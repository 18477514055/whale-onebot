# Bilibili: publish content and manage one authorized DM conversation

These actions implement W15–W21 and R18–R20 from the [capability matrix](../_notes/bilibili-handoff/CAPABILITY-MATRIX.md). A draft save, media upload, vote creation, public post, and DM read receipt are **separate operations**. Uploading an image or creating a vote does not publish a dynamic. Updating a draft does not submit it. No video submission, editing or replacement endpoint is present.

## Parameters

IDs and pagination cursors accept positive unsigned 64-bit decimals. **Send them as strings**, especially message keys, to avoid JSON number rounding. Small integer fields (size, category, original, dimensions, etc.) take JSON numbers. Unknown top-level fields are rejected, not forwarded. There is no raw request, arbitrary upload filename/path, caller-specified account or receiver, or caller-supplied CSRF token. Unless noted below, results are the upstream `data` field rather than the entire response envelope.

### Dynamics and polls

| Action | Parameters | Result / effect |
|---|---|---|
| `bili_dynamic_upload_image` | `image`: base64 data URI, see below | One `file_up` multipart upload; receipt includes `image_url`, `image_width`, `image_height`. |
| `bili_dynamic_create` | Optional `text` (≤2000 code points), `images` (≤9 `{url,width,height}` objects), `vote` (`{id,title}`; title ≤80). At least one meaningful component. | Creates one public text or picture dynamic, optionally with an existing vote. Pass upload receipt fields as `url`, `width`, `height`. |
| `bili_dynamic_repost` | `dynamic_id`; optional plain `text` (≤2000, defaults to `转发动态`) | Reposts one dynamic; no automatic @-mention resolution. |
| `bili_vote_create` | `title` (≤80), `options` (2–8 distinct text options of ≤80 each), `duration` (seconds, 60–2592000). Optional `description` (≤200) and `max_choices` (1…option count, default 1). | Creates a text-option poll; pass its `vote_id` to `bili_dynamic_create.vote.id` to attach it. |

Example parameters for `bili_dynamic_create` after upload and poll creation (synthetic values):

```json
{"text":"Choose a cover","images":[{"url":"https://i0.hdslb.com/bfs/new_dyn/a123.png","width":300,"height":200}],"vote":{"id":"5","title":"Which cover?"}}
```

### Articles

Use `title` (≤80 code points), `text` (≤30000), a positive second-level `category` ID, `original` (`0` or `1`) and optional `cover_url`. `text` is **plain text**, not HTML: markup is escaped; newlines become paragraphs. Draft edits and public edits replace the content. Send the complete desired state, including the current cover if it is to be kept. `aid` here is the creative article/draft ID, **not a video ID**.

| Action | Parameters | Effect |
|---|---|---|
| `bili_article_upload_cover` | `image` data URI | Upload via the form field `cover`. Use the returned `url` or `image_url` as `cover_url`. |
| `bili_article_draft_create` | Article fields above; no `aid` | Save a new draft; inspect returned `aid`. |
| `bili_article_draft_update` | Article fields and existing draft `aid` | Replace draft without submitting. |
| `bili_article_draft_view` | `aid` | Read one draft in the signed-in creative workspace. |
| `bili_article_submit` | Article fields, draft `aid`, explicit `reprint` (`0`/`1`) | Submit the draft for publication/review. Not a request to save another draft. |
| `bili_article_view` | `aid` | View one article via the signed-in creative endpoint. |
| `bili_article_update` | Article fields, published `aid`, explicit `reprint` (`0`/`1`) | Change an already submitted article, subject to review/cooldowns. |

**Images:** upload accepts `data:image/png;base64,…`, `image/jpeg`, or `image/gif`, with canonical base64, matching leading file signature and ≤2 MiB decoded (caller/transport body limits can be smaller). This is signature checking, not full image decoding. Width/height must be integer pixels (1–32768). Image references must be simple BFS image paths on `i0`/`i1`/`i2.hdslb.com`, `i0`/`i1`/`i2.biliimg.com`, or `message.biliimg.com`; legacy `http:` receipts normalize to `https:`. No fetch of a caller-supplied URL takes place.

### Private messages

All five actions require a configured, authorized peer different from self; there is **no** caller-supplied UID, group, or bulk mode. History/session list perform one page read, not auto-pagination. `null` next cursor means stop. A filtered page can be empty even when its next cursor is non-null; pass the returned cursor explicitly to continue.

| Action | Parameters | Result / effect |
|---|---|---|
| `bili_dm_sessions` | Optional `size` (1–50, default 20), `end_ts` (microsecond timestamp) | `{session_list,next_end_ts}`. Reads one ordinary/unfolded upstream session page; returns only configured peer's summary (IDs, unread count, ack sequence, timestamp), never other talkers, groups, `last_msg`, or account-wide metadata. Cursor is the oldest page timestamp, including when no peer matched. |
| `bili_dm_history` | Optional `size` (1–50, default 30), `end_seqno` (exclusive) | `{messages,next_end_seqno}`. Each row includes exact `msg_key`, `msg_seqno`, `msg_type`, sender/receiver IDs, timestamp and upstream `content` string. This is an on-demand history view, not the realtime incoming text-event filter: outgoing and incoming message types may both be present. Withdrawn/abnormal, automatic (`msg_source=8`), and cross-peer rows are not exposed. This does not mark messages read. |
| `bili_dm_ack` | `ack_seqno` | **Write**: mark this peer's session read through that sequence. |
| `bili_dm_send_image` | `url` (BFS image), `width`, `height` | Send one type-2 image message to the authorized peer using the configured UUIDv4 device and WBI-signed query. Returns `{msg_key}` on a confirmed receipt. Upload separately if necessary. |
| `bili_dm_recall` | `msg_key`, `msg_seqno` from a recent outgoing text/image | First read one peer history row just before `msg_seqno + 1`. Only if IDs, sender, receiver, status and age (<120 seconds) match, send a type-5 recall carrying the original key. Returns `{msg_key}` for the recall receipt. A failed ownership check sends nothing. |

## Evidence and limitations

- [API Collect: dynamic publishing, `917a90a`](https://github.com/SocialSisterYi/bilibili-API-collect/blob/917a90a/docs/dynamic/publish.md) documents `create/dyn` JSON with query CSRF, multipart `upload_bfs`, and vote fields. For W17/W18 we used the explicit contracts in the [17.4.2 Python distribution](https://pypi.org/project/bilibili-api-python/17.4.2/): `dynamic.py:Dynamic.repost`, `vote.py:create_vote` and their bundled API descriptors. Those use `dynamic_repost/v1/dynamic_repost/repost` and `vote_svr/v1/vote_svr/create_vote`, rather than assuming the matrix's unverified repost and vote paths.
- [bili-cli: article creative API, `bfc568f`](https://github.com/kukemc/bili-cli/blob/bfc568f169f50b11f743a8dad7c1d7c0ba3a84e0/src/bili_cli/commands/article.py) distinguishes `draft/addupdate`, `article/submit`, `article/update`, `draft/view`, `article/view`, and `article/upcover`. Submit takes the complete form, not just an ID. `category` is the upstream field, not `category_id`.
- [API Collect: IM endpoints/fields](https://github.com/SocialSisterYi/bilibili-API-collect/blob/917a90a/docs/message/private_msg.md) and [IM content types](https://github.com/SocialSisterYi/bilibili-API-collect/blob/917a90a/docs/message/private_msg_content.md) document the page cursors, two CSRF form fields, WBI query for send, image payload and recall window/key. Sending types 2/5 is separate from the existing text-message transport.
- Contracts are community source observations, **not** verified current production compatibility. All tests are synthetic (`node --test test/bili-publish.test.mjs`); no real Bilibili reads, sends, uploads, or publications were performed. A transport or receipt failure after dispatch may have an unknown outcome: inspect platform state manually rather than resending. Platform control, review, quota, cooldown or permission failures are not bypassed.
