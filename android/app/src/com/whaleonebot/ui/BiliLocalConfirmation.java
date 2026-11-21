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
    private BiliLocalConfirmation(){}
}
