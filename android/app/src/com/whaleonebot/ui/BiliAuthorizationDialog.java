package com.whaleonebot.ui;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;
import io.nayuki.qrcodegen.QrCode;

/** Render the one-time QR in memory. Only a user-triggered, domain-verified app handoff may carry the link. */
final class BiliAuthorizationDialog {
    static View image(Activity a,String challenge){
        if(!BiliWebLogin.accepts(challenge)||BiliWebLogin.START.equals(challenge))throw new IllegalArgumentException("invalid challenge");
        final QrCode qr=QrCode.encodeText(challenge,QrCode.Ecc.MEDIUM);
        View image=new View(a){final Paint paint=new Paint();protected void onDraw(Canvas c){
            c.drawColor(0xffffffff);int step=Math.min(getWidth(),getHeight())/(qr.size+8);if(step<1)return;
            int x=(getWidth()-qr.size*step)/2,y=(getHeight()-qr.size*step)/2;paint.setColor(0xff000000);paint.setAntiAlias(false);
            for(int j=0;j<qr.size;j++)for(int i=0;i<qr.size;i++)if(qr.getModule(i,j))c.drawRect(x+i*step,y+j*step,x+(i+1)*step,y+(j+1)*step,paint);
        }};image.setContentDescription("本次 B 站官方授权二维码");return image;
    }
    static AlertDialog show(Activity a,String challenge,String uid,Runnable cancel) {
        if(!BiliWebLogin.accepts(challenge)||BiliWebLogin.START.equals(challenge))return null;
        View image=image(a,challenge);
        LinearLayout box=Ui.column(a);int p=Ui.dp(a,Theme.S3);box.setPadding(p,p,p,p);
        TextView note=new TextView(a);note.setText("用哔哩哔哩扫码，或截图后从扫一扫的相册识码。核对账号："+uid+"。不要转发此码。确认后会自动核验账号。");box.addView(note);
        box.addView(image,new LinearLayout.LayoutParams(-1,Ui.dp(a,260)));
        AlertDialog d=new AlertDialog.Builder(a).setTitle("B 站官方授权").setView(box).setPositiveButton("返回查看状态",null).setNegativeButton("取消本次授权",(w,k)->cancel.run()).create();
        d.setButton(AlertDialog.BUTTON_NEUTRAL,"用本机哔哩哔哩确认",(android.content.DialogInterface.OnClickListener)null);
        d.show();d.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v->{
            if(BiliLocalConfirmation.open(a,challenge))d.dismiss();
            else note.setText("请截取二维码，在哔哩哔哩扫一扫中选择相册。不要转发此码。");
        });return d;
    }
}
