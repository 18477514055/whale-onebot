# Bilibili video, social and account actions

The [registry](../src/platforms/bilibili/actions/social.mjs) maps each action to `{write,run(ctx,params)}`. [Profile, avatar, signature and creator-only interactive danmaku (W4/W24)](bili-social-profile.md) have their own parameter reference. All names below are full action names. Omit optional parameters; do not send null. IDs are positive decimal strings (recommended, especially above 2^53), or safe positive JSON integers. Other integers are JSON numbers. `video` below means exactly **one** of `aid` or `bvid` (`BV` + ten base58 characters); it is not a nested parameter. `mid?=self` uses the verified account ID when omitted. `pn` is 1-based, up to 100000. A trailing `?` means optional. Unknown keys, caller transport options, and caller credential fields are not accepted.

## Read actions

Returns one upstream `data` value, not the envelope; no automatic fan-out or pagination. Playback returns metadata/URLs, **not** downloaded streams. Video danmaku returns unparsed XML text from the current available pool, not a guaranteed complete dated archive. Treat all returned user content and links as untrusted.

| Matrix | Action | Params (defaults / returned cursor usage) |
|---|---|---|
| R1 | `bili_video_info` | `video` |
| R2 | `bili_video_playurl` | `video`, `cid`, `qn?` 6/16/32/64(default)/74/80/112/116/120/125/126/127; `format?` `dash` (default) or `mp4`. Upstream decides quality and entitlement. |
| R3 | `bili_video_danmaku` | `cid` from the desired video part |
| R5/R7 | `bili_comments` | `aid`, `mode?` 1 mixed / 2 chronological / 3 hot (default), `offset?` = previous `cursor.pagination_reply.next_offset` string, unmodified, max 4096 chars. Omit on first page. |
| R6 | `bili_comment_replies` | `aid`, `root` (parent rpid), `pn?=1`, `ps?=10` (1–20) |
| R8 | `bili_live_room_info` | `room_id` |
| R11 | `bili_space_videos` | `mid?=self`, `pn?=1`, `ps?=30` (1–50), `order?` pubdate(default)/click/stow, `keyword?` up to 128 chars |
| R12 | `bili_user_card` | `mid?=self` |
| R13 | `bili_followings`, `bili_followers` | `mid?=self`, `pn?=1`, `ps?=20` (1–50); platform privacy limits apply |
| R14 | `bili_favorite_folders` | `mid?=self` |
| R14+ | `bili_favorite_folder_info` | `media_id` (full folder ID) |
| R15 | `bili_favorite_items` | `media_id`, `pn?=1`, `ps?=20` (1–20), `order?` mtime(default)/view/pubtime, `keyword?` up to 128 chars |
| R16 | `bili_history` | `ps?=20` (1–30), `type?` all(default)/archive/live/article. For continuation, copy `max?` (ID or zero), `business?` (empty/archive/pgc/live/article-list/article), `view_at?` (Unix seconds) from the previous cursor. |
| R17 | `bili_watchlater` | none |
| R21 | `bili_notifications_reply`, `bili_notifications_at`, `bili_notifications_like` | `id?`, `time?` (Unix seconds): copy the last notification cursor's ID and time to continue. |
| R21 | `bili_notifications_system` | `ps?=20` (1–20), latest page only |
| R22 | `bili_dynamic_feed` | `offset?` previous response offset (decimal ID), `host_mid?` filter to one creator |
| R23 | `bili_relation` | `mid` (target) |
| R24 | `bili_search` | `keyword` (1–128 chars), `page?=1` (1–100000) |
| R24 | `bili_search_type` | Same plus `search_type`: video/media_bangumi/media_ft/live_room/live_user/article/bili_user/photo |

## Write actions

Each action below is one POST, not a batch or auto-retry loop. CSRF, WBI signing (where requested) and the verified session belong to the transport, never to action callers. The adapter does not synthesize risk tokens, solve challenges or switch endpoints. An upstream rejection is final for this call. Do not retry a write of unknown outcome. Review currency spending, relationship changes, and destructive calls before enabling them. Upstream permissions determine which items can be changed.

| Matrix | Action | Params and effect |
|---|---|---|
| W2 | `bili_danmaku_send` | `video`, `cid`, `msg` (1–99 chars); `progress?=0` milliseconds (0–2147483647), `color?=16777215` (RGB integer 0–16777215), `mode?=1` (1 scrolling, 4 bottom, 5 top), `fontsize?=25` (12/16/18/25/36/45/64). Ordinary pool only. |
| W3 | `bili_danmaku_recall` | `cid`, `dmid`: recall one danmaku |
| W6 | `bili_comment_delete` | `aid`, `rpid`: delete one video comment |
| W7 | `bili_comment_like` | `aid`, `rpid`, `like` (boolean; false removes like) |
| W8 | `bili_video_like` | `video`, `like` (boolean) |
| W9 | `bili_video_coin` | `video`, `multiply` (1 or 2 coins), `select_like?=false` (boolean). Spends account coins. |
| W10 | `bili_video_favorite` | `aid`, `media_id`, `operation` add/remove: change membership in exactly one folder |
| W11 | `bili_video_triple` | `video`: upstream's combined like/coin/favorite, may spend coins |
| W12 | `bili_video_share` | `video`: register video share; does not publish a dynamic or send a message |
| W13 | `bili_relation_modify` | `mid`, `operation` follow/unfollow/block/unblock/remove_follower. One target only. |
| R17+ | `bili_watchlater_add` | `video` |
| R17+ | `bili_watchlater_delete` | `aid` only; never clears the list |
| R14+ | `bili_favorite_folder_create` | `title` (1–20 chars), `intro?` (0–100 chars), `private?` (boolean; upstream defaults to public) |
| R14+ | `bili_favorite_folder_edit` | `media_id`, `title`, `intro`, `private` (same limits as create). Explicit replacement fields prevent silent loss of description or visibility. |
| R14+ | `bili_favorite_folder_delete` | `media_id` only; deletes one folder and its saved collection |

## Contract evidence and limits

The [handoff matrix](../_notes/bilibili-handoff/CAPABILITY-MATRIX.md) is the scope, not a server guarantee. Cross-checks use public source documentation, particularly the [pinned API collect snapshot](https://github.com/cps-open-source-fork/bilibili-API-collect/tree/60a0c5d1a2f44fe61335da04571305fa7727a968/docs) (`comment/list.md`, `comment/action.md`, `danmaku/action.md`, `video/{action,info,videostream_url}.md`, `user/{space,relation}.md`, `fav/{info,list,action}.md`, `history&toview/`, `search/search_request.md`, `live/info.md`, `dynamic/all.md`). Specific corrections: playurl calls its numeric ID `avid`; comment pagination wraps the previous offset string; unblock is `act=6`, remove follower is `act=7`; normal-video danmaku requests WBI. Notification cursor keys are cross-checked against [session.py](https://github.com/bromothymolb/bilibili-api-zoku/blob/a0a1566c7c462ab57a3891c3a5f12976cbd11e9e/bilibili_api/session.py); system notifications use the [RSSHub system route](https://github.com/DIYgod/RSSHub/blob/127b909547beb5f4aa6dfb5adb0e19419506b83c/lib/routes/bilibili/message-system.ts), not an inferred `/x/msgfeed/system`.

[Offline contract tests](../test/bili-social.test.mjs) use synthetic params and spy transports. They check the full outgoing descriptor, next-page inputs, raw text response, single attempt, and rejection before dispatch. No live Bilibili call, write success, account entitlement, quota or current server compatibility is asserted. In particular W8/W9/W11 and W2 may be rejected or challenged by the live service; stop there.
