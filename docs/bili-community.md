# Bilibili community actions

These are fixed account-action contracts, not a general API client. Use the `bili_` prefix on each name below. R = read; W = write (subject to the bridge's write gate). Use positive signed-64-bit decimal strings for IDs, especially dynamic IDs; safe positive JSON integers are also accepted. Switches require real JSON booleans. Do not pass cookies, CSRF, API paths, or unknown parameters. The return value is the transport's unwrapped upstream data, not a promise that every account can use every operation.

## Operations and evidence

SDK references below are exact keys under `bilibili_api/data/api/<module>.json` inside the [bilibili-api-python 17.4.2 wheel](https://pypi.org/project/bilibili-api-python/17.4.2/#files), SHA-256 `91e002b2e0bcd3eb50239e35ceb849133b574f407a92a06636e1de1031b6d09d`. The linked archived documentation pins revisions as well. Both are community-maintained contract evidence, not current production verification.

| Action | Input / effect | Contract evidence |
|---|---|---|
| `dynamic_detail` R | `dynamic_id`; signed request, dynamic item | SDK `dynamic.info.detail` and `Dynamic.get_info` (`dynamic.py:737`); [query fields and response](https://github.com/rinnein/bilibili-API-collect/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/dynamic/detail.md#L5-L112) |
| `dynamic_like` W | `dynamic_id, like`; false = unlike; actor UID comes from signed-in context | SDK `dynamic.operate.like`, `Dynamic.set_like` (`dynamic.py:990`) |
| `dynamic_delete` W | `dynamic_id`; reads the item first. Exact `id_str` and outer `modules.module_author.mid` must match target and self. A failed read or ownership check means deletion was not sent. | SDK `dynamic.operate.delete`, `Dynamic.delete` (`dynamic.py:1015`) and detail response above |
| `vote_info` R | `vote_id` | SDK `vote.info.vote_info` |
| `vote_cast` W | `vote_id, options` (array of 1–32 distinct positive integer option `idx` values from `vote_info`; not zero-based array positions). Voter is always self. | [Pinned BiliCO endpoint](https://github.com/Costben/BiliCO/blob/d9ae247f0d239446e4effd9b3674fa7610b07ed2/data/src/main/java/erl/bilico/data/network/BiliApi.kt) and [submit form and option indices](https://github.com/Costben/BiliCO/blob/d9ae247f0d239446e4effd9b3674fa7610b07ed2/data/src/main/java/erl/bilico/data/repository/DynamicVoteSupport.kt#L97-L129) |
| `article_draft_delete` W | `aid`; delete one signed-in creator draft by its draft ID, not a published article | BiliExper [draft deletion call site](https://github.com/MaxSecurity/BiliExper/blob/a78288e35452783aa0f0841069e9830be1c88289/BiliClient/Article.py) `delself`; [exact POST endpoint/form](https://github.com/MaxSecurity/BiliExper/blob/a78288e35452783aa0f0841069e9830be1c88289/BiliClient/BiliApi.py) `deleteArticle` |
| `article_public_read` R | `cvid`; public article JSON, **not** creator draft/view and not an HTML page fetch. `data.content` can contain HTML or serialized JSON: treat as untrusted, do not render it as active content. | SDK `article.info.detail`; [documented JSON envelope and content type](https://github.com/rinnein/bilibili-API-collect/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/article/view.md#L5-L60) |
| `article_info` R | `cvid`; article metadata | SDK `article.info.view` |
| `article_list` R | `rlid`; articles in one collection; not creator inventory | SDK `article.info.list`, `ArticleList.get_content` (`article.py:130`) |
| `article_like` W | `cvid, like`; false = unlike | SDK `article.operate.like` |
| `article_favorite` W | `cvid, operation` = `add` or `remove` | SDK `article.operate.add_favorite` / `del_favorite` |
| `article_delete` W | `cvid`; deletes one published article. Creator authorization is enforced by Bilibili (`37104` for another author's article). | [Archived creator endpoint, form, and permission error](https://github.com/SocialSisterYi/bilibili-API-collect/blob/e99f64c9b5c2bbd156e95ca254620378a22697f7/docs/article/delete.md#L1-L32) |
| `video_tags` R | exactly one of `aid`/`bvid`, optional `cid` | SDK `video.info.tags`; [optional part ID](https://github.com/rinnein/bilibili-API-collect/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/video/tags.md#L5-L17) |
| `video_related` R | exactly one of `aid`/`bvid` | SDK `video.info.related` |
| `pgc_follow` W | `season_id, operation` = `add` or `remove`; tracks a season, does not buy access | SDK `bangumi.operate.follow_add` / `follow_del` |
| `comment_pin` W | `aid, rpid, pin`; video reply only, false = unpin; requires upstream permission | SDK `common.comment.pin` |
| `comment_dislike` W | `aid, rpid, dislike`; video reply only, false = undo | SDK `common.comment.hate` |
| `history_delete` W | `business, id`; one item only. `archive` = aid, `live` = room ID, `article` = cvid, `pgc` = season ID, `article-list` = collection ID. | [History deletion kid format and form](https://github.com/rinnein/bilibili-API-collect/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/historytoview/history.md#L660-L672) |
| `dm_unread` R | no parameters; account aggregate private-message counts, not conversations or message contents | [Single-unread, optional filters and defaults](https://github.com/rinnein/bilibili-API-collect/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/message/private_msg.md#L100-L117) |
| `notifications_unread` R | no parameters; notification counts, distinct from DM unread | SDK `session.session.unread` |
| `follow_groups` R | no parameters; own group list | SDK `user.info.self_subscribe_group` |
| `follow_user_groups` R | `mid`; that user's group membership in own follow list | SDK `user.info.get_user_in_which_subscribe_groups` |
| `follow_group_create` W | `name`; locally capped at 16 Unicode code points | SDK `user.operate.create_subscribe_group` |
| `follow_group_rename` W | `tagid, name`; positive group ID, same name limit | SDK `user.operate.rename_subscribe_group` |
| `follow_group_delete` W | `tagid`; one positive custom group ID | SDK `user.operate.del_subscribe_group` |
| `follow_group_assign` W | `mid, tagid`; assign one followed user to one group (not a bulk membership editor) | SDK `user.operate.set_user_subscribe_group` |

Not exposed: voting in photo or live-room polls, draft deletion via the published-article endpoint, or multi-item writes. No history clear, bulk deletion, coin/spend, video submission, arbitrary URL fetch, or cross-peer message retrieval.

Offline verification: `node --test test/bili-community.test.mjs` checks exact requests and write flags, both sides of toggles, target/actor identity, rejection before dispatch, and name collisions with social and publishing catalogs. No credential or live Bilibili call is used in those tests.
