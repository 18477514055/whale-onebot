package com.whaleonebot.douyin.mobile;

import android.content.ClipData;
import android.content.Intent;
import android.os.BadParcelableException;

/** Exported entry is inert until a locally authenticated owner explicitly picks a destination. */
public final class ShareActivity extends Sheet {
    private static String from(Intent i) {
        if(i==null || !Intent.ACTION_SEND.equals(i.getAction()) || !"text/plain".equals(i.getType()) || i.getData()!=null) return null;
        try {
            if(i.hasExtra(Intent.EXTRA_STREAM)) return null;
            ClipData clip=i.getClipData();
            if(clip!=null) {
                if(clip.getItemCount()!=1) return null;
                ClipData.Item item=clip.getItemAt(0);
                if(item.getUri()!=null || item.getIntent()!=null) return null;
            }
            CharSequence t=i.getCharSequenceExtra(Intent.EXTRA_TEXT);
            return t!=null && t.length()<=4096 ? Desk.candidate(t.toString()):null;
        } catch(BadParcelableException|ClassCastException e){return null;}
    }
    private boolean consumed;
    @Override void render() {
        String link=from(getIntent());
        if(link==null){text("未收到支持的作品链接。请分享一条 HTTPS 作品地址，不附带文件或多个链接。");return;}
        text("接收一条作品链接"); text(link); text("尚未验证公开可见。仅把链接交给你选的机器人，不转发原文、不回复外部会话。");
        java.util.List<Desk.Slot> slots=desk.slots();
        if(slots.isEmpty()) text("尚未配置账号。请先在宿主内设置机器人，再重新分享。");
        for(Desk.Slot s:slots) button("交给 "+s.botId+"（"+s.accountId+"）",()->{
            if(consumed) return; consumed=true;
            boolean queued=false;
            try { queued=desk.current(s) && host.enqueueCandidate(s,link); }
            catch(RuntimeException ignored) { /* Unknown outcome. Never retry automatically. */ }
            android.widget.Toast.makeText(this,queued?"链接已交给本地队列":"未能确认本地接收；不会自动重试",android.widget.Toast.LENGTH_LONG).show();finish();
        });
    }
}
