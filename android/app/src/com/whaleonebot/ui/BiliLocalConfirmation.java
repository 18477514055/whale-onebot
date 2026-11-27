package com.whaleonebot.ui;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.verify.domain.DomainVerificationManager;
import android.content.pm.verify.domain.DomainVerificationUserState;
import android.net.Uri;
import android.os.Build;

/** A user gesture may hand a current QR to the domain-verified official app only. */
final class BiliLocalConfirmation {
    private static final String APP="tv.danmaku.bili";
    static boolean open(Activity activity,String url){
        if(Build.VERSION.SDK_INT<31 || !BiliWebLogin.accepts(url) || BiliWebLogin.START.equals(url))return false;
        try{
            Uri uri=Uri.parse(url);
            DomainVerificationUserState state=activity.getSystemService(DomainVerificationManager.class).getDomainVerificationUserState(APP);
            if(state==null || !state.isLinkHandlingAllowed() || !Integer.valueOf(DomainVerificationUserState.DOMAIN_STATE_VERIFIED).equals(state.getHostToStateMap().get(uri.getHost())))return false;
            Intent view=new Intent(Intent.ACTION_VIEW,uri).addCategory(Intent.CATEGORY_BROWSABLE).setPackage(APP);
            if(view.resolveActivity(activity.getPackageManager())==null)return false;
            activity.startActivity(view);return true;
        }catch(Exception unavailable){return false;}
    }

    /** 引导前往系统 B 站应用详情页开启「默认打开受支持的链接」(App Links)。 */
    static void openAppLinksSettings(Activity activity) {
        if (activity == null) return;
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_APP_OPEN_BY_DEFAULT_SETTINGS,
                    Uri.parse("package:" + APP));
            activity.startActivity(i);
            return;
        } catch (Throwable ignored) {}
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + APP));
            activity.startActivity(i);
        } catch (Throwable ignored) {}
    }

    private BiliLocalConfirmation(){}
}
